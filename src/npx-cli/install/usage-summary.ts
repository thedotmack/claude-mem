/**
 * Numbers-only summary of the local memory database, sent with the installer's
 * sign-in start request (`usage_summary` on POST /api/installer/oauth/start) and
 * printed as the "Your memory so far" block.
 *
 * Privacy: per-UTC-day observation counts and discovery-token sums ONLY. No
 * prompts, observation text, paths, project names, or hostnames ever enter this
 * structure — the shape below is the whole payload, and cmem.ai drops anything
 * that does not match it exactly.
 *
 * DB access: the npx CLI runs under Node (engines >=20.12), where `bun:sqlite`
 * does not exist and `node:sqlite` is missing or experimental. Bun is the
 * plugin's required runtime, so the reader runs as a short-lived `bun -e`
 * child that opens the database READ-ONLY and prints one JSON line of per-day
 * rows. Aggregation and validation stay here in plain TypeScript. Every
 * failure (no DB, no bun, locked/corrupt DB, old schema, timeout, bad output)
 * resolves to `null` so the caller simply omits the summary — this can never
 * break an install.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';

export const USAGE_WINDOW_DAYS = 28;

export interface UsageDay {
  /** UTC calendar date, YYYY-MM-DD. */
  d: string;
  obs: number;
  tokens: number;
}

export interface UsageSummary {
  window_days: typeof USAGE_WINDOW_DAYS;
  active_days: number;
  observations: number;
  memory_tokens: number;
  days: UsageDay[];
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const READ_TIMEOUT_MS = 5_000;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC midnight that opens the window: today plus the 27 days before it. */
export function usageWindowStartMs(nowMs: number): number {
  const todayMidnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return todayMidnight - (USAGE_WINDOW_DAYS - 1) * DAY_MS;
}

function toCount(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function isRealDate(d: string): boolean {
  return DATE_RE.test(d) && utcDate(Date.parse(`${d}T00:00:00Z`)) === d;
}

/**
 * Pure: turns raw per-day rows into the wire summary. Rows outside the 28-day
 * UTC window (including future dates), with malformed dates, or with
 * non-numeric / negative counts are dropped; duplicate dates are merged; days
 * with no observations are not listed. Returns a valid (possibly all-zero)
 * summary for any input.
 */
export function buildUsageSummary(rows: unknown, nowMs: number): UsageSummary {
  const firstDay = utcDate(usageWindowStartMs(nowMs));
  const today = utcDate(nowMs);
  const byDay = new Map<string, { obs: number; tokens: number }>();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.d !== 'string' || !isRealDate(r.d)) continue;
    // YYYY-MM-DD compares correctly as a string.
    if (r.d < firstDay || r.d > today) continue;
    const obs = toCount(r.obs);
    const tokens = r.tokens === null || r.tokens === undefined ? 0 : toCount(r.tokens);
    if (obs === null || tokens === null || obs === 0) continue;
    const prev = byDay.get(r.d) ?? { obs: 0, tokens: 0 };
    byDay.set(r.d, {
      obs: Math.min(prev.obs + obs, Number.MAX_SAFE_INTEGER),
      tokens: Math.min(prev.tokens + tokens, Number.MAX_SAFE_INTEGER),
    });
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-USAGE_WINDOW_DAYS)
    .map(([d, v]) => ({ d, obs: v.obs, tokens: v.tokens }));

  return {
    window_days: USAGE_WINDOW_DAYS,
    active_days: days.length,
    observations: Math.min(days.reduce((sum, day) => sum + day.obs, 0), Number.MAX_SAFE_INTEGER),
    memory_tokens: Math.min(days.reduce((sum, day) => sum + day.tokens, 0), Number.MAX_SAFE_INTEGER),
    days,
  };
}

/**
 * Runs inside `bun -e`. Inputs arrive via env so nothing is shell-parsed.
 * `created_at_epoch` is normalized to ms (older rows stored seconds, same rule
 * as telemetry's asMs), and `discovery_tokens` is read only if the column
 * exists on this schema version.
 */
export const USAGE_READER_SCRIPT = `
const { Database } = require('bun:sqlite');
const db = new Database(process.env.CMEM_USAGE_DB, { readonly: true });
try {
  const cols = db.query("PRAGMA table_info(observations)").all().map((c) => c.name);
  if (!cols.includes('created_at_epoch')) throw new Error('no observations table');
  const tokens = cols.includes('discovery_tokens') ? 'COALESCE(discovery_tokens, 0)' : '0';
  const ms = 'CASE WHEN created_at_epoch < 1000000000000 THEN created_at_epoch * 1000 ELSE created_at_epoch END';
  const rows = db.query(
    "SELECT strftime('%Y-%m-%d', (" + ms + ") / 1000, 'unixepoch') AS d, COUNT(*) AS obs, SUM(" + tokens + ") AS tokens"
    + " FROM observations WHERE (" + ms + ") >= ?1 AND (" + ms + ") < ?2 GROUP BY d"
  ).all(Number(process.env.CMEM_USAGE_FROM), Number(process.env.CMEM_USAGE_TO));
  process.stdout.write(JSON.stringify(rows) + '\\n');
} finally {
  db.close();
}
`;

export interface ReadUsageSummaryOptions {
  dbPath: string;
  bunPath: string | null;
  nowMs?: number;
  timeoutMs?: number;
}

/** Reads the local DB via a read-only bun child. Never throws; null = omit. */
export function readUsageSummary(opts: ReadUsageSummaryOptions): Promise<UsageSummary | null> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!opts.bunPath || !existsSync(opts.dbPath)) return Promise.resolve(null);
  const bunPath = opts.bunPath;

  return new Promise((resolve) => {
    try {
      execFile(bunPath, ['-e', USAGE_READER_SCRIPT], {
        timeout: opts.timeoutMs ?? READ_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          CMEM_USAGE_DB: opts.dbPath,
          CMEM_USAGE_FROM: String(usageWindowStartMs(nowMs)),
          // End of today (UTC): excludes rows stamped in the future.
          CMEM_USAGE_TO: String(Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS),
        },
      }, (error, stdout) => {
        if (error) return resolve(null);
        try {
          const lastLine = String(stdout).trim().split('\n').pop() ?? '';
          const rows: unknown = JSON.parse(lastLine);
          resolve(Array.isArray(rows) ? buildUsageSummary(rows, nowMs) : null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** 1234 -> "1,234"; 4_200_000 -> "4.2M". */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString('en-US');
}

/** Lines for the installer's "Your memory so far" block; empty when there is nothing to show. */
export function formatUsageSummaryLines(summary: UsageSummary | null): string[] {
  if (!summary || summary.observations === 0) return [];
  const obs = summary.observations.toLocaleString('en-US');
  const days = summary.active_days;
  return [
    `Your memory so far (last ${summary.window_days} days): ${obs} observation${summary.observations === 1 ? '' : 's'}`
      + ` across ${days} active day${days === 1 ? '' : 's'}, ${formatTokenCount(summary.memory_tokens)} memory tokens.`,
  ];
}
