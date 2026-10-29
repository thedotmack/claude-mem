import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pruneOldLogs, resolveLogRetentionDays } from '../../src/services/worker/log-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

let dir: string;

function utcDate(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY_MS).toISOString().split('T')[0];
}

/** A file in the logs dir whose mtime is `mtimeDaysAgo` days before NOW. */
function seedLog(name: string, mtimeDaysAgo: number, body = 'x'): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  const mtime = new Date(NOW - mtimeDaysAgo * DAY_MS);
  utimesSync(path, mtime, mtime);
  return path;
}

/** A daily log named `daysAgo` UTC days before NOW. */
function dailyLog(daysAgo: number, mtimeDaysAgo = daysAgo): string {
  return seedLog(`claude-mem-${utcDate(daysAgo)}.log`, mtimeDaysAgo);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-log-retention-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveLogRetentionDays', () => {
  it('accepts whole numbers as a string or an unquoted number', () => {
    expect(resolveLogRetentionDays('30')).toBe(30);
    expect(resolveLogRetentionDays(' 14 ')).toBe(14);
    expect(resolveLogRetentionDays(30)).toBe(30);
  });

  it('keeps everything for 0 and for anything that is not a whole number of days', () => {
    for (const raw of ['0', 0, '', 'abc', '-5', -5, '1.5', 1.5, '1e3', null, undefined, ['30'], { days: 30 }]) {
      expect(resolveLogRetentionDays(raw)).toBe(0);
    }
  });
});

describe('pruneOldLogs', () => {
  it('deletes daily logs older than the window and keeps the rest', () => {
    const old = [dailyLog(31), dailyLog(45), dailyLog(200)];
    const kept = [dailyLog(0), dailyLog(1), dailyLog(29), dailyLog(30)];

    const result = pruneOldLogs(dir, 30, NOW);

    expect(result.removed.sort()).toEqual(old.map(baseName).sort());
    expect(result.bytes).toBe(3);
    for (const path of old) expect(existsSync(path)).toBe(false);
    for (const path of kept) expect(existsSync(path)).toBe(true);
  });

  it('always keeps today and yesterday, even with a one-day retention', () => {
    const today = dailyLog(0);
    const yesterday = dailyLog(1);
    const older = dailyLog(2);

    pruneOldLogs(dir, 1, NOW);

    expect(existsSync(today)).toBe(true);
    expect(existsSync(yesterday)).toBe(true);
    expect(existsSync(older)).toBe(false);
  });

  it('keeps an old-named file that is still being written inside the window', () => {
    // A pre-#4063 daemon appended to its start-date file for weeks.
    const latched = dailyLog(60, 0);

    const result = pruneOldLogs(dir, 30, NOW);

    expect(result.removed).toEqual([]);
    expect(existsSync(latched)).toBe(true);
  });

  it('never touches files that are not the logger\'s daily logs', () => {
    const others = [
      seedLog('runner-errors.log', 400),
      seedLog(`worker-${utcDate(400)}.log`, 400),
      seedLog(`worker-${utcDate(400)}.log.err`, 400),
      seedLog(`claude-mem-${utcDate(400)}.log.bak`, 400),
      seedLog(`old-claude-mem-${utcDate(400)}.log`, 400),
      seedLog('observer-audit.log', 400),
    ];
    mkdirSync(join(dir, `claude-mem-${utcDate(400)}.log`));

    const result = pruneOldLogs(dir, 30, NOW);

    expect(result.removed).toEqual([]);
    for (const path of others) expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(others.length + 1);
  });

  it('is a no-op for a retention of 0', () => {
    const old = dailyLog(400);

    expect(pruneOldLogs(dir, 0, NOW)).toEqual({ removed: [], bytes: 0 });
    expect(existsSync(old)).toBe(true);
  });

  it('returns nothing when the logs directory does not exist', () => {
    expect(pruneOldLogs(join(dir, 'missing'), 30, NOW)).toEqual({ removed: [], bytes: 0 });
  });

  it('skips a file it cannot delete and still removes the others', () => {
    const locked = dailyLog(40);
    const free = dailyLog(50);

    const result = pruneOldLogs(dir, 30, NOW, path => {
      if (path === locked) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      rmSync(path);
    });

    expect(result.removed).toEqual([baseName(free)]);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(free)).toBe(false);
  });

  it('counts the age of a file from its UTC date name just after UTC midnight', () => {
    // 00:30 UTC: the file dated 31 calendar days back was last written ~30.02 days ago.
    const justAfterMidnight = Date.UTC(2026, 9, 7, 0, 30, 0);
    const day = new Date(justAfterMidnight - 31 * DAY_MS).toISOString().split('T')[0];
    const name = `claude-mem-${day}.log`;
    const path = join(dir, name);
    writeFileSync(path, 'x');
    const mtime = new Date(Date.UTC(2026, 8, 6, 23, 59, 0));
    utimesSync(path, mtime, mtime);

    expect(pruneOldLogs(dir, 30, justAfterMidnight).removed).toEqual([name]);
  });
});
