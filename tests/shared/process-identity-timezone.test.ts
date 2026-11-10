import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UTC_START_TOKEN_PREFIX,
  captureProcessStartToken,
  hasMatchingProcessStartToken,
  isSameProcess,
  isSameProcessStartToken,
  isUtcPinnedStartToken,
  startTokenProbeEnv,
  withUtcStartTokenPrefix,
} from '../../src/shared/process-identity.js';
import { parsePosixProcessTable } from '../../src/shared/kill-process-tree.js';
import {
  readOwnedWorkerPidInfo,
  verifyPidFileOwnership,
  verifyWorkerPidFileOwnership,
  isSameProcessStartToken as isSameProcessStartTokenReexport,
  type PidInfo,
} from '../../src/supervisor/process-registry.js';
import { ChromaMcpManager } from '../../src/services/sync/ChromaMcpManager.js';

/** `EEE MMM d HH:mm:ss yyyy` for the same wall clock moved by `skewMs`, as `ps lstart` pads it. */
function shiftLstart(rawToken: string, skewMs: number): string {
  const [, month, day, time, year] = rawToken.trim().split(/\s+/);
  const shifted = new Date(new Date(`${month} ${day} ${year} ${time} UTC`).getTime() + skewMs);
  const [weekday, dayOfMonth, shortMonth, fullYear, clock] = shifted.toUTCString().replace(',', '').split(' ');
  return `${weekday} ${shortMonth} ${String(Number(dayOfMonth)).padStart(2, ' ')} ${clock} ${fullYear}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A cross-era token for the live process that proves nothing, on any platform.
 * A pinned live read (darwin) gets a legacy token 37 seconds off, which is what
 * a reused PID looks like. An unprefixed live read (Linux, Windows) gets a
 * pinned token, which cannot parse against its digits.
 */
function unprovableCrossEraToken(pid: number): string {
  const live = captureProcessStartToken(pid);
  expect(live).not.toBeNull();
  return isUtcPinnedStartToken(live!)
    ? shiftLstart(live!.slice(UTC_START_TOKEN_PREFIX.length), 37_000)
    : withUtcStartTokenPrefix('Wed Sep 30 11:00:00 2026');
}

/**
 * Time-zone independence of the process-identity start token (#5311).
 *
 * `ps` prints `lstart` in the time zone of the calling process, and the spawn
 * env used to pin only the locale. A worker and a later check running under
 * different zones therefore captured different tokens for the SAME live
 * process; the ownership check misread the skew as PID reuse, the worker PID
 * file resolved to null, and the version-mismatch recycle refused to kill the
 * stale worker — forever, because only that recycle could replace it.
 *
 * The fix has three parts, each asserted here:
 *  1. the spawn env pins TZ=UTC (startTokenProbeEnv);
 *  2. pinned-era darwin tokens carry the `utc:` prefix, applied identically
 *     by the single-PID reader and the `ps -eo` table parsers so their
 *     byte-identical agreement survives;
 *  3. a token from the pre-pin era matches only when it differs from the
 *     pinned read by a possible UTC offset (isSameProcessStartToken). That lets
 *     the upgrade that ships the fix recycle a stale pre-fix worker instead of
 *     deadlocking against it, without letting a reused PID pass for the worker.
 */

describe('startTokenProbeEnv (#5311)', () => {
  it.each([
    { PATH: '/usr/bin', TZ: 'America/New_York', LANG: 'de_DE.UTF-8' },
    { PATH: '/usr/bin' },
  ])('pins TZ and locale without mutating the host env %j', (base) => {
    const original = { ...base };
    const env = startTokenProbeEnv(base);
    expect(env.TZ).toBe('UTC');
    expect(env.LC_ALL).toBe('C');
    expect(env.LANG).toBe('C');
    expect(env.PATH).toBe('/usr/bin');
    expect(base).toEqual(original);
  });
});

describe('isSameProcessStartToken: era-aware token comparison (#5311)', () => {
  const pinned = (raw: string) => withUtcStartTokenPrefix(raw);

  it('matches identical tokens regardless of era', () => {
    expect(isSameProcessStartToken(pinned('Mon Nov  2 16:49:17 2026'), pinned('Mon Nov  2 16:49:17 2026'))).toBe(true);
    expect(isSameProcessStartToken('Mon Nov  2 16:49:17 2026', 'Mon Nov  2 16:49:17 2026')).toBe(true);
    expect(isSameProcessStartToken('987654', '987654')).toBe(true);
  });

  it('refuses two pinned tokens that differ (genuine PID reuse evidence)', () => {
    expect(isSameProcessStartToken(pinned('Mon Nov  2 16:49:17 2026'), pinned('Tue Nov  3 16:49:17 2026'))).toBe(false);
  });

  it('refuses two legacy tokens that differ (pre-fix strictness is unchanged)', () => {
    expect(isSameProcessStartToken('Mon Nov  2 16:49:17 2026', 'Tue Nov  3 16:49:17 2026')).toBe(false);
    expect(isSameProcessStartToken('111111', '222222')).toBe(false);
  });

  const pinnedRead = 'Mon Nov  2 16:49:17 2026';

  it('accepts the same instant across the pin boundary at a whole-hour offset, in both directions', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 11:49:17 2026')).toBe(true);
    expect(isSameProcessStartToken('Mon Nov  2 11:49:17 2026', pinned(pinnedRead))).toBe(true);
  });

  it('accepts a record written in UTC itself, the zero offset', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), pinnedRead)).toBe(true);
  });

  it('accepts +5:30 and +5:45 offsets', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 22:19:17 2026')).toBe(true);
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 22:34:17 2026')).toBe(true);
  });

  it('accepts the widest offsets, which cross a day boundary', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Tue Nov  3 06:49:17 2026')).toBe(true);
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 02:49:17 2026')).toBe(true);
  });

  it('refuses a different start time across the pin boundary (a reused PID)', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 11:49:54 2026')).toBe(false);
  });

  it('refuses an offset that is not a multiple of 15 minutes', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 16:59:17 2026')).toBe(false);
  });

  it('refuses a difference over 14 hours, even at a 15-minute multiple', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Tue Nov  3 07:04:17 2026')).toBe(false);
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Nov  2 02:34:17 2026')).toBe(false);
  });

  it('refuses a cross-era token that does not parse, since it proves nothing', () => {
    expect(isSameProcessStartToken(pinned(pinnedRead), 'token-from-a-different-incarnation')).toBe(false);
    expect(isSameProcessStartToken(pinned(pinnedRead), '987654')).toBe(false);
    expect(isSameProcessStartToken('987654', pinned(pinnedRead))).toBe(false);
    expect(isSameProcessStartToken(pinned('not an lstart'), pinnedRead)).toBe(false);
    expect(isSameProcessStartToken(pinned(pinnedRead), 'Mon Foo  2 11:49:17 2026')).toBe(false);
  });

  it('proceeds on an uncapturable token on either side', () => {
    expect(isSameProcessStartToken(null, 'Mon Nov  2 16:49:17 2026')).toBe(true);
    expect(isSameProcessStartToken('Mon Nov  2 16:49:17 2026', null)).toBe(true);
    expect(isSameProcessStartToken(null, null)).toBe(true);
  });

  it('a legacy token can never collide with the prefix', () => {
    // ps lstart starts with a weekday; /proc starttime and the Windows CIM
    // string are digits — none can start with `utc:`, so the era check can
    // never misclassify an old token as pinned.
    expect(isUtcPinnedStartToken('Mon Nov  2 16:49:17 2026')).toBe(false);
    expect(isUtcPinnedStartToken('987654')).toBe(false);
    expect(isUtcPinnedStartToken(`${UTC_START_TOKEN_PREFIX}Mon Nov  2 16:49:17 2026`)).toBe(true);
  });

  it('is re-exported from process-registry so callers share one rule', () => {
    expect(isSameProcessStartTokenReexport).toBe(isSameProcessStartToken);
  });
});

describe('utc: prefix agreement between the single-PID reader and the ps -eo table parsers (#5311)', () => {
  // The single-PID darwin reader wraps every read in the prefix; these
  // assertions pin the same prefix onto both table parsers, whose output is
  // revalidated through captureProcessStartToken (asserted live by
  // kill-process-tree-identity.test.ts). Without the prefix on BOTH sides,
  // every cross-reader comparison would degrade to "proceed" and silently
  // remove the PID-reuse guard from tree-kill and the orphan sweep.
  it('BSD/POSIX table rows carry the prefix; blank tokens stay null', () => {
    const stdout = [
      '  812     1 Sun Oct 12 14:22:01 2026',
      '  813     1',
      'garbage',
    ].join('\n');
    const rows = parsePosixProcessTable(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ pid: 812, ppid: 1, startToken: withUtcStartTokenPrefix('Sun Oct 12 14:22:01 2026') });
  });

  it('Linux /proc starttime stays unprefixed (already zone-independent)', () => {
    // The Linux token is a raw tick count on BOTH sides of every comparison,
    // so pre- and post-upgrade records stay byte-comparable there — no era
    // boundary.
    const token = captureProcessStartToken(process.pid);
    if (process.platform !== 'linux') return;
    expect(token).toMatch(/^\d+$/);
    expect(isUtcPinnedStartToken(token!)).toBe(false);
  });
});

describe('ownership checks require proof for pre-pin records (#5311)', () => {
  // Each record names this live test process, so the liveness half always
  // passes and only the token rule is under test. A pre-fix record carries a
  // local-time `ps lstart` string; post-fix, every read is pinned to UTC and
  // prefixed, so the raw comparison always differs. A real time-zone skew must
  // not read as PID reuse, or the upgrade hits the very recycle deadlock it
  // fixes, and anything else must not read as the same process.
  const pidFile = (startToken: string | undefined): PidInfo => ({
    pid: process.pid,
    port: 37777,
    startedAt: new Date().toISOString(),
    startToken,
  });

  /** The live process's own start time as a pre-fix record in a zone `skewMs` from UTC. */
  const legacyTokenForThisProcess = (skewMs: number): string => {
    const live = captureProcessStartToken(process.pid);
    expect(live).not.toBeNull();
    return shiftLstart(live!.slice(UTC_START_TOKEN_PREFIX.length), skewMs);
  };

  // A pinned live read against an unprefixed record only happens on darwin/BSD.
  // Linux and Windows live reads stay unprefixed, so they have no real skew to
  // build; unprovableCrossEraToken covers their refusal below.
  const pinnedPlatform = process.platform !== 'linux' && process.platform !== 'win32';

  it.if(pinnedPlatform)('accepts a pre-fix record of this process at a real UTC offset', () => {
    for (const skewMs of [0, -5 * HOUR_MS, 5 * HOUR_MS + 45 * MINUTE_MS]) {
      const legacy = legacyTokenForThisProcess(skewMs);
      expect(verifyPidFileOwnership(pidFile(legacy))).toBe(true);
      expect(verifyWorkerPidFileOwnership(pidFile(legacy))).toBe(true);
      expect(isSameProcess(process.pid, legacy)).toBe(true);
      expect(hasMatchingProcessStartToken(process.pid, legacy)).toBe(true);
    }
  });

  it('refuses a same-era token that differs, on every platform (reuse evidence)', () => {
    // Build the wrong token in the era the live read produces, so the
    // mismatch is attributable on linux (both unprefixed) and darwin (both
    // prefixed) alike.
    const live = captureProcessStartToken(process.pid);
    expect(live).not.toBeNull();
    const wrongToken = isUtcPinnedStartToken(live!)
      ? withUtcStartTokenPrefix(`not-${live}`)
      : `not-${live}`;
    expect(verifyPidFileOwnership(pidFile(wrongToken))).toBe(false);
  });

  it('refuses a cross-era token with no proof through every reader', () => {
    const unproven = unprovableCrossEraToken(process.pid);
    expect(verifyPidFileOwnership(pidFile(unproven))).toBe(false);
    expect(isSameProcess(process.pid, unproven)).toBe(false);
    expect(hasMatchingProcessStartToken(process.pid, unproven)).toBe(false);
  });

  it('hasMatchingProcessStartToken fails closed on an uncapturable read', () => {
    expect(hasMatchingProcessStartToken(2147483647, 'Wed Sep 30 11:00:00 2026')).toBe(false);
  });
});

describe('a pre-pin record naming a reused PID stays refused (#5311)', () => {
  let pidFileDirectory: string | undefined;
  afterEach(() => {
    if (pidFileDirectory) rmSync(pidFileDirectory, { recursive: true, force: true });
    pidFileDirectory = undefined;
  });

  // readOwnedWorkerPidInfo is what killWorkerForRecycle reads first. Null there
  // means it refuses, so it never SIGKILLs the process tree of the program that
  // inherited the PID.
  it('the worker ownership check refuses it, so the recycle never gets a PID to kill', () => {
    const record: PidInfo = {
      pid: process.pid,
      port: 37777,
      startedAt: new Date().toISOString(),
      startToken: unprovableCrossEraToken(process.pid),
    };
    expect(verifyWorkerPidFileOwnership(record)).toBe(false);

    pidFileDirectory = mkdtempSync(join(tmpdir(), 'cmem-pid-reuse-'));
    const pidFilePath = join(pidFileDirectory, 'worker.pid');
    writeFileSync(pidFilePath, JSON.stringify(record));
    expect(readOwnedWorkerPidInfo(pidFilePath)).toBeNull();
  });

  it('the Chroma writer lock treats it as stale, so vector search is not stuck behind it', () => {
    const lockFor = (startToken: string) => ({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      startToken,
    });
    const isLive = (startToken: string) => ChromaMcpManager['isChromaWriterLockLive'](lockFor(startToken) as never);

    expect(isLive(unprovableCrossEraToken(process.pid))).toBe(false);
    expect(isLive(captureProcessStartToken(process.pid)!)).toBe(true);
  });
});
