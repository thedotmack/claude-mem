import { describe, it, expect } from 'bun:test';

/**
 * Tests for bun-runner.js Windows path normalization (fixes #1281)
 *
 * On Windows with Git Bash, CLAUDE_PLUGIN_ROOT expands to a backslash path
 * (e.g. C:\Users\username\.claude\...) that gets corrupted when the shell
 * interprets escape sequences like \t (tab in "thedotmack") or \b (backspace
 * in "basil"). Normalizing backslashes to forward slashes fixes module
 * resolution without affecting Unix paths.
 *
 * bun-runner.js cannot be imported directly (it has top-level await and
 * process side-effects), so the normalizePath logic is tested here as a
 * pure function that mirrors the implementation.
 */

// Mirror of normalizePath() in plugin/scripts/bun-runner.js
function normalizePath(p: string | undefined | null): string | undefined | null {
  if (!p) return p;
  return p.replace(/\\/g, '/');
}

describe('bun-runner normalizePath (fixes #1281)', () => {
  it('converts backslashes to forward slashes in a Windows path', () => {
    const win = 'C:\\Users\\username\\.claude\\plugins\\cache\\thedotmack\\claude-mem\\9.1.1\\scripts\\worker-service.cjs';
    expect(normalizePath(win)).toBe(
      'C:/Users/username/.claude/plugins/cache/thedotmack/claude-mem/9.1.1/scripts/worker-service.cjs'
    );
  });

  it('leaves Unix paths unchanged', () => {
    const unix = '/home/user/.claude/plugins/cache/thedotmack/claude-mem/9.1.1/scripts/worker-service.cjs';
    expect(normalizePath(unix)).toBe(unix);
  });

  it('handles a path containing \\t (would become tab without normalization)', () => {
    // \t in "thedotmack" is the problematic sequence from the bug report
    const withTab = 'C:\\plugins\\cache\\thedotmack\\scripts\\worker.cjs';
    const result = normalizePath(withTab);
    expect(result).not.toContain('\\');
    expect(result).toContain('thedotmack');
    expect(result).toBe('C:/plugins/cache/thedotmack/scripts/worker.cjs');
  });

  it('handles a path containing \\b (would become backspace without normalization)', () => {
    // \b in paths like \basil or \bun would be a backspace character
    const withBs = 'C:\\Users\\basil\\.claude\\scripts\\bun-runner.js';
    const result = normalizePath(withBs);
    expect(result).not.toContain('\\');
    expect(result).toContain('basil');
    expect(result).toBe('C:/Users/basil/.claude/scripts/bun-runner.js');
  });

  it('returns undefined unchanged', () => {
    expect(normalizePath(undefined)).toBeUndefined();
  });

  it('returns null unchanged', () => {
    expect(normalizePath(null)).toBeNull();
  });

  it('returns empty string unchanged', () => {
    expect(normalizePath('')).toBe('');
  });

  it('handles mixed slashes (common in Windows Git Bash)', () => {
    const mixed = 'C:\\Users\\user/.claude/plugins\\scripts/worker.cjs';
    expect(normalizePath(mixed)).toBe('C:/Users/user/.claude/plugins/scripts/worker.cjs');
  });
});
