import type { RequestHandler } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { requireRateLimit, requireMonthlyQuota } from './rate-limit.js';
import { meterRequests } from './usage-metering.js';

/** The same configured admission policy for canonical and compatibility routes. */
export function serverUsageGuards(pool: PostgresPool, options: { write?: boolean } = {}): RequestHandler[] {
  const guards: RequestHandler[] = [];
  const ratePerMin = Number(process.env.CLAUDE_MEM_RATE_LIMIT_PER_MIN ?? '0');
  if (ratePerMin > 0) guards.push(requireRateLimit(pool, { windowSec: 60, max: ratePerMin }));
  const monthlyCap = Number(process.env.CLAUDE_MEM_MONTHLY_REQUEST_CAP ?? '0');
  if (monthlyCap > 0) guards.push(requireMonthlyQuota(pool, { kind: 'request', cap: monthlyCap }));
  if (process.env.CLAUDE_MEM_USAGE_METERING === '1') guards.push(meterRequests(pool));
  // Ingestion drives provider spend. Reads remain available over token quota.
  const tokenCap = Number(process.env.CLAUDE_MEM_MONTHLY_TOKEN_CAP ?? '0');
  if (options.write && tokenCap > 0) guards.push(requireMonthlyQuota(pool, { kind: 'tokens', cap: tokenCap }));
  return guards;
}
