import { describe, expect, it } from 'bun:test';
import {
  findOrphanedChromaRoots,
  parseProcessTable,
  sweepOrphanedChromaTrees,
  type ProcessRow,
} from '../../src/supervisor/orphan-chroma-sweep.js';

const SELF = 4242;

// A realistic table: our own live pair, an orphaned pair reparented to launchd, a pair whose worker
// died but whose PID has not yet been recycled, an unrelated PID-1 daemon, and a bystander that
// merely mentions chroma in a path but is not a launch.
const UVX = 'uvx --with chromadb==1.0.0 chroma-mcp --client-type persistent --data-dir /Users/x/.claude-mem/chroma';
const UV = 'uv tool uvx --with chromadb==1.0.0 chroma-mcp --client-type persistent';
const PY = '/Users/x/.cache/uv/archive/abc/bin/python3.13 /Users/x/.cache/uv/archive/abc/bin/chroma-mcp --client-type persistent';

const TABLE: ProcessRow[] = [
  { pid: 1, ppid: 0, command: '/sbin/launchd' },
  { pid: SELF, ppid: 1, command: 'bun plugin/scripts/worker-service.cjs start' },
  // ours
  { pid: 5001, ppid: SELF, command: UVX },
  { pid: 5002, ppid: 5001, command: UV },
  { pid: 5003, ppid: 5002, command: PY },
  // orphan A: reparented to launchd
  { pid: 6001, ppid: 1, command: UVX },
  { pid: 6002, ppid: 6001, command: UV },
  { pid: 6003, ppid: 6002, command: PY },
  // orphan B: parent worker is dead (pid 7000 absent from the table)
  { pid: 7001, ppid: 7000, command: UVX },
  { pid: 7002, ppid: 7001, command: PY },
  // not ours to touch
  { pid: 8001, ppid: 1, command: '/usr/libexec/some-daemon' },
  { pid: 8002, ppid: 1, command: 'vim /Users/x/notes/chroma-mcp-incident.md' },
];

const alive = (pid: number): boolean => TABLE.some((r) => r.pid === pid);

describe('parseProcessTable', () => {
  it('parses ps -eo pid=,ppid=,command= rows and ignores garbage', () => {
    const rows = parseProcessTable([
      '  1     0 /sbin/launchd',
      ' 6001     1 ' + UVX,
      'not a row',
      '',
      '6003  6002 ' + PY,
    ].join('\n'));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ pid: 6001, ppid: 1, command: UVX });
    expect(rows[2]!.command).toBe(PY);
  });
});

describe('findOrphanedChromaRoots', () => {
  it('groups signature rows into trees and reports only the roots', () => {
    const { matched, roots } = findOrphanedChromaRoots(TABLE, { isAlive: alive, selfPid: SELF });
    expect(matched.map((r) => r.pid).sort()).toEqual([5001, 5002, 5003, 6001, 6002, 6003, 7001, 7002]);
    expect(roots.map((r) => r.pid).sort()).toEqual([5001, 6001, 7001]);
  });

  it('flags roots whose parent is PID 1 or dead, and never our own children', () => {
    const { orphans } = findOrphanedChromaRoots(TABLE, { isAlive: alive, selfPid: SELF });
    const pids = orphans.map((r) => r.pid).sort();
    expect(pids).toContain(6001);   // reparented to launchd
    expect(pids).toContain(7001);   // parent 7000 is gone
    expect(pids).not.toContain(5001); // ours
    expect(pids).not.toContain(6002); // a child, not a root
  });

  it('a bystander whose command line merely mentions chroma-mcp is not a candidate', () => {
    // `vim chroma-mcp-incident.md` under PID 1 must never be swept: the executable is not uvx, uv
    // or python. The python grandchild, whose argv ends in `.../bin/chroma-mcp`, still matches.
    const { matched, orphans } = findOrphanedChromaRoots(TABLE, { isAlive: alive, selfPid: SELF });
    expect(matched.map((r) => r.pid)).not.toContain(8002);
    expect(orphans.map((r) => r.pid)).not.toContain(8002);
    expect(matched.map((r) => r.pid)).toContain(6003);
  });

  it('never treats the worker itself as a chroma row even if its command mentions chroma', () => {
    const rows: ProcessRow[] = [
      { pid: SELF, ppid: 1, command: 'bun worker-service.cjs start --chroma-mcp-debug' },
    ];
    const { matched } = findOrphanedChromaRoots(rows, { isAlive: alive, selfPid: SELF });
    expect(matched).toHaveLength(0);
  });
});

describe('sweepOrphanedChromaTrees', () => {
  it('kills each orphan root exactly once and leaves owned trees and children alone', async () => {
    const killed: number[] = [];
    const result = await sweepOrphanedChromaTrees({
      platform: 'darwin',
      selfPid: SELF,
      isAlive: alive,
      readTable: async () => TABLE,
      killTree: async (pid) => { killed.push(pid); },
    });
    expect(killed.sort()).toEqual([6001, 7001]);
    expect(result).toMatchObject({ matched: 8, trees: 3, orphans: 2, killed: 2, failed: 0, skipped: null });
  });

  it('counts a failed kill and continues with the rest', async () => {
    const killed: number[] = [];
    const result = await sweepOrphanedChromaTrees({
      platform: 'linux',
      selfPid: SELF,
      isAlive: alive,
      readTable: async () => TABLE,
      killTree: async (pid) => {
        if (pid === 6001) throw new Error('EPERM');
        killed.push(pid);
      },
    });
    expect(killed).toEqual([7001]);
    expect(result.killed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('drops a registry chroma row whose PID it just reaped, and only that one', async () => {
    const unregistered: string[] = [];
    const result = await sweepOrphanedChromaTrees({
      platform: 'darwin',
      selfPid: SELF,
      isAlive: alive,
      readTable: async () => TABLE,
      killTree: async () => {},
      registry: {
        getAll: () => [
          { id: 'chroma-mcp', pid: 6001, type: 'chroma', startedAt: '2026-09-01T00:00:00Z', pgid: 6001 },
          { id: 'worker', pid: SELF, type: 'worker', startedAt: '2026-09-08T00:00:00Z' },
          { id: 'sdk:1', pid: 9001, type: 'sdk', startedAt: '2026-09-08T00:00:00Z' },
        ],
        unregister: (id) => { unregistered.push(id); },
      },
    });
    expect(unregistered).toEqual(['chroma-mcp']);
    expect(result.unregistered).toBe(1);
  });

  it('is a no-op on Windows', async () => {
    let read = false;
    const result = await sweepOrphanedChromaTrees({
      platform: 'win32',
      readTable: async () => { read = true; return TABLE; },
      killTree: async () => { throw new Error('must not be called'); },
    });
    expect(read).toBe(false);
    expect(result.skipped).toBe('windows');
    expect(result.killed).toBe(0);
  });

  it('skips cleanly when the process table cannot be read', async () => {
    const result = await sweepOrphanedChromaTrees({
      platform: 'darwin',
      readTable: async () => { throw new Error('ps: not found'); },
      killTree: async () => { throw new Error('must not be called'); },
    });
    expect(result.skipped).toBe('unreadable');
    expect(result.orphans).toBe(0);
  });

  it('reads the real process table on this platform without throwing', async () => {
    if (process.platform === 'win32') return;
    // No kills: killTree is stubbed. This only proves the ps invocation and parser work here.
    const result = await sweepOrphanedChromaTrees({
      selfPid: process.pid,
      killTree: async () => {},
    });
    expect(result.skipped).toBeNull();
    expect(result.matched).toBeGreaterThanOrEqual(0);
  });
});
