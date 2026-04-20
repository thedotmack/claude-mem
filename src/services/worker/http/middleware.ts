/**
 * HTTP Middleware for Worker Service
 *
 * Extracted from WorkerService.ts for better organization.
 * Handles request/response logging, CORS, JSON parsing, and static file serving.
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import path from 'path';
import { getPackageRoot } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

/**
 * Create all middleware for the worker service
 * @param summarizeRequestBody - Function to summarize request bodies for logging
 * @returns Array of middleware functions
 */
export function createMiddleware(
  summarizeRequestBody: (method: string, path: string, body: any) => string
): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  // JSON parsing with 5mb limit (#1935)
  middlewares.push(express.json({ limit: '5mb' }));

  // CORS - restrict to localhost origins only
  middlewares.push(cors({
    origin: (origin, callback) => {
      // Allow: requests without Origin header (hooks, curl, CLI tools)
      // Allow: localhost and 127.0.0.1 origins
      if (!origin ||
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:')) {
        callback(null, true);
      } else {
        callback(new Error('CORS not allowed'));
      }
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
    credentials: false
  }));

  // Simple in-memory rate limiter (#1935).
  // Worker binds localhost-only, so in practice this is a global 300 req/min
  // cap — every caller shares the 127.0.0.1/::1 bucket.
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX_REQUESTS = 300;

  const rateLimiter: RequestHandler = (req, res, next) => {
    // Normalise IPv4-mapped IPv6 so 127.0.0.1 and ::ffff:127.0.0.1 share a bucket.
    const clientIp = (req.socket.remoteAddress ?? req.ip ?? 'unknown').replace(/^::ffff:/, '');
    const now = Date.now();
    let entry = requestCounts.get(clientIp);

    if (!entry || now >= entry.resetAt) {
      // Safety valve in case the worker is ever bound non-localhost.
      if (requestCounts.size > 1000) {
        for (const [ip, e] of requestCounts) {
          if (now >= e.resetAt) requestCounts.delete(ip);
        }
      }
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      requestCounts.set(clientIp, entry);
    }

    if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }
    entry.count++;

    next();
  };

  middlewares.push(rateLimiter);

  // HTTP request/response logging
  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    // Skip logging for static assets, health checks, and polling endpoints
    const staticExtensions = ['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.eot'];
    const isStaticAsset = staticExtensions.some(ext => req.path.endsWith(ext));
    const isPollingEndpoint = req.path === '/api/logs'; // Skip logs endpoint to avoid noise from auto-refresh
    if (req.path.startsWith('/health') || req.path === '/' || isStaticAsset || isPollingEndpoint) {
      return next();
    }

    const start = Date.now();
    const requestId = `${req.method}-${Date.now()}`;

    // Log incoming request with body summary
    const bodySummary = summarizeRequestBody(req.method, req.path, req.body);
    logger.debug('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

    // Capture response
    const originalSend = res.send.bind(res);
    res.send = function(body: any) {
      const duration = Date.now() - start;
      logger.debug('HTTP', `← ${res.statusCode} ${req.path}`, { requestId, duration: `${duration}ms` });
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
  const clientIp = req.ip || req.connection.remoteAddress || '';
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
export function summarizeRequestBody(method: string, path: string, body: any): string {
  if (!body || Object.keys(body).length === 0) return '';

  // Session init
  if (path.includes('/init')) {
    return '';
  }

  // Observations
  if (path.includes('/observations')) {
    const toolName = body.tool_name || '?';
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
