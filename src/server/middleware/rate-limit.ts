// SPDX-License-Identifier: Apache-2.0
//
// Per-API-key request rate limiting + monthly usage quota for Server Beta.
// Both are opt-in (the route layer only installs them when the operator sets a
// limit) and both FAIL OPEN — a limiter/quota storage hiccup must never take the
// API down. Rate limiting keys on the API key id; quota keys on the team.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresRateLimitRepository } from '../../storage/postgres/rate-limit.js';
import { PostgresUsageRepository } from '../../storage/postgres/usage.js';
import { logger } from '../../utils/logger.js';

function floorToWindow(nowMs: number, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(nowMs / ms) * ms);
}

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Fixed-window per-key limiter: `max` requests per `windowSec`. */
export function requireRateLimit(pool: PostgresPool, opts: { windowSec: number; max: number }): RequestHandler {
  const repo = new PostgresRateLimitRepository(pool);
  return async (req: Request, res: Response, next: NextFunction) => {
    const subject = req.authContext?.apiKeyId;
    if (!subject) return next(); // unauthenticated / local-dev bypass: nothing to limit
    try {
      const start = floorToWindow(Date.now(), opts.windowSec);
      const resetMs = start.getTime() + opts.windowSec * 1000;
      const result = await repo.hit({ subjectId: subject, windowStart: start, limit: opts.max });
      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - result.count)));
      // Unix-seconds reset time — the conventional companion to Retry-After that
      // most client libraries read to schedule automatic retries.
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: 'rate_limited',
          message: `Rate limit exceeded (${opts.max} requests / ${opts.windowSec}s)`,
        });
      }
      return next();
    } catch (error) {
      logger.warn('HTTP', 'rate limit check failed; allowing request (fail open)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return next();
    }
  };
}

/** Monthly per-team quota on a usage `kind` (e.g. 'request'). 402 when reached. */
export function requireMonthlyQuota(pool: PostgresPool, opts: { kind: string; cap: number }): RequestHandler {
  const repo = new PostgresUsageRepository(pool);
  return async (req: Request, res: Response, next: NextFunction) => {
    const teamId = req.authContext?.teamId;
    if (!teamId) return next();
    try {
      const used = await repo.total({ teamId, kind: opts.kind, since: monthStartUtc(new Date()) });
      if (used >= opts.cap) {
        return res.status(402).json({
          error: 'quota_exceeded',
          message: `Monthly ${opts.kind} quota reached (${opts.cap})`,
          used,
          cap: opts.cap,
        });
      }
      return next();
    } catch (error) {
      logger.warn('HTTP', 'quota check failed; allowing request (fail open)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return next();
    }
  };
}
