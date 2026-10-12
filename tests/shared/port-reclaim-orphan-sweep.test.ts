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
}

function sweepDeps({ table, dataDir = DATA_DIR }: SweepDeps) {
  const killed: KillRecord[] = [];
  const deps = {
    readTable: async () => table,
    dataDir: () => dataDir,
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
      killTree: async (pid, options) => {
        if (pid === 4100) throw new Error('taskkill wedged');
        killed.push({ pid, token: options.expectedStartToken ?? null });
      },
    });
    expect(result.killedPids).toEqual([4098]);
    expect(killed).toEqual([{ pid: 4098, token: 't-uvx' }]);
  });
});
