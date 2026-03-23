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
  /** Health check interval in ms. Default: 10_000 */
  healthCheckIntervalMs?: number;
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

    // Parse JSON bodies
    this.app.use(express.json({ limit: '50mb' }));

    // Catch-all: forward everything
    this.app.all('*', this.handleRequest.bind(this));
  }

  async start(localPort: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = this.app.listen(localPort, '127.0.0.1', () => {
        logger.info('PROXY', 'Proxy started', { localPort, target: `${this.serverHost}:${this.serverPort}` });
        resolve();
      });
      this.server.on('error', reject);
    });

    // Start background health check (after listen resolves)
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

  private async handleRequest(req: express.Request, res: express.Response): Promise<void> {
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const targetUrl = `http://${this.serverHost}:${this.serverPort}${req.path}${queryString}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Claude-Mem-Node': getNodeName(),
      'X-Claude-Mem-Instance': getInstanceName(),
      'X-Claude-Mem-Mode': 'proxy',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const fetchOptions: RequestInit = {
        method: req.method,
        headers,
      };
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
        fetchOptions.body = JSON.stringify(req.body);
      }

      const response = await fetch(targetUrl, fetchOptions);
      this.serverReachable = true;

      // Forward status
      res.status(response.status);
      // Forward important headers
      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('content-type', contentType);
      const cacheControl = response.headers.get('cache-control');
      if (cacheControl) res.setHeader('cache-control', cacheControl);
      // Forward body
      const body = await response.text();
      res.send(body);
    } catch (error) {
      this.serverReachable = false;

      // POST/PUT/PATCH requests -> buffer
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
        // GET requests -> 503
        res.status(503).json({ error: 'server_unreachable', serverHost: this.serverHost });
      }
    }
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      try {
        const headers: Record<string, string> = {};
        if (this.authToken) {
          headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        const resp = await fetch(
          `http://${this.serverHost}:${this.serverPort}/api/health`,
          { headers }
        );
        const wasUnreachable = !this.serverReachable;
        this.serverReachable = resp.ok;

        if (wasUnreachable && this.serverReachable) {
          logger.info('PROXY', 'Server is back online, starting buffer replay');
          this.replayBuffer();
        }
      } catch {
        this.serverReachable = false;
      }
    }, this.healthCheckIntervalMs);
  }

  private async replayBuffer(): Promise<void> {
    const result = await this.buffer.replay(async (entry) => {
      try {
        const replayHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(entry.headers || {}),
          'X-Claude-Mem-Replayed': 'true',
        };
        if (this.authToken && !replayHeaders['Authorization']) {
          replayHeaders['Authorization'] = `Bearer ${this.authToken}`;
        }
        const resp = await fetch(`http://${this.serverHost}:${this.serverPort}${entry.path}`, {
          method: entry.method,
          headers: replayHeaders,
          body: JSON.stringify(entry.body),
        });
        return resp.ok; // Only 2xx is success. 4xx and 5xx both stop replay.
      } catch {
        return false;
      }
    });

    if (result.replayed > 0) {
      logger.info('PROXY', 'Buffer replay', { replayed: result.replayed, remaining: result.remaining });
    }
  }

  getPendingCount(): number {
    return this.buffer.pendingCount();
  }

  isServerReachable(): boolean {
    return this.serverReachable;
  }
}
