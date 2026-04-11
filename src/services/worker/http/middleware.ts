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
import { createAuthMiddleware } from './auth-middleware.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';

/**
 * Create all middleware for the worker service
 * @param summarizeRequestBody - Function to summarize request bodies for logging
 * @returns Array of middleware functions
 */
export function createMiddleware(
  summarizeRequestBody: (method: string, path: string, body: any) => string
): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  // JSON parsing with 50mb limit
  middlewares.push(express.json({ limit: '50mb' }));

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false
  }));

  // Serve static files for web UI BEFORE auth — viewer HTML/JS/CSS are public assets.
  // Only API endpoints and SSE stream require authentication.
  // Try both cache structure (ui/) and marketplace structure (plugin/ui/).
  const packageRoot = getPackageRoot();
  const uiDirCache = path.join(packageRoot, 'ui');
  const uiDirMarketplace = path.join(packageRoot, 'plugin', 'ui');
  const staticOptions = { index: 'viewer.html' };
  middlewares.push(express.static(uiDirCache, staticOptions));
  middlewares.push(express.static(uiDirMarketplace, staticOptions));

  // Extract provenance from proxy headers ONCE for all downstream handlers.
  // Avoids scattered header reads in individual route handlers.
  middlewares.push((req: Request, _res: Response, next: NextFunction) => {
    const originNode = req.headers['x-claude-mem-node'] as string || '';
    const originInstance = req.headers['x-claude-mem-instance'] as string || '';
    const originLlmSource = req.headers['x-claude-mem-llm-source'] as string || '';
    if (originNode || originInstance || originLlmSource) {
      (req as any)._provenance = { node: originNode, instance: originInstance, llmSource: originLlmSource };
    }
    next();
  });

  // Auth — require Bearer token on non-localhost requests in server mode
  const authToken = () => {
    const settings = SettingsDefaultsManager.loadFromFile(
      path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json')
    );
    return settings.CLAUDE_MEM_AUTH_TOKEN || '';
  };
  middlewares.push(createAuthMiddleware(authToken));

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

  return middlewares;
}

/**
 * Get origin provenance from request (set by provenance middleware).
 * Returns the originating client's node/instance/llmSource from proxy headers.
 * Falls back to empty strings if not a proxied request.
 */
export function getRequestProvenance(req: Request): { node: string; instance: string; llmSource: string } {
  return (req as any)._provenance || { node: '', instance: '', llmSource: '' };
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
