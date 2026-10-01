/**
 * Ghost-listener reclaim unit tests.
 *
 * The production reclaim (reclaimGhostListeningPort) only runs on Windows and
 * shells out to netstat / Get-CimInstance / taskkill, so its decision logic is
 * exercised on every CI platform through injected fakes; the pure parsers run
 * directly. The real end-to-end path — worker killed out-of-band, chroma
 * sidecar chain holding the inherited socket, launcher reclaims and starts —
 * is the Windows integration gate (tests/integration/worker-ghost-port-recovery
 * .test.ts, CLAUDE_MEM_TEST_CHROMA=1 in the windows workflow).
 */

import { describe, it, expect } from 'bun:test';
import {
  parseNetstatListeningPids,
  parsePidLines,
  isChromaSidecarName,
  chromaCmdlineMatchesDataDir,
  reclaimGhostListeningPort,
  type GhostPortReclaimDeps,
  type WindowsProcessRow,
} from '../../src/shared/port-reclaim.js';

const SAMPLE_NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100',
  '  TCP    127.0.0.1:37777        0.0.0.0:0              LISTENING       57824',
  '  TCP    127.0.0.1:37777        127.0.0.1:54321        ESTABLISHED     9999',
  '  TCP    127.0.0.1:37778        0.0.0.0:0              LISTENING       22040',
  '  TCP    [::1]:37777            [::]:0                 LISTENING       57824',
  '  TCP    [::]:37001             [::]:0                 LISTENING       4',
  '  UDP    0.0.0.0:37777          *:*                                    57824',
].join('\r\n');

describe('parseNetstatListeningPids', () => {
  it('extracts every LISTENING owner for the exact port', () => {
    const owners = parseNetstatListeningPids(SAMPLE_NETSTAT, 37777);
    // IPv4 + IPv6 listeners dedupe to one owner PID.
    expect(owners).toEqual([57824]);
  });

  it('ignores other ports, non-LISTENING states and UDP rows', () => {
    const owners = parseNetstatListeningPids(SAMPLE_NETSTAT, 37777);
    expect(owners).not.toContain(1100); // different port
    expect(owners).not.toContain(22040); // 37778
    expect(owners).not.toContain(9999); // ESTABLISHED, not a listener
    expect(owners).not.toContain(4); // 37001
  });

  it('returns an empty list when nothing listens on the port', () => {
    expect(parseNetstatListeningPids(SAMPLE_NETSTAT, 39999)).toEqual([]);
    expect(parseNetstatListeningPids('', 37777)).toEqual([]);
  });
});

describe('isChromaSidecarName', () => {
  it('accepts the uvx -> uv -> python -> chroma-mcp chain, with or without .exe', () => {
    for (const name of ['uv', 'uvx', 'python', 'chroma-mcp', 'uv.exe', 'uvx.exe', 'python.exe', 'chroma-mcp.exe']) {
      expect(isChromaSidecarName(name), `expected ${name} to match`).toBe(true);
    }
  });

  it('rejects case-insensitively so casing differences cannot cause a miss', () => {
    expect(isChromaSidecarName('UV.EXE')).toBe(true);
    expect(isChromaSidecarName('Python')).toBe(true);
  });

  it('rejects everything a reused PID could plausibly own', () => {
    for (const name of ['bun.exe', 'node.exe', 'claude.exe', 'cmd.exe', 'powershell.exe', '', 'python3.13']) {
      expect(isChromaSidecarName(name), `expected ${JSON.stringify(name)} not to match`).toBe(false);
    }
  });
});

describe('chromaCmdlineMatchesDataDir', () => {
  const DATA = 'C:/Users/test/.claude-mem';

  it('matches the chroma-mcp persistent command line, backslash or forward slash', () => {
    expect(chromaCmdlineMatchesDataDir(
      '"chroma-mcp.exe" --client-type persistent --data-dir C:/Users/test/.claude-mem/chroma',
      DATA
    )).toBe(true);
    expect(chromaCmdlineMatchesDataDir(
      '"chroma-mcp.exe" --client-type persistent --data-dir C:\\Users\\test\\.claude-mem\\chroma',
      DATA
    )).toBe(true);
  });

  it('matches case-insensitively (Windows paths are case-insensitive)', () => {
    expect(chromaCmdlineMatchesDataDir(
      '--data-dir c:/USERS/Test/.claude-mem/chroma',
      DATA
    )).toBe(true);
  });

  it('handles a double-quoted data-dir value containing spaces', () => {
    expect(chromaCmdlineMatchesDataDir(
      '--data-dir "C:/Users/Test User/.claude-mem/chroma"',
      'C:/Users/Test User/.claude-mem'
    )).toBe(true);
  });

  it('rejects a different data dir, including prefix lookalikes', () => {
    expect(chromaCmdlineMatchesDataDir(
      '--data-dir C:/Users/test/other-install/chroma',
      DATA
    )).toBe(false);
    // Prefix lookalike: .claude-mem-other must not match .claude-mem
    expect(chromaCmdlineMatchesDataDir(
      '--data-dir C:/Users/test/.claude-mem-other/chroma',
      DATA
    )).toBe(false);
    expect(chromaCmdlineMatchesDataDir('python.exe --version', DATA)).toBe(false);
    expect(chromaCmdlineMatchesDataDir(null, DATA)).toBe(false);
  });
});

/** A dead owner: a PID that cannot exist on this machine (max 32-bit PID space). */
const DEAD_OWNER = 4_000_000_000;
const DEAD_OWNER_2 = 4_000_000_001;
/** A live owner: this test runner itself. */
const LIVE_OWNER = process.pid;

interface RowInput {
  pid: number;
  ppid: number;
  name: string;
  token?: string;
  cmdline?: string | null;
}

function rows(inputs: RowInput[]): WindowsProcessRow[] {
  return inputs.map(input => ({
    pid: input.pid,
    ppid: input.ppid,
    name: input.name,
    startToken: input.token ?? null,
    cmdline: input.cmdline !== undefined ? input.cmdline : null,
  }));
}


/**
 * listOwners is invoked twice (probe + verify). A real ghost clears after the
 * kill, so the fake returns the live owner list first and `afterOwners` on
 * the verify call.
 */
function ghostDeps(overrides: {
  owners?: number[] | null;
  table?: RowInput[] | null;
  killFails?: boolean;
  afterOwners?: number[] | null;
  dataDir?: string | null;
}): { deps: GhostPortReclaimDeps; killed: Array<{ pid: number; token: string | null | undefined }> } {
  const killed: Array<{ pid: number; token: string | null | undefined }> = [];
  const firstOwners = overrides.owners === undefined ? [DEAD_OWNER] : overrides.owners;
  const verifyOwners = overrides.afterOwners !== undefined ? overrides.afterOwners : [];
  let probeCount = 0;
  return {
    killed,
    deps: {
      isWin32: () => true,
      // No wedged worker in the ghost-listener scenarios: keep the reclaim on
      // the dead-owner path and never touch the real PID file / port probe.
      readOwnedWorker: () => null,
      listOwners: async () => {
        probeCount += 1;
        return probeCount === 1 ? firstOwners : verifyOwners;
      },
      readTable: async () => (overrides.table === undefined ? [] : overrides.table === null ? null : rows(overrides.table)),
      dataDir: () => (overrides.dataDir === undefined ? null : overrides.dataDir),
      killTree: async (pid, options) => {
        if (overrides.killFails) throw new Error('taskkill access denied');
        killed.push({ pid, token: options.expectedStartToken });
      },
    },
  };
}

describe('reclaimGhostListeningPort decision branches', () => {
  it('resolves to not-supported off Windows (never touches a process)', async () => {
    const result = await reclaimGhostListeningPort(37777, {
      isWin32: () => false,
      readOwnedWorker: () => null,
      listOwners: async () => {
        throw new Error('must not be called');
      },
    });
    expect(result).toEqual({ reclaimed: false, reason: 'not-supported', killedPids: [] });
  });

  it('reports netstat-unreadable when the owner list cannot be read', async () => {
    const { deps: testDeps } = ghostDeps({ owners: null });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(false);
    expect((result as { reason: string }).reason).toBe('netstat-unreadable');
  });

  it('reports no-listener when nothing is bound to the port', async () => {
    const { deps: testDeps } = ghostDeps({ owners: [] });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'no-listener', killedPids: [] });
  });

  it('reports table-unreadable when the process table cannot be enumerated', async () => {
    const { deps: testDeps } = ghostDeps({ owners: [DEAD_OWNER], table: null });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect((result as { reason: string }).reason).toBe('table-unreadable');
  });

  it('never kills when a live FOREIGN owner holds the port (not our PID file)', async () => {
    // readOwnedWorker returns null (ghostDeps default), so a live owner our PID
    // file does not claim keeps the owner-alive refusal.
    const { deps: testDeps, killed } = ghostDeps({ owners: [LIVE_OWNER] });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'owner-alive', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('walks the dead owner\'s descendants and kills only chroma sidecars', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER],
      table: [
        { pid: 3001, ppid: DEAD_OWNER, name: 'uvx.exe', token: 't-uvx' },
        { pid: 3002, ppid: 3001, name: 'uv.exe', token: 't-uv' },
        { pid: 3003, ppid: 3002, name: 'python.exe', token: 't-py' },
        { pid: 3004, ppid: 3003, name: 'chroma-mcp.exe', token: 't-cm' },
        // A bun/node descendant of the dead worker is NOT a sidecar — a
        // recycled-PID edge case must not pull it into the kill.
        { pid: 3005, ppid: 3004, name: 'bun.exe', token: 't-bun' },
        // Unrelated processes elsewhere in the table are untouched.
        { pid: 4001, ppid: 1, name: 'explorer.exe' },
      ],
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(true);
    expect((result as { killedPids: number[] }).killedPids).toEqual([3004, 3003, 3002, 3001]);
    expect(killed.map(entry => entry.pid)).toEqual([3004, 3003, 3002, 3001]);
    // Every kill carried the token from the SAME table read that discovered it.
    expect(killed.map(entry => entry.token)).toEqual(['t-cm', 't-py', 't-uv', 't-uvx']);
    expect(killed.map(entry => entry.pid)).not.toContain(3005);
    expect(killed.map(entry => entry.pid)).not.toContain(4001);
  });

  it('reports no-chroma-descendants when the dead owner\'s survivors are unrelated', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER],
      table: [
        // PID-reuse worst case: the number now names a live process with
        // children — but they are bun/node, so nothing may be killed.
        { pid: 5001, ppid: DEAD_OWNER, name: 'bun.exe', token: 't-bun' },
        { pid: 5002, ppid: 5001, name: 'node.exe', token: 't-node' },
      ],
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'no-chroma-descendants', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('reclaims a broken chain via the data-dir fingerprint when the walk cannot reach it', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER],
      // The worker's uvx/uv stdio layers exited on pipe EOF after the worker
      // died, so the surviving chroma-mcp/python sidecar hangs off a DEAD
      // intermediate pid — unreachable by walking down from the dead owner.
      // Its --data-dir argument is what identifies it as ours.
      table: [
        { pid: 6201, ppid: DEAD_OWNER, name: 'uvx.exe', token: 't-uvx' },
        // 6202 (uv) and 6203 (uvx of a SECOND generation) both died; the table
        // keeps no rows for them, and 6301's ppid points at the dead 6202.
        { pid: 6301, ppid: 6202, name: 'chroma-mcp.exe', token: 't-cm',
          cmdline: '"chroma-mcp.exe" --client-type persistent --data-dir C:/Users/test/.claude-mem/chroma' },
        { pid: 6302, ppid: 6301, name: 'python.exe', token: 't-py',
          cmdline: '"python.exe" "chroma-mcp.exe" --client-type persistent --data-dir C:/Users/test/.claude-mem/chroma' },
        // Another install's chroma on the same machine must NOT be touched.
        { pid: 6401, ppid: 1, name: 'chroma-mcp.exe', token: 't-other',
          cmdline: '"chroma-mcp.exe" --client-type persistent --data-dir C:/Users/other/.claude-mem/chroma' },
        // A sidecar-named process with no data-dir argument is not evidence.
        { pid: 6402, ppid: 1, name: 'python.exe', token: 't-nodir', cmdline: 'python.exe -m http.server' },
      ],
      dataDir: 'C:/Users/test/.claude-mem',
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(true);
    // 6201 (uvx) is reachable by the walk; 6301/6302 (chroma-mcp/python)
    // only by the data-dir scan — all three are legitimate targets.
    expect((result as { killedPids: number[] }).killedPids).toEqual([6201, 6301, 6302]);
    expect(killed.map(entry => entry.pid)).toEqual([6201, 6301, 6302]);
    expect(killed.map(entry => entry.token)).toEqual(['t-uvx', 't-cm', 't-py']);
  });

  it('does not run the data-dir scan when the data dir is unresolved', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER],
      table: [
        { pid: 6301, ppid: DEAD_OWNER, name: 'bun.exe', token: 't-bun' },
      ],
      dataDir: null,
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(false);
    expect(killed).toEqual([]);
  });

  it('reports kill-failed when a tree-kill genuinely fails and stops', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER],
      table: [
        { pid: 3001, ppid: DEAD_OWNER, name: 'uvx.exe', token: 't-uvx' },
        { pid: 3002, ppid: 3001, name: 'python.exe', token: 't-py' },
      ],
      killFails: true,
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(false);
    expect((result as { reason: string }).reason).toBe('kill-failed');
    expect(killed).toEqual([]); // failed on the first target (deepest leaf)
  });

  it('reports still-bound when the port survives the kill (holder is elsewhere)', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER],
      table: [{ pid: 3001, ppid: DEAD_OWNER, name: 'uvx.exe', token: 't-uvx' }],
      afterOwners: [42], // something else still owns the port after the kill
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(false);
    expect((result as { reason: string }).reason).toBe('still-bound');
    expect(killed.map(entry => entry.pid)).toEqual([3001]);
  });

  it('handles multiple dead owners (IPv4 + IPv6 listeners) without double kills', async () => {
    const { deps: testDeps, killed } = ghostDeps({
      owners: [DEAD_OWNER, DEAD_OWNER_2],
      table: [
        { pid: 3001, ppid: DEAD_OWNER, name: 'uvx.exe', token: 't-a' },
        { pid: 3101, ppid: DEAD_OWNER_2, name: 'python.exe', token: 't-b' },
      ],
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(true);
    expect(killed.map(entry => entry.pid).sort((a, b) => a - b)).toEqual([3001, 3101]);
  });
});


/**
 * Wedged-worker reclaim: our PID file names a LIVE worker that holds the port
 * but no longer answers /health (#4127). Unlike the ghost-listener path this is
 * not Windows-specific and the owner is alive, so it runs before the netstat /
 * sidecar logic and on every platform — and it kills only on evidence: past its
 * boot grace, silent on two spaced health probes, the LISTEN owner of the port,
 * the recorded start token, and a claude-mem worker command line.
 */
const NOW_MS = Date.parse('2026-09-30T12:00:00.000Z');
const WEDGED_WORKER_PID = 51000;
const WEDGED_WORKER_TOKEN = 'Wed Sep 30 11:00:00 2026';

interface WedgedOverrides {
  isWin32?: boolean;
  owned?: { pid: number; port: number; startedAt: string; startToken?: string } | null;
  ageSeconds?: number;
  healthAnswers?: boolean[];
  listenersBefore?: number[] | null;
  listenersAfter?: number[] | null;
  identity?: { startToken: string | null; cmdline: string | null };
  killFails?: boolean;
}

function wedgedDeps(overrides: WedgedOverrides = {}): {
  deps: GhostPortReclaimDeps;
  killed: Array<{ pid: number; signalMode: string; expectedStartToken?: string | null }>;
  healthProbes: () => number;
  sleeps: number[];
} {
  const killed: Array<{ pid: number; signalMode: string; expectedStartToken?: string | null }> = [];
  const sleeps: number[] = [];
  const healthAnswers = [...(overrides.healthAnswers ?? [false, false])];
  let healthProbes = 0;
  let listOwnersCalls = 0;
  const startedAt = new Date(NOW_MS - (overrides.ageSeconds ?? 3_600) * 1000).toISOString();
  return {
    killed,
    sleeps,
    healthProbes: () => healthProbes,
    deps: {
      isWin32: () => overrides.isWin32 ?? false,
      readOwnedWorker: () => (overrides.owned === undefined
        ? { pid: WEDGED_WORKER_PID, port: 37777, startedAt, startToken: WEDGED_WORKER_TOKEN }
        : overrides.owned),
      now: () => NOW_MS,
      sleep: async (ms: number) => { sleeps.push(ms); },
      minOwnerAgeSeconds: 300,
      probeHealth: async () => {
        healthProbes += 1;
        return healthAnswers.shift() ?? false;
      },
      // First call: who LISTENs before the kill; second call: after it.
      listOwners: async () => {
        listOwnersCalls += 1;
        if (listOwnersCalls === 1) {
          return overrides.listenersBefore === undefined ? [WEDGED_WORKER_PID] : overrides.listenersBefore;
        }
        return overrides.listenersAfter === undefined ? [] : overrides.listenersAfter;
      },
      readIdentity: async () => overrides.identity ?? {
        startToken: WEDGED_WORKER_TOKEN,
        cmdline: '/Users/me/.bun/bin/bun /Users/me/.claude/plugins/claude-mem/scripts/worker-service.cjs --daemon',
      },
      // The ghost path must never be reached when the wedged path applies.
      readTable: async () => {
        throw new Error('ghost path must not run when the wedged path applies');
      },
      killTree: async (pid, options) => {
        if (overrides.killFails) throw new Error('kill failed');
        killed.push({ pid, signalMode: options.signalMode, expectedStartToken: options.expectedStartToken });
      },
    },
  };
}

describe('reclaimWedgedOwnedWorker (via reclaimGhostListeningPort)', () => {
  it('reclaims a wedged worker we own on POSIX: graceful tree-kill pinned to the recorded start token', async () => {
    const { deps: testDeps, killed, healthProbes, sleeps } = wedgedDeps({ isWin32: false });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: true, killedPids: [WEDGED_WORKER_PID] });
    expect(killed).toEqual([
      { pid: WEDGED_WORKER_PID, signalMode: 'graceful', expectedStartToken: WEDGED_WORKER_TOKEN },
    ]);
    // Two health re-probes, spaced apart, before any signal.
    expect(healthProbes()).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('reclaims a wedged worker we own on Windows too', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ isWin32: true });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result.reclaimed).toBe(true);
    expect(killed.map(k => k.pid)).toEqual([WEDGED_WORKER_PID]);
  });

  it('never kills a young worker (boot / migration grace) and does not even probe it', async () => {
    const { deps: testDeps, killed, healthProbes } = wedgedDeps({ ageSeconds: 30 });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'owner-booting', killedPids: [] });
    expect(killed).toEqual([]);
    expect(healthProbes()).toBe(0);
  });

  it('never kills when the PID file has no parseable startedAt', async () => {
    const { deps: testDeps, killed } = wedgedDeps({
      owned: { pid: WEDGED_WORKER_PID, port: 37777, startedAt: 'not-a-date', startToken: WEDGED_WORKER_TOKEN },
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect((result as { reason: string }).reason).toBe('owner-booting');
    expect(killed).toEqual([]);
  });

  it('stands down when the worker answers the second health re-probe', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ healthAnswers: [false, true] });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'owner-responding', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('never kills on a start-token mismatch (PID reused since the PID file was written)', async () => {
    const { deps: testDeps, killed } = wedgedDeps({
      identity: { startToken: 'Thu Oct  1 09:00:00 2026', cmdline: 'bun worker-service.cjs --daemon' },
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'owner-identity-mismatch', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('never kills a process whose command line is not a claude-mem worker', async () => {
    const { deps: testDeps, killed } = wedgedDeps({
      identity: { startToken: WEDGED_WORKER_TOKEN, cmdline: '/usr/bin/python3 -m http.server 37777' },
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect((result as { reason: string }).reason).toBe('owner-identity-mismatch');
    expect(killed).toEqual([]);
  });

  it('never kills when the identity read came back empty (PID reissued mid-read)', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ identity: { startToken: null, cmdline: null } });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect((result as { reason: string }).reason).toBe('owner-identity-mismatch');
    expect(killed).toEqual([]);
  });

  it('leaves a foreign listener untouched: our worker is alive but does not own the port', async () => {
    // The wedged path defers to the ghost-listener logic, which on POSIX has
    // nothing to reclaim — the live foreign owner is never signalled.
    const { deps: testDeps, killed } = wedgedDeps({ isWin32: false, listenersBefore: [4242] });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'not-supported', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('on Windows, a live foreign listener still gets the owner-alive refusal', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ isWin32: true, listenersBefore: [process.pid] });
    // After the wedged path defers, the ghost path re-reads owners (still the
    // live foreign pid) and needs the process table.
    testDeps.listOwners = async () => [process.pid];
    testDeps.readTable = async () => [];
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'owner-alive', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('refuses to kill when the port owner cannot be read (lsof / netstat unavailable)', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ listenersBefore: null });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'netstat-unreadable', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('reports kill-failed when the wedged worker cannot be killed', async () => {
    const { deps: testDeps } = wedgedDeps({ killFails: true });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'kill-failed', killedPids: [] });
  });

  it('reports still-bound when the port survives the kill', async () => {
    const { deps: testDeps } = wedgedDeps({ listenersAfter: [WEDGED_WORKER_PID] });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect(result).toEqual({ reclaimed: false, reason: 'still-bound', killedPids: [WEDGED_WORKER_PID] });
  });

  it('does not apply when our PID file claims a DIFFERENT port (falls through)', async () => {
    // owned.port !== target: the wedged path declines, so POSIX resolves to
    // not-supported instead of killing a worker bound to another port.
    const { deps: testDeps, killed, healthProbes } = wedgedDeps({
      isWin32: false,
      owned: { pid: WEDGED_WORKER_PID, port: 40000, startedAt: '2026-09-30T00:00:00.000Z' },
    });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect((result as { reason: string }).reason).toBe('not-supported');
    expect(killed).toEqual([]);
    expect(healthProbes()).toBe(0);
  });

  it('does not apply when no worker PID file is ours (falls through)', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ isWin32: false, owned: null });
    const result = await reclaimGhostListeningPort(37777, testDeps);
    expect((result as { reason: string }).reason).toBe('not-supported');
    expect(killed).toEqual([]);
  });
});

describe('reclaimGhostListeningPort under a hook deadline (UserPromptSubmit, 15 s host cap)', () => {
  it('declines before probing or killing when the budget left cannot cover a reclaim', async () => {
    const { deps: testDeps, killed, healthProbes } = wedgedDeps({ isWin32: false });
    const result = await reclaimGhostListeningPort(37777, { ...testDeps, deadlineAt: NOW_MS + 3_000 });
    expect(result).toEqual({ reclaimed: false, reason: 'out-of-budget', killedPids: [] });
    expect(healthProbes()).toBe(0);
    expect(killed).toEqual([]);
  });

  it('declines the Windows ghost path before reading netstat when the budget is short', async () => {
    const { deps: testDeps, killed } = ghostDeps({ table: [] });
    const result = await reclaimGhostListeningPort(37777, {
      ...testDeps,
      now: () => NOW_MS,
      deadlineAt: NOW_MS + 2_000,
      listOwners: async () => {
        throw new Error('must not read netstat without the budget to finish');
      },
    });
    expect(result).toEqual({ reclaimed: false, reason: 'out-of-budget', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('cuts every process read to what is left of the budget', async () => {
    const { deps: testDeps } = wedgedDeps({ isWin32: false });
    const caps: Array<number | undefined> = [];
    const result = await reclaimGhostListeningPort(37777, {
      ...testDeps,
      deadlineAt: NOW_MS + 20_000,
      listOwners: async (port, capMs) => {
        caps.push(capMs);
        return caps.length === 1 ? [WEDGED_WORKER_PID] : [];
      },
      readIdentity: async (_pid, capMs) => {
        caps.push(capMs);
        return { startToken: WEDGED_WORKER_TOKEN, cmdline: 'bun /plugin/scripts/worker-service.cjs --daemon' };
      },
    });
    expect(result.reclaimed).toBe(true);
    expect(caps).toEqual([20_000, 20_000, 20_000]);
  });

  it('stops before the kill when the reads used up the budget a kill needs', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ isWin32: false });
    let nowCalls = 0;
    // The budget check and the age read see the start; by the kill, 4 s are left.
    const now = () => (++nowCalls <= 2 ? NOW_MS : NOW_MS + 16_000);
    const result = await reclaimGhostListeningPort(37777, { ...testDeps, now, deadlineAt: NOW_MS + 20_000 });
    expect(result).toEqual({ reclaimed: false, reason: 'out-of-budget', killedPids: [] });
    expect(killed).toEqual([]);
  });

  it('keeps the unbounded reclaim for callers without a deadline', async () => {
    const { deps: testDeps, killed } = wedgedDeps({ isWin32: false });
    const result = await reclaimGhostListeningPort(37777, { ...testDeps, deadlineAt: null });
    expect(result.reclaimed).toBe(true);
    expect(killed.map((kill) => kill.pid)).toEqual([WEDGED_WORKER_PID]);
  });
});

describe('parsePidLines', () => {
  it('parses lsof -t output into unique PIDs', () => {
    expect(parsePidLines('51000\n51000\n4242\n\n')).toEqual([51000, 4242]);
    expect(parsePidLines('')).toEqual([]);
  });
});
