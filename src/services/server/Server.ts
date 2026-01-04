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
import { logger } from '../../utils/logger.js';
import { createMiddleware, summarizeRequestBody, requireLocalhost } from './Middleware.js';
import { errorHandler, notFoundHandler } from './ErrorHandler.js';

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
      this.server = this.app.listen(port, host, () => {
        logger.info('SYSTEM', 'HTTP server started', { host, port, pid: process.pid });
        resolve();
      });
      this.server.on('error', reject);
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
    // Test build ID for debugging which build is running
    const TEST_BUILD_ID = 'TEST-008-wrapper-ipc';

    // Health check endpoint - always responds, even during initialization
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.status(200).json({
        status: 'ok',
        build: TEST_BUILD_ID,
        managed: process.env.CLAUDE_MEM_MANAGED === 'true',
        hasIpc: typeof process.send === 'function',
        platform: process.platform,
        pid: process.pid,
        initialized: this.options.getInitializationComplete(),
        mcpReady: this.options.getMcpReady(),
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

    // Instructions endpoint - loads SKILL.md sections on-demand
    this.app.get('/api/instructions', async (req: Request, res: Response) => {
      const topic = (req.query.topic as string) || 'all';
      const operation = req.query.operation as string | undefined;

      try {
        let content: string;

        if (operation) {
          const operationPath = path.join(__dirname, '../skills/mem-search/operations', `${operation}.md`);
          content = await fs.promises.readFile(operationPath, 'utf-8');
        } else {
          const skillPath = path.join(__dirname, '../skills/mem-search/SKILL.md');
          const fullContent = await fs.promises.readFile(skillPath, 'utf-8');
          content = this.extractInstructionSection(fullContent, topic);
        }

        res.json({
          content: [{ type: 'text', text: content }]
        });
      } catch (error) {
        res.status(404).json({ error: 'Instruction not found' });
      }
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
        setTimeout(async () => {
          await this.options.onRestart();
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
          await this.options.onShutdown();
        }, 100);
      }
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
