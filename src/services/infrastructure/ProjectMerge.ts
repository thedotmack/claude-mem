import path from 'path';
import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { ChromaSync, type MergedIntoProjectTarget } from '../sync/ChromaSync.js';
import { emitRemapProject, hasSyncLane } from '../sync/remap-outbox.js';
import { resolveDbPath } from '../../shared/paths.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';

export interface ProjectMergeResult {
  from: string;
  into: string;
  mergedObservations: number;
  mergedSummaries: number;
  chromaUpdates: number;
  chromaFailed: number;
  dryRun: boolean;
}

class DryRunRollback extends Error {}

/**
 * `claude-mem project merge <from> <into>` (plan-20 step 2): fold the memory
 * stored under project `from` into project `into`, e.g. the old per-folder keys
 * of directories a CLAUDE_MEM_PROJECT_ENVIRONMENTS entry now groups.
 *
 * Nothing is rewritten. Rows keep their `project` and are stamped
 * `merged_into_project = into`, the alias every read path already honors, the
 * same way worktree adoption folds a worktree into its repository. On a synced
 * database the stamp goes through emitRemapProject, so a remap_project op is
 * queued in the same transaction and cloud sync converges on every device.
 * Chroma metadata is patched afterwards so semantic search follows; a failed
 * patch is retried by running the command again.
 *
 * Rows already merged somewhere else are left alone. Any SQL error rolls the
 * whole merge back and propagates.
 */
export async function mergeProjectInto(opts: {
  from: string;
  into: string;
  dataDirectory?: string;
  dryRun?: boolean;
}): Promise<ProjectMergeResult> {
  const from = opts.from.trim();
  const into = opts.into.trim();
  if (!from || !into) {
    throw new Error('project merge needs both <from> and <into>');
  }
  if (from === into) {
    throw new Error(`project merge: <from> and <into> are both "${from}"`);
  }

  const dryRun = opts.dryRun ?? false;
  const result: ProjectMergeResult = {
    from,
    into,
    mergedObservations: 0,
    mergedSummaries: 0,
    chromaUpdates: 0,
    chromaFailed: 0,
    dryRun,
  };

  // Resolved at call time, like resolveDbPath's other callers: the same
  // database for the worker and the CLI, and one a test can point elsewhere.
  const dbPath = opts.dataDirectory ? path.join(opts.dataDirectory, 'claude-mem.db') : resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`No claude-mem database at ${dbPath}`);
  }

  const chromaTargets: MergedIntoProjectTarget[] = [];
  const db = openConfiguredSqliteDatabase(dbPath);
  try {
    // Already-merged rows stay eligible for the Chroma patch so a run whose
    // patch failed after the SQL commit can be retried; the UPDATE itself only
    // touches rows that are not merged anywhere yet.
    const patchable = (table: 'observations' | 'session_summaries') => db.prepare(
      `SELECT id FROM ${table}
        WHERE project = ? AND (merged_into_project IS NULL OR merged_into_project = ?)`
    ).all(from, into) as Array<{ id: number }>;

    const merge = db.transaction(() => {
      if (hasSyncLane(db)) {
        const remap = emitRemapProject(
          db,
          { project: from, merged_into_project_is_null: true },
          { merged_into_project: into }
        );
        result.mergedObservations = remap.observations;
        result.mergedSummaries = remap.summaries;
      } else {
        // A database that has never had the sync lane has never synced, so
        // there is no replica state to keep converged.
        result.mergedObservations = db.prepare(
          'UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
        ).run(into, from).changes;
        result.mergedSummaries = db.prepare(
          'UPDATE session_summaries SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
        ).run(into, from).changes;
      }
      for (const row of patchable('observations')) chromaTargets.push({ docType: 'observation', sqliteId: row.id });
      for (const row of patchable('session_summaries')) chromaTargets.push({ docType: 'session_summary', sqliteId: row.id });
      if (dryRun) throw new DryRunRollback();
    });

    try {
      merge();
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
  } finally {
    db.close();
  }

  if (!dryRun && chromaTargets.length > 0) {
    try {
      await new ChromaSync('claude-mem').updateMergedIntoProject(chromaTargets, into);
      result.chromaUpdates = chromaTargets.length;
    } catch (error) {
      result.chromaFailed = chromaTargets.length;
      logger.warn('SYSTEM', 'Project merge committed; Chroma metadata patch failed (run the command again to retry)', {
        from,
        into,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('SYSTEM', 'Project merge finished', { ...result });
  return result;
}

/** A large merge plus its Chroma patch can take a while; the CLI waits for it. */
const WORKER_MERGE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * `claude-mem project merge` from the CLI. The running worker holds the Chroma
 * writer lock, so a merge run in this process could update SQLite but never
 * Chroma: with a worker up, the merge runs inside it (POST /api/projects/merge).
 * This process runs it only when no worker answers (it is then the only
 * writer), or when the worker is an older one without that route. Any other
 * worker failure is raised rather than retried here, so a merge never runs
 * twice against two writers (gate P2-4).
 */
export async function runProjectMergeCommand(
  opts: {
    from: string;
    into: string;
    dryRun?: boolean;
    /** Data directory for the in-process fallback (tests). */
    dataDirectory?: string;
  },
  requestWorker: typeof workerHttpRequest = workerHttpRequest,
): Promise<ProjectMergeResult & { ranIn: 'worker' | 'cli' }> {
  const dryRun = opts.dryRun ?? false;
  let response: Response | null = null;
  try {
    response = await requestWorker('/api/projects/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: opts.from, into: opts.into, dryRun }),
      timeoutMs: WORKER_MERGE_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    logger.info('SYSTEM', 'No worker answered; running the project merge in this process', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (response && response.status !== 404) {
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`The worker refused the project merge (HTTP ${response.status}): ${body}`);
    }
    return { ...(JSON.parse(body) as ProjectMergeResult), ranIn: 'worker' };
  }

  const result = await mergeProjectInto({ from: opts.from, into: opts.into, dryRun, dataDirectory: opts.dataDirectory });
  return { ...result, ranIn: 'cli' };
}
