/**
 * WorktreeAdoption - Stamp observations from merged worktrees into their parent project.
 *
 * Given a parent repo path, this engine:
 *   1. Uses git to enumerate worktrees of the parent repo.
 *   2. Classifies each worktree's branch as "merged" (in `git branch --merged HEAD`)
 *      or manually overridden via `onlyBranch` (for squash-merge detection).
 *   3. Stamps `merged_into_project` on `observations` and `session_summaries` rows
 *      whose `project` matches the composite `parent/worktree` name.
 *   4. Propagates the same metadata to Chroma so semantic search includes the
 *      adopted rows under the parent project.
 *
 * `project` is never overwritten — it remains immutable provenance. The
 * `merged_into_project` column is a virtual pointer that query layers OR into
 * their WHERE predicates.
 *
 * DB lifecycle mirrors `runOneTimeCwdRemap` in ProcessManager.ts: we manage our
 * own Database handle (open -> transaction -> close in finally) so this engine
 * can be called on worker startup before `dbManager.initialize()` without
 * contending on the shared handle.
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { ChromaSync } from '../sync/ChromaSync.js';

const DEFAULT_DATA_DIR = path.join(homedir(), '.claude-mem');

export interface AdoptionResult {
  repoPath: string;
  parentProject: string;
  scannedWorktrees: number;
  mergedBranches: string[];
  adoptedObservations: number;
  adoptedSummaries: number;
  chromaUpdates: number;
  chromaFailed: number;
  dryRun: boolean;
  errors: Array<{ worktree: string; error: string }>;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

const GIT_TIMEOUT_MS = 5000;

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

function gitCapture(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? '').trim();
}

/**
 * Resolve the main working-tree root for an arbitrary cwd inside a repo or worktree.
 * Mirrors the handling in `scripts/cwd-remap.ts:48-51`.
 */
function resolveMainRepoPath(cwd: string): string | null {
  const commonDir = gitCapture(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ]);
  if (!commonDir) return null;

  // Normal: common-dir is "<repo>/.git". Bare: strip the trailing ".git".
  const mainRoot = commonDir.endsWith('/.git')
    ? path.dirname(commonDir)
    : commonDir.replace(/\.git$/, '');
  return existsSync(mainRoot) ? mainRoot : null;
}

function listWorktrees(mainRepo: string): WorktreeEntry[] {
  const raw = gitCapture(mainRepo, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (line.startsWith('branch ')) {
      // `branch refs/heads/<name>` — strip the ref prefix.
      const refName = line.slice('branch '.length).trim();
      current.branch = refName.startsWith('refs/heads/')
        ? refName.slice('refs/heads/'.length)
        : refName;
    } else if (line === '' && current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}

function listMergedBranches(mainRepo: string): Set<string> {
  const raw = gitCapture(mainRepo, [
    'branch',
    '--merged',
    'HEAD',
    '--format=%(refname:short)'
  ]);
  if (!raw) return new Set();
  return new Set(
    raw.split('\n').map(b => b.trim()).filter(b => b.length > 0)
  );
}

/**
 * Stamp `merged_into_project` on observations and session_summaries for every
 * worktree of `opts.repoPath` whose branch has been merged into the parent's HEAD.
 *
 * SQL writes are idempotent: an UPDATE only touches rows where
 * `merged_into_project IS NULL`. `result.adoptedObservations` / `adoptedSummaries`
 * reflect the actual SQL changes on each run.
 *
 * Chroma patches are self-healing: the Chroma id set is built from ALL
 * observations whose `project` matches a merged worktree (both unadopted rows
 * AND rows previously stamped to this parent), and `updateMergedIntoProject`
 * is idempotent, so a transient Chroma failure on an earlier run is retried
 * automatically on the next adoption pass. `result.chromaUpdates` therefore
 * counts the total Chroma writes performed this pass (which may exceed
 * `adoptedObservations` when retries happen).
 */
export async function adoptMergedWorktrees(opts: {
  repoPath?: string;
  dataDirectory?: string;
  dryRun?: boolean;
  onlyBranch?: string;
} = {}): Promise<AdoptionResult> {
  const dataDirectory = opts.dataDirectory ?? DEFAULT_DATA_DIR;
  const dryRun = opts.dryRun ?? false;
  const startCwd = opts.repoPath ?? process.cwd();

  const mainRepo = resolveMainRepoPath(startCwd);
  const parentProject = mainRepo ? getProjectContext(mainRepo).primary : '';

  const result: AdoptionResult = {
    repoPath: mainRepo ?? startCwd,
    parentProject,
    scannedWorktrees: 0,
    mergedBranches: [],
    adoptedObservations: 0,
    adoptedSummaries: 0,
    chromaUpdates: 0,
    chromaFailed: 0,
    dryRun,
    errors: []
  };

  if (!mainRepo) {
    logger.debug('SYSTEM', 'Worktree adoption skipped (not a git repo)', { startCwd });
    return result;
  }

  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    logger.debug('SYSTEM', 'Worktree adoption skipped (no DB yet)', { dbPath });
    return result;
  }

  const allWorktrees = listWorktrees(mainRepo);
  const childWorktrees = allWorktrees.filter(w => w.path !== mainRepo);
  result.scannedWorktrees = childWorktrees.length;

  if (childWorktrees.length === 0) {
    return result;
  }

  let targets: WorktreeEntry[];
  if (opts.onlyBranch) {
    targets = childWorktrees.filter(w => w.branch === opts.onlyBranch);
  } else {
    const merged = listMergedBranches(mainRepo);
    targets = childWorktrees.filter(w => w.branch !== null && merged.has(w.branch));
  }

  result.mergedBranches = targets
    .map(t => t.branch)
    .filter((b): b is string => b !== null);

  if (targets.length === 0) {
    return result;
  }

  const adoptedSqliteIds: number[] = [];

  let db: import('bun:sqlite').Database | null = null;
  try {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    db = new Database(dbPath);

    // Schema guard: adoption may be invoked on worker startup before
    // DatabaseManager runs migrations. If the `merged_into_project` column
    // isn't present yet, prepared statements below will fail with
    // "no such column", silently skipping adoption until the next restart.
    // Return early so the next boot (post-migration) picks this up.
    interface ColumnInfo { name: string }
    const obsColumns = db
      .prepare('PRAGMA table_info(observations)')
      .all() as ColumnInfo[];
    const sumColumns = db
      .prepare('PRAGMA table_info(session_summaries)')
      .all() as ColumnInfo[];
    const obsHasColumn = obsColumns.some(c => c.name === 'merged_into_project');
    const sumHasColumn = sumColumns.some(c => c.name === 'merged_into_project');
    if (!obsHasColumn || !sumHasColumn) {
      logger.debug(
        'SYSTEM',
        'Worktree adoption skipped (merged_into_project column missing; will run after migration)',
        { obsHasColumn, sumHasColumn }
      );
      return result;
    }

    // Select ALL observations for the worktree project (both unadopted rows
    // AND rows already stamped to this parent), not just unadopted ones. This
    // ensures a transient Chroma failure on a prior run gets retried the next
    // time adoption executes: SQL may already be stamped, but we re-include
    // those ids in the Chroma patch set (updateMergedIntoProject is idempotent
    // — it replays the same metadata write).
    const selectObsForPatch = db.prepare(
      `SELECT id FROM observations
       WHERE project = ?
         AND (merged_into_project IS NULL OR merged_into_project = ?)`
    );
    const updateObs = db.prepare(
      'UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );
    const updateSum = db.prepare(
      'UPDATE session_summaries SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );

    const adoptWorktreeInTransaction = (wt: WorktreeEntry) => {
      const worktreeProject = getProjectContext(wt.path).primary;
      const rows = selectObsForPatch.all(
        worktreeProject,
        parentProject
      ) as Array<{ id: number }>;

      const obsChanges = updateObs.run(parentProject, worktreeProject).changes;
      const sumChanges = updateSum.run(parentProject, worktreeProject).changes;
      for (const r of rows) adoptedSqliteIds.push(r.id);
      result.adoptedObservations += obsChanges;
      result.adoptedSummaries += sumChanges;
    };

    const tx = db.transaction(() => {
      for (const wt of targets) {
        try {
          adoptWorktreeInTransaction(wt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('SYSTEM', 'Worktree adoption skipped branch', {
            worktree: wt.path,
            branch: wt.branch,
            error: message
          });
          result.errors.push({ worktree: wt.path, error: message });
        }
      }
      if (dryRun) {
        // Throw a dedicated error to force rollback. Caught below by instanceof check.
        throw new DryRunRollback();
      }
    });

    try {
      tx();
    } catch (err) {
      if (err instanceof DryRunRollback) {
        // Rolled back as intended for dry-run — counts are still useful.
      } else if (err instanceof Error) {
        logger.error('SYSTEM', 'Worktree adoption transaction failed', {}, err);
        throw err;
      } else {
        logger.error('SYSTEM', 'Worktree adoption transaction failed with non-Error', { error: String(err) });
        throw err;
      }
    }
  } finally {
    db?.close();
  }

  if (!dryRun && adoptedSqliteIds.length > 0) {
    const chromaSync = new ChromaSync('claude-mem');
    try {
      await chromaSync.updateMergedIntoProject(adoptedSqliteIds, parentProject);
      result.chromaUpdates = adoptedSqliteIds.length;
    } catch (err) {
      if (err instanceof Error) {
        logger.error(
          'SYSTEM',
          'Worktree adoption Chroma patch failed (SQL already committed)',
          { parentProject, sqliteIdCount: adoptedSqliteIds.length },
          err
        );
      } else {
        logger.error(
          'SYSTEM',
          'Worktree adoption Chroma patch failed (SQL already committed)',
          { parentProject, sqliteIdCount: adoptedSqliteIds.length, error: String(err) }
        );
      }
      result.chromaFailed = adoptedSqliteIds.length;
    } finally {
      await chromaSync.close();
    }
  }

  if (
    result.adoptedObservations > 0 ||
    result.adoptedSummaries > 0 ||
    result.chromaUpdates > 0 ||
    result.errors.length > 0
  ) {
    logger.info('SYSTEM', 'Worktree adoption applied', {
      parentProject,
      dryRun,
      scannedWorktrees: result.scannedWorktrees,
      mergedBranches: result.mergedBranches,
      adoptedObservations: result.adoptedObservations,
      adoptedSummaries: result.adoptedSummaries,
      chromaUpdates: result.chromaUpdates,
      chromaFailed: result.chromaFailed,
      errors: result.errors.length
    });
  }

  return result;
}

/**
 * Run adoption once per distinct parent repo referenced by recorded cwds.
 *
 * Worker startup adoption cannot use `process.cwd()` as a seed — the daemon is
 * spawned with cwd=marketplace-plugin-dir, which isn't a git repo. Instead, we
 * derive candidate parent repos from `pending_messages.cwd` (the user's actual
 * working directories), dedupe via `resolveMainRepoPath`, and run adoption
 * against each. Failures on individual repos are logged but don't short-circuit
 * the others.
 *
 * Safe to call before `dbManager.initialize()`: opens its own short-lived DB
 * handle (readonly) to enumerate cwds, then delegates to `adoptMergedWorktrees`
 * which opens its own writable handle.
 */
export async function adoptMergedWorktreesForAllKnownRepos(opts: {
  dataDirectory?: string;
  dryRun?: boolean;
} = {}): Promise<AdoptionResult[]> {
  const dataDirectory = opts.dataDirectory ?? DEFAULT_DATA_DIR;
  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const results: AdoptionResult[] = [];

  if (!existsSync(dbPath)) {
    logger.debug('SYSTEM', 'Worktree adoption skipped (no DB yet)', { dbPath });
    return results;
  }

  const uniqueParents = new Set<string>();
  let db: import('bun:sqlite').Database | null = null;
  try {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    db = new Database(dbPath, { readonly: true });

    const hasPending = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).get() as { name: string } | undefined;
    if (!hasPending) {
      logger.debug('SYSTEM', 'Worktree adoption skipped (pending_messages table missing)');
      return results;
    }

    const cwdRows = db.prepare(`
      SELECT cwd FROM pending_messages
      WHERE cwd IS NOT NULL AND cwd != ''
      GROUP BY cwd
    `).all() as Array<{ cwd: string }>;

    for (const { cwd } of cwdRows) {
      const mainRepo = resolveMainRepoPath(cwd);
      if (mainRepo) uniqueParents.add(mainRepo);
    }
  } finally {
    db?.close();
  }

  if (uniqueParents.size === 0) {
    logger.debug('SYSTEM', 'Worktree adoption found no known parent repos');
    return results;
  }

  for (const repoPath of uniqueParents) {
    try {
      const result = await adoptMergedWorktrees({
        repoPath,
        dataDirectory,
        dryRun: opts.dryRun
      });
      results.push(result);
    } catch (err) {
      logger.warn(
        'SYSTEM',
        'Worktree adoption failed for parent repo (continuing)',
        { repoPath, error: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  return results;
}
