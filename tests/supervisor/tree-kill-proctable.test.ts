import { describe, expect, it } from 'bun:test';
import { descendantsFromProcTable, parseParentMap } from '../../src/supervisor/tree-kill.js';

// Fallback path for hosts without a usable `pgrep` (minimal containers): the
// descendant set is derived from ONE `ps -eo pid,ppid` snapshot instead of
// silently leaving the orphan's children alive to re-orphan (greptile review,
// PR #3232). These pin the pure walk that fallback relies on.
describe('tree-kill — descendantsFromProcTable (pgrep-less fallback)', () => {
  it('collects a multi-level tree bottom-up, excluding the root and unrelated pids', () => {
    const rows = [
      { pid: 1, ppid: 0 },
      { pid: 100, ppid: 1 },   // root (the chroma-mcp wrapper)
      { pid: 200, ppid: 100 }, // uv
      { pid: 300, ppid: 200 }, // python / chroma
      { pid: 999, ppid: 1 },   // unrelated sibling
    ];
    const d = descendantsFromProcTable(100, rows);
    expect(new Set(d)).toEqual(new Set([200, 300]));
    // Leaves first: the deepest node precedes its parent so callers can signal
    // children before ancestors.
    expect(d.indexOf(300)).toBeLessThan(d.indexOf(200));
    expect(d).not.toContain(100); // root itself is never in its own descendants
    expect(d).not.toContain(999); // unrelated subtree untouched
  });

  it('returns [] for a root with no children', () => {
    expect(descendantsFromProcTable(100, [{ pid: 100, ppid: 1 }])).toEqual([]);
  });

  it('terminates on a self-parenting / cyclic table (no infinite loop)', () => {
    const rows = [{ pid: 100, ppid: 100 }, { pid: 200, ppid: 100 }];
    expect(new Set(descendantsFromProcTable(100, rows))).toEqual(new Set([200]));
  });

  it('parseParentMap parses pid/ppid rows and skips the header and garbage', () => {
    expect(parseParentMap('  PID  PPID\n  100    1\n 200  100\ngarbage line\n')).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
    ]);
  });
});
