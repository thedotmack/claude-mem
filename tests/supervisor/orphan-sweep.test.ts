import { describe, expect, it } from 'bun:test';
import { parsePsOutput, findOrphanedChromaPids } from '../../src/supervisor/orphan-sweep.js';

const DATA = '/home/u/.claude-mem/chroma';
const ps = (...lines: string[]) => parsePsOutput(['  PID  PPID ARGS', ...lines].join('\n'));

describe('orphan-sweep — parsePsOutput', () => {
  it('parses pid/ppid/args rows and skips the header', () => {
    const rows = parsePsOutput([
      '  PID  PPID ARGS',
      '  100    1 /usr/bin/uvx chroma-mcp --data-dir /home/u/.claude-mem/chroma',
      ' 2000 1500 node worker.js',
    ].join('\n'));
    expect(rows).toEqual([
      { pid: 100, ppid: 1, args: '/usr/bin/uvx chroma-mcp --data-dir /home/u/.claude-mem/chroma' },
      { pid: 2000, ppid: 1500, args: 'node worker.js' },
    ]);
  });
});

describe('orphan-sweep — findOrphanedChromaPids (#3216/#3218)', () => {
  it('flags a chroma-mcp with our data-dir re-parented to PID 1', () => {
    const rows = ps(`  100    1 python /x/chroma-mcp --client-type persistent --data-dir ${DATA}`);
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([100]);
  });

  it('flags a chroma-mcp re-parented to systemd --user (NOT PID 1)', () => {
    const rows = ps(
      '  900    1 systemd --user',
      `  100  900 uvx chroma-mcp --data-dir ${DATA}`,
    );
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([100]);
  });

  // ps renders the user manager with its absolute argv[0] on most systemd
  // distros (Debian/Ubuntu/Fedora) — `startsWith('systemd --user')` would miss
  // these and leave the orphan running, the exact case this sweep exists for.
  it('flags a chroma-mcp re-parented to /usr/lib/systemd/systemd --user (abs path)', () => {
    const rows = ps(
      '  900    1 /usr/lib/systemd/systemd --user',
      `  100  900 uvx chroma-mcp --data-dir ${DATA}`,
    );
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([100]);
  });

  it('flags a chroma-mcp re-parented to /lib/systemd/systemd --user (abs path)', () => {
    const rows = ps(
      '  900    1 /lib/systemd/systemd --user',
      `  100  900 uvx chroma-mcp --data-dir ${DATA}`,
    );
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([100]);
  });

  // Guard against over-matching: a process whose name merely ends in "systemd"
  // (or uses --userland-ish flags) must NOT be treated as the user manager.
  it('does NOT treat a lookalike ".../notsystemd --user" as the user manager', () => {
    const rows = ps(
      '  900    1 /opt/notsystemd --user',
      `  100  900 uvx chroma-mcp --data-dir ${DATA}`,
    );
    // pid 100's parent (900) is not init and not a real systemd --user manager,
    // so it is not classified as an orphan.
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([]);
  });

  it('does NOT flag a chroma-mcp still parented to the live worker', () => {
    const rows = ps(` 100 5000 uvx chroma-mcp --data-dir ${DATA}`);
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([]);
  });

  it('does NOT flag a chroma-mcp for a DIFFERENT data-dir', () => {
    const rows = ps('  100    1 uvx chroma-mcp --data-dir /some/other/project/chroma');
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([]);
  });

  it('excludes pids in the exclude set (our own live tree)', () => {
    const rows = ps(`  100    1 uvx chroma-mcp --data-dir ${DATA}`);
    expect(findOrphanedChromaPids(rows, DATA, new Set([100]))).toEqual([]);
  });

  it('ignores non-chroma processes re-parented to init', () => {
    const rows = ps('  100    1 /sbin/agetty tty1');
    expect(findOrphanedChromaPids(rows, DATA, new Set())).toEqual([]);
  });
});
