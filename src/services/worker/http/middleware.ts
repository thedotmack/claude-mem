/**
 * HTTP Middleware for Worker Service
 *
 * Extracted from WorkerService.ts for better organization.
 * Handles request/response logging, CORS, JSON parsing, and static file serving.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { getPackageRoot } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

/** File extensions to skip in HTTP request logging. */
const STATIC_EXTENSIONS = new Set([
  '.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.eot',
]);

/** Returns true when the request path ends with a known static file extension. */
function isStaticAsset(path: string): boolean {
  const dotIndex = path.lastIndexOf('.');
  return dotIndex !== -1 && STATIC_EXTENSIONS.has(path.slice(dotIndex));
}

/**
 * Create all middleware for the worker service
 * @param summarizeRequestBody - Function to summarize request bodies for logging
 * @returns Array of middleware functions
 */
export function createMiddleware(
  summarizeRequestBody: (method: string, path: string, body: Record<string, unknown>) => string
): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  // JSON parsing with 50mb limit
  middlewares.push(express.json({ limit: '50mb' }));

  // CORS — restrict to localhost origins only
  middlewares.push(cors({ origin: ['http://localhost:37777', 'http://127.0.0.1:37777'] }));

  // HTTP request/response logging
  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    // Skip logging for static assets, health checks, and polling endpoints
    if (req.path.startsWith('/health') || req.path === '/' || req.path === '/api/logs' || isStaticAsset(req.path)) {
      next(); return;
    }

    const start = Date.now();
    const requestId = `${req.method}-${String(Date.now())}`;

    // Log incoming request with body summary
    const bodySummary = summarizeRequestBody(req.method, req.path, req.body as Record<string, unknown>);
    logger.info('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

    // Capture response
    const originalSend = res.send.bind(res);
    res.send = function(body: unknown) {
      const duration = Date.now() - start;
      logger.info('HTTP', `← ${String(res.statusCode)} ${req.path}`, { requestId, duration: `${String(duration)}ms` });
      return originalSend(body);
    };

    next();
  });

  // Serve static files for web UI (viewer-bundle.js, logos, fonts, etc.)
  const packageRoot = getPackageRoot();
  const uiDir = path.join(packageRoot, 'plugin', 'ui');
  middlewares.push(express.static(uiDir));

  return middlewares;
}

/**
 * Middleware to require localhost-only access
 * Used for admin endpoints that should not be exposed when binding to 0.0.0.0
 */
export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const clientIp = req.ip || req.socket.remoteAddress || '';
  const isLocalhost =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1' ||
    clientIp === 'localhost';

  if (!isLocalhost) {
    logger.warn('SECURITY', 'Admin endpoint access denied - not localhost', {
      endpoint: req.path,
      clientIp,
      method: req.method
    });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin endpoints are only accessible from localhost'
    });
    return;
  }

  next();
}

/**
 * Summarize request body for logging
 * Used to avoid logging sensitive data or large payloads
 */
export function summarizeRequestBody(method: string, path: string, body: Record<string, unknown>): string {
  if (Object.keys(body).length === 0) return '';

  // Session init
  if (path.includes('/init')) {
    return '';
  }

  // Observations
  if (path.includes('/observations')) {
    const toolName = typeof body.tool_name === 'string' ? body.tool_name : '?';
    const toolInput = body.tool_input;
    const toolSummary = logger.formatTool(toolName, toolInput);
    return `tool=${toolSummary}`;
  }

  // Summarize request
  if (path.includes('/summarize')) {
    return 'requesting summary';
  }

  return '';
}
