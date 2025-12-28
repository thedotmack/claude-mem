/**
 * ABOUTME: Authentication middleware for remote Memory MCP access
 * ABOUTME: Provides bearer token validation for cross-device/cross-model access
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../../../utils/logger.js';

/**
 * Get the configured API token from environment or settings
 */
function getApiToken(): string | null {
  return process.env.CLAUDE_MEM_API_TOKEN || null;
}

/**
 * Check if remote authentication is required
 * Auth is only required when:
 * 1. CLAUDE_MEM_REMOTE_AUTH=true is set
 * 2. Request is not from localhost
 */
function isAuthRequired(req: Request): boolean {
  const remoteAuthEnabled = process.env.CLAUDE_MEM_REMOTE_AUTH === 'true';
  if (!remoteAuthEnabled) return false;

  // Check if request is from localhost
  const ip = req.ip || req.socket.remoteAddress || '';
  const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

  return !isLocalhost;
}

/**
 * Authentication middleware
 *
 * Usage: Add to routes that need remote access protection
 *
 * Environment variables:
 * - CLAUDE_MEM_REMOTE_AUTH=true  Enable authentication for remote requests
 * - CLAUDE_MEM_API_TOKEN=xxx     The bearer token to validate against
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for local requests or when auth is not enabled
  if (!isAuthRequired(req)) {
    return next();
  }

  const token = getApiToken();

  // If no token configured but auth is required, reject
  if (!token) {
    logger.warn('AUTH', 'Remote auth enabled but no API token configured');
    res.status(500).json({
      error: 'Authentication not configured',
      message: 'CLAUDE_MEM_API_TOKEN must be set when CLAUDE_MEM_REMOTE_AUTH=true'
    });
    return;
  }

  // Check Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('AUTH', 'Missing Authorization header', { ip: req.ip });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header required'
    });
    return;
  }

  // Validate bearer token format
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    logger.warn('AUTH', 'Invalid Authorization format', { ip: req.ip });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header must be: Bearer <token>'
    });
    return;
  }

  const providedToken = parts[1];

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedToken, token)) {
    logger.warn('AUTH', 'Invalid API token', { ip: req.ip });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API token'
    });
    return;
  }

  // Auth successful
  logger.debug('AUTH', 'Remote request authenticated', { ip: req.ip });
  next();
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Optional middleware that can be applied to specific route groups
 * Use this for routes that should always require auth (even local)
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getApiToken();

  if (!token) {
    logger.warn('AUTH', 'API token not configured for protected route');
    res.status(500).json({
      error: 'Authentication not configured',
      message: 'CLAUDE_MEM_API_TOKEN must be set'
    });
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authorization header required' });
    return;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid Authorization format' });
    return;
  }

  if (!timingSafeEqual(parts[1], token)) {
    res.status(403).json({ error: 'Forbidden', message: 'Invalid API token' });
    return;
  }

  next();
}
