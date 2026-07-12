import { describe, it, expect, afterEach, afterAll, mock } from 'bun:test';

import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

// Memory-watchdog regression coverage.
//
// chroma-mcp 0.2.6's long-lived python subprocess leaks native allocations
// (observed: 23 GB physical footprint after 2 days while `ps` RSS reported
// 13 MB because the pages had been compressed out). The watchdog recycles the
// subprocess tree when its resident memory exceeds
// CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB. These tests cover the pure parsing
// helpers and the limit-setting resolution; the recycle path reuses
// disposeCurrentSubprocess(), which chroma-mcp-manager-singleton.test.ts
// already covers.

const manager = ChromaMcpManager as unknown as {
  parsePsRssKb(stdout: string): number;
  parseTasklistMemoryKb(stdout: string): number;
  getChromaMemoryLimitMb(): number;
  descendantsFromPidTable(rootPid: number, stdout: string): number[];
  parseTopFootprintMb(stdout: string, pids: number[]): number | null;
};

const originalLimit = process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB;

afterEach(() => {
  if (originalLimit === undefined) {
    delete process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB;
  } else {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = originalLimit;
  }
});

describe('parsePsRssKb', () => {
  it('sums RSS across multiple pids', () => {
    expect(manager.parsePsRssKb('  1024\n 2048\n512\n')).toBe(3584);
  });

  it('ignores blank lines and non-numeric rows', () => {
    expect(manager.parsePsRssKb('\n1024\n\n  RSS\ngarbage\n')).toBe(1024);
  });

  it('returns 0 for empty output', () => {
    expect(manager.parsePsRssKb('')).toBe(0);
  });
});

describe('parseTasklistMemoryKb', () => {
  it('parses comma-grouped Mem Usage', () => {
    const row = '"python.exe","1234","Console","1","1,234,567 K"';
    expect(manager.parseTasklistMemoryKb(row)).toBe(1234567);
  });

  it('parses dot-grouped Mem Usage (non-English locales)', () => {
    const row = '"python.exe","1234","Console","1","1.234.567 K"';
    expect(manager.parseTasklistMemoryKb(row)).toBe(1234567);
  });

  it('returns 0 when the pid filter matches no tasks', () => {
    expect(manager.parseTasklistMemoryKb('INFO: No tasks are running which match the specified criteria.')).toBe(0);
  });
});

describe('getChromaMemoryLimitMb', () => {
  it('uses the env override when valid', () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '4096';
    expect(manager.getChromaMemoryLimitMb()).toBe(4096);
  });

  it('treats 0 as an explicit opt-out', () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '0';
    expect(manager.getChromaMemoryLimitMb()).toBe(0);
  });

  it('falls back to the default for non-numeric values', () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = 'lots';
    expect(manager.getChromaMemoryLimitMb()).toBe(2048);
  });

  it('falls back to the default for out-of-bounds values', () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '100';
    expect(manager.getChromaMemoryLimitMb()).toBe(2048);
  });

  it('defaults to 2048 when unset', () => {
    delete process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB;
    expect(manager.getChromaMemoryLimitMb()).toBe(2048);
  });
});

describe('descendantsFromPidTable', () => {
  it('walks the uvx -> uv -> python chain and ignores unrelated pids', () => {
    const table = '  100 1\n  111 100\n  222 111\n  333 222\n  444 9999\n';
    expect(manager.descendantsFromPidTable(111, table)).toEqual([222, 333]);
  });

  it('returns empty for a leaf pid and for empty output', () => {
    expect(manager.descendantsFromPidTable(333, ' 111 100\n 222 111\n 333 222\n')).toEqual([]);
    expect(manager.descendantsFromPidTable(111, '')).toEqual([]);
  });

  it('does not loop on cyclic pid tables', () => {
    expect(manager.descendantsFromPidTable(111, '222 111\n111 222\n')).toEqual([222]);
  });
});

describe('parseTopFootprintMb', () => {
  // Regression: `ps` RSS collapses once macOS compresses the leaked pages out
  // (observed: 1.5 GB RSS vs 20 GB Activity Monitor footprint on the same
  // python), so the watchdog reads top's MEM column (phys_footprint) instead.
  const topOutput = [
    'Processes: 436 total, 3 running, 433 sleeping, 2015 threads',
    'PhysMem: 7569M used (1248M wired, 817M compressor), 63M unused.',
    '',
    'PID    MEM',
    '31699  26M',
    '31700  20G',
    '99999  512K',
    ''
  ].join('\n');

  it('sums humanized MEM cells for the requested pids only', () => {
    expect(manager.parseTopFootprintMb(topOutput, [31699, 31700])).toBe(26 + 20 * 1024);
  });

  it('handles K/M/G units and +/- delta markers', () => {
    const out = 'PID MEM\n1 1024K+\n2 512M-\n3 2G\n';
    expect(manager.parseTopFootprintMb(out, [1, 2, 3])).toBe(1 + 512 + 2048);
  });

  it('returns null when none of the pids appear so the caller falls back to RSS', () => {
    expect(manager.parseTopFootprintMb(topOutput, [123, 456])).toBeNull();
    expect(manager.parseTopFootprintMb('', [31700])).toBeNull();
  });
});

describe('checkSubprocessMemory', () => {
  // Statics are patched on the class (process-global), so snapshot and
  // restore them for later test files.
  const realCollectDescendantPidsFromSnapshot = (ChromaMcpManager as any).collectDescendantPidsFromSnapshot;
  const realMeasureProcessTreeMemoryMb = (ChromaMcpManager as any).measureProcessTreeMemoryMb;

  afterAll(() => {
    (ChromaMcpManager as any).collectDescendantPidsFromSnapshot = realCollectDescendantPidsFromSnapshot;
    (ChromaMcpManager as any).measureProcessTreeMemoryMb = realMeasureProcessTreeMemoryMb;
  });

  function makeInstance(usageMb: number | null) {
    (ChromaMcpManager as any).collectDescendantPidsFromSnapshot = mock(async () => [222, 333]);
    (ChromaMcpManager as any).measureProcessTreeMemoryMb = mock(async (pids: number[]) => {
      expect(pids).toEqual([111, 222, 333]);
      return usageMb;
    });

    // Bypass the singleton: exercise the decision logic on a bare instance so
    // no real transport, supervisor entry, or subprocess is involved.
    const instance = Object.create(ChromaMcpManager.prototype) as any;
    instance.connected = true;
    instance.transport = { _process: { pid: 111 } };
    instance.memoryWatchdogTimer = null;
    instance.disposeCurrentSubprocess = mock(async () => {
      instance.connected = false;
    });
    return instance;
  }

  it('recycles the subprocess tree when usage exceeds the limit', async () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '2048';
    const instance = makeInstance(5000);

    await instance.checkSubprocessMemory();

    expect(instance.disposeCurrentSubprocess).toHaveBeenCalledTimes(1);
    expect(instance.connected).toBe(false);
  });

  it('leaves the subprocess alone when usage is under the limit', async () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '2048';
    const instance = makeInstance(512);

    await instance.checkSubprocessMemory();

    expect(instance.disposeCurrentSubprocess).not.toHaveBeenCalled();
  });

  it('never treats a failed measurement as over-limit', async () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '2048';
    const instance = makeInstance(null);

    await instance.checkSubprocessMemory();

    expect(instance.disposeCurrentSubprocess).not.toHaveBeenCalled();
  });

  it('does nothing when the watchdog is disabled via the 0 opt-out', async () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '0';
    const instance = makeInstance(5000);

    await instance.checkSubprocessMemory();

    expect(instance.disposeCurrentSubprocess).not.toHaveBeenCalled();
  });

  it('does nothing when not connected', async () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '2048';
    const instance = makeInstance(5000);
    instance.connected = false;

    await instance.checkSubprocessMemory();

    expect(instance.disposeCurrentSubprocess).not.toHaveBeenCalled();
  });

  it('skips the recycle when the transport was replaced during measurement', async () => {
    process.env.CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB = '2048';
    const instance = makeInstance(5000);
    (ChromaMcpManager as any).measureProcessTreeMemoryMb = mock(async () => {
      // Simulate a reconnect landing while the measurement was in flight.
      instance.transport = { _process: { pid: 999 } };
      return 5000;
    });

    await instance.checkSubprocessMemory();

    expect(instance.disposeCurrentSubprocess).not.toHaveBeenCalled();
  });
});
