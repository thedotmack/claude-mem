
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import { getPackageRoot } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

export function createMiddleware(): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  middlewares.push(express.json({ limit: '5mb' }));

  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    const staticExtensions = ['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.eot'];
    const isStaticAsset = staticExtensions.some(ext => req.path.endsWith(ext));
    const isPollingEndpoint = req.path === '/api/logs'; 
    if (req.path.startsWith('/health') || req.path === '/' || isStaticAsset || isPollingEndpoint) {
      return next();
    }

    const start = Date.now();
    const requestId = `${req.method}-${Date.now()}`;

    const bodySummary = summarizeRequestBody(req.method, req.path, req.body);
    logger.debug('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

    const originalSend = res.send.bind(res);
    res.send = function(body: any) {
      const duration = Date.now() - start;
      logger.debug('HTTP', `← ${res.statusCode} ${req.path}`, { requestId, duration: `${duration}ms` });
      return originalSend(body);
    };

    next();
  });

  const packageRoot = getPackageRoot();
  const uiDir = path.join(packageRoot, 'plugin', 'ui');
  middlewares.push(express.static(uiDir));

  return middlewares;
}

export interface CorsOptions {
  // Exact-match full origins (e.g. https://app.example.com) allowed in
  // addition to the always-allowed localhost family. Empty = localhost only.
  allowedOrigins?: string[];
}

// Parses the CLAUDE_MEM_WORKER_ALLOWED_ORIGINS setting: comma-separated full
// origins. Trailing slashes are stripped so `https://a.com/` matches the
// browser-sent `Origin: https://a.com`.
export function parseAllowedOriginsSetting(value: string): string[] {
  return value
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

export function isLocalhostOrigin(origin: string): boolean {
  return origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
}

export function createCorsMiddleware(options: CorsOptions = {}): RequestHandler {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      if (!isLocalhostOrigin(origin) && !allowedOrigins.has(origin.toLowerCase())) {
        res.status(403).json({
          error: 'origin_not_allowed',
          message: 'Origin is not in CLAUDE_MEM_WORKER_ALLOWED_ORIGINS',
        });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Api-Key,X-Requested-With');
      // Chrome Private Network Access: an allowlisted public (https) origin
      // reaching a local server must get this header on preflight or the
      // browser blocks the request even with permissive CORS.
      if (origin && req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
      res.status(204).end();
      return;
    }
    next();
  };
}

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

export function summarizeRequestBody(method: string, path: string, body: any): string {
  if (!body || Object.keys(body).length === 0) return '';

  if (path.includes('/init')) {
    return '';
  }

  if (path.includes('/observations')) {
    const toolName = body.tool_name || '?';
    const toolInput = body.tool_input;
    const toolSummary = logger.formatTool(toolName, toolInput);
    return `tool=${toolSummary}`;
  }

  if (path.includes('/summarize')) {
    return 'requesting summary';
  }

  return '';
}
