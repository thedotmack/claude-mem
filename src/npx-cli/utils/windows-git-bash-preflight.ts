/**
 * Windows-only preflight for claude-mem's Setup hook.
 *
 * Runtime hooks in plugin/hooks/hooks.json run the on-PATH `claude-mem`
 * launcher in exec form, with no shell, so they do not need bash (#3605). Only
 * the Setup hook (version-check.js) still declares `"shell": "bash"`, and
 * Claude Code fires it only for `claude --init` / `--init-only` /
 * `-p --maintenance`. On Windows, Claude Code resolves that bash through a
 * closed chain — verified against the Claude Code CLI binary, no WSL fallback
 * exists:
 *
 *   1. CLAUDE_CODE_GIT_BASH_PATH env var
 *   2. C:\Program Files\Git\bin\bash.exe
 *   3. C:\Program Files (x86)\Git\bin\bash.exe
 *   4. `git` resolved on PATH, then ../../bin/bash.exe relative to it
 *   5. null — Claude Code throws, and the Setup hook throws with it
 *
 * Step 4 here deliberately checks EVERY `git` hit on PATH, not just the first:
 * Git for Windows puts both mingw64\bin\git.exe and cmd\git.exe on PATH, and
 * when mingw64\bin sorts first the ../../bin derivation lands on
 * <Git>\mingw64\bin\bash.exe, which does not exist — while the cmd\git.exe hit
 * derives the real <Git>\bin\bash.exe. Bash resolves fine on such machines, so
 * a first-hit-only replica reports a false negative (#3661 tester report).
 *
 * This module replicates the same chain so the installer and doctor can say
 * plainly, as a warning, that the Setup hook will not run. Memory capture does
 * not depend on it. It does not change hook behavior.
 */

import { existsSync } from 'fs';
import { win32 } from 'path';
import { lookupWindowsCommandCandidates } from '../../shared/spawn.js';

export const STANDARD_GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

export const GIT_BASH_REMEDIATION =
  'Git Bash not found. claude-mem\'s runtime hooks do not need it (they run the claude-mem launcher ' +
  'directly), but its Setup hook, which runs only for `claude --init` / `--maintenance`, uses bash, ' +
  'and Claude Code resolves bash via Git for Windows on Windows. To use that Setup hook, install Git ' +
  'for Windows (https://git-scm.com/download/win), or if bash is installed somewhere non-standard, ' +
  'set CLAUDE_CODE_GIT_BASH_PATH to the full path of bash.exe.';

/** Filesystem access this check needs, injectable so tests never touch the real FS. */
export interface GitBashProbe {
  fileExists: (path: string) => boolean;
  /** Every `git` hit on PATH, in `where` order — injectable for tests. */
  lookupGitCandidates: () => string[];
}

const defaultProbe: GitBashProbe = {
  fileExists: existsSync,
  lookupGitCandidates: () => lookupWindowsCommandCandidates('git'),
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

  for (const gitOnPath of probe.lookupGitCandidates()) {
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
