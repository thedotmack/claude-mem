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
    lookupGitOnPath: () => {
      throw new Error('lookupGitOnPath should not be called off-Windows');
    },
  };
}

describe('checkWindowsGitBash', () => {
  it('reports the actionable error when no bash is reachable anywhere in the chain', () => {
    const probe: GitBashProbe = {
      fileExists: () => false,
      lookupGitOnPath: () => null,
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
      lookupGitOnPath: () => {
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
      lookupGitOnPath: () => {
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
      lookupGitOnPath: () => 'C:\\Program Files\\Git\\cmd\\git.exe',
    };

    const result = checkWindowsGitBash('win32', {}, probe);

    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
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
