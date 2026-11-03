import { describe, it, expect } from 'bun:test';
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
import { parseMacProcessTable } from '../../src/shared/port-reclaim.js';
import { verifyPidFileOwnership, isSameProcessStartToken as isSameProcessStartTokenReexport, type PidInfo } from '../../src/supervisor/process-registry.js';

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
 *  3. comparisons tolerate tokens from the pre-pin era instead of letting a
 *     time-zone skew stand for PID reuse (isSameProcessStartToken), which is
 *     what lets the upgrade that ships the fix recycle a stale pre-fix
 *     worker instead of deadlocking against it.
 */

describe('startTokenProbeEnv (#5311)', () => {
  it('pins TZ together with the locale, overriding whatever the host exported', () => {
    const env = startTokenProbeEnv({ PATH: '/usr/bin', TZ: 'America/New_York', LANG: 'de_DE.UTF-8' });
    expect(env.TZ).toBe('UTC');
    expect(env.LC_ALL).toBe('C');
    expect(env.LANG).toBe('C');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('pins TZ even when the host exported none', () => {
    const env = startTokenProbeEnv({ PATH: '/usr/bin' });
    expect(env.TZ).toBe('UTC');
    expect(env.LC_ALL).toBe('C');
    expect(env.LANG).toBe('C');
  });

  it('does not mutate the base env object', () => {
    const base = { TZ: 'America/New_York' };
    startTokenProbeEnv(base);
    expect(base.TZ).toBe('America/New_York');
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

  it('tolerates a mismatch across the pin boundary in both directions (time-zone skew is not PID reuse)', () => {
    // A pre-fix record (local-time token) checked by a pinned read:
    expect(isSameProcessStartToken(pinned('Mon Nov  2 16:49:17 2026'), 'Mon Nov  2 11:49:17 2026')).toBe(true);
    // And the mirror case, for completeness:
    expect(isSameProcessStartToken('Mon Nov  2 16:49:17 2026', pinned('Mon Nov  2 16:49:17 2026'))).toBe(true);
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
  it('macOS table rows carry the prefix byte-identically to the single-PID reader', () => {
    const stdout = [
      '  812     1   501 Mon Oct  5 09:03:07 2026     /usr/bin/uvx --from chroma-mcp chroma-mcp',
      '',
    ].join('\n');
    const rows = parseMacProcessTable(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startToken).toBe(withUtcStartTokenPrefix('Mon Oct  5 09:03:07 2026'));
    expect(rows[0]!.startToken).toBe(`${UTC_START_TOKEN_PREFIX}Mon Oct  5 09:03:07 2026`);
  });

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
    // boundary, no tolerance window.
    const token = captureProcessStartToken(process.pid);
    if (process.platform !== 'linux') return;
    expect(token).toMatch(/^\d+$/);
    expect(isUtcPinnedStartToken(token!)).toBe(false);
  });
});

describe('ownership checks tolerate pre-pin PID files (#5311)', () => {
  // Each record names this live test process, so the liveness half always
  // passes and only the token rule is under test. A pre-fix record carries a
  // local-time `ps lstart` string; post-fix, every read is pinned to UTC and
  // prefixed, so the raw comparison would differ — and must NOT read as PID
  // reuse, or the upgrade hits the very recycle deadlock it fixes.
  const pidFile = (startToken: string | undefined): PidInfo => ({
    pid: process.pid,
    port: 37777,
    startedAt: new Date().toISOString(),
    startToken,
  });

  // Tolerance only fires where the era gate can: a pinned live read against
  // an unprefixed record — that is darwin. Linux keeps comparing numbers
  // byte-for-byte across the upgrade (no era boundary), and Windows keeps
  // its unprefixed CIM strings, so both stay strict; encoding the legacy
  // scenario on them would assert the wrong thing.
  it.if(process.platform === 'darwin')('verifyPidFileOwnership accepts a record whose legacy local-time token cannot match', () => {
    // 'Wed Sep 30 11:00:00 2026' is a plausible pre-fix token: the same live
    // worker, read under a different zone, which a strict === misread as PID
    // reuse and stranded the stale worker (#5311).
    expect(verifyPidFileOwnership(pidFile('Wed Sep 30 11:00:00 2026'))).toBe(true);
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

  it('verifyPidFileOwnership accepts a record carrying the live token', () => {
    expect(verifyPidFileOwnership(pidFile(captureProcessStartToken(process.pid) ?? undefined))).toBe(true);
  });

  it('isSameProcess proceeds on an uncapturable snapshot', () => {
    expect(isSameProcess(process.pid, null)).toBe(true);
  });

  it.if(process.platform === 'darwin')('isSameProcess proceeds over a legacy snapshot, refuses a differing pinned one', () => {
    expect(isSameProcess(process.pid, 'Wed Sep 30 11:00:00 2026')).toBe(true);
    expect(isSameProcess(process.pid, withUtcStartTokenPrefix('Wed Sep 30 11:00:00 2026'))).toBe(false);
  });

  it('hasMatchingProcessStartToken fails closed on an uncapturable read', () => {
    expect(hasMatchingProcessStartToken(2147483647, 'Wed Sep 30 11:00:00 2026')).toBe(false);
  });

  it.if(process.platform === 'darwin')('hasMatchingProcessStartToken tolerates legacy snapshots, refuses differing pinned ones', () => {
    expect(hasMatchingProcessStartToken(process.pid, 'Wed Sep 30 11:00:00 2026')).toBe(true);
    expect(hasMatchingProcessStartToken(process.pid, withUtcStartTokenPrefix('Wed Sep 30 11:00:00 2026'))).toBe(false);
  });
});
