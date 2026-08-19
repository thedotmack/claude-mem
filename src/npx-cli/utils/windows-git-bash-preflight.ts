/**
 * Windows-only preflight for claude-mem's hooks.
 *
 * Every hook in plugin/hooks/hooks.json declares `"shell": "bash"`. On
 * Windows, Claude Code resolves that through a closed chain — verified
 * against the Claude Code CLI binary, no WSL fallback exists:
 *
 *   1. CLAUDE_CODE_GIT_BASH_PATH env var
 *   2. C:\Program Files\Git\bin\bash.exe
 *   3. C:\Program Files (x86)\Git\bin\bash.exe
 *   4. `git` resolved on PATH, then ../../bin/bash.exe relative to it
 *   5. null — Claude Code throws, and every claude-mem hook throws with it
 *
 * A Windows user who satisfied Claude Code's own requirements via PowerShell
 * (no Git for Windows at all) hits step 5 with a raw, unbranded error. This
 * module replicates the same chain so claude-mem can detect that case ahead
 * of time and say so plainly. It does not change hook behavior — see #3605.
 */

import { existsSync } from 'fs';
import { win32 } from 'path';
import { lookupWindowsCommand } from '../../shared/spawn.js';

export const STANDARD_GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

export const GIT_BASH_REMEDIATION =
  'Git Bash not found. claude-mem hooks require bash, and Claude Code resolves it via Git for ' +
  'Windows on Windows. Install Git for Windows (https://git-scm.com/download/win), or if bash is ' +
  'installed somewhere non-standard, set CLAUDE_CODE_GIT_BASH_PATH to the full path of bash.exe.';

/** Filesystem access this check needs, injectable so tests never touch the real FS. */
export interface GitBashProbe {
  fileExists: (path: string) => boolean;
  /** Resolve `git` on PATH the way Claude Code does — injectable for tests. */
  lookupGitOnPath: () => string | null;
}

const defaultProbe: GitBashProbe = {
  fileExists: existsSync,
  lookupGitOnPath: () => lookupWindowsCommand('git'),
};

export interface GitBashPreflightResult {
  ok: boolean;
  /** bash.exe path claude-mem expects Claude Code to resolve, when found. */
  resolvedPath?: string;
  detail: string;
}

/**
 * Replicates Claude Code's Git Bash resolution chain. A no-op on
 * non-Windows platforms — no probe call is made, since bash is not
 * Windows-specific there.
 */
export function checkWindowsGitBash(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  probe: GitBashProbe = defaultProbe,
): GitBashPreflightResult {
  if (platform !== 'win32') {
    return { ok: true, detail: 'not applicable (non-Windows)' };
  }

  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override && probe.fileExists(override)) {
    return { ok: true, resolvedPath: override, detail: `CLAUDE_CODE_GIT_BASH_PATH=${override}` };
  }

  for (const candidate of STANDARD_GIT_BASH_PATHS) {
    if (probe.fileExists(candidate)) {
      return { ok: true, resolvedPath: candidate, detail: candidate };
    }
  }

  const gitOnPath = probe.lookupGitOnPath();
  if (gitOnPath) {
    // Windows paths regardless of the host platform running this check —
    // win32.join, not the platform-dependent `path` import, so this resolves
    // correctly under tests on macOS/Linux too.
    const candidate = win32.join(gitOnPath, '..', '..', 'bin', 'bash.exe');
    if (probe.fileExists(candidate)) {
      return { ok: true, resolvedPath: candidate, detail: candidate };
    }
  }

  return { ok: false, detail: GIT_BASH_REMEDIATION };
}
