
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import { getPackageRoot } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { readPidFile } from '../../infrastructure/ProcessManager.js';

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

export function createCorsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      if (!origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:')) {
        next(new Error('CORS not allowed'));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
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

/**
 * Capability check for destructive session endpoints (#3073 review).
 *
 * `requireLocalhost` is not sufficient on its own for a route that aborts live
 * work: every process on the machine is "localhost", so any local caller that
 * learns or guesses a session id could tear down another session's in-flight
 * generator and queued observations.
 *
 * The proof required here is knowledge of the running worker's own start token,
 * which lives in `worker.pid` inside the user's data directory. That makes the
 * capability exactly "can read this user's claude-mem data dir" — which is the
 * real trust boundary, and which every legitimate caller (the hooks) already
 * sits inside. Nothing new is stored and no secret is minted; the token is
 * already written and already used as the worker's identity proof.
 *
 * Comparison is length-safe and constant-time to avoid leaking the token
 * through response timing.
 */
export function requireWorkerToken(req: Request, res: Response, next: NextFunction): void {
  const presented = req.get('X-Claude-Mem-Worker-Token') ?? '';
  const expected = readPidFile()?.startToken ?? '';

  if (!expected) {
    // No token on disk means we cannot verify anything. Refuse rather than
    // fall open — the caller degrades to "session not explicitly ended",
    // which is exactly the pre-existing behaviour and harms nothing.
    logger.warn('SECURITY', 'Destructive session endpoint denied — worker has no start token to verify against', {
      endpoint: req.path
    });
    res.status(403).json({ error: 'Forbidden', message: 'Worker token unavailable' });
    return;
  }

  const presentedBuffer = Buffer.from(presented, 'utf-8');
  const expectedBuffer = Buffer.from(expected, 'utf-8');
  const matches =
    presentedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(presentedBuffer, expectedBuffer);

  if (!matches) {
    logger.warn('SECURITY', 'Destructive session endpoint denied — missing or invalid worker token', {
      endpoint: req.path,
      method: req.method
    });
    res.status(403).json({ error: 'Forbidden', message: 'Valid worker token required' });
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
