
import express, { Request, Response, Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import http from 'http';
import * as fs from 'fs';
import path from 'path';
import { ALLOWED_OPERATIONS, ALLOWED_TOPICS } from './allowed-constants.js';
import { logger } from '../../utils/logger.js';
import { createCorsMiddleware, createMiddleware, summarizeRequestBody, requireLocalhost } from './Middleware.js';
import { errorHandler, notFoundHandler } from './ErrorHandler.js';
import { getSupervisor } from '../../supervisor/index.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { ENV_PREFIXES, ENV_EXACT_MATCHES } from '../../supervisor/env-sanitizer.js';
import { flushResponseThen } from './flushResponseThen.js';
import { getUptimeSeconds } from '../../shared/uptime.js';
import { globalRateLimitStore } from '../worker/RateLimitStore.js';
import type { ObservationQueueHealth } from '../../server/queue/ObservationQueueEngine.js';

const INSTRUCTIONS_BASE_DIR: string = path.resolve(__dirname, '../skills/mem-search');
const INSTRUCTIONS_OPERATIONS_DIR: string = path.join(INSTRUCTIONS_BASE_DIR, 'operations');
const INSTRUCTIONS_SKILL_PATH: string = path.join(INSTRUCTIONS_BASE_DIR, 'SKILL.md');

const cachedSkillMd: string | null = (() => {
  try {
    const text = fs.readFileSync(INSTRUCTIONS_SKILL_PATH, 'utf-8');
    logger.info('SYSTEM', 'Cached SKILL.md at boot', {
      path: INSTRUCTIONS_SKILL_PATH,
      bytes: Buffer.byteLength(text, 'utf-8'),
    });
    return text;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'SKILL.md not present at boot, /api/instructions will 404 for topic queries', {
      path: INSTRUCTIONS_SKILL_PATH,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
})();

const cachedOperationContent: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const operation of ALLOWED_OPERATIONS) {
    const operationPath = path.join(INSTRUCTIONS_OPERATIONS_DIR, `${operation}.md`);
    try {
      map.set(operation, fs.readFileSync(operationPath, 'utf-8'));
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Operation instruction file not present at boot', {
        path: operationPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (map.size > 0) {
    logger.info('SYSTEM', 'Cached operation instruction files at boot', {
      count: map.size,
      operations: Array.from(map.keys()),
    });
  }
  return map;
})();

declare const __DEFAULT_PACKAGE_VERSION__: string;
const BUILT_IN_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development';

export interface RouteHandler {
  setupRoutes(app: Application): void;
}

export interface AiStatus {
  provider: string;
  authMethod: string;
  lastInteraction: {
    timestamp: number;
    success: boolean;
    error?: string;
  } | null;
}

export interface ServerOptions {
  getInitializationComplete: () => boolean;
  getMcpReady: () => boolean;
  onShutdown: () => Promise<void>;
  onRestart: () => Promise<void>;
  workerPath: string;
  runtime?: string;
  getAiStatus: () => AiStatus;
  preBodyParserRoutes?: RouteHandler[];
  getQueueHealth?: () => ObservationQueueHealth | null | Promise<ObservationQueueHealth | null>;
}

export class Server {
  readonly app: Application;
  private server: http.Server | null = null;
  private readonly options: ServerOptions;
  private readonly startTime: number = Date.now();

  constructor(options: ServerOptions) {
    this.options = options;
    this.app = express();
    this.setupSecurityHeaders();
    this.setupCors();
    this.setupPreBodyParserRoutes();
    this.setupMiddleware();
    this.setupGlobalRateLimit();
    this.setupCoreRoutes();
  }

  /**
   * Returns true when this Server instance is running inside the server-beta
   * runtime (Postgres + Valkey, internet-exposable). Worker mode runs the same
   * Server class on a localhost-only port for the viewer UI and is intentionally
   * exempted from the strict security middleware below — the viewer needs
   * inline scripts/styles and CORS from arbitrary localhost ports.
   */
  private isServerBetaRuntime(): boolean {
    return (
      this.options.runtime === 'server-beta' ||
      process.env.CLAUDE_MEM_RUNTIME === 'server-beta'
    );
  }

  getHttpServer(): http.Server | null {
    return this.server;
  }

  async listen(port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = http.createServer(this.app);
      this.server = server;
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        logger.info('SYSTEM', 'HTTP server started', { host, port, pid: process.pid });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;

    this.server.closeAllConnections();

    if (process.platform === 'win32') {
      await new Promise(r => setTimeout(r, 500));
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close(err => err ? reject(err) : resolve());
    });

    if (process.platform === 'win32') {
      await new Promise(r => setTimeout(r, 500));
    }

    this.server = null;
    logger.info('SYSTEM', 'HTTP server closed');
  }

  registerRoutes(handler: RouteHandler): void {
    handler.setupRoutes(this.app);
  }

  finalizeRoutes(): void {
    this.app.use(notFoundHandler);

    this.app.use(errorHandler);
  }

  private setupMiddleware(): void {
    // fix — cap JSON body size on server-beta to defeat trivial
    // disk-exhaustion via large POST bodies. Worker keeps the legacy 5mb
    // limit so existing viewer flows keep working.
    const bodyLimit = this.isServerBetaRuntime()
      ? (process.env.CLAUDE_MEM_BODY_LIMIT ?? '1mb')
      : '5mb';
    // Body parser registered explicitly here so the limit is visible at
    // a single, audit-friendly call site (cf. contract test for ).
    this.app.use(express.json({ limit: bodyLimit }));
    const middlewares = createMiddleware(summarizeRequestBody, {
      includeCors: false,
      skipJson: true,
    });
    middlewares.forEach(mw => this.app.use(mw));
  }

  /**
   *  fix — helmet security headers on the server-beta /v1/* surface.
   * Adds X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security,
   * Content-Security-Policy, and friends. No-op on worker mode (the local
   * viewer at 127.0.0.1 ships inline scripts and would break under default CSP).
   */
  private setupSecurityHeaders(): void {
    if (!this.isServerBetaRuntime()) return;
    this.app.use(helmet());
    logger.info('SECURITY', 'helmet middleware enabled for server-beta runtime');
  }

  /**
   *  defence-in-depth — a coarse global IP-based rate limit on
   * server-beta /v1/* paths. The per-route limiters in
   * ServerV1PostgresRoutes (10/min auth, 30/min write, 100/min read) remain
   * the source of truth for fine-grained policy. This global cap exists so
   * that paths NOT mounted by ServerV1PostgresRoutes (mistakes, future
   * additions) still inherit a reasonable floor. Configurable via
   * CLAUDE_MEM_GLOBAL_RATE_LIMIT_PER_MIN (default 300).
   */
  private setupGlobalRateLimit(): void {
    if (!this.isServerBetaRuntime()) return;
    const maxPerMin =
      Number.parseInt(process.env.CLAUDE_MEM_GLOBAL_RATE_LIMIT_PER_MIN ?? '', 10) || 300;
    const limiter = rateLimit({
      windowMs: 60_000,
      max: maxPerMin,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: 'TooManyRequests',
        message: 'Global rate limit exceeded; retry after window expires.',
      },
    });
    this.app.use('/v1', limiter);
    logger.info('SECURITY', 'global /v1 rate limit enabled for server-beta runtime', {
      maxPerMin,
    });
  }

  private setupCors(): void {
    if (this.isServerBetaRuntime()) {
      // fix — server-beta defaults to CORS denied. Operators opt in
      // by listing comma-separated origins in CLAUDE_MEM_ALLOWED_ORIGINS.
      const originsRaw = process.env.CLAUDE_MEM_ALLOWED_ORIGINS;
      const allowedOrigins = originsRaw
        ? originsRaw.split(',').map(o => o.trim()).filter(Boolean)
        : false;
      this.app.use(
        cors({
          origin: allowedOrigins,
          methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
          allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
          credentials: false,
        })
      );
      logger.info('SECURITY', 'server-beta CORS configured', {
        allowedOrigins:
          allowedOrigins === false ? '(none — CORS denied)' : allowedOrigins,
      });
      return;
    }
    this.app.use(createCorsMiddleware());
  }

  private setupPreBodyParserRoutes(): void {
    this.options.preBodyParserRoutes?.forEach(handler => handler.setupRoutes(this.app));
  }

  private setupCoreRoutes(): void {
    this.app.get('/api/health', async (_req: Request, res: Response) => {
      const queueHealth = this.options.getQueueHealth
        ? await this.options.getQueueHealth()
        : null;
      const queueDegraded = queueHealth?.engine === 'bullmq' && queueHealth.redis.status === 'error';
      res.status(queueDegraded ? 503 : 200).json({
        status: queueDegraded ? 'degraded' : 'ok',
        ...(this.options.runtime ? { runtime: this.options.runtime } : {}),
        version: BUILT_IN_VERSION,
        workerPath: this.options.workerPath,
        uptime: getUptimeSeconds(this.startTime),
        managed: process.env.CLAUDE_MEM_MANAGED === 'true',
        hasIpc: typeof process.send === 'function',
        platform: process.platform,
        pid: process.pid,
        initialized: this.options.getInitializationComplete(),
        mcpReady: this.options.getMcpReady(),
        ai: this.options.getAiStatus(),
        rateLimits: globalRateLimitStore.getMostRecentByWindow(),
        ...(queueHealth ? { queue: queueHealth } : {}),
      });
    });

    this.app.get('/api/readiness', (_req: Request, res: Response) => {
      if (this.options.getInitializationComplete()) {
        res.status(200).json({
          status: 'ready',
          mcpReady: this.options.getMcpReady(),
        });
      } else {
        res.status(503).json({
          status: 'initializing',
          message: 'Worker is still initializing, please retry',
        });
      }
    });

    this.app.get('/api/version', (_req: Request, res: Response) => {
      res.status(200).json({ version: BUILT_IN_VERSION });
    });

    this.app.get('/api/instructions', (req: Request, res: Response) => {
      const topic = (req.query.topic as string) || 'all';
      const operation = req.query.operation as string | undefined;

      if (topic && !ALLOWED_TOPICS.includes(topic)) {
        return res.status(400).json({ error: 'Invalid topic' });
      }

      if (operation && !ALLOWED_OPERATIONS.includes(operation)) {
        return res.status(400).json({ error: 'Invalid operation' });
      }

      if (operation) {
        const cached = cachedOperationContent.get(operation);
        if (cached === undefined) {
          logger.debug('HTTP', 'Instruction file not cached at boot', { operation });
          return res.status(404).json({ error: 'Instruction not found' });
        }
        return res.json({ content: [{ type: 'text', text: cached }] });
      }

      if (cachedSkillMd === null) {
        logger.debug('HTTP', 'SKILL.md not cached at boot', { topic });
        return res.status(404).json({ error: 'Instruction not found' });
      }
      const sectionText = this.extractInstructionSection(cachedSkillMd, topic);
      res.json({ content: [{ type: 'text', text: sectionText }] });
    });

    this.app.post('/api/admin/restart', requireLocalhost, async (_req: Request, res: Response) => {
      const isWindowsManaged = process.platform === 'win32' &&
        process.env.CLAUDE_MEM_MANAGED === 'true' &&
        process.send;

      if (isWindowsManaged) {
        res.json({ status: 'restarting' });
        logger.info('SYSTEM', 'Sending restart request to wrapper');
        process.send!({ type: 'restart' });
      } else {
        flushResponseThen(res, { status: 'restarting' }, () => this.options.onRestart());
      }
    });

    this.app.post('/api/admin/shutdown', requireLocalhost, async (_req: Request, res: Response) => {
      const isWindowsManaged = process.platform === 'win32' &&
        process.env.CLAUDE_MEM_MANAGED === 'true' &&
        process.send;

      if (isWindowsManaged) {
        res.json({ status: 'shutting_down' });
        logger.info('SYSTEM', 'Sending shutdown request to wrapper');
        process.send!({ type: 'shutdown' });
      } else {
        flushResponseThen(res, { status: 'shutting_down' }, () => this.options.onShutdown());
      }
    });

    this.app.get('/api/admin/doctor', requireLocalhost, (_req: Request, res: Response) => {
      const supervisor = getSupervisor();
      const registry = supervisor.getRegistry();
      const allRecords = registry.getAll();

      const processes = allRecords.map(record => ({
        id: record.id,
        pid: record.pid,
        type: record.type,
        status: isPidAlive(record.pid) ? 'alive' as const : 'dead' as const,
        startedAt: record.startedAt,
      }));

      const deadProcessPids = processes.filter(p => p.status === 'dead').map(p => p.pid);

      const envClean = !Object.keys(process.env).some(key =>
        ENV_EXACT_MATCHES.has(key) || ENV_PREFIXES.some(prefix => key.startsWith(prefix))
      );

      const uptimeSeconds = getUptimeSeconds(this.startTime);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const formattedUptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      res.json({
        supervisor: {
          running: true,
          pid: process.pid,
          uptime: formattedUptime,
        },
        processes,
        health: {
          deadProcessPids,
          envClean,
        },
      });
    });
  }

  private extractInstructionSection(content: string, topic: string): string {
    const sections: Record<string, string> = {
      'workflow': this.extractBetween(content, '## The Workflow', '## Search Parameters'),
      'search_params': this.extractBetween(content, '## Search Parameters', '## Examples'),
      'examples': this.extractBetween(content, '## Examples', '## Why This Workflow'),
      'all': content
    };

    return sections[topic] || sections['all'];
  }

  private extractBetween(content: string, startMarker: string, endMarker: string): string {
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);

    if (startIdx === -1) return content;
    if (endIdx === -1) return content.substring(startIdx);

    return content.substring(startIdx, endIdx).trim();
  }
}
