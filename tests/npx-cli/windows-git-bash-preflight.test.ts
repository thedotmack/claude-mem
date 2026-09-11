import { describe, it, expect } from 'bun:test';
import {
  checkWindowsGitBash,
  GIT_BASH_REMEDIATION,
  STANDARD_GIT_BASH_PATHS,
  type GitBashProbe,
} from '../../src/npx-cli/utils/windows-git-bash-preflight.js';

// Windows #3605 (fail-loudly slice) — claude-mem hooks require bash, and on
// Windows Claude Code resolves it via a closed chain (CLAUDE_CODE_GIT_BASH_PATH
// -> standard Git for Windows paths -> `git` on PATH -> null, no WSL fallback).
// This preflight replicates that chain to detect "no Git Bash reachable" ahead
// of the first opaque hook throw.

function probeThatMustNotBeCalled(): GitBashProbe {
  return {
    fileExists: () => {
      throw new Error('fileExists should not be called off-Windows');
    },
    lookupGitCandidates: () => {
      throw new Error('lookupGitCandidates should not be called off-Windows');
    },
  };
}

describe('checkWindowsGitBash', () => {
  it('reports the actionable error when no bash is reachable anywhere in the chain', () => {
    const probe: GitBashProbe = {
      fileExists: () => false,
      lookupGitCandidates: () => [],
    };

    const result = checkWindowsGitBash('win32', {}, probe);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe(GIT_BASH_REMEDIATION);
    expect(result.detail).toContain('Git for Windows');
    expect(result.detail).toContain('CLAUDE_CODE_GIT_BASH_PATH');
  });

  it('passes when CLAUDE_CODE_GIT_BASH_PATH points at a real file', () => {
    const probe: GitBashProbe = {
      fileExists: (path) => path === 'D:\\custom\\bash.exe',
      lookupGitCandidates: () => {
        throw new Error('should not fall through to PATH lookup');
      },
    };

    const result = checkWindowsGitBash(
      'win32',
      { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\custom\\bash.exe' },
      probe,
    );

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe('D:\\custom\\bash.exe');
  });

  it('passes when Git is present at the standard install path', () => {
    const probe: GitBashProbe = {
      fileExists: (path) => path === STANDARD_GIT_BASH_PATHS[0],
      lookupGitCandidates: () => {
        throw new Error('should not fall through to PATH lookup');
      },
    };

    const result = checkWindowsGitBash('win32', {}, probe);

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(STANDARD_GIT_BASH_PATHS[0]);
  });

  it('falls through to `git` on PATH and resolves ../../bin/bash.exe relative to it', () => {
    const probe: GitBashProbe = {
      fileExists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe',
      lookupGitCandidates: () => ['C:\\Program Files\\Git\\cmd\\git.exe'],
    };

    const result = checkWindowsGitBash('win32', {}, probe);

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  // #3661 tester report: Git for Windows at a non-standard root puts both
  // mingw64\bin\git.exe and cmd\git.exe on PATH. When mingw64\bin sorts first,
  // its ../../bin derivation points at mingw64\bin\bash.exe (does not exist);
  // the cmd\git.exe hit derives the real <Git>\bin\bash.exe. Every candidate
  // must be tried, not just the first.
  it('tries every `git` PATH hit when the first one does not yield a bash.exe', () => {
    const probe: GitBashProbe = {
      fileExists: (path) => path === 'D:\\JavaTool\\GIT\\bin\\bash.exe',
      lookupGitCandidates: () => [
        'D:\\JavaTool\\GIT\\mingw64\\bin\\git.exe',
        'D:\\JavaTool\\GIT\\cmd\\git.exe',
      ],
    };

    const result = checkWindowsGitBash('win32', {}, probe);

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe('D:\\JavaTool\\GIT\\bin\\bash.exe');
  });

  it('does not run at all on darwin', () => {
    const result = checkWindowsGitBash('darwin', {}, probeThatMustNotBeCalled());
    expect(result.ok).toBe(true);
  });

  it('does not run at all on linux', () => {
    const result = checkWindowsGitBash('linux', {}, probeThatMustNotBeCalled());
    expect(result.ok).toBe(true);
  });
});
