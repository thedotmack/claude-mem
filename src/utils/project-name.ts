import path from 'path';
import { existsSync, realpathSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { expandHome } from '../shared/expand-home.js';
import { CLAUDE_CONFIG_DIR, USER_SETTINGS_PATH } from '../shared/paths.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../shared/SettingsDefaultsManager.js';
import { logger } from './logger.js';
import { detectWorktree, type WorktreeInfo } from './worktree.js';
import { matchProjectEnvironment, parseProjectEnvironments, type ProjectEnvironment } from './project-environments.js';

const CLAUDE_PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';
const UNKNOWN_PROJECT_NAME = 'unknown-project';

/**
 * Resolve the anchor directory for a Claude Code hook payload: prefer
 * `CLAUDE_PROJECT_DIR` (the directory Claude Code declares for the session) over
 * the raw hook cwd, so SDK/subagent temp cwds never become the project identity
 * (#3437). Returns `null` when neither a declared project dir nor a usable cwd
 * exists. Scoped to the hook adapter boundary — callers that already hold an
 * authoritative cwd (worker, transcript, worktree) must not route through this.
 */
export function resolveHookProjectPath(cwd: string | null | undefined): string | null {
  const claudeProjectDir = process.env[CLAUDE_PROJECT_DIR_ENV]?.trim();
  if (claudeProjectDir) {
    return claudeProjectDir;
  }
  if (!cwd || cwd.trim() === '') {
    return null;
  }
  return cwd;
}

/**
 * Resolve the git repository ROOT for a directory, so a project's name is
 * stable across its subdirectories and worktrees (#2663). Returns the absolute
 * repo-root path, or null when `dir` is not inside a git repo (or git is
 * unavailable). `--show-toplevel` resolves to the working-tree root even when
 * invoked from a worktree or a nested subdirectory.
 */
function findGitRepoRoot(dir: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return root || null;
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Not a git repo, git not installed, or dir does not exist — fall back further.
    logger.debug('PROJECT_NAME', 'git rev-parse failed, falling back to non-git root', { dir }, err);
    return null;
  }
}

/**
 * Explicit claude-mem project-root markers (#3194, plan-20 step 1). Outside a
 * git repo, the nearest ancestor holding one names the project, so launches
 * from any of its subdirectories share one key. Only explicit claude-mem files
 * count: generic manifests (package.json, CLAUDE.md, ...) sit in home
 * directories and nested packages, and treating them as roots would silently
 * re-key memory users already have.
 */
const PROJECT_ROOT_MARKERS = ['.claude-mem-project', '.claude-mem.json'] as const;

/** Upper bound on the marker walk; real directory trees are far shallower. */
const MAX_MARKER_WALK_DEPTH = 64;

function realpathOrSelf(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Directories that never name a project. The walk stops before reaching one:
 * a marker in $HOME, TMPDIR or at the filesystem root would collapse every
 * non-git directory below it into a single bucket. Claude's config directory
 * (plugins and marketplaces live there) is excluded entirely.
 */
function markerWalkStops(): string[] {
  return [homedir(), tmpdir(), CLAUDE_CONFIG_DIR].flatMap(dir => {
    const resolved = path.resolve(dir);
    return [resolved, realpathOrSelf(resolved)];
  });
}

/**
 * Walk up from `dir` to the nearest ancestor holding a project-root marker.
 * Returns that directory, or null when the walk reaches a stop directory or the
 * filesystem root first.
 */
function findMarkerProjectRoot(dir: string): string | null {
  const stops = markerWalkStops();
  let current = path.resolve(dir);
  const configDirs = [path.resolve(CLAUDE_CONFIG_DIR), realpathOrSelf(path.resolve(CLAUDE_CONFIG_DIR))];
  if (configDirs.some(configDir => isWithin(current, configDir))) {
    return null;
  }

  for (let depth = 0; depth < MAX_MARKER_WALK_DEPTH; depth++) {
    if (stops.includes(current)) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null; // filesystem root
    }
    if (PROJECT_ROOT_MARKERS.some(marker => existsSync(path.join(current, marker)))) {
      return current;
    }
    current = parent;
  }
  return null;
}

/** The project name for the directory that names it (git toplevel, marker root, or cwd). */
function projectNameFromSource(cwd: string, nameSource: string): string {
  const basename = path.basename(nameSource);

  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return UNKNOWN_PROJECT_NAME;
  }

  return basename;
}

const PROJECT_NAME_SOURCE_SETTING = 'CLAUDE_MEM_PROJECT_NAME_SOURCE';

/**
 * Identity settings, read live. Hooks are short-lived, but the worker resolves
 * projects for its whole lifetime, and a copy cached at startup would keep
 * writing under the old identity after the user switched modes. Re-parsed only
 * when settings.json changes, so the hot path pays one stat.
 */
let identitySettingsCache: { mtimeMs: number; settings: SettingsDefaults } | null = null;

function settingsFileMtimeMs(): number {
  try {
    return statSync(USER_SETTINGS_PATH).mtimeMs;
  } catch {
    return -1;
  }
}

function readIdentitySettings(): SettingsDefaults {
  const mtimeMs = settingsFileMtimeMs();
  if (mtimeMs === -1) {
    // No settings file yet: the defaults. Resolving a project name runs inside
    // every hook and must never write files, and loadFromFile creates a missing
    // settings.json (announcing it on stderr). Callers read env overrides first.
    return SettingsDefaultsManager.getAllDefaults();
  }
  if (identitySettingsCache && identitySettingsCache.mtimeMs === mtimeMs) {
    return identitySettingsCache.settings;
  }
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  identitySettingsCache = { mtimeMs: settingsFileMtimeMs(), settings };
  return settings;
}

function useGitRemoteProjectNames(): boolean {
  const source = process.env[PROJECT_NAME_SOURCE_SETTING] ?? readIdentitySettings().CLAUDE_MEM_PROJECT_NAME_SOURCE;
  return String(source ?? 'path').trim().toLowerCase() === 'git-remote';
}

const PROJECT_ENVIRONMENTS_SETTING = 'CLAUDE_MEM_PROJECT_ENVIRONMENTS';
let environmentsCache: { raw: unknown; environments: ProjectEnvironment[] } | null = null;

/**
 * Named environments (CLAUDE_MEM_PROJECT_ENVIRONMENTS, env wins), read live
 * like the other identity settings and re-parsed only when the raw value
 * changes, so an invalid value warns once rather than on every resolution.
 */
export function loadProjectEnvironments(): ProjectEnvironment[] {
  const raw = process.env[PROJECT_ENVIRONMENTS_SETTING] ?? readIdentitySettings().CLAUDE_MEM_PROJECT_ENVIRONMENTS;
  if (!environmentsCache || environmentsCache.raw !== raw) {
    environmentsCache = { raw, environments: parseProjectEnvironments(raw) };
  }
  return environmentsCache.environments;
}

/**
 * Pure parser: turn a git remote URL into an `org/repo` slug. Handles scp-style
 * (`git@host:org/repo.git`, `host:org/repo`) and URL forms
 * (`https://host[:port]/org/repo.git`, `ssh://git@host/org/repo`), with or
 * without a trailing slash or `.git`. Returns the last two path segments, a
 * single segment when that is all there is, or null for an empty URL, a bare
 * host, or a local remote (`file://`, an absolute or relative path): those name
 * a directory on this machine, not a repository identity. Exported for tests.
 */
export function parseOriginUrlToSlug(url: string): string | null {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return null;
  const isLocal = /^file:/i.test(trimmed)
    || trimmed.startsWith('/')
    || trimmed.startsWith('.')
    || trimmed.startsWith('~')
    || trimmed.startsWith('\\\\')
    || /^[a-z]:[\\/]/i.test(trimmed);
  if (isLocal) return null;

  // Trailing slashes first, then `.git`, so `repo.git/` loses both.
  const cleaned = trimmed.replace(/\/+$/, '').replace(/\.git$/i, '');
  const urlFormMatch = cleaned.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i);
  const scpFormMatch = urlFormMatch ? null : cleaned.match(/^(?:[^/@\s]+@)?[^:/\s]+:(?!\/\/)(.+)$/);
  const pathPart = urlFormMatch?.[1] ?? scpFormMatch?.[1];
  if (!pathPart) return null;

  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length >= 2) return segments.slice(-2).join('/');
  if (segments.length === 1) return segments[0];
  return null;
}

function deriveSlugFromRemote(repoRoot: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return parseOriginUrlToSlug(url);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug('PROJECT_NAME', 'No usable origin remote, keeping the path-based name', { repoRoot }, err);
    return null;
  }
}

/**
 * One `git remote get-url` per repository per process: this runs on the hook
 * and ingest hot path, and a repository's origin rarely changes.
 */
const remoteSlugByRepoRoot = new Map<string, string | null>();

/** The origin slug for `repoRoot` when git-remote naming is on and one can be derived, else null. */
function gitRemoteProjectSlug(repoRoot: string): string | null {
  if (!useGitRemoteProjectNames()) return null;
  if (!remoteSlugByRepoRoot.has(repoRoot)) {
    remoteSlugByRepoRoot.set(repoRoot, deriveSlugFromRemote(repoRoot));
  }
  return remoteSlugByRepoRoot.get(repoRoot) ?? null;
}

export function getProjectName(
  cwd: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return UNKNOWN_PROJECT_NAME;
  }

  const expanded = expandHome(cwd, platform);

  // #2737 — an environment the user configured is an explicit declaration of
  // identity, so it wins over every derived name.
  const environment = matchProjectEnvironment(expanded, loadProjectEnvironments());
  if (environment) {
    return environment;
  }

  // #2663 — inside a repo, the git root names the project so the name is stable
  // across subdirectories and worktrees (or, opt-in, the origin slug: #2827).
  // #3194 — outside one, the nearest claude-mem marker root does; otherwise the
  // cwd basename.
  const repoRoot = findGitRepoRoot(expanded);
  const slug = repoRoot ? gitRemoteProjectSlug(repoRoot) : null;
  if (slug) {
    return slug;
  }
  const nameSource = repoRoot ?? findMarkerProjectRoot(expanded) ?? expanded;
  return projectNameFromSource(cwd, nameSource);
}

/**
 * How a project key was derived: from the folder (git toplevel, worktree or
 * submodule composite, marker root, cwd), from the origin remote's slug
 * (#2827), or from a named environment (#2737). Only a folder-derived key is
 * tied to its checkout, so only its checkout's deletion says anything about it.
 */
export type ProjectKeySource = 'path' | 'git-remote' | 'environment';

const PROJECT_KEY_SOURCES: readonly ProjectKeySource[] = ['path', 'git-remote', 'environment'];

export function isProjectKeySource(value: unknown): value is ProjectKeySource {
  return typeof value === 'string' && (PROJECT_KEY_SOURCES as readonly string[]).includes(value);
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  /** Set when `primary` is a composite key for a submodule (#2842). */
  isSubmodule: boolean;
  allProjects: string[];
  /** How `primary` was derived. */
  keySource: ProjectKeySource;
}

/**
 * Build the worktree compound project key from its parent and worktree names.
 *
 * #3641 — Codex CLI puts worktrees at `~/.codex/worktrees/<id>/<repo>`, so the
 * worktree basename equals the repo name and the naive `<parent>/<worktree>`
 * key doubles to `<repo>/<repo>`. That doubled key matches neither session-start
 * injection nor search, so every observation is orphaned. A worktree named after
 * its repo adds no distinguishing information, so collapse the key to the parent
 * name alone. This is the one shared resolver — both getProjectContext and
 * ProcessManager.classifyCwdForRemap call it so the write path and the migration
 * path agree.
 */
export function buildWorktreeProjectKey(parentProjectName: string, worktreeName: string): string {
  return worktreeName === parentProjectName
    ? parentProjectName
    : `${parentProjectName}/${worktreeName}`;
}

/**
 * A submodule's key component is its path under the superproject, not its
 * basename: two nested submodules can share a leaf repo name
 * (`outer/alpha/shared` and `outer/beta/shared`), and keying on the basename
 * alone collapses them into one project whose observations overwrite each
 * other. Worktrees keep the basename — they usually live outside the parent
 * tree, where a relative path is meaningless.
 */
function submoduleLeaf(info: WorktreeInfo, repoRoot: string): string | null {
  if (!info.isSubmodule || !info.parentRepoPath) return null;
  const relative = path.relative(info.parentRepoPath, repoRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

export function getProjectContext(
  cwd: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): ProjectContext {
  if (!cwd || cwd.trim() === '') {
    const fallback = getProjectName(cwd, platform);
    return { primary: fallback, parent: null, isWorktree: false, isSubmodule: false, allProjects: [fallback], keySource: 'path' };
  }

  const expandedCwd = expandHome(cwd, platform);
  // One git spawn per resolution: the toplevel both names the project and
  // anchors worktree detection. #3262 — detectWorktree stats `<dir>/.git`, which
  // only exists at the worktree root, so a session started in a subdirectory
  // must detect from the toplevel to get the parent/worktree compound key.
  const repoRoot = findGitRepoRoot(expandedCwd);
  const pathContext = getPathProjectContext(cwd, expandedCwd, repoRoot);

  // #2827 — opt-in: the origin remote's `org/repo` slug names every checkout of
  // the repository (worktrees share their remotes), survives renaming the folder
  // and tells same-named repositories apart. The path-mode keys stay readable,
  // so switching modes never hides memory stored before the switch. Only when a
  // slug was actually derived: without one, path mode applies unchanged,
  // worktree compositing included.
  const slug = repoRoot ? gitRemoteProjectSlug(repoRoot) : null;
  const derivedContext = slug ? withPrimaryKey(pathContext, slug, 'git-remote') : pathContext;

  // #2737 — a configured environment wins over every derived name, and the
  // derived keys stay readable so memory stored before the environment existed
  // is not hidden (`project merge` folds it in permanently).
  const environment = matchProjectEnvironment(expandedCwd, loadProjectEnvironments());
  return environment ? withPrimaryKey(derivedContext, environment, 'environment') : derivedContext;
}

/** Re-key a context to `primary`, keeping every key it already read as a read-only alias. */
function withPrimaryKey(context: ProjectContext, primary: string, keySource: ProjectKeySource): ProjectContext {
  return {
    primary,
    parent: null,
    isWorktree: context.isWorktree,
    isSubmodule: context.isSubmodule,
    allProjects: [...context.allProjects.filter(key => key !== primary), primary],
    keySource,
  };
}

/**
 * The folder-based identity (CLAUDE_MEM_PROJECT_NAME_SOURCE=path), whatever
 * names the checkout now. Worktree and submodule composites only exist in this
 * mode, so worktree adoption works on these keys; every other mode keeps them
 * readable (#2827).
 */
export function getPathModeProjectContext(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): ProjectContext {
  const expandedCwd = expandHome(cwd, platform);
  return getPathProjectContext(cwd, expandedCwd, findGitRepoRoot(expandedCwd));
}

/** Path-mode identity: git toplevel (worktrees and submodules composite under their parent), marker root, or cwd. */
function getPathProjectContext(cwd: string, expandedCwd: string, repoRoot: string | null): ProjectContext {
  const markerRoot = repoRoot ? null : findMarkerProjectRoot(expandedCwd);
  const cwdProjectName = projectNameFromSource(cwd, repoRoot ?? markerRoot ?? expandedCwd);

  const checkoutRoot = repoRoot ?? expandedCwd;
  const worktreeInfo = detectWorktree(checkoutRoot);

  if ((worktreeInfo.isWorktree || worktreeInfo.isSubmodule) && worktreeInfo.parentProjectName) {
    const parent = worktreeInfo.parentProjectName;
    // Keys this checkout's rows may already be stored under, kept readable so a
    // re-key never hides existing memory; writes use the primary only.
    // - #2842: before submodules folded into their superproject, a submodule's
    //   rows were stored under its own leaf name.
    // - #3641: a worktree named after its repo now writes to the repo itself;
    //   rows written before sit under the doubled `<repo>/<repo>` key until the
    //   adoption sweep folds them into the repo (merged_into_project).
    let primary: string;
    let legacyKeys: string[];
    if (worktreeInfo.isSubmodule) {
      primary = `${parent}/${submoduleLeaf(worktreeInfo, checkoutRoot) ?? cwdProjectName}`;
      legacyKeys = cwdProjectName !== parent ? [cwdProjectName] : [];
    } else {
      primary = buildWorktreeProjectKey(parent, cwdProjectName);
      legacyKeys = primary === parent ? [`${parent}/${cwdProjectName}`] : [];
    }
    return {
      primary,
      parent,
      isWorktree: worktreeInfo.isWorktree,
      isSubmodule: worktreeInfo.isSubmodule,
      allProjects: [...new Set([parent, ...legacyKeys, primary])].filter(key => key !== primary).concat(primary),
      keySource: 'path',
    };
  }

  // A marker re-keys launches from below its root. Keep the key those launches
  // were stored under before the marker existed (the cwd basename) readable as
  // an alias, so adding a marker never hides existing memory. Writes use
  // `primary` only.
  if (markerRoot && path.resolve(markerRoot) !== path.resolve(expandedCwd)) {
    const legacyKey = projectNameFromSource(cwd, expandedCwd);
    if (legacyKey !== cwdProjectName && legacyKey !== UNKNOWN_PROJECT_NAME) {
      return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [legacyKey, cwdProjectName], keySource: 'path' };
    }
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [cwdProjectName], keySource: 'path' };
}
