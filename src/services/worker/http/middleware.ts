/**
 * HTTP Middleware for Worker Service
 *
 * Extracted from WorkerService.ts for better organization.
 * Handles request/response logging, CORS, JSON parsing, static file serving,
 * admin token auth, and rate limiting.
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getPackageRoot } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

/**
 * Admin token file path — generated once on first startup, stored per-user.
 */
const ADMIN_TOKEN_PATH = path.join(os.homedir(), '.claude-mem', 'admin.token');

/**
 * Lazily-initialized admin token. Generated via crypto.randomBytes if not on disk.
 */
let cachedAdminToken: string | null = null;

/**
 * Get or create the admin bearer token.
 * On first call, reads from ~/.claude-mem/admin.token or generates a new one.
 */
export function getAdminToken(): string {
  if (cachedAdminToken) return cachedAdminToken;

  const tokenDir = path.dirname(ADMIN_TOKEN_PATH);
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir, { recursive: true });
  }

  if (fs.existsSync(ADMIN_TOKEN_PATH)) {
    const stored = fs.readFileSync(ADMIN_TOKEN_PATH, 'utf-8').trim();
    if (stored.length >= 32) {
      cachedAdminToken = stored;
      return cachedAdminToken;
    }
  }

  // Generate a new token
  cachedAdminToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(ADMIN_TOKEN_PATH, cachedAdminToken, { mode: 0o600 });
  logger.info('SECURITY', 'Generated new admin token', { path: ADMIN_TOKEN_PATH });
  return cachedAdminToken;
}

/**
 * Simple in-memory rate limiter.
 * Tracks request counts per endpoint group in a sliding window.
 */
const rateLimitWindowMs = 60_000; // 1 minute
const rateLimitMaxRequests = 100; // max requests per window per endpoint group
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function getRateLimitGroup(requestPath: string): string {
  // Group by first two path segments: /api/search, /api/data, /api/admin, etc.
  const segments = requestPath.split('/').filter(Boolean);
  return `/${segments.slice(0, 2).join('/')}`;
}

/**
 * Rate limiting middleware — max 100 requests/minute per endpoint group.
 */
export function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const group = getRateLimitGroup(req.path);
  const now = Date.now();

  let bucket = rateLimitBuckets.get(group);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + rateLimitWindowMs };
    rateLimitBuckets.set(group, bucket);
  }

  bucket.count++;

  if (bucket.count > rateLimitMaxRequests) {
    logger.warn('SECURITY', 'Rate limit exceeded', { group, count: bucket.count });
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded for ${group}. Max ${rateLimitMaxRequests} requests per minute.`
    });
    return;
  }

  next();
}

/**
 * Create all middleware for the worker service
 * @param summarizeRequestBody - Function to summarize request bodies for logging
 * @returns Array of middleware functions
 */
export function createMiddleware(
  summarizeRequestBody: (method: string, path: string, body: any) => string
): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  // JSON parsing with 1mb limit (hardened from 50mb — Bug #1935)
  middlewares.push(express.json({ limit: '1mb' }));

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
 * Middleware to require localhost-only access.
 * Uses req.socket.remoteAddress (not req.ip) to avoid X-Forwarded-For spoofing.
 * Used for all API endpoints since this is a local-only tool.
 */
export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  // Use socket-level address to ignore X-Forwarded-For entirely (Bug #1932)
  const clientIp = req.socket.remoteAddress || '';
  const isLocalhost =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1';

  if (!isLocalhost) {
    logger.warn('SECURITY', 'API access denied - not localhost', {
      endpoint: req.path,
      clientIp,
      method: req.method
    });
    res.status(403).json({
      error: 'Forbidden',
      message: 'API endpoints are only accessible from localhost'
    });
    return;
  }

  next();
}

/**
 * Middleware to require admin bearer token for admin endpoints.
 * Admin routes must include `Authorization: Bearer <token>` header.
 * Token is auto-generated on first access if not already on disk.
 */
export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  // First, verify localhost via socket (not req.ip)
  const clientIp = req.socket.remoteAddress || '';
  const isLocalhost =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1';

  if (!isLocalhost) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin endpoints are only accessible from localhost'
    });
    return;
  }

  // Always require a valid bearer token (auto-generated on first access)
  const expectedToken = getAdminToken();
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || token !== expectedToken) {
    logger.warn('SECURITY', 'Admin endpoint: missing or invalid bearer token', {
      endpoint: req.path,
      method: req.method
    });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Valid admin bearer token required'
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
