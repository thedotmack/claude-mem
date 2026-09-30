import path from 'path';
import { existsSync, realpathSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { expandHome } from '../shared/expand-home.js';
import { CLAUDE_CONFIG_DIR } from '../shared/paths.js';
import { logger } from './logger.js';
import { detectWorktree, type WorktreeInfo } from './worktree.js';

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

export function getProjectName(
  cwd: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return UNKNOWN_PROJECT_NAME;
  }

  const expanded = expandHome(cwd, platform);

  // #2663 — inside a repo, the git root names the project so the name is stable
  // across subdirectories and worktrees. #3194 — outside one, the nearest
  // claude-mem marker root does; otherwise the cwd basename.
  const repoRoot = findGitRepoRoot(expanded);
  const nameSource = repoRoot ?? findMarkerProjectRoot(expanded) ?? expanded;
  return projectNameFromSource(cwd, nameSource);
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  /** Set when `primary` is a composite key for a submodule (#2842). */
  isSubmodule: boolean;
  allProjects: string[];
}

/**
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
    return { primary: fallback, parent: null, isWorktree: false, isSubmodule: false, allProjects: [fallback] };
  }

  const expandedCwd = expandHome(cwd, platform);
  // One git spawn per resolution: the toplevel both names the project and
  // anchors worktree detection. #3262 — detectWorktree stats `<dir>/.git`, which
  // only exists at the worktree root, so a session started in a subdirectory
  // must detect from the toplevel to get the parent/worktree compound key.
  const repoRoot = findGitRepoRoot(expandedCwd);
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
      allProjects: [...new Set([parent, ...legacyKeys, primary])].filter(key => key !== primary).concat(primary)
    };
  }

  // A marker re-keys launches from below its root. Keep the key those launches
  // were stored under before the marker existed (the cwd basename) readable as
  // an alias, so adding a marker never hides existing memory. Writes use
  // `primary` only.
  if (markerRoot && path.resolve(markerRoot) !== path.resolve(expandedCwd)) {
    const legacyKey = projectNameFromSource(cwd, expandedCwd);
    if (legacyKey !== cwdProjectName && legacyKey !== UNKNOWN_PROJECT_NAME) {
      return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [legacyKey, cwdProjectName] };
    }
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, isSubmodule: false, allProjects: [cwdProjectName] };
}
