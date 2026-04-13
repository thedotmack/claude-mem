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
import { getNodeName, getInstanceName, getLlmSource, clearNodeNameCache } from '../../shared/node-identity.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { OfflineBuffer, type ReplayResult } from '../infrastructure/OfflineBuffer.js';
import { logger } from '../../utils/logger.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
declare const __GIT_COMMIT_SHA__: string;

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
      res.setEncoding('utf8');
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
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
  private serverVersion: string | null = null;
  private serverCommit: string | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number;
  private settingsSyncInterval: ReturnType<typeof setInterval> | null = null;
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
    const effectiveDataDir = typeof hostOrOptions === 'string'
      ? (dataDir || SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'))
      : (hostOrOptions.dataDir || SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'));

    if (typeof hostOrOptions === 'string') {
      this.serverHost = hostOrOptions;
      this.serverPort = serverPort ?? 37777;
      this.authToken = authToken ?? '';
      this.buffer = new OfflineBuffer(effectiveDataDir);
      this.healthCheckIntervalMs = 10_000;
    } else {
      this.serverHost = hostOrOptions.serverHost;
      this.serverPort = hostOrOptions.serverPort;
      this.authToken = hostOrOptions.authToken;
      this.buffer = new OfflineBuffer(effectiveDataDir);
      this.healthCheckIntervalMs = hostOrOptions.healthCheckIntervalMs ?? 10_000;
    }
    this.uiDir = resolveUiDir();
    this.settingsPath = path.join(effectiveDataDir, 'settings.json');
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
    this.startSettingsSync();
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.settingsSyncInterval) { clearInterval(this.settingsSyncInterval); this.settingsSyncInterval = null; }
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
      const proxyVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
        ? __DEFAULT_PACKAGE_VERSION__ : 'development';
      const proxyCommit = typeof __GIT_COMMIT_SHA__ !== 'undefined'
        ? __GIT_COMMIT_SHA__ : '';
      const versionMatch = this.serverVersion
        ? proxyVersion === this.serverVersion
        : null; // null = unknown (server not yet polled)
      this.jsonResponse(res, 200, {
        status: 'ok',
        mode: 'client',
        proxy: true,
        node: getNodeName(),
        proxyVersion,
        proxyCommit: proxyCommit || undefined,
        serverVersion: this.serverVersion,
        serverCommit: this.serverCommit,
        versionMatch,
        serverReachable: this.serverReachable,
        serverHost: this.serverHost,
        pendingBuffer: this.buffer.pendingCount(),
        settingsSyncActive: this.settingsSyncInterval !== null,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/readiness') {
      this.jsonResponse(res, 200, { status: 'ready', proxy: true });
      return;
    }

    // Local settings — serve THIS node's settings, not the server's.
    // Write access is safe here: the proxy listens on 127.0.0.1 only (see start()),
    // so only processes on this machine can reach this endpoint.
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
          if (body === 'too_large') { this.jsonResponse(res, 413, { error: 'payload_too_large' }); return; }
      if (body === 'error') { this.jsonResponse(res, 502, { error: 'request_read_error' }); return; }
          try {
            const updates = JSON.parse(body);
            if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
              this.jsonResponse(res, 400, { error: 'Settings must be a JSON object' });
              return;
            }
            let current: Record<string, unknown> = {};
            try {
              current = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
            } catch {
              // File doesn't exist yet — start fresh
            }
            const merged = { ...current, ...updates };
            writeFileSync(this.settingsPath, JSON.stringify(merged, null, 2));
            clearNodeNameCache(); // Invalidate cached identity after local settings change
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
      const requestedPath = pathname === '/' ? '/viewer.html' : pathname;
      // Use path.resolve to expand any ".." segments before checking containment.
      // path.join does NOT protect against traversal; resolve + startsWith does.
      const filePath = path.resolve(this.uiDir, '.' + requestedPath);
      const isWithinUiDir = filePath.startsWith(this.uiDir + path.sep) || filePath === this.uiDir;
      if (!isWithinUiDir) {
        this.jsonResponse(res, 403, { error: 'forbidden' });
        return;
      }
      if (existsSync(filePath)) {
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

    // ── Block admin routes — never forward shutdown/restart to the remote server ──
    if (pathname.startsWith('/api/admin/')) {
      this.jsonResponse(res, 403, { error: 'admin_routes_local_only', path: pathname });
      return;
    }

    // ── Forward all other requests to server ──

    this.readBody(req, (body) => {
      if (body === 'too_large') { this.jsonResponse(res, 413, { error: 'payload_too_large' }); return; }
      if (body === 'error') { this.jsonResponse(res, 502, { error: 'request_read_error' }); return; }
      const proxyReq = http.request({
        hostname: this.serverHost,
        port: this.serverPort,
        path: pathname + url.search,
        method,
        headers: { ...this.proxyHeaders(), 'Content-Type': req.headers['content-type'] || 'application/json' },
        timeout: 30000,
      }, (proxyRes) => {
        this.serverReachable = true;
        // Strip hop-by-hop headers before forwarding (RFC 2616 §13.5.1)
        const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);
        const headers = Object.fromEntries(
          Object.entries(proxyRes.headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase()))
        );
        res.writeHead(proxyRes.statusCode || 200, headers);
        proxyRes.pipe(res);
      });

      // Track request lifecycle to prevent double-response and unsafe replay.
      let requestWritten = false;
      let timedOut = false;

      proxyReq.on('error', () => {
        if (timedOut) return; // timeout handler already responded
        this.serverReachable = false;
        if (res.headersSent) return; // response already sent
        if (['POST', 'PUT', 'PATCH'].includes(method) && !requestWritten) {
          // Safe to buffer: no bytes reached upstream yet
          try {
            const { Authorization: _, ...safeHeaders } = this.proxyHeaders();
            this.buffer.append({
              ts: new Date().toISOString(),
              method,
              path: pathname + url.search,
              body: (body && body.trim()) ? JSON.parse(body) : null,
              node: getNodeName(),
              headers: safeHeaders,
            });
            this.jsonResponse(res, 202, { buffered: true, path: pathname });
          } catch (e) {
            logger.error('PROXY', 'Buffer failed', { path: pathname }, e as Error);
            if (!res.headersSent) this.jsonResponse(res, 502, { error: 'buffer_failed', path: pathname });
          }
        } else if (requestWritten) {
          this.jsonResponse(res, 502, { error: 'upstream_error_after_send', path: pathname });
        } else {
          this.jsonResponse(res, 503, { error: 'server_unreachable', serverHost: this.serverHost });
        }
      });

      proxyReq.on('timeout', () => {
        timedOut = true;
        proxyReq.destroy();
        if (!res.headersSent) {
          this.jsonResponse(res, 504, { error: 'upstream_timeout', path: pathname });
        }
      });
      if (body) proxyReq.write(body);
      // Mark as written BEFORE end() — even empty-body mutating requests
      // send headers to upstream via end(), making replay ambiguous.
      if (['POST', 'PUT', 'PATCH'].includes(method)) requestWritten = true;
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

        // Cache server version from health response
        if (this.serverReachable && response.body) {
          try {
            const serverHealth = JSON.parse(response.body);
            if (serverHealth.version) {
              this.serverVersion = serverHealth.version;
            }
            if (serverHealth.commit) {
              this.serverCommit = serverHealth.commit;
            }
          } catch { /* ignore parse errors */ }
        }

        if (this.serverReachable && (wasUnreachable || this.buffer.pendingCount() > 0)) {
          // Only log on reconnection transition (not on every tick with stale buffer entries)
          if (wasUnreachable) {
            logger.info('PROXY', 'Server is back online, replaying buffer', {
              pending: this.buffer.pendingCount()
            });
          }
          // OfflineBuffer.replay() has its own internal `replaying` guard that prevents
          // concurrent replays, so calling this on every tick is safe — it will no-op
          // if a replay is already in progress.
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

  // ── Settings sync (client pulls LLM/processing settings from server) ──

  /** Settings that must NOT be overwritten by server values (network-specific to each node). */
  private static readonly LOCAL_ONLY_SETTINGS = new Set([
    'CLAUDE_MEM_NETWORK_MODE',
    'CLAUDE_MEM_SERVER_HOST',
    'CLAUDE_MEM_SERVER_PORT',
    'CLAUDE_MEM_AUTH_TOKEN',
    'CLAUDE_MEM_NODE_NAME',
    'CLAUDE_MEM_INSTANCE_NAME',
    'CLAUDE_MEM_DATA_DIR',
    'CLAUDE_MEM_WORKER_HOST',
    'CLAUDE_MEM_WORKER_PORT',
  ]);

  private startSettingsSync(): void {
    let syncEnabled = true;
    let intervalMs = 60_000;
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
      if (settings.CLAUDE_MEM_SETTINGS_SYNC_ENABLED === 'false') syncEnabled = false;
      const parsed = parseInt(settings.CLAUDE_MEM_SETTINGS_SYNC_INTERVAL_MS);
      if (!isNaN(parsed) && parsed > 0) intervalMs = parsed;
    } catch {
      // Settings file missing or unreadable — use defaults
    }

    if (!syncEnabled) {
      logger.info('PROXY', 'Settings sync disabled by configuration');
      return;
    }

    // Sync immediately on start, then at the configured interval
    this.syncSettingsFromServer();
    this.settingsSyncInterval = setInterval(() => this.syncSettingsFromServer(), intervalMs);

    logger.info('PROXY', 'Settings sync started', { intervalMs });
  }

  private syncSettingsFromServer(): void {
    if (!this.serverReachable) return;

    const req = http.request({
      hostname: this.serverHost,
      port: this.serverPort,
      path: '/api/settings',
      method: 'GET',
      headers: this.proxyHeaders(),
      timeout: 10000,
    }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return;
        try {
          const serverSettings = JSON.parse(body);
          if (typeof serverSettings !== 'object' || serverSettings === null || Array.isArray(serverSettings)) {
            logger.warn('PROXY', 'Server settings response is not a plain object, skipping');
            return;
          }
          this.applyServerSettings(serverSettings);
        } catch {
          logger.warn('PROXY', 'Failed to parse server settings');
        }
      });
    });
    req.on('error', (err) => logger.debug('PROXY', 'Settings sync transport error, will retry', { error: (err as Error).message }));
    req.on('timeout', () => req.destroy());
    req.end();
  }

  private applyServerSettings(serverSettings: Record<string, unknown>): void {
    try {
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(this.settingsPath, 'utf-8'));
      } catch {
        // File doesn't exist yet
      }

      let changed = false;
      for (const [key, value] of Object.entries(serverSettings)) {
        if (ProxyServer.LOCAL_ONLY_SETTINGS.has(key)) continue;
        if (JSON.stringify(current[key]) !== JSON.stringify(value)) {
          current[key] = value;
          changed = true;
        }
      }

      if (changed) {
        writeFileSync(this.settingsPath, JSON.stringify(current, null, 2));
        clearNodeNameCache(); // Invalidate cached node name after settings change
        logger.info('PROXY', 'Settings synced from server', {
          keys: Object.keys(serverSettings).filter(k => !ProxyServer.LOCAL_ONLY_SETTINGS.has(k)).length
        });
      }
    } catch (error) {
      logger.warn('PROXY', 'Failed to apply server settings', {}, error as Error);
    }
  }

  // ── Buffer replay ──

  private replayBuffer(): void {
    this.buffer.replay((entry) => {
      return new Promise<ReplayResult>((resolve) => {
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
        }).then((r) => {
          if (r.statusCode >= 200 && r.statusCode < 300) return resolve('ok');
          // 4xx = permanent failure (bad request, not found, validation error) → skip to dead-letter
          if (r.statusCode >= 400 && r.statusCode < 500) {
            logger.warn('PROXY', 'Replay got permanent rejection, skipping', {
              status: r.statusCode, path: entry.path, node: entry.node,
            });
            return resolve('skip');
          }
          // 5xx or unexpected status → transient, retry next cycle
          return resolve('retry');
        }).catch(() => resolve('retry')); // network error = transient
      });
    }).then((result) => {
      if (result.replayed > 0 || result.skipped > 0) {
        logger.info('PROXY', 'Buffer replay', {
          replayed: result.replayed, skipped: result.skipped, remaining: result.remaining,
        });
      }
    }).catch((error) => {
      logger.warn('PROXY', 'Buffer replay error', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  // ── Helpers ──

  private proxyHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'X-Claude-Mem-Node': getNodeName(),
      'X-Claude-Mem-Instance': getInstanceName(),
      'X-Claude-Mem-Llm-Source': getLlmSource(),
      'X-Claude-Mem-Mode': 'proxy',
    };
    if (this.authToken) h['Authorization'] = `Bearer ${this.authToken}`;
    return h;
  }

  private jsonResponse(res: http.ServerResponse, status: number, data: Record<string, unknown>): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  /**
   * Read request body with size limit. Calls callback with null on oversized payloads
   * so callers can respond with 413 instead of forwarding empty data.
   */
  /**
   * Read request body with size limit.
   * Callback receives: body string on success, 'too_large' on size exceeded, 'error' on socket failure.
   */
  private readBody(req: http.IncomingMessage, callback: (body: string | 'too_large' | 'error') => void): void {
    const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB — matches worker's express.json limit
    req.setEncoding('utf8'); // Decode UTF-8 at stream level to avoid multi-byte split across chunks
    let body = '';
    let done = false;
    req.on('data', (chunk: string) => {
      if (done) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf-8') > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        callback('too_large');
      }
    });
    req.on('end', () => { if (!done) { done = true; callback(body); } });
    req.on('error', () => { if (!done) { done = true; callback('error'); } });
  }

  getPendingCount(): number {
    return this.buffer.pendingCount();
  }

  isServerReachable(): boolean {
    return this.serverReachable;
  }
}
