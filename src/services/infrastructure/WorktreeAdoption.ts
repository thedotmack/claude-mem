
import path from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { ChromaSync, MergedIntoProjectTarget } from '../sync/ChromaSync.js';
import { emitRemapProject, hasSyncLane } from '../sync/remap-outbox.js';
import { paths } from '../../shared/paths.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';

const DEFAULT_DATA_DIR = paths.dataDir();

export interface AdoptionResult {
  repoPath: string;
  parentProject: string;
  scannedWorktrees: number;
  mergedBranches: string[];
  /**
   * #2864 — composite project keys adopted because their worktree directory is
   * gone, regardless of merge status. Reported separately from mergedBranches
   * so a run never silently widens what it folded into the parent.
   */
  orphanedWorktrees: string[];
  adoptedObservations: number;
  adoptedSummaries: number;
  chromaUpdates: number;
  chromaFailed: number;
  dryRun: boolean;
  errors: Array<{ worktree: string; error: string }>;
}

/**
 * Render per-branch adoption errors as a string for logger CONTEXT values —
 * the logger interpolates context values with a template literal
 * (logger.ts `${k}=${v}`), so a raw object array renders as
 * '[object Object]' (#3378).
 */
export function formatAdoptionErrors(errors: AdoptionResult['errors']): string {
  return errors.map(e => `${e.worktree}: ${e.error}`).join('; ');
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
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
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

  // #2842 — inside a submodule, --git-common-dir is `<super>/.git/modules/<name>`
  // (nested submodules append further `/modules/<name>` segments). Neither
  // branch below matches that shape, so discovery used to hand back the
  // gitdir itself: a path that exists, is not a working tree, and resolves to
  // the wrong project. Walk back past `/.git/modules/` to the superproject
  // root — the same anchor detectWorktree uses for the composite key, so
  // discovery and key derivation agree.
  const modulesMarker = `${path.sep}.git${path.sep}modules${path.sep}`;
  const normalized = commonDir.split('/').join(path.sep);
  const modulesIndex = normalized.indexOf(modulesMarker);
  if (modulesIndex !== -1) {
    const superprojectRoot = normalized.slice(0, modulesIndex);
    return existsSync(superprojectRoot) ? superprojectRoot : null;
  }

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

/**
 * #2864 — composite `parent/leaf` keys in the DB that have no corresponding
 * live worktree. Once the worktree directory is gone, the parent↔worktree
 * association cannot be recomputed from disk, so these rows are unreachable by
 * every read path: `getProjectContext` on the parent yields only `[parent]`,
 * and `merged_into_project` was never stamped. They are orphaned by definition,
 * which is why they are adopted regardless of merge status — the alternative is
 * not "kept separate", it is "lost".
 *
 * Matched with a half-open range rather than `LIKE 'parent/%' ESCAPE`, because
 * comparing exact bytes removes the LIKE-wildcard hazard at the source: `_` is
 * a single-character wildcard and is very common in repo names, so an
 * unescaped `my_app/%` also matches `myXapp/...` — a different repo's
 * worktree. (Both forms plan the same way today: SQLite drives off
 * `idx_observations_merged_into` for the `IS NULL` term rather than the
 * project prefix, so this is a correctness choice, not a speed one.)
 */
function listOrphanProjectKeys(
  db: import('bun:sqlite').Database,
  parentProject: string,
  liveWorktreeProjects: Set<string>,
  /**
   * When false, only keys with rows still awaiting adoption are returned —
   * used for reporting, so a run's output is a changelog of what it folded in
   * rather than a running tally of everything ever adopted.
   */
  includeAlreadyAdopted: boolean
): string[] {
  const prefix = `${parentProject}/`;
  // '0' is the byte immediately after '/', so [prefix, upperBound) is exactly
  // the set of keys beginning with `${parentProject}/`.
  const upperBound = `${parentProject}0`;
  // `merged_into_project IS NULL OR = parent` mirrors selectObsForPatch. The
  // SQL update is a no-op for rows already stamped (emitRemapProject only
  // touches NULLs), so re-runs neither double-count nor bump sync revs — but
  // the rows stay eligible for the Chroma patch, which commits separately and
  // can fail on its own (single-writer data dir). Filtering on NULL alone
  // would drop an adopted key out of the target set permanently and strand
  // its vector metadata, contradicting the "will retry on next run" the CLI
  // reports.
  const adoptedClause = includeAlreadyAdopted
    ? 'AND (merged_into_project IS NULL OR merged_into_project = ?)'
    : 'AND merged_into_project IS NULL';
  const params = includeAlreadyAdopted
    ? [prefix, upperBound, parentProject, prefix, upperBound, parentProject]
    : [prefix, upperBound, prefix, upperBound];

  const rows = db.prepare(
    `SELECT DISTINCT project FROM observations
      WHERE project >= ? AND project < ? ${adoptedClause}
     UNION
     SELECT DISTINCT project FROM session_summaries
      WHERE project >= ? AND project < ? ${adoptedClause}`
  ).all(...params) as Array<{ project: string }>;

  return rows
    .map(r => r.project)
    .filter(project => {
      if (liveWorktreeProjects.has(project)) return false;
      // Composite keys are exactly one level deep (`${parent}/${leaf}`); anything
      // deeper is not a key this resolver produces.
      const leaf = project.slice(prefix.length);
      return leaf.length > 0 && !leaf.includes('/');
    });
}

/**
 * #2842 — absolute paths of this repo's submodule checkouts. Submodules share
 * the `parent/leaf` composite key with worktrees (getProjectContext) but are
 * NOT reported by `git worktree list`, so without this an actively-used
 * submodule looks exactly like a worktree whose directory was deleted and the
 * orphan sweep would fold it into the superproject.
 *
 * Only paths that still exist are returned: a submodule checkout that is gone
 * strands its observations the same way a removed worktree does, and should be
 * adopted rather than protected.
 */
function listSubmodulePaths(mainRepo: string): string[] {
  const raw = gitCapture(mainRepo, ['submodule', 'status', '--recursive']);
  if (!raw) return [];

  const paths: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // ` <sha> <path> (<describe>)`, where a leading -/+/U flags an
    // uninitialized/out-of-sync/conflicted submodule and the trailing
    // describe-suffix is optional. Paths may contain spaces.
    const match = line.match(/^[\s+\-U]*[0-9a-f]{7,40}\s+(.+?)(?:\s+\([^)]*\))?$/);
    if (!match) continue;
    const absolute = path.resolve(mainRepo, match[1]);
    if (existsSync(absolute)) paths.push(absolute);
  }
  return paths;
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
    orphanedWorktrees: [],
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

  const adoptedChromaTargets: MergedIntoProjectTarget[] = [];

  let db: import('bun:sqlite').Database | null = null;
  try {
    db = openConfiguredSqliteDatabase(dbPath);

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
    const selectSumForPatch = db.prepare(
      `SELECT id FROM session_summaries
       WHERE project = ?
         AND (merged_into_project IS NULL OR merged_into_project = ?)`
    );
    const updateObs = db.prepare(
      'UPDATE observations SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );
    const updateSum = db.prepare(
      'UPDATE session_summaries SET merged_into_project = ? WHERE project = ? AND merged_into_project IS NULL'
    );

    // Two-lane sync (plan Phase 3 task 2): this function runs on its OWN DB
    // connection, so the remap must be pure SQL — emitRemapProject bumps
    // sync_rev to R = 1+MAX per the SyncApply contract, re-nulls synced_at
    // on native rows, and queues the remap_project mutation op in the same
    // transaction. Pre-migration DBs (no sync lane yet) take the legacy
    // plain-UPDATE path.
    const syncLane = hasSyncLane(db);

    const adoptWorktreeInTransaction = (worktreeProject: string) => {
      const rows = selectObsForPatch.all(
        worktreeProject,
        parentProject
      ) as Array<{ id: number }>;
      const summaryRows = selectSumForPatch.all(
        worktreeProject,
        parentProject
      ) as Array<{ id: number }>;

      let obsChanges: number;
      let sumChanges: number;
      if (syncLane) {
        const remap = emitRemapProject(
          db!,
          { project: worktreeProject, merged_into_project_is_null: true },
          { merged_into_project: parentProject }
        );
        obsChanges = remap.observations;
        sumChanges = remap.summaries;
      } else {
        obsChanges = updateObs.run(parentProject, worktreeProject).changes;
        sumChanges = updateSum.run(parentProject, worktreeProject).changes;
      }
      for (const r of rows) {
        adoptedChromaTargets.push({ docType: 'observation', sqliteId: r.id });
      }
      for (const r of summaryRows) {
        adoptedChromaTargets.push({ docType: 'session_summary', sqliteId: r.id });
      }
      result.adoptedObservations += obsChanges;
      result.adoptedSummaries += sumChanges;
    };

    // Every nested checkout still on disk — worktrees (merged or in-flight) and
    // submodules alike. Both share the parent/leaf composite key, and neither
    // is an orphan while its directory exists.
    const liveWorktreeProjects = new Set([
      ...childWorktrees.map(w => getProjectContext(w.path).primary),
      ...listSubmodulePaths(mainRepo).map(p => getProjectContext(p).primary),
    ]);

    // `--branch` is a targeted escape hatch for squash-merges; keep it precise
    // and leave the orphan sweep to the default run.
    // Targets include already-adopted keys so a previously-failed Chroma patch
    // can recover; reporting lists only what this run actually folds in.
    const orphanProjects = opts.onlyBranch
      ? []
      : listOrphanProjectKeys(db, parentProject, liveWorktreeProjects, true);
    result.orphanedWorktrees = opts.onlyBranch
      ? []
      : listOrphanProjectKeys(db, parentProject, liveWorktreeProjects, false);

    const adoptionTargets: Array<{ project: string; label: string }> = [
      ...targets.map(wt => ({ project: getProjectContext(wt.path).primary, label: wt.path })),
      ...orphanProjects.map(project => ({ project, label: `${project} (worktree removed)` })),
    ];

    const tx = db.transaction(() => {
      for (const target of adoptionTargets) {
        try {
          adoptWorktreeInTransaction(target.project);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('SYSTEM', 'Worktree adoption skipped branch', {
            worktree: target.label,
            error: message
          });
          result.errors.push({ worktree: target.label, error: message });
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

  if (!dryRun && adoptedChromaTargets.length > 0) {
    const chromaSync = new ChromaSync('claude-mem');
    try {
      await chromaSync.updateMergedIntoProject(adoptedChromaTargets, parentProject);
      result.chromaUpdates = adoptedChromaTargets.length;
    } catch (err) {
      if (err instanceof Error) {
        logger.error(
          'SYSTEM',
          'Worktree adoption Chroma patch failed (SQL already committed)',
          { parentProject, sqliteIdCount: adoptedChromaTargets.length },
          err
        );
      } else {
        logger.error(
          'SYSTEM',
          'Worktree adoption Chroma patch failed (SQL already committed)',
          { parentProject, sqliteIdCount: adoptedChromaTargets.length, error: String(err) }
        );
      }
      result.chromaFailed = adoptedChromaTargets.length;
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
      orphanedWorktrees: result.orphanedWorktrees,
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

    // #2864 — repo discovery reads sdk_sessions.cwd. It used to read
    // pending_messages.cwd, but that queue was replaced by an in-RAM buffer
    // (61fe70a2, v13.10.0) and the table stopped receiving writes, so this
    // sweep found zero repos on every startup and adoption only ever ran via a
    // manual `npx claude-mem adopt`. pending_messages is still UNIONed in so
    // installs that upgrade with pre-13.10 rows still on disk keep their
    // history of known repos until sessions re-populate sdk_sessions.cwd.
    const sessionCols = db
      .prepare('PRAGMA table_info(sdk_sessions)')
      .all() as Array<{ name: string }>;
    if (!sessionCols.some(c => c.name === 'cwd')) {
      logger.debug(
        'SYSTEM',
        'Worktree adoption skipped (sdk_sessions.cwd missing; will run after migration)'
      );
      return results;
    }

    const hasPending = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'"
    ).get() as { name: string } | undefined;

    const cwdSources = ['SELECT cwd FROM sdk_sessions WHERE cwd IS NOT NULL AND cwd != \'\''];
    if (hasPending) {
      cwdSources.push('SELECT cwd FROM pending_messages WHERE cwd IS NOT NULL AND cwd != \'\'');
    }

    const cwdRows = db.prepare(
      `SELECT DISTINCT cwd FROM (${cwdSources.join(' UNION ')})`
    ).all() as Array<{ cwd: string }>;

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
