
import path from 'path';
import { existsSync, realpathSync } from 'fs';
import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';
import { getPathModeProjectContext, getProjectContext } from '../../utils/project-name.js';
import { bareRepositoryProjectName } from '../../utils/worktree.js';
import { ChromaSync, MergedIntoProjectTarget } from '../sync/ChromaSync.js';
import { emitRemapProject, hasSyncLane } from '../sync/remap-outbox.js';
import { paths } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { openConfiguredSqliteDatabase } from '../sqlite/connection.js';

const DEFAULT_DATA_DIR = paths.dataDir();

/** Let pending I/O callbacks (HTTP requests) run before more synchronous work. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export interface AdoptionResult {
  repoPath: string;
  parentProject: string;
  scannedWorktrees: number;
  mergedBranches: string[];
  /** Keys adopted because their checkout is gone, merged or not (#2864). */
  orphanedWorktrees: string[];
  adoptedObservations: number;
  adoptedSummaries: number;
  /** Bare-repo worktree rows moved off the folder-only key they were stored under before #4958. */
  rekeyedSessions: number;
  rekeyedObservations: number;
  rekeyedSummaries: number;
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
  head: string | null;
}

interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

const GIT_TIMEOUT_MS = 15000;

/** Extra wait for git to exit after the SIGTERM, before we stop waiting. */
const GIT_KILL_GRACE_MS = 5000;

function gitTimeoutError(): Error {
  const error = new Error('spawn git ETIMEDOUT');
  error.name = 'ETIMEDOUT';
  return error;
}

/**
 * Run git without holding the event loop.
 *
 * This used to be `spawnSync` with `timeout: GIT_TIMEOUT_MS`, so a single git
 * call on a slow or sleeping volume froze the worker's event loop for the
 * whole timeout. Adoption shares that loop with `/api/health`: the health
 * endpoint went silent for up to 15 s per git call, hooks reclaimed the worker
 * as wedged, and every restart re-ran adoption and the Chroma backfill
 * (#4741). Async (spawn, not spawnSync), like runNpmStrict in
 * npx-cli/install/npm-install-helper.ts, keeping the timeout, the error
 * classification and windowsHide semantics of the spawnSync it replaces.
 */
function spawnGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>(resolve => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: GitCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A volume that fell asleep can leave git ignoring SIGTERM; stop
      // waiting either way — an unsettled promise would strand the sweep.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        settle({ status: null, stdout: '', stderr: '', error: gitTimeoutError() });
      }, GIT_KILL_GRACE_MS);
    }, GIT_TIMEOUT_MS);

    child.on('error', err => {
      spawnError = err;
    });
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', code => {
      if (timedOut) {
        settle({ status: null, stdout: '', stderr: '', error: gitTimeoutError() });
        return;
      }
      if (spawnError) {
        settle({ status: null, stdout: '', stderr: '', error: spawnError });
        return;
      }
      settle({ status: code, stdout, stderr, error: undefined });
    });
    // Bun can throw from spawn() itself while it sets up stdio; report that
    // as a failed git call instead of a rejection that stops the sweep.
  }).catch((err: unknown) => ({
    status: null,
    stdout: '',
    stderr: '',
    error: err instanceof Error ? err : new Error(String(err))
  }));
}

async function gitRun(cwd: string, args: string[]): Promise<GitCommandResult> {
  const startTime = Date.now();
  const r = await spawnGit(cwd, args);
  const duration = Date.now() - startTime;

  if (duration > 1000) {
    logger.debug('GIT', `Slow git operation: git -C ${cwd} ${args.join(' ')} took ${duration}ms`);
  }

  if (r.error) {
    logger.warn('GIT', `Git operation failed: git -C ${cwd} ${args.join(' ')}`, {
      error: r.error.message,
      timedOut: r.error.name === 'ETIMEDOUT'
    });
    return { status: r.status, stdout: '', stderr: '', error: r.error };
  }

  if (r.status !== 0) {
    logger.debug('GIT', `Git returned non-zero exit code ${r.status}: git -C ${cwd} ${args.join(' ')}`, {
      stderr: r.stderr.trim()
    });
    return { status: r.status, stdout: '', stderr: r.stderr, error: undefined };
  }
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr, error: undefined };
}

async function gitCapture(cwd: string, args: string[]): Promise<string | null> {
  const result = await gitRun(cwd, args);
  return result.status === 0 ? result.stdout : null;
}

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

async function resolveMainRepoPath(cwd: string): Promise<string | null> {
  const commonDir = await gitCapture(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir'
  ]);
  if (!commonDir) return null;

  // A submodule's --git-common-dir is `<super>/.git/modules/<name>`, which
  // neither branch below matches — discovery used to return the gitdir itself.
  // Anchor on the same marker detectWorktree uses, so discovery and key
  // derivation agree (#2842).
  const modulesMarker = `${path.sep}.git${path.sep}modules${path.sep}`;
  const normalized = commonDir.split('/').join(path.sep);
  const modulesIndex = normalized.indexOf(modulesMarker);
  if (modulesIndex !== -1) {
    const superprojectRoot = normalized.slice(0, modulesIndex);
    return existsSync(superprojectRoot) ? superprojectRoot : null;
  }

  if (commonDir.endsWith('/.git')) {
    const mainRoot = path.dirname(commonDir);
    return existsSync(mainRoot) ? mainRoot : null;
  }

  // A bare repository (`app.git`, `project/.bare`) has no checkout of its own:
  // the repository is the bare directory, and detectWorktree keys its worktrees
  // under bareRepositoryProjectName (#4958).
  if (await gitCapture(commonDir, ['rev-parse', '--is-bare-repository']) === 'true') {
    return commonDir;
  }

  const mainRoot = commonDir.replace(/\.git$/, '');
  return existsSync(mainRoot) ? mainRoot : null;
}

/** Whether `candidate` is `directory` or inside it, comparing real paths where they exist. */
function isPathInside(candidate: string, directory: string): boolean {
  const real = (p: string) => {
    try { return realpathSync(p); } catch { return path.resolve(p); }
  };
  const relative = path.relative(real(directory), real(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Before #4958 a worktree of a bare repository was not recognised as one, so its
 * rows were keyed on the worktree folder alone (`main`), a key every bare
 * repository's `main` worktree shared. Re-key the sessions whose recorded
 * checkout is inside this live worktree, with their observations and summaries,
 * to the worktree's `<repo>/<worktree>` key. Sessions recorded elsewhere, or
 * keyed from a git-remote slug or an environment name, keep their key.
 */
function rekeyBareWorktreeSessions(
  db: import('bun:sqlite').Database,
  worktreePath: string,
  legacyKey: string,
  worktreeKey: string,
  evidence: WriterEvidence,
  syncLane: boolean
): { sessions: number; observations: number; summaries: number } {
  const counts = { sessions: 0, observations: 0, summaries: 0 };
  if (!evidence.sessionCwd) return counts;
  const keySource = evidence.sessionKeySource ? 'project_key_source' : 'NULL';
  const sessions = db.prepare(
    `SELECT id, memory_session_id, cwd, ${keySource} AS key_source FROM sdk_sessions
      WHERE project = ? AND cwd IS NOT NULL AND cwd != ''`
  ).all(legacyKey) as Array<{ id: number; memory_session_id: string | null; cwd: string; key_source: string | null }>;

  const updateSession = db.prepare('UPDATE sdk_sessions SET project = ? WHERE id = ?');
  const updateObs = db.prepare('UPDATE observations SET project = ? WHERE project = ? AND memory_session_id = ?');
  const updateSum = db.prepare('UPDATE session_summaries SET project = ? WHERE project = ? AND memory_session_id = ?');
  for (const session of sessions) {
    if (session.key_source !== null && session.key_source !== 'path') continue;
    if (!isPathInside(session.cwd, worktreePath)) continue;
    counts.sessions += updateSession.run(worktreeKey, session.id).changes;
    if (!session.memory_session_id) continue;
    if (syncLane) {
      const remap = emitRemapProject(
        db,
        { project: legacyKey, memory_session_id: session.memory_session_id },
        { project: worktreeKey }
      );
      counts.observations += remap.observations;
      counts.summaries += remap.summaries;
    } else {
      counts.observations += updateObs.run(worktreeKey, legacyKey, session.memory_session_id).changes;
      counts.summaries += updateSum.run(worktreeKey, legacyKey, session.memory_session_id).changes;
    }
  }
  return counts;
}

async function listWorktrees(mainRepo: string): Promise<WorktreeEntry[]> {
  const raw = await gitCapture(mainRepo, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim() || null;
    } else if (line.startsWith('branch ')) {
      const refName = line.slice('branch '.length).trim();
      current.branch = refName.startsWith('refs/heads/')
        ? refName.slice('refs/heads/'.length)
        : refName;
    } else if (line === '' && current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? null });
  return entries;
}

/**
 * Composite keys with no live checkout. Their parent association can no longer
 * be recomputed from disk, so they are unreachable by every read path and are
 * adopted regardless of merge status — the alternative to adopting is not
 * "kept separate", it is "lost" (#2864).
 *
 * Range-matched rather than `LIKE 'parent/%'`: `_` is a LIKE wildcard and
 * common in repo names, so `my_app/%` would also match another repo's
 * `myXapp/...`.
 */
function listOrphanProjectKeys(
  db: import('bun:sqlite').Database,
  parentProject: string,
  liveWorktreeProjects: Set<string>,
  /** False narrows to keys still awaiting adoption, for reporting. */
  includeAlreadyAdopted: boolean,
  writerEvidence: WriterEvidence
): string[] {
  const prefix = `${parentProject}/`;
  // '0' is the byte after '/', so [prefix, upperBound) is exactly the children.
  const upperBound = `${parentProject}0`;
  // Mirrors selectObsForPatch: already-adopted rows stay eligible so a Chroma
  // patch that failed after the SQL commit can retry. The update itself is a
  // no-op for them, so re-runs neither double-count nor bump sync revs.
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
      // Nested submodules key on their path under the superproject, so a
      // composite is not always one level deep (#2842).
      return project.length > prefix.length;
    })
    .filter(project => wasWrittenUnderRepository(db, project, parentProject, writerEvidence));
}

/** What this database can tell about who wrote a key (older schemas lack some of it). */
interface WriterEvidence {
  /** sdk_sessions.cwd (v53, #2864). */
  sessionCwd: boolean;
  /** sdk_sessions.project_key_source (v59). */
  sessionKeySource: boolean;
  /** origin_device_id on observations and session_summaries (cloud sync). */
  originDevice: boolean;
  /** When this database began recording checkouts (v53 applied), epoch ms; null if it never has. */
  checkoutsRecordedSinceEpoch: number | null;
}

function readWriterEvidence(
  db: import('bun:sqlite').Database,
  obsColumns: Array<{ name: string }>,
  sumColumns: Array<{ name: string }>
): WriterEvidence {
  const sessionColumns = db.prepare('PRAGMA table_info(sdk_sessions)').all() as Array<{ name: string }>;
  const checkoutsRecorded = db.prepare(
    'SELECT applied_at FROM schema_versions WHERE version = 53'
  ).get() as { applied_at: string } | undefined;
  const checkoutsRecordedSinceEpoch = checkoutsRecorded ? Date.parse(checkoutsRecorded.applied_at) : NaN;
  return {
    sessionCwd: sessionColumns.some(c => c.name === 'cwd'),
    sessionKeySource: sessionColumns.some(c => c.name === 'project_key_source'),
    originDevice: obsColumns.some(c => c.name === 'origin_device_id')
      && sumColumns.some(c => c.name === 'origin_device_id'),
    checkoutsRecordedSinceEpoch: Number.isFinite(checkoutsRecordedSinceEpoch) ? checkoutsRecordedSinceEpoch : null,
  };
}

/**
 * Whether the rows under a candidate key can have been written by a checkout of
 * this repository. The key's shape cannot tell on its own: with
 * CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote a repository is named by its
 * `org/repo` slug (#2827), and an environment (#2737) by any name the user
 * picks; either can look exactly like `<parent>/<worktree>` under a repository
 * whose folder has the right name, and adopting it would fold another
 * repository's memory into this one (and sync that to every device).
 *
 * - Keys whose sessions recorded their checkout (sdk_sessions.cwd): every
 *   recorded key must be folder-derived (project_key_source 'path', or NULL
 *   before key sources were recorded). Environment names and remote slugs do
 *   not identify orphaned worktrees, whether the checkout exists or not.
 *   Every checkout that still exists must resolve into this repository using
 *   its folder-based identity; a live repo-named worktree resolves to the
 *   repository itself (#3641). Current read scopes cannot establish ownership
 *   or hide historical folder-derived keys from adoption (#5022).
 * - Keys with nothing recorded: sessions record their checkout since v53, so
 *   only rows older than that are attributable, and those predate slug and
 *   environment naming. They must also be rows this device wrote: a replica's
 *   rows are adopted by the device that wrote them, and that remap reaches this
 *   one through sync. Newer rows without a recorded checkout (an import, say)
 *   have an unknown writer and stay where they are.
 */
function wasWrittenUnderRepository(
  db: import('bun:sqlite').Database,
  candidateKey: string,
  parentProject: string,
  evidence: WriterEvidence
): boolean {
  if (evidence.sessionCwd) {
    const keySource = evidence.sessionKeySource ? 'project_key_source' : 'NULL';
    const checkouts = db.prepare(
      `SELECT DISTINCT cwd, ${keySource} AS key_source FROM sdk_sessions
        WHERE project = ? AND cwd IS NOT NULL AND cwd != ''`
    ).all(candidateKey) as Array<{ cwd: string; key_source: string | null }>;
    if (checkouts.length > 0) {
      return checkouts.every(({ cwd, key_source }) => {
        if (key_source !== null && key_source !== 'path') return false;
        if (!existsSync(cwd)) return true;
        const context = getPathModeProjectContext(cwd);
        return context.primary === parentProject || context.parent === parentProject;
      });
    }
  }

  const conditions = ['project = ?'];
  const params: Array<string | number> = [candidateKey];
  if (evidence.originDevice) {
    conditions.push('origin_device_id IS NULL');
  }
  if (evidence.checkoutsRecordedSinceEpoch !== null) {
    conditions.push('created_at_epoch < ?');
    params.push(evidence.checkoutsRecordedSinceEpoch);
  }
  const where = conditions.join(' AND ');
  const attributableRow = db.prepare(
    `SELECT 1 AS attributable FROM observations WHERE ${where}
     UNION ALL
     SELECT 1 AS attributable FROM session_summaries WHERE ${where}
     LIMIT 1`
  ).get(...params, ...params);
  return attributableRow != null;
}

/**
 * Submodule checkouts, which share the composite key with worktrees but are not
 * reported by `git worktree list` — without them a live submodule looks exactly
 * like a deleted worktree to the orphan sweep. Existence-filtered, so a deleted
 * submodule is still adopted (#2842).
 */
async function listSubmodulePaths(mainRepo: string): Promise<string[]> {
  const raw = await gitCapture(mainRepo, ['submodule', 'status', '--recursive']);
  if (!raw) return [];

  const paths: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // ` <sha> <path> (<describe>)`; paths may contain spaces.
    const match = line.match(/^[\s+\-U]*[0-9a-f]{7,40}\s+(.+?)(?:\s+\([^)]*\))?$/);
    if (!match) continue;
    const absolute = path.resolve(mainRepo, match[1]);
    if (existsSync(absolute)) paths.push(absolute);
  }
  return paths;
}

async function resolveCandidateOids(mainRepo: string): Promise<Set<string>> {
  const oids = new Set<string>();
  for (const ref of ['HEAD', 'origin/HEAD', 'origin/main', 'origin/master']) {
    const result = await gitRun(mainRepo, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (result.status === 0 && result.stdout) oids.add(result.stdout);
  }
  return oids;
}

export async function hasProvenAncestry(mainRepo: string, worktreeHead: string, candidateOids: Set<string>): Promise<boolean> {
  for (const candidateOid of candidateOids) {
    const result = await gitRun(mainRepo, ['merge-base', '--is-ancestor', worktreeHead, candidateOid]);
    if (result.status === 0 && !result.error) return true;
    // Status 1 is a known negative. Spawn failures and other statuses remain
    // conservative by simply leaving this worktree unselected.
  }
  return false;
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

  const mainRepo = await resolveMainRepoPath(startCwd);
  // Worktree and submodule composites (`<repo>/<worktree>`) are folder-based
  // keys, so the sweep works on the repository's folder-based key whatever
  // names the repository now: with a git-remote slug (#2827), rows a worktree
  // wrote before the switch are still folded when it merges or is deleted, into
  // a key the repository keeps reading.
  // A bare repository has no `.git` of its own; its worktrees key under the
  // same name detectWorktree gives it (`app.git` → `app`, `app/.bare` → `app`).
  const mainRepoIsBare = mainRepo !== null && !existsSync(path.join(mainRepo, '.git'));
  const parentProject = !mainRepo
    ? ''
    : mainRepoIsBare
      ? bareRepositoryProjectName(mainRepo) ?? ''
      : getPathModeProjectContext(mainRepo).primary;
  const currentProject = mainRepo ? getProjectContext(mainRepo).primary : '';

  const result: AdoptionResult = {
    repoPath: mainRepo ?? startCwd,
    parentProject,
    scannedWorktrees: 0,
    mergedBranches: [],
    orphanedWorktrees: [],
    adoptedObservations: 0,
    adoptedSummaries: 0,
    rekeyedSessions: 0,
    rekeyedObservations: 0,
    rekeyedSummaries: 0,
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

  const allWorktrees = await listWorktrees(mainRepo);
  const childWorktrees = allWorktrees.filter(w => w.path !== mainRepo);
  result.scannedWorktrees = childWorktrees.length;

  let targets: WorktreeEntry[];
  if (opts.onlyBranch) {
    targets = childWorktrees.filter(w => w.branch === opts.onlyBranch);
  } else {
    const candidateOids = await resolveCandidateOids(mainRepo);
    targets = [];
    // Sequential like the pre-async filter: one merge-base probe per
    // candidate, in order, short-circuiting on the same predicates.
    for (const w of childWorktrees) {
      if (w.head === null) continue;
      // A branch at the current parent tip is a valid existing worktree;
      // detached exact-tip checkouts are fresh inspection worktrees.
      if (w.branch === null && candidateOids.has(w.head)) continue;
      if (await hasProvenAncestry(mainRepo, w.head, candidateOids)) targets.push(w);
    }
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
    const writerEvidence = readWriterEvidence(db, obsColumns, sumColumns);

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

    // Every key a live checkout writes, folder-based and current (a slug can
    // sit under the folder key's prefix: `acme/acme`), plus the repository's
    // own current key: the sweep never adopts what a live checkout still writes.
    const liveCheckouts = [...childWorktrees.map(w => w.path), ...(await listSubmodulePaths(mainRepo))];
    const liveWorktreeProjects = new Set([
      currentProject,
      ...liveCheckouts.flatMap(checkout => [
        getPathModeProjectContext(checkout).primary,
        getProjectContext(checkout).primary,
      ]),
    ]);

    // `--branch` is a targeted squash-merge escape hatch; no orphan sweep.
    const orphanProjects = opts.onlyBranch
      ? []
      : listOrphanProjectKeys(db, parentProject, liveWorktreeProjects, true, writerEvidence);
    result.orphanedWorktrees = opts.onlyBranch
      ? []
      : listOrphanProjectKeys(db, parentProject, liveWorktreeProjects, false, writerEvidence);

    const adoptionTargets: Array<{ project: string; label: string }> = [
      ...targets.map(wt => ({ project: getPathModeProjectContext(wt.path).primary, label: wt.path })),
      ...orphanProjects.map(project => ({ project, label: `${project} (worktree removed)` })),
    ]
      // A worktree named after its repo writes to the repo key itself (#3641);
      // "adopting" it would stamp the repo's own rows as merged into
      // themselves and queue a remap op that re-pushes every one of them.
      .filter(target => target.project !== parentProject);

    const tx = db.transaction(() => {
      // Runs first, so the adoption below sees the re-keyed rows (#4958).
      if (mainRepoIsBare) {
        for (const worktree of childWorktrees) {
          const legacyKey = path.basename(worktree.path);
          const worktreeKey = getPathModeProjectContext(worktree.path).primary;
          if (worktreeKey === legacyKey || !existsSync(worktree.path)) continue;
          const rekeyed = rekeyBareWorktreeSessions(db!, worktree.path, legacyKey, worktreeKey, writerEvidence, syncLane);
          result.rekeyedSessions += rekeyed.sessions;
          result.rekeyedObservations += rekeyed.observations;
          result.rekeyedSummaries += rekeyed.summaries;
        }
      }
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

  if (
    !dryRun &&
    adoptedChromaTargets.length > 0 &&
    SettingsDefaultsManager.loadFromFile(path.join(dataDirectory, 'settings.json')).CLAUDE_MEM_CHROMA_ENABLED !== 'false'
  ) {
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
    result.rekeyedSessions > 0 ||
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
      rekeyedSessions: result.rekeyedSessions,
      rekeyedObservations: result.rekeyedObservations,
      rekeyedSummaries: result.rekeyedSummaries,
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

  // The worker starts this sweep fire-and-forget at boot. The git runs below
  // no longer block the loop (#4741), but the SQLite reads are still
  // synchronous: yield before starting and between repositories so the worker
  // keeps serving requests meanwhile (gate P2-3).
  await yieldToEventLoop();

  let recordedCwds: string[] = [];
  let db: import('bun:sqlite').Database | null = null;
  try {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    db = new Database(dbPath, { readonly: true });

    // Discovery reads sdk_sessions.cwd; pending_messages stopped receiving
    // writes in v13.10.0 and is UNIONed only for rows still on disk (#2864).
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
    recordedCwds = cwdRows.map(row => row.cwd);
  } finally {
    db?.close();
  }

  // A checkout that no longer exists cannot lead to a repository; asking git
  // anyway cost a process spawn each (~5 s of blocked worker per 300).
  const uniqueParents = new Set<string>();
  for (const cwd of recordedCwds) {
    if (!existsSync(cwd)) continue;
    const mainRepo = await resolveMainRepoPath(cwd);
    if (mainRepo) uniqueParents.add(mainRepo);
  }

  if (uniqueParents.size === 0) {
    logger.debug('SYSTEM', 'Worktree adoption found no known parent repos');
    return results;
  }

  for (const repoPath of uniqueParents) {
    await yieldToEventLoop();
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
