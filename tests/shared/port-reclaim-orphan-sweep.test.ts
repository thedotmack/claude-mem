/**
 * Orphan chroma-mcp sidecar sweep unit tests (#4608).
 *
 * After a worker crash, out-of-band kill, or version upgrade, the previous
 * worker's chroma-mcp sidecar chain survives re-parented to init (PPID=1) and
 * keeps holding `--data-dir <DATA_DIR>/chroma`. The next worker's
 * ChromaMcpManager must kill those orphans before spawning its own sidecar,
 * or two writers share one store (the reporter's 16-day log: 110 failed
 * batch adds).
 *
 * Like the ghost-port suite, the sweep's decision logic is exercised on every
 * CI platform through injected fakes — the process table is faked, no real
 * processes are touched, and no chromadb/uvx is launched.
 */

import { describe, it, expect } from 'bun:test';
import {
  chromaCmdlineNamesExactDataDir,
  parseLinuxProcStat,
  parseMacProcessTable,
  reclaimOrphanChromaDataDirWriters,
  type WindowsProcessRow,
} from '../../src/shared/port-reclaim.js';

const DATA_DIR = '/home/u/.claude-mem/chroma';

interface KillRecord {
  pid: number;
  token: string | null;
  signalMode?: string;
}

interface SweepDeps {
  table: WindowsProcessRow[] | null;
  dataDir?: string | null;
  ownUid?: number | null;
  stillOwnsStore?: () => boolean;
}

function sweepDeps({ table, dataDir = DATA_DIR, ownUid = null, stillOwnsStore }: SweepDeps) {
  const killed: KillRecord[] = [];
  const deps = {
    readTable: async () => table,
    dataDir: () => dataDir,
    ownUid: () => ownUid,
    platform: 'linux' as NodeJS.Platform,
    stillOwnsStore,
    killTree: async (pid: number, options: { expectedStartToken?: string | null; signalMode?: string }) => {
      killed.push({ pid, token: options.expectedStartToken ?? null, signalMode: options.signalMode });
    },
  };
  return { deps, killed };
}

/** The upgrade orphan from #4608: the python leaf holds the data dir, PPID=1. */
const ORPHAN_LEAF: WindowsProcessRow = {
  pid: 4100,
  ppid: 1,
  name: 'python3.13', // Linux comm: NOT on the sidecar-name whitelist
  startToken: 't-leaf',
  cmdline: `/home/u/.local/share/uv/tools/chroma-mcp/bin/python3.13 /home/u/.local/share/uv/tools/chroma-mcp/bin/chroma-mcp --client-type persistent --data-dir ${DATA_DIR}`,
};

const ORPHAN_UVX: WindowsProcessRow = {
  pid: 4098,
  ppid: 1,
  name: 'uvx',
  startToken: 't-uvx',
  cmdline: `uvx --python 3.13 --from chroma-mcp==0.2.6 chroma-mcp --client-type persistent --data-dir ${DATA_DIR}`,
};

describe('reclaimOrphanChromaDataDirWriters', () => {
  it('kills the #4608 upgrade orphan: comm python3.x is off the whitelist but the cmdline names chroma-mcp + our data dir', async () => {
    const { deps, killed } = sweepDeps({ table: [ORPHAN_LEAF] });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([4100]);
    expect(killed).toEqual([{ pid: 4100, token: 't-leaf', signalMode: 'graceful' }]);
  });

  it('kills whitelist-named sidecars (uvx/uv/chroma-mcp) holding the data dir, with same-read tokens', async () => {
    const { deps, killed } = sweepDeps({
      table: [
        ORPHAN_UVX,
        { pid: 4099, ppid: 4098, name: 'chroma-mcp', startToken: 't-cm', cmdline: `chroma-mcp --data-dir ${DATA_DIR}` },
      ],
    });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids.sort()).toEqual([4098, 4099]);
    expect(killed.map(entry => entry.token).sort()).toEqual(['t-cm', 't-uvx']);
  });

  it('never touches processes that are not chroma sidecars or do not hold OUR data dir', async () => {
    const { deps, killed } = sweepDeps({
      table: [
        // A python process with no data-dir argument at all.
        { pid: 4200, ppid: 1, name: 'python3', startToken: 't-http', cmdline: 'python3 -m http.server 8000' },
        // A chroma-mcp pointing at a DIFFERENT store (another install/user).
        { pid: 4300, ppid: 1, name: 'python3', startToken: 't-other', cmdline: 'python3 -m chroma_mcp --data-dir /home/v/.claude-mem/chroma' },
        // Directory-prefix must not over-match: chroma-data is a sibling dir, not ours.
        { pid: 4350, ppid: 1, name: 'chroma-mcp', startToken: 't-prefix', cmdline: `chroma-mcp --data-dir ${DATA_DIR}-data` },
        // The worker itself (bun) can carry the string in its own argv — never a target.
        { pid: process.pid, ppid: 400, name: 'bun', startToken: 't-self', cmdline: `bun run worker-service --x --data-dir ${DATA_DIR}` },
        // Unrelated desktop processes.
        { pid: 4400, ppid: 1, name: 'Code Helper', startToken: null, cmdline: '/Applications/Code Helper' },
      ],
    });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('refuses to guess when the process table cannot be read', async () => {
    const { deps, killed } = sweepDeps({ table: null });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('is a no-op when there is no local data dir (remote Chroma mode)', async () => {
    const { deps, killed } = sweepDeps({ table: [ORPHAN_LEAF], dataDir: null });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('continues past a failed tree-kill so one wedged orphan cannot strand the others', async () => {
    const killed: KillRecord[] = [];
    const result = await reclaimOrphanChromaDataDirWriters({
      readTable: async () => [ORPHAN_LEAF, ORPHAN_UVX],
      dataDir: () => DATA_DIR,
      ownUid: () => null,
      platform: 'linux',
      killTree: async (pid, options) => {
        if (pid === 4100) throw new Error('taskkill wedged');
        killed.push({ pid, token: options.expectedStartToken ?? null });
      },
    });
    expect(result.killedPids).toEqual([4098]);
    expect(killed).toEqual([{ pid: 4098, token: 't-uvx' }]);
  });

  it('never targets a different store: a child dir, or a case-only difference on Linux', async () => {
    const { deps, killed } = sweepDeps({
      table: [
        { ...ORPHAN_LEAF, pid: 4500, cmdline: `chroma-mcp --data-dir ${DATA_DIR}/nested/chroma` },
        { ...ORPHAN_LEAF, pid: 4501, cmdline: 'chroma-mcp --data-dir /home/u/.CLAUDE-MEM/chroma' },
      ],
    });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('never targets another user\'s process, or one whose owner is unknown, on POSIX', async () => {
    const { deps, killed } = sweepDeps({
      ownUid: 501,
      table: [
        { ...ORPHAN_LEAF, pid: 4600, uid: 502 },
        { ...ORPHAN_LEAF, pid: 4601, uid: null },
        { ...ORPHAN_LEAF, pid: 4602, uid: 501 },
      ],
    });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([4602]);
    expect(killed.map(entry => entry.pid)).toEqual([4602]);
  });

  it('kills nothing when stop() overtook the table read (the lock may now be a replacement worker\'s)', async () => {
    const { deps, killed } = sweepDeps({ table: [ORPHAN_LEAF, ORPHAN_UVX], stillOwnsStore: () => false });
    const result = await reclaimOrphanChromaDataDirWriters(deps);
    expect(result.killedPids).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('stops between kills once the connection is cancelled', async () => {
    let owns = true;
    const killed: number[] = [];
    const result = await reclaimOrphanChromaDataDirWriters({
      readTable: async () => [ORPHAN_LEAF, ORPHAN_UVX],
      dataDir: () => DATA_DIR,
      ownUid: () => null,
      platform: 'linux',
      stillOwnsStore: () => owns,
      killTree: async pid => { killed.push(pid); owns = false; },
    });
    expect(result.killedPids).toEqual([4100]);
    expect(killed).toEqual([4100]);
  });
});

describe('chromaCmdlineNamesExactDataDir', () => {
  it('matches the exact store, tolerating slash style, quoting and a trailing slash', () => {
    expect(chromaCmdlineNamesExactDataDir(`chroma-mcp --data-dir ${DATA_DIR}/`, DATA_DIR, 'linux')).toBe(true);
    expect(chromaCmdlineNamesExactDataDir('chroma-mcp --data-dir "C:/Users/A B/.claude-mem/chroma"', 'C:\\Users\\A B\\.claude-mem\\chroma', 'win32')).toBe(true);
  });

  it('folds case only on case-insensitive platforms', () => {
    const cmd = 'chroma-mcp --data-dir /Users/U/.claude-mem/chroma';
    expect(chromaCmdlineNamesExactDataDir(cmd, '/users/u/.claude-mem/chroma', 'darwin')).toBe(true);
    expect(chromaCmdlineNamesExactDataDir(cmd, '/users/u/.claude-mem/chroma', 'linux')).toBe(false);
  });

  it('rejects children, siblings and a missing flag', () => {
    expect(chromaCmdlineNamesExactDataDir(`chroma-mcp --data-dir ${DATA_DIR}/x`, DATA_DIR, 'linux')).toBe(false);
    expect(chromaCmdlineNamesExactDataDir(`chroma-mcp --data-dir ${DATA_DIR}-data`, DATA_DIR, 'linux')).toBe(false);
    expect(chromaCmdlineNamesExactDataDir('chroma-mcp', DATA_DIR, 'linux')).toBe(false);
  });
});

describe('process-table readers', () => {
  it('macOS: keeps the single-digit lstart padding verbatim and the full command with spaces', () => {
    const stdout = [
      '  812     1   501 Mon Oct  5 09:03:07 2026     /Users/A B/.local/bin/uvx --from chroma-mcp chroma-mcp --data-dir "/Users/A B/.claude-mem/chroma"',
      '91234   812   501 Sun Oct 12 14:22:01 2026     python3.13 /x/chroma-mcp --data-dir /Users/u/.claude-mem/chroma',
      'garbage line',
      '',
    ].join('\n');
    const rows = parseMacProcessTable(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 812, ppid: 1, uid: 501, startToken: 'Mon Oct  5 09:03:07 2026' });
    expect(rows[0].cmdline).toBe('/Users/A B/.local/bin/uvx --from chroma-mcp chroma-mcp --data-dir "/Users/A B/.claude-mem/chroma"');
    expect(chromaCmdlineNamesExactDataDir(rows[0].cmdline, '/Users/A B/.claude-mem/chroma', 'darwin')).toBe(true);
    expect(rows[1]).toMatchObject({ pid: 91234, ppid: 812, uid: 501, startToken: 'Sun Oct 12 14:22:01 2026' });
  });

  it('Linux: reads ppid and starttime after the LAST paren, so comm may hold spaces and parens', () => {
    const tail = 'S 1 4100 4100 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10';
    expect(parseLinuxProcStat(`4100 (python3.13) ${tail}`)).toEqual({ ppid: 1, startToken: '987654' });
    expect(parseLinuxProcStat(`4101 (we ird) (name)) ${tail}`)).toEqual({ ppid: 1, startToken: '987654' });
    expect(parseLinuxProcStat('4102 no-paren-here')).toBeNull();
  });
});
