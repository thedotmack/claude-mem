/**
 * Server - Express app setup and route registration
 *
 * Extracted from worker-service.ts monolith to provide centralized HTTP server management.
 * Handles:
 * - Express app creation and configuration
 * - Middleware registration
 * - Route registration (delegates to route handlers)
 * - Core system endpoints (health, readiness, version, admin)
 */

import express, { Request, Response, Application } from 'express';
import http from 'http';
import * as fs from 'fs';
import path from 'path';
import { ALLOWED_OPERATIONS, ALLOWED_TOPICS } from './allowed-constants.js';
import { logger } from '../../utils/logger.js';
import { createMiddleware, summarizeRequestBody, requireLocalhost } from './Middleware.js';
import { errorHandler, notFoundHandler } from './ErrorHandler.js';
import { getSupervisor } from '../../supervisor/index.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { ENV_PREFIXES, ENV_EXACT_MATCHES } from '../../supervisor/env-sanitizer.js';

/**
 * Plan 06 Phase 6 — instruction content (SKILL.md + ALLOWED_OPERATIONS .md
 * files) is read once at module init and held in memory for the lifetime of
 * the worker process. Process restart is the cache-invalidation event.
 *
 * `SKILL.md` is held as the full UTF-8 string so `extractInstructionSection`
 * can slice topic windows on every request without re-reading the file.
 * Per-operation files are cached as a `Map<operation, content>`. Files that
 * are missing on disk simply omit from the map; the request handler returns
 * 404 in that case (preserving legacy behaviour).
 */
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
      // Missing operation files are non-fatal — 404 is returned per request.
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

// Build-time injected version constant (set by esbuild define)
declare const __DEFAULT_PACKAGE_VERSION__: string;
const BUILT_IN_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development';

/**
 * Interface for route handlers that can be registered with the server
 */
export interface RouteHandler {
  setupRoutes(app: Application): void;
}

/**
 * AI provider status for health endpoint
 */
export interface AiStatus {
  provider: string;
  authMethod: string;
  lastInteraction: {
    timestamp: number;
    success: boolean;
    error?: string;
  } | null;
}

/**
 * Options for initializing the server
 */
export interface ServerOptions {
  /** Whether initialization is complete (for readiness check) */
  getInitializationComplete: () => boolean;
  /** Whether MCP is ready (for health/readiness info) */
  getMcpReady: () => boolean;
  /** Shutdown function for admin endpoints */
  onShutdown: () => Promise<void>;
  /** Restart function for admin endpoints */
  onRestart: () => Promise<void>;
  /** Filesystem path to the worker entry point */
  workerPath: string;
  /** Callback to get current AI provider status */
  getAiStatus: () => AiStatus;
}

/**
 * Express application and HTTP server wrapper
 * Provides centralized setup for middleware and routes
 */
export class Server {
  readonly app: Application;
  private server: http.Server | null = null;
  private readonly options: ServerOptions;
  private readonly startTime: number = Date.now();

  constructor(options: ServerOptions) {
    this.options = options;
    this.app = express();
    this.setupMiddleware();
    this.setupCoreRoutes();
  }

  /**
   * Get the underlying HTTP server
   */
  getHttpServer(): http.Server | null {
    return this.server;
  }

  /**
   * Start listening on the specified host and port
   */
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

  /**
   * Close the HTTP server
   */
  async close(): Promise<void> {
    if (!this.server) return;

    // Close all active connections
    this.server.closeAllConnections();

    // Give Windows time to close connections before closing server
    if (process.platform === 'win32') {
      await new Promise(r => setTimeout(r, 500));
    }

    // Close the server
    await new Promise<void>((resolve, reject) => {
      this.server!.close(err => err ? reject(err) : resolve());
    });

    // Extra delay on Windows to ensure port is fully released
    if (process.platform === 'win32') {
      await new Promise(r => setTimeout(r, 500));
    }

    this.server = null;
    logger.info('SYSTEM', 'HTTP server closed');
  }

  /**
   * Register a route handler
   */
  registerRoutes(handler: RouteHandler): void {
    handler.setupRoutes(this.app);
  }

  /**
   * Finalize route setup by adding error handlers
   * Call this after all routes have been registered
   */
  finalizeRoutes(): void {
    // 404 handler for unmatched routes
    this.app.use(notFoundHandler);

    // Global error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    const middlewares = createMiddleware(summarizeRequestBody);
    middlewares.forEach(mw => this.app.use(mw));
  }

  /**
   * Setup core system routes (health, readiness, version, admin)
   */
  private setupCoreRoutes(): void {
    // Health check endpoint - always responds, even during initialization
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        version: BUILT_IN_VERSION,
        workerPath: this.options.workerPath,
        uptime: Date.now() - this.startTime,
        managed: process.env.CLAUDE_MEM_MANAGED === 'true',
        hasIpc: typeof process.send === 'function',
        platform: process.platform,
        pid: process.pid,
        initialized: this.options.getInitializationComplete(),
        mcpReady: this.options.getMcpReady(),
        ai: this.options.getAiStatus(),
      });
    });

    // Readiness check endpoint - returns 503 until full initialization completes
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

    // Version endpoint - returns the worker's built-in version
    this.app.get('/api/version', (_req: Request, res: Response) => {
      res.status(200).json({ version: BUILT_IN_VERSION });
    });

    // Instructions endpoint — Plan 06 Phase 6 — serves the cached SKILL.md /
    // operations content loaded once at module init.
    this.app.get('/api/instructions', (req: Request, res: Response) => {
      const topic = (req.query.topic as string) || 'all';
      const operation = req.query.operation as string | undefined;

      // Validate topic
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

    // Admin endpoints for process management (localhost-only)
    this.app.post('/api/admin/restart', requireLocalhost, async (_req: Request, res: Response) => {
      res.json({ status: 'restarting' });

      // Handle Windows managed mode via IPC
      const isWindowsManaged = process.platform === 'win32' &&
        process.env.CLAUDE_MEM_MANAGED === 'true' &&
        process.send;

      if (isWindowsManaged) {
        logger.info('SYSTEM', 'Sending restart request to wrapper');
        process.send!({ type: 'restart' });
      } else {
        // Unix or standalone Windows - handle restart ourselves
        // The spawner (ensureWorkerStarted/restart command) handles spawning the new daemon.
        // This process just needs to shut down and exit.
        setTimeout(async () => {
          try {
            await this.options.onRestart();
          } finally {
            process.exit(0);
          }
        }, 100);
      }
    });

    this.app.post('/api/admin/shutdown', requireLocalhost, async (_req: Request, res: Response) => {
      res.json({ status: 'shutting_down' });

      // Handle Windows managed mode via IPC
      const isWindowsManaged = process.platform === 'win32' &&
        process.env.CLAUDE_MEM_MANAGED === 'true' &&
        process.send;

      if (isWindowsManaged) {
        logger.info('SYSTEM', 'Sending shutdown request to wrapper');
        process.send!({ type: 'shutdown' });
      } else {
        // Unix or standalone Windows - handle shutdown ourselves
        setTimeout(async () => {
          try {
            await this.options.onShutdown();
          } finally {
            // CRITICAL: Exit the process after shutdown completes (or fails).
            // Without this, the daemon stays alive as a zombie — background tasks
            // (backfill, reconnects) keep running and respawn chroma-mcp subprocesses.
            process.exit(0);
          }
        }, 100);
      }
    });

    // Doctor endpoint - diagnostic view of supervisor, processes, and health
    this.app.get('/api/admin/doctor', requireLocalhost, (_req: Request, res: Response) => {
      const supervisor = getSupervisor();
      const registry = supervisor.getRegistry();
      const allRecords = registry.getAll();

      // Check each process liveness
      const processes = allRecords.map(record => ({
        id: record.id,
        pid: record.pid,
        type: record.type,
        status: isPidAlive(record.pid) ? 'alive' as const : 'dead' as const,
        startedAt: record.startedAt,
      }));

      // Check for dead processes still in registry
      const deadProcessPids = processes.filter(p => p.status === 'dead').map(p => p.pid);

      // Check if CLAUDECODE_* env vars are leaking into this process
      const envClean = !Object.keys(process.env).some(key =>
        ENV_EXACT_MATCHES.has(key) || ENV_PREFIXES.some(prefix => key.startsWith(prefix))
      );

      // Format uptime
      const uptimeMs = Date.now() - this.startTime;
      const uptimeSeconds = Math.floor(uptimeMs / 1000);
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

  /**
   * Extract a specific section from instruction content
   */
  private extractInstructionSection(content: string, topic: string): string {
    const sections: Record<string, string> = {
      'workflow': this.extractBetween(content, '## The Workflow', '## Search Parameters'),
      'search_params': this.extractBetween(content, '## Search Parameters', '## Examples'),
      'examples': this.extractBetween(content, '## Examples', '## Why This Workflow'),
      'all': content
    };

    return sections[topic] || sections['all'];
  }

  /**
   * Extract text between two markers
   */
  private extractBetween(content: string, startMarker: string, endMarker: string): string {
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);

    if (startIdx === -1) return content;
    if (endIdx === -1) return content.substring(startIdx);

    return content.substring(startIdx, endIdx).trim();
  }
}
