/**
 * ProxyServer — HTTP forwarding proxy for client mode.
 *
 * Uses Node's http.request() instead of fetch() for all outbound calls.
 * Bun's fetch() loses network connectivity after a few calls in setInterval
 * on some macOS machines (confirmed on MBPM4M). http.request is stable.
 */

import express from 'express';
import http from 'http';
import { getNodeName, getInstanceName } from '../../shared/node-identity.js';
import { OfflineBuffer, type BufferedRequest } from '../infrastructure/OfflineBuffer.js';
import { logger } from '../../utils/logger.js';

export interface ProxyServerOptions {
  serverHost: string;
  serverPort: number;
  authToken: string;
  dataDir: string;
  healthCheckIntervalMs?: number;
}

/**
 * Make an HTTP request using Node's http module (not fetch).
 * Returns { statusCode, headers, body } or throws on error.
 */
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
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

export class ProxyServer {
  private app = express();
  private server: http.Server | null = null;
  private serverHost: string;
  private serverPort: number;
  private authToken: string;
  private buffer: OfflineBuffer;
  private serverReachable = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number;

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

    this.app.use(express.json({ limit: '50mb' }));

    // Forward requests — non-async handler (Bun compatibility)
    this.app.use((req: express.Request, res: express.Response) => {
      this.handleRequest(req, res);
    });
  }

  async start(localPort: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = this.app.listen(localPort, '127.0.0.1', () => {
        logger.info('PROXY', 'Proxy started', { localPort, target: `${this.serverHost}:${this.serverPort}` });
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startHealthCheck();
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  private handleRequest(req: express.Request, res: express.Response): void {
    // Local health/readiness
    if (req.method === 'GET' && req.path === '/api/health') {
      res.status(200).json({
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
    if (req.method === 'GET' && req.path === '/api/readiness') {
      res.status(200).json({ status: 'ready', proxy: true });
      return;
    }

    // SSE stream — pipe via raw http
    if (req.method === 'GET' && req.path === '/stream') {
      const sseReq = http.request({
        hostname: this.serverHost,
        port: this.serverPort,
        path: '/stream',
        method: 'GET',
        headers: {
          ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
          'X-Claude-Mem-Node': getNodeName(),
          'X-Claude-Mem-Mode': 'proxy',
        },
      }, (sseRes) => {
        if (sseRes.statusCode !== 200) { res.status(502).end(); return; }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        sseRes.pipe(res);
      });
      sseReq.on('error', () => res.status(502).end());
      req.on('close', () => sseReq.destroy());
      sseReq.end();
      return;
    }

    // Forward all other requests
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Claude-Mem-Node': getNodeName(),
      'X-Claude-Mem-Instance': getInstanceName(),
      'X-Claude-Mem-Mode': 'proxy',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) && req.body
      ? JSON.stringify(req.body) : undefined;

    httpRequest({
      host: this.serverHost,
      port: this.serverPort,
      path: req.path + queryString,
      method: req.method,
      headers,
      body,
    }).then((response) => {
      this.serverReachable = true;
      res.status(response.statusCode);
      const ct = response.headers['content-type'];
      if (ct) res.setHeader('content-type', ct);
      const cc = response.headers['cache-control'];
      if (cc) res.setHeader('cache-control', cc);
      res.send(response.body);
    }).catch(() => {
      this.serverReachable = false;
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        try {
          this.buffer.append({
            ts: new Date().toISOString(),
            method: req.method,
            path: req.path,
            body: req.body,
            node: getNodeName(),
            headers,
          });
        } catch (bufferError) {
          logger.error('PROXY', 'Failed to buffer request', { path: req.path }, bufferError as Error);
        }
        res.status(202).json({ buffered: true, path: req.path });
      } else {
        res.status(503).json({ error: 'server_unreachable', serverHost: this.serverHost });
      }
    });
  }

  private startHealthCheck(): void {
    logger.info('PROXY', 'Health check started', {
      intervalMs: this.healthCheckIntervalMs,
      target: `${this.serverHost}:${this.serverPort}`,
      hasToken: !!this.authToken
    });

    this.healthCheckInterval = setInterval(() => {
      const headers: Record<string, string> = {};
      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      httpRequest({
        host: this.serverHost,
        port: this.serverPort,
        path: '/api/health',
        method: 'GET',
        headers,
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

  private replayBuffer(): void {
    this.buffer.replay((entry) => {
      return new Promise<boolean>((resolve) => {
        const replayHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(entry.headers || {}),
          'X-Claude-Mem-Replayed': 'true',
        };
        if (this.authToken && !replayHeaders['Authorization']) {
          replayHeaders['Authorization'] = `Bearer ${this.authToken}`;
        }

        httpRequest({
          host: this.serverHost,
          port: this.serverPort,
          path: entry.path,
          method: entry.method,
          headers: replayHeaders,
          body: JSON.stringify(entry.body),
        }).then((response) => {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        }).catch(() => {
          resolve(false);
        });
      });
    }).then((result) => {
      if (result.replayed > 0) {
        logger.info('PROXY', 'Buffer replay', { replayed: result.replayed, remaining: result.remaining });
      }
    });
  }

  getPendingCount(): number {
    return this.buffer.pendingCount();
  }

  isServerReachable(): boolean {
    return this.serverReachable;
  }
}
