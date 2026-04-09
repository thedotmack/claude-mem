/**
 * Bearer Token Auth Middleware
 *
 * Separated from middleware.ts so it can be imported and tested
 * without requiring the express package to be installed.
 *
 * Uses only Node.js built-ins (crypto) and logger — no express runtime dependency.
 */

import { timingSafeEqual } from 'crypto';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { logger } from '../../../utils/logger.js';

export interface AuthMiddlewareOptions {
  /** Called whenever a remote request is rejected (no token, missing header, or invalid token). */
  onAuthRejected?: (ip: string, path: string) => void;
}

/**
 * Middleware to authenticate non-localhost requests via Bearer token.
 * Active in ALL modes. Localhost requests always bypass auth.
 *
 * Security: Uses crypto.timingSafeEqual to prevent timing attacks.
 */
export function createAuthMiddleware(
  getAuthToken: () => string,
  options: AuthMiddlewareOptions = {},
): RequestHandler {
  const { onAuthRejected } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1'
      || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';

    // Localhost bypass — but NOT for cross-origin browser requests.
    // A malicious website on the server machine could otherwise exfiltrate
    // the auth token via XHR to localhost (CORS allows any origin in server mode).
    if (isLocal) {
      const origin = req.headers.origin;
      const isLocalOrigin = !origin
        || origin.startsWith('http://localhost:')
        || origin.startsWith('http://127.0.0.1:')
        || origin.startsWith('http://[::1]:')
        || origin.startsWith('https://localhost:')
        || origin.startsWith('https://127.0.0.1:')
        || origin.startsWith('https://[::1]:');
      if (isLocalOrigin) return next();
      // Non-localhost Origin on a localhost IP = cross-origin browser request → require auth
    }

    const expectedToken = getAuthToken();
    if (!expectedToken) {
      logger.warn('SECURITY', 'Remote request rejected — no auth token configured', { ip: clientIp, path: req.path });
      onAuthRejected?.(clientIp, req.path);
      res.status(403).json({ error: 'forbidden', message: 'Remote access requires CLAUDE_MEM_AUTH_TOKEN' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      logger.warn('SECURITY', 'Unauthorized — missing or malformed token', { ip: clientIp, path: req.path });
      onAuthRejected?.(clientIp, req.path);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = authHeader.slice(7);

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      logger.warn('SECURITY', 'Unauthorized — invalid token', { ip: clientIp, path: req.path });
      onAuthRejected?.(clientIp, req.path);
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
