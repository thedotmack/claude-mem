/**
 * ProxyServer — HTTP forwarding proxy for client mode.
 *
 * Uses Node's http.createServer + http.request instead of Express + fetch.
 * Express middleware and Bun's fetch() both cause networking issues in daemon
 * mode on some macOS machines. Raw http module is universally stable.
 */

import http from 'http';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getNodeName, getInstanceName } from '../../shared/node-identity.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { OfflineBuffer } from '../infrastructure/OfflineBuffer.js';
import { logger } from '../../utils/logger.js';

export interface ProxyServerOptions {
  serverHost: string;
  serverPort: number;
  authToken: string;
  dataDir: string;
  healthCheckIntervalMs?: number;
}

/** Make an HTTP request via Node's http module. */
function httpRequest(
  options: { host: string; port: number; path: string; method: string; headers?: Record<string, string>; body?: string; timeout?: number }
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: options.host,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: options.headers || {},
      timeout: options.timeout || 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Resolve the UI assets directory for serving static files. */
function resolveUiDir(): string | null {
  const candidates = [
    // When running from plugin scripts dir: ../ui
    path.resolve(path.dirname(process.argv[1] || ''), '..', 'ui'),
    // Marketplace location
    path.join(process.env.HOME || '', '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'ui'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'viewer.html'))) return dir;
  }
  return null;
}

/** MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

export class ProxyServer {
  private server: http.Server | null = null;
  private serverHost: string;
  private serverPort: number;
  private authToken: string;
  private buffer: OfflineBuffer;
  private serverReachable = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number;
  private uiDir: string | null;
  private settingsPath: string;

  constructor(options: ProxyServerOptions);
  /** @deprecated Use options object form */
  constructor(serverHost: string, serverPort: number, authToken: string, dataDir: string);
  constructor(
    hostOrOptions: string | ProxyServerOptions,
    serverPort?: number,
    authToken?: string,
    dataDir?: string,
  ) {
    if (typeof hostOrOptions === 'string') {
      this.serverHost = hostOrOptions;
      this.serverPort = serverPort ?? 37777;
      this.authToken = authToken ?? '';
      this.buffer = new OfflineBuffer(dataDir ?? '');
      this.healthCheckIntervalMs = 10_000;
    } else {
      this.serverHost = hostOrOptions.serverHost;
      this.serverPort = hostOrOptions.serverPort;
      this.authToken = hostOrOptions.authToken;
      this.buffer = new OfflineBuffer(hostOrOptions.dataDir);
      this.healthCheckIntervalMs = hostOrOptions.healthCheckIntervalMs ?? 10_000;
    }
    this.uiDir = resolveUiDir();
    this.settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  }

  async start(localPort: number): Promise<void> {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(localPort, '127.0.0.1', () => {
        logger.info('PROXY', 'Proxy started', { localPort, target: `${this.serverHost}:${this.serverPort}` });
        resolve();
      });
      this.server!.on('error', reject);
    });

    this.startHealthCheck();
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // ── Local endpoints (never forwarded) ──

    if (method === 'GET' && pathname === '/api/health') {
      this.jsonResponse(res, 200, {
        status: 'ok',
        mode: 'client',
        proxy: true,
        node: getNodeName(),
        serverReachable: this.serverReachable,
        serverHost: this.serverHost,
        pendingBuffer: this.buffer.pendingCount(),
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/readiness') {
      this.jsonResponse(res, 200, { status: 'ready', proxy: true });
      return;
    }

    // Local settings — serve THIS node's settings, not the server's
    if (pathname === '/api/settings') {
      if (method === 'GET') {
        try {
          const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath);
          this.jsonResponse(res, 200, settings);
        } catch {
          this.jsonResponse(res, 500, { error: 'Failed to read local settings' });
        }
        return;
      }
      if (method === 'PUT' || method === 'POST') {
        this.readBody(req, (body) => {
          try {
            const updates = JSON.parse(body);
            const current = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
            const merged = { ...current, ...updates };
            writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2));
            this.jsonResponse(res, 200, { success: true });
          } catch {
            this.jsonResponse(res, 400, { error: 'Invalid settings' });
          }
        });
        return;
      }
    }

    // ── Static UI files ──

    if (method === 'GET' && this.uiDir && !pathname.startsWith('/api/') && pathname !== '/stream') {
      const filePath = path.join(this.uiDir, pathname === '/' ? 'viewer.html' : pathname);
      if (existsSync(filePath) && !filePath.includes('..')) {
        const ext = path.extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(readFileSync(filePath));
        return;
      }
    }

    // ── SSE stream — pipe directly ──

    if (method === 'GET' && pathname === '/stream') {
      const sseReq = http.request({
        hostname: this.serverHost,
        port: this.serverPort,
        path: '/stream',
        method: 'GET',
        headers: this.proxyHeaders(),
      }, (sseRes) => {
        if (sseRes.statusCode !== 200) { res.writeHead(502); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        sseRes.pipe(res);
      });
      sseReq.on('error', () => { res.writeHead(502); res.end(); });
      req.on('close', () => sseReq.destroy());
      sseReq.end();
      return;
    }

    // ── Forward all other requests to server ──

    this.readBody(req, (body) => {
      const proxyReq = http.request({
        hostname: this.serverHost,
        port: this.serverPort,
        path: pathname + url.search,
        method,
        headers: { ...this.proxyHeaders(), 'Content-Type': 'application/json' },
        timeout: 30000,
      }, (proxyRes) => {
        this.serverReachable = true;
        // Pipe response headers and body directly (preserves binary, streaming, etc.)
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', () => {
        this.serverReachable = false;
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          try {
            this.buffer.append({
              ts: new Date().toISOString(),
              method,
              path: pathname,
              body: body ? JSON.parse(body) : {},
              node: getNodeName(),
              headers: this.proxyHeaders(),
            });
          } catch (e) {
            logger.error('PROXY', 'Buffer failed', { path: pathname }, e as Error);
          }
          this.jsonResponse(res, 202, { buffered: true, path: pathname });
        } else {
          this.jsonResponse(res, 503, { error: 'server_unreachable', serverHost: this.serverHost });
        }
      });

      proxyReq.on('timeout', () => proxyReq.destroy());
      if (body) proxyReq.write(body);
      proxyReq.end();
    });
  }

  // ── Health check (uses http.request, not fetch) ──

  private startHealthCheck(): void {
    logger.info('PROXY', 'Health check started', {
      intervalMs: this.healthCheckIntervalMs,
      target: `${this.serverHost}:${this.serverPort}`,
      hasToken: !!this.authToken
    });

    this.healthCheckInterval = setInterval(() => {
      httpRequest({
        host: this.serverHost,
        port: this.serverPort,
        path: '/api/health',
        method: 'GET',
        headers: this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {},
        timeout: 5000,
      }).then((response) => {
        const wasUnreachable = !this.serverReachable;
        this.serverReachable = response.statusCode === 200;
        if (wasUnreachable && this.serverReachable) {
          logger.info('PROXY', 'Server is back online, starting buffer replay');
          this.replayBuffer();
        }
      }).catch((error) => {
        this.serverReachable = false;
        logger.warn('PROXY', 'Health check failed', {
          target: `${this.serverHost}:${this.serverPort}`,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.healthCheckIntervalMs);
  }

  // ── Buffer replay ──

  private replayBuffer(): void {
    this.buffer.replay((entry) => {
      return new Promise<boolean>((resolve) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(entry.headers || {}),
          'X-Claude-Mem-Replayed': 'true',
        };
        if (this.authToken && !headers['Authorization']) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        httpRequest({
          host: this.serverHost,
          port: this.serverPort,
          path: entry.path,
          method: entry.method,
          headers,
          body: JSON.stringify(entry.body),
        }).then((r) => resolve(r.statusCode >= 200 && r.statusCode < 300))
          .catch(() => resolve(false));
      });
    }).then((result) => {
      if (result.replayed > 0) {
        logger.info('PROXY', 'Buffer replay', { replayed: result.replayed, remaining: result.remaining });
      }
    });
  }

  // ── Helpers ──

  private proxyHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'X-Claude-Mem-Node': getNodeName(),
      'X-Claude-Mem-Instance': getInstanceName(),
      'X-Claude-Mem-Mode': 'proxy',
      'X-Claude-Mem-Platform': 'claude-code',
    };
    if (this.authToken) h['Authorization'] = `Bearer ${this.authToken}`;
    return h;
  }

  private jsonResponse(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: http.IncomingMessage, callback: (body: string) => void): void {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => callback(body));
  }

  getPendingCount(): number {
    return this.buffer.pendingCount();
  }

  isServerReachable(): boolean {
    return this.serverReachable;
  }
}
