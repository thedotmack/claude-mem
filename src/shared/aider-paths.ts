import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * Aider path resolution (mirror src/shared/kimi-paths.ts).
 *
 * Aider searches `.aider.conf.yml` in git root, then the working directory,
 * then $HOME (aider.chat/docs/config/aider_conf). The memory file is
 * project-relative so it never collides with user files and stays portable:
 * `.claude-mem/aider-memory.md` under the directory that owns the config.
 * A global (~/.aider.conf.yml) config still gets a per-project memory file —
 * the `read:` entry is resolved by Aider relative to where it runs.
 */
export const AIDER_CONFIG_FILENAME = '.aider.conf.yml';
export const AIDER_MEMORY_DIRNAME = '.claude-mem';
export const AIDER_MEMORY_FILENAME = 'aider-memory.md';
/** Project-relative path written into `.aider.conf.yml` `read:`. */
export const AIDER_MEMORY_RELATIVE_PATH = `${AIDER_MEMORY_DIRNAME}/${AIDER_MEMORY_FILENAME}`;

export function aiderHomeConfigPath(): string {
  return path.join(homedir(), AIDER_CONFIG_FILENAME);
}

/** Git repository root for `dir`, or null when `dir` is not inside a repo. */
export function findAiderGitRoot(dir: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).replace(/\n$/, '');
    return root || null;
  } catch {
    return null;
  }
}

/** Config search order: git root, working directory, $HOME (deduped). */
export function aiderConfigSearchPaths(cwd: string = process.cwd()): string[] {
  const candidates = [];
  const gitRoot = findAiderGitRoot(cwd);
  if (gitRoot) candidates.push(path.join(gitRoot, AIDER_CONFIG_FILENAME));
  candidates.push(path.join(cwd, AIDER_CONFIG_FILENAME));
  candidates.push(aiderHomeConfigPath());
  return [...new Set(candidates)];
}

/** First existing config in search order, else where a new one belongs. */
export function resolveAiderConfigPath(cwd: string = process.cwd()): string {
  for (const candidate of aiderConfigSearchPaths(cwd)) {
    if (existsSync(candidate)) return candidate;
  }
  return aiderConfigSearchPaths(cwd)[0];
}

/**
 * Directory that owns the memory file for `configPath`: the config's own
 * directory, except a global ~/.aider.conf.yml, whose memory file belongs to
 * the project the user is working in (git root, else cwd).
 */
export function aiderProjectDirForConfig(configPath: string, cwd: string = process.cwd()): string {
  if (path.resolve(configPath) === path.resolve(aiderHomeConfigPath())) {
    return findAiderGitRoot(cwd) ?? cwd;
  }
  return path.dirname(configPath);
}

/** Absolute path of the per-project memory file for `configPath`. */
export function aiderMemoryFilePath(configPath: string, cwd: string = process.cwd()): string {
  return path.join(aiderProjectDirForConfig(configPath, cwd), AIDER_MEMORY_DIRNAME, AIDER_MEMORY_FILENAME);
}
