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

/**
 * Middleware to authenticate non-localhost requests via Bearer token.
 * Active in ALL modes. Localhost requests always bypass auth.
 *
 * Security: Uses crypto.timingSafeEqual to prevent timing attacks.
 */
export function createAuthMiddleware(getAuthToken: () => string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.connection.remoteAddress || '';
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1'
      || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
    if (isLocal) return next();

    const expectedToken = getAuthToken();
    if (!expectedToken) {
      logger.warn('SECURITY', 'Remote request rejected — no auth token configured', { ip: clientIp, path: req.path });
      res.status(403).json({ error: 'forbidden', message: 'Remote access requires CLAUDE_MEM_AUTH_TOKEN' });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      logger.warn('SECURITY', 'Unauthorized — missing or malformed token', { ip: clientIp, path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = authHeader.slice(7);

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      logger.warn('SECURITY', 'Unauthorized — invalid token', { ip: clientIp, path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
