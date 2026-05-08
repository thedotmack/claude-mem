// SPDX-License-Identifier: Apache-2.0

import pc from 'picocolors';
import { logger } from '../../utils/logger.js';

// Phase 12 — `claude-mem server jobs <subcommand>` operator console for the
// Postgres-backed observation generation queue. These commands talk DIRECTLY
// to Postgres (and BullMQ when configured), bypassing the HTTP API. They MUST
// run from a host that can reach the same database the server-beta runtime
// uses — set CLAUDE_MEM_SERVER_DATABASE_URL in the shell.
//
// Anti-pattern guards:
//   - Operating without --team/--project requires CLAUDE_MEM_SERVER_ADMIN=1
//     in the env (admin scope). This makes the elevation explicit.
//   - retry/cancel write to audit_log so every operator action is logged.
//   - retry is idempotent: a row already in queued status is a no-op.
//   - cancel sets status to cancelled; the generator's lockOutbox guard
//     ensures any in-flight delivery aborts before side effects.

interface ParsedArgs {
  team: string | null;
  project: string | null;
  limit: number;
  positional: string[];
}

interface JobStatusRow {
  status: string;
  count: number;
}

interface FailedJobRow {
  id: string;
  source_type: string;
  source_id: string;
  attempts: number;
  failed_at: Date | null;
  last_error: unknown;
  team_id: string;
  project_id: string;
}

const FAILED_DEFAULT_LIMIT = 20;

export async function runServerJobsCommand(argv: string[]): Promise<void> {
  const sub = argv[0]?.toLowerCase();
  const rest = argv.slice(1);
  if (!sub) {
    printJobsUsage();
    process.exit(1);
  }
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    console.error(pc.red('CLAUDE_MEM_SERVER_DATABASE_URL is required for server jobs commands.'));
    console.error('Configure Postgres first, then re-run.');
    process.exit(1);
  }

  switch (sub) {
    case 'status':
      await runJobsStatus(parseArgs(rest));
      return;
    case 'failed':
      await runJobsFailed(parseArgs(rest));
      return;
    case 'retry':
      await runJobsRetry(parseArgs(rest));
      return;
    case 'cancel':
      await runJobsCancel(parseArgs(rest));
      return;
    default:
      console.error(pc.red(`Unknown server jobs subcommand: ${sub}`));
      printJobsUsage();
      process.exit(1);
  }
}

function printJobsUsage(): void {
  console.error(`Usage: ${pc.bold('npx claude-mem server jobs <subcommand>')}`);
  console.error('Subcommands:');
  console.error('  status                    Show queue lane counts (Postgres + BullMQ)');
  console.error('  failed [--limit N]        List failed generation jobs (default 20)');
  console.error('  retry <id>                Re-enqueue a failed/cancelled generation job');
  console.error('  cancel <id>               Cancel a queued/processing generation job');
  console.error('Filters: --team <id>  --project <id>  (omit both with CLAUDE_MEM_SERVER_ADMIN=1)');
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { team: null, project: null, limit: FAILED_DEFAULT_LIMIT, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === '--team' || arg === '--project' || arg === '--limit') {
      const value = argv[i + 1];
      if (!value) {
        console.error(pc.red(`Missing value for ${arg}`));
        process.exit(1);
      }
      if (arg === '--team') out.team = value;
      else if (arg === '--project') out.project = value;
      else if (arg === '--limit') {
        const n = Number.parseInt(value, 10);
        out.limit = Number.isInteger(n) && n > 0 ? n : FAILED_DEFAULT_LIMIT;
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--team=')) { out.team = arg.slice('--team='.length); continue; }
    if (arg.startsWith('--project=')) { out.project = arg.slice('--project='.length); continue; }
    if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      out.limit = Number.isInteger(n) && n > 0 ? n : FAILED_DEFAULT_LIMIT;
      continue;
    }
    out.positional.push(arg);
  }
  return out;
}

// `--team`/`--project` may both be absent only when CLAUDE_MEM_SERVER_ADMIN=1
// is set in the env. Without admin we refuse and ask the operator to scope.
function requireScope(args: ParsedArgs): { team: string | null; project: string | null } {
  if (!args.team && !args.project && process.env.CLAUDE_MEM_SERVER_ADMIN !== '1') {
    console.error(pc.red('Refusing to run unscoped: pass --team <id> and/or --project <id>, or set CLAUDE_MEM_SERVER_ADMIN=1.'));
    process.exit(1);
  }
  return { team: args.team, project: args.project };
}

async function runJobsStatus(args: ParsedArgs): Promise<void> {
  const scope = requireScope(args);
  const { pool, releasePool } = await openPool();
  try {
    const where: string[] = [];
    const params: Array<string | number | Date> = [];
    if (scope.team) { params.push(scope.team); where.push(`team_id = $${params.length}`); }
    if (scope.project) { params.push(scope.project); where.push(`project_id = $${params.length}`); }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Postgres outbox is canonical history.
    const pgResult = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM observation_generation_jobs ${whereClause} GROUP BY status`,
      params,
    );
    const pgCounts: Record<string, number> = {};
    for (const row of pgResult.rows as JobStatusRow[]) {
      pgCounts[row.status] = Number(row.count);
    }

    // BullMQ counts (best effort — missing Redis just shows pg counts).
    let bullmqCounts: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number; stalled: number }> | null = null;
    try {
      bullmqCounts = await (testSeams.collectBullmqCounts ?? collectBullmqCounts)();
    } catch (error) {
      logger.debug?.('SYSTEM', 'BullMQ counts unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const output = {
      scope: { team: scope.team, project: scope.project },
      postgres: pgCounts,
      bullmq: bullmqCounts ?? { unavailable: true },
      divergence: detectDivergence(pgCounts, bullmqCounts),
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await releasePool();
  }
}

async function runJobsFailed(args: ParsedArgs): Promise<void> {
  const scope = requireScope(args);
  const { pool, releasePool } = await openPool();
  try {
    const where: string[] = [`status = 'failed'`];
    const params: Array<string | number> = [];
    if (scope.team) { params.push(scope.team); where.push(`team_id = $${params.length}`); }
    if (scope.project) { params.push(scope.project); where.push(`project_id = $${params.length}`); }
    params.push(args.limit);
    const limitParam = params.length;
    const result = await pool.query(
      `
        SELECT id, source_type, source_id, attempts, failed_at, last_error, team_id, project_id
        FROM observation_generation_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY failed_at DESC NULLS LAST, created_at DESC
        LIMIT $${limitParam}
      `,
      params,
    );
    const formatted = (result.rows as FailedJobRow[]).map(row => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      teamId: row.team_id,
      projectId: row.project_id,
      attempts: row.attempts,
      failedAt: row.failed_at?.toISOString() ?? null,
      lastError: row.last_error && typeof row.last_error === 'object'
        ? (row.last_error as { message?: string }).message ?? row.last_error
        : null,
    }));
    console.log(JSON.stringify({
      scope: { team: scope.team, project: scope.project },
      limit: args.limit,
      count: formatted.length,
      failed: formatted,
    }, null, 2));
  } finally {
    await releasePool();
  }
}

async function runJobsRetry(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) {
    console.error(pc.red('Usage: server jobs retry <id>'));
    process.exit(1);
  }
  const scope = requireScope(args);
  const { pool, releasePool } = await openPool();
  try {
    // Verify the row exists. Scope-first lookup so admin without --team is
    // honored, but project/team filters narrow the lookup when present.
    const lookup = await loadJobScoped(pool, id, scope);
    if (!lookup) {
      console.error(pc.red(`Generation job not found: ${id}`));
      process.exit(1);
    }

    if (lookup.status === 'queued') {
      console.log(JSON.stringify({
        id: lookup.id,
        action: 'retry',
        outcome: 'noop_already_queued',
        retriedCount: extractRetriedCount(lookup.payload),
      }, null, 2));
      await writeOperatorAudit(pool, lookup, 'generation_job.retried_by_operator', {
        outcome: 'noop_already_queued',
        currentAttempts: lookup.attempts,
      });
      return;
    }
    if (lookup.status === 'processing') {
      console.error(pc.red(`Cannot retry an in-flight job. Cancel first or wait. Current status: ${lookup.status}`));
      process.exit(1);
    }

    const newRetriedCount = extractRetriedCount(lookup.payload) + 1;
    const newPayload = {
      ...(lookup.payload && typeof lookup.payload === 'object' ? lookup.payload as Record<string, unknown> : {}),
      retried_count: newRetriedCount,
      last_retried_by: 'cli_operator',
    };

    const updated = await pool.query(
      `
        UPDATE observation_generation_jobs
        SET status = 'queued',
            locked_at = NULL,
            locked_by = NULL,
            failed_at = NULL,
            cancelled_at = NULL,
            completed_at = NULL,
            last_error = NULL,
            attempts = LEAST(attempts, max_attempts - 1),
            payload = $2::jsonb,
            updated_at = now()
        WHERE id = $1
        RETURNING id, status, attempts, bullmq_job_id, source_type
      `,
      [id, JSON.stringify(newPayload)],
    );
    type UpdatedRetryRow = { id: string; status: string; attempts: number; bullmq_job_id: string | null; source_type: string };
    const row = (updated.rows as UpdatedRetryRow[])[0];
    if (!row) {
      console.error(pc.red('Update returned no rows; the job may have been deleted.'));
      process.exit(1);
    }

    // Append lifecycle event row matching the audit chain shape.
    await pool.query(
      `INSERT INTO observation_generation_job_events (id, generation_job_id, event_type, status_after, attempt, details)
       VALUES (gen_random_uuid(), $1, 'queued', 'queued', $2, $3::jsonb)`,
      [id, row.attempts, JSON.stringify({ source: 'cli_operator_retry', retriedCount: newRetriedCount })],
    );

    await writeOperatorAudit(pool, lookup, 'generation_job.retried_by_operator', {
      previousStatus: lookup.status,
      currentStatus: row.status,
      retriedCount: newRetriedCount,
    });

    // Best-effort BullMQ re-publish using the deterministic id.
    if (row.bullmq_job_id) {
      try {
        await (testSeams.republishToBullmq ?? republishToBullmq)(row.source_type, row.bullmq_job_id, newPayload);
      } catch (error) {
        logger.warn('SYSTEM', 'BullMQ re-enqueue failed (will reconcile on startup)', {
          jobId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(JSON.stringify({
      id: row.id,
      action: 'retry',
      outcome: 'requeued',
      retriedCount: newRetriedCount,
      status: row.status,
      attempts: row.attempts,
    }, null, 2));
  } finally {
    await releasePool();
  }
}

async function runJobsCancel(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) {
    console.error(pc.red('Usage: server jobs cancel <id>'));
    process.exit(1);
  }
  const scope = requireScope(args);
  const { pool, releasePool } = await openPool();
  try {
    const lookup = await loadJobScoped(pool, id, scope);
    if (!lookup) {
      console.error(pc.red(`Generation job not found: ${id}`));
      process.exit(1);
    }
    if (lookup.status === 'cancelled') {
      console.log(JSON.stringify({ id: lookup.id, action: 'cancel', outcome: 'noop_already_cancelled' }, null, 2));
      await writeOperatorAudit(pool, lookup, 'generation_job.cancelled_by_operator', { outcome: 'noop_already_cancelled' });
      return;
    }
    if (lookup.status === 'completed') {
      console.error(pc.red('Cannot cancel a completed job.'));
      process.exit(1);
    }

    const updated = await pool.query(
      `
        UPDATE observation_generation_jobs
        SET status = 'cancelled',
            cancelled_at = now(),
            updated_at = now()
        WHERE id = $1
        RETURNING id, status, bullmq_job_id, source_type
      `,
      [id],
    );
    type UpdatedCancelRow = { id: string; status: string; bullmq_job_id: string | null; source_type: string };
    const row = (updated.rows as UpdatedCancelRow[])[0];
    if (!row) {
      console.error(pc.red('Update returned no rows.'));
      process.exit(1);
    }

    await pool.query(
      `INSERT INTO observation_generation_job_events (id, generation_job_id, event_type, status_after, attempt, details)
       VALUES (gen_random_uuid(), $1, 'cancelled', 'cancelled', $2, $3::jsonb)`,
      [id, lookup.attempts, JSON.stringify({ source: 'cli_operator_cancel' })],
    );

    await writeOperatorAudit(pool, lookup, 'generation_job.cancelled_by_operator', {
      previousStatus: lookup.status,
      currentStatus: row.status,
    });

    // Best-effort BullMQ removal.
    if (row.bullmq_job_id) {
      try {
        await (testSeams.removeFromBullmq ?? removeFromBullmq)(row.source_type, row.bullmq_job_id);
      } catch (error) {
        logger.debug?.('SYSTEM', 'BullMQ remove on cancel failed (job may not be in queue)', {
          jobId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(JSON.stringify({
      id: row.id,
      action: 'cancel',
      outcome: 'cancelled',
      status: row.status,
    }, null, 2));
  } finally {
    await releasePool();
  }
}

interface JobLookup {
  id: string;
  team_id: string;
  project_id: string;
  status: string;
  attempts: number;
  bullmq_job_id: string | null;
  source_type: string;
  payload: Record<string, unknown> | null;
}

async function loadJobScoped(
  pool: PoolLike,
  id: string,
  scope: { team: string | null; project: string | null },
): Promise<JobLookup | null> {
  const where: string[] = ['id = $1'];
  const params: Array<string> = [id];
  if (scope.team) { params.push(scope.team); where.push(`team_id = $${params.length}`); }
  if (scope.project) { params.push(scope.project); where.push(`project_id = $${params.length}`); }
  const result = await pool.query(
    `SELECT id, team_id, project_id, status, attempts, bullmq_job_id, source_type, payload
     FROM observation_generation_jobs
     WHERE ${where.join(' AND ')}`,
    params,
  );
  const row = (result.rows as JobLookup[])[0];
  return row ?? null;
}

interface PoolLike {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
}

async function writeOperatorAudit(
  pool: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  job: JobLookup,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, team_id, project_id, actor_id, api_key_id, action, resource_type, resource_id, details)
       VALUES (gen_random_uuid(), $1, $2, NULL, NULL, $3, 'observation_generation_job', $4, $5::jsonb)`,
      [job.team_id, job.project_id, action, job.id, JSON.stringify({ ...details, source: 'cli_operator' })],
    );
  } catch (error) {
    logger.warn('SYSTEM', 'failed to write operator audit row', {
      action,
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractRetriedCount(payload: Record<string, unknown> | null | undefined): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = (payload as { retried_count?: unknown }).retried_count;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function detectDivergence(
  pg: Record<string, number>,
  bullmq: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number; stalled: number }> | null,
): Record<string, unknown> {
  if (!bullmq) return { reason: 'bullmq_unavailable' };
  // Sum across lanes for comparison. Postgres counts are per-status; BullMQ
  // counts are per-state. We compare the obvious two: `failed` and `queued`
  // (= waiting + delayed). Divergence is informational — Postgres is canonical.
  const bullmqWaiting = Object.values(bullmq).reduce((a, b) => a + b.waiting + b.delayed, 0);
  const bullmqFailed = Object.values(bullmq).reduce((a, b) => a + b.failed, 0);
  const pgQueued = pg.queued ?? 0;
  const pgFailed = pg.failed ?? 0;
  const out: Record<string, unknown> = {};
  if (pgQueued !== bullmqWaiting) {
    out.queuedMismatch = { postgres: pgQueued, bullmq: bullmqWaiting };
  }
  if (pgFailed !== bullmqFailed) {
    out.failedMismatch = { postgres: pgFailed, bullmq: bullmqFailed };
  }
  return out;
}

// Phase 12 — test seam. Tests can override the pool factory + bullmq access
// without resorting to module-level mocks (which leak across Bun test files).
// Production callers leave these unset; only `tests/cli/server-jobs.test.ts`
// touches them.
export interface ServerJobsTestSeams {
  openPool?: () => Promise<{
    pool: PoolLike;
    releasePool: () => Promise<void>;
  }>;
  collectBullmqCounts?: () => Promise<Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number; stalled: number }>>;
  republishToBullmq?: (sourceType: string, jobId: string, payload: Record<string, unknown>) => Promise<void>;
  removeFromBullmq?: (sourceType: string, jobId: string) => Promise<void>;
}

let testSeams: ServerJobsTestSeams = {};

export function __setServerJobsTestSeams(seams: ServerJobsTestSeams): void {
  testSeams = seams;
}

export function __clearServerJobsTestSeams(): void {
  testSeams = {};
}

async function openPool(): Promise<{
  pool: PoolLike;
  releasePool: () => Promise<void>;
}> {
  if (testSeams.openPool) return testSeams.openPool();
  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  return {
    pool: pool as never,
    releasePool: async () => { /* shared pool tears down on process exit */ },
  };
}

// BullMQ access. Direct construction avoids importing the runtime, keeping
// the CLI fast to boot. Returns counts per known queue name; gracefully
// returns null when Redis is unconfigured.
async function collectBullmqCounts(): Promise<Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number; stalled: number }>> {
  const { getRedisQueueConfig } = await import('../../server/queue/redis-config.js');
  const { Queue } = await import('bullmq');
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') {
    throw new Error('CLAUDE_MEM_QUEUE_ENGINE is not "bullmq"');
  }
  const { SERVER_JOB_QUEUE_NAMES } = await import('../../server/jobs/types.js');
  const out: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number; stalled: number }> = {};
  for (const [kind, name] of Object.entries(SERVER_JOB_QUEUE_NAMES)) {
    const queue = new Queue(name, { connection: config.connection, prefix: config.prefix });
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
      out[kind] = {
        waiting: Number(counts.waiting ?? 0),
        active: Number(counts.active ?? 0),
        completed: Number(counts.completed ?? 0),
        failed: Number(counts.failed ?? 0),
        delayed: Number(counts.delayed ?? 0),
        stalled: 0, // BullMQ rotates the stalled list; runtime tracks it via QueueEvents.
      };
    } finally {
      await queue.close();
    }
  }
  return out;
}

async function republishToBullmq(sourceType: string, jobId: string, payload: Record<string, unknown>): Promise<void> {
  const { getRedisQueueConfig } = await import('../../server/queue/redis-config.js');
  const { Queue } = await import('bullmq');
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') return;
  const { SERVER_JOB_QUEUE_NAMES } = await import('../../server/jobs/types.js');
  const lane = sourceType === 'session_summary' ? SERVER_JOB_QUEUE_NAMES.summary : SERVER_JOB_QUEUE_NAMES.event;
  const queue = new Queue(lane, { connection: config.connection, prefix: config.prefix });
  try {
    try { await queue.remove(jobId); } catch { /* terminal slot may be missing */ }
    await queue.add(lane, payload as never, { jobId });
  } finally {
    await queue.close();
  }
}

async function removeFromBullmq(sourceType: string, jobId: string): Promise<void> {
  const { getRedisQueueConfig } = await import('../../server/queue/redis-config.js');
  const { Queue } = await import('bullmq');
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') return;
  const { SERVER_JOB_QUEUE_NAMES } = await import('../../server/jobs/types.js');
  const lane = sourceType === 'session_summary' ? SERVER_JOB_QUEUE_NAMES.summary : SERVER_JOB_QUEUE_NAMES.event;
  const queue = new Queue(lane, { connection: config.connection, prefix: config.prefix });
  try {
    await queue.remove(jobId);
  } finally {
    await queue.close();
  }
}
