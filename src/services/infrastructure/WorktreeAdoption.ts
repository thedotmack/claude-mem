
import path from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { paths } from '../../shared/paths.js';

const DEFAULT_DATA_DIR = paths.dataDir();

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

const GIT_TIMEOUT_MS = 15000;

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

function gitCapture(cwd: string, args: string[]): string | null {
  const startTime = Date.now();
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS
  });
  const duration = Date.now() - startTime;
  
  if (duration > 1000) {
    logger.debug('GIT', `Slow git operation: git -C ${cwd} ${args.join(' ')} took ${duration}ms`);
  }

  if (r.error) {
    logger.warn('GIT', `Git operation failed: git -C ${cwd} ${args.join(' ')}`, {
      error: r.error.message,
      timedOut: r.error.name === 'ETIMEDOUT' || (r.status === null && r.signal === 'SIGTERM')
    });
    return null;
  }

  if (r.status !== 0) {
    logger.debug('GIT', `Git returned non-zero exit code ${r.status}: git -C ${cwd} ${args.join(' ')}`, {
      stderr: r.stderr?.toString().trim()
    });
    return null;
  }
  return (r.stdout ?? '').trim();
}

function resolveMainRepoPath(cwd: string): string | null {
  const commonDir = gitCapture(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ]);
  if (!commonDir) return null;

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
