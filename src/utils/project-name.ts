import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
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
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    logger.debug('PROJECT_NAME', 'git rev-parse failed, falling back to basename', { dir }, err);
    return null;
  }
}

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)

  // #2663 — derive the project name from the git repo root when inside a repo so
  // the name is stable across subdirectories/worktrees. Fall back to the cwd
  // basename when not in a repo.
  const repoRoot = findGitRepoRoot(expanded);
  const nameSource = repoRoot ?? expanded;

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
    return 'unknown-project';
  }

  return basename;
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  allProjects: string[];
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

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
  // #3262 — detectWorktree stats `<cwd>/.git`, which only exists at the
  // worktree root. Resolve the git working-tree root first (same pattern as
  // getProjectName / #2663) so sessions started in a subdirectory still get
  // the parent/worktree compound key.
  const worktreeInfo = detectWorktree(findGitRepoRoot(expandedCwd) ?? expandedCwd);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const composite = buildWorktreeProjectKey(worktreeInfo.parentProjectName, cwdProjectName);
    const allProjects = composite === worktreeInfo.parentProjectName
      ? [worktreeInfo.parentProjectName]
      : [worktreeInfo.parentProjectName, composite];
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects
    };
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
}
