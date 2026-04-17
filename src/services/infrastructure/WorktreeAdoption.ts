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

function gitCapture(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
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
 * Idempotent: a row is only touched when its `merged_into_project IS NULL`.
 *
 * Chroma is patched AFTER SQL commits. Chroma failure does NOT roll back SQL —
 * SQL is source of truth; a subsequent run will retry the Chroma patch because
 * the filter in `updateMergedIntoProject` keys on `sqlite_id`.
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

    const selectObs = db.prepare(
      'SELECT id FROM observations WHERE project = ? AND merged_into_project IS NULL'
    );
    const updateObs = db.prepare(
      'UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );
    const updateSum = db.prepare(
      'UPDATE session_summaries SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );

    const tx = db.transaction(() => {
      for (const wt of targets) {
        try {
          const worktreeProject = getProjectContext(wt.path).primary;
          const rows = selectObs.all(worktreeProject) as Array<{ id: number }>;
          for (const r of rows) adoptedSqliteIds.push(r.id);

          const obsChanges = updateObs.run(parentProject, worktreeProject).changes;
          const sumChanges = updateSum.run(parentProject, worktreeProject).changes;
          result.adoptedObservations += obsChanges;
          result.adoptedSummaries += sumChanges;
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
        // Throw to force rollback. Sentinel caught below.
        throw new Error('__DRY_RUN_ROLLBACK__');
      }
    });

    try {
      tx();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === '__DRY_RUN_ROLLBACK__') {
        // Rolled back as intended for dry-run — counts are still useful.
      } else {
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
      logger.error(
        'CHROMA_SYNC',
        'Worktree adoption Chroma patch failed (SQL already committed)',
        { parentProject, sqliteIdCount: adoptedSqliteIds.length },
        err as Error
      );
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
