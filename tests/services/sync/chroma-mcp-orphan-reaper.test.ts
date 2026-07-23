import { describe, it, expect } from 'bun:test';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

// Orphan-reaper selection coverage.
//
// Hypothesis under test: chroma-mcp subprocess pairs orphaned by an UNGRACEFUL
// worker death (SIGKILL / crash / failed-graceful restart) re-parent to
// init/launchd (ppid 1) and, because chroma-mcp does not exit on stdin EOF,
// live forever — observed in production as 221 leaked uv+python pairs (~3 GB
// RSS) accumulated during a version-mismatch recycle storm. The reaper must
// select exactly those processes: re-parented to init AND referencing OUR
// chroma data dir. It must never select live workers' children (ppid != 1),
// other installs' data dirs, or unrelated processes.

const DATA_DIR = '/Users/someone/.claude-mem/chroma';

function psRow(pid: number, ppid: number, command: string): string {
  return `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${command}`;
}

const UV_ORPHAN = psRow(
  88562,
  1,
  `/Users/someone/.local/bin/uv tool uvx --python 3.13 --with onnxruntime>=1.20 --with protobuf<7 --from chroma-mcp==0.2.6 chroma-mcp --client-type persistent --data-dir ${DATA_DIR}`
);
const PYTHON_ORPHAN = psRow(
  90001,
  1,
  `/opt/homebrew/bin/python3.13 /Users/someone/.cache/uv/archive-v0/abc/bin/chroma-mcp --client-type persistent --data-dir ${DATA_DIR}`
);
const LIVE_WORKER_CHILD = psRow(
  88816,
  88778,
  `/Users/someone/.local/bin/uv tool uvx --from chroma-mcp==0.2.6 chroma-mcp --client-type persistent --data-dir ${DATA_DIR}`
);
const OTHER_INSTALL_ORPHAN = psRow(
  91000,
  1,
  `/Users/someone/.local/bin/uv tool uvx --from chroma-mcp==0.2.6 chroma-mcp --client-type persistent --data-dir /Users/other/.claude-mem/chroma`
);
const UNRELATED_INIT_CHILD = psRow(2001, 1, '/usr/libexec/secd');

describe('ChromaMcpManager.findOrphanedChromaRoots', () => {
  it('selects chroma-mcp processes re-parented to init that reference our data dir', () => {
    const psOutput = [UV_ORPHAN, PYTHON_ORPHAN, LIVE_WORKER_CHILD, UNRELATED_INIT_CHILD].join('\n');
    expect(ChromaMcpManager.findOrphanedChromaRoots(psOutput, DATA_DIR)).toEqual([88562, 90001]);
  });

  it('never selects a live worker\'s chroma child (ppid is the worker, not init)', () => {
    expect(ChromaMcpManager.findOrphanedChromaRoots(LIVE_WORKER_CHILD, DATA_DIR)).toEqual([]);
  });

  it('never selects another install\'s orphans (data dir mismatch)', () => {
    expect(ChromaMcpManager.findOrphanedChromaRoots(OTHER_INSTALL_ORPHAN, DATA_DIR)).toEqual([]);
  });

  it('ignores unrelated init children and malformed rows', () => {
    const psOutput = [UNRELATED_INIT_CHILD, 'garbage row', '', '   '].join('\n');
    expect(ChromaMcpManager.findOrphanedChromaRoots(psOutput, DATA_DIR)).toEqual([]);
  });

  it('returns an empty list for empty ps output', () => {
    expect(ChromaMcpManager.findOrphanedChromaRoots('', DATA_DIR)).toEqual([]);
  });
});
