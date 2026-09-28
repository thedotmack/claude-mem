import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearAttempts,
  nextAttemptLog,
  previousFailureInWindow,
  readAttemptLog,
  recordFailedAttempt,
  REPEAT_WINDOW_MS,
} from '../../src/npx-cli/install/attempt-guard';

const HOUR = 60 * 60 * 1000;

describe('attempt guard', () => {
  let dataDir: string;
  const previous = process.env.CLAUDE_MEM_DATA_DIR;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cm-attempts-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('flags the second failure of the same category within 24h', () => {
    const t0 = Date.parse('2026-09-28T10:00:00Z');
    expect(recordFailedAttempt('bun-missing-after-install', t0)).toEqual({ attemptN: 1, isRepeat: false });
    expect(recordFailedAttempt('bun-missing-after-install', t0 + HOUR)).toEqual({ attemptN: 2, isRepeat: true });
    expect(recordFailedAttempt('bun-missing-after-install', t0 + 2 * HOUR)).toEqual({ attemptN: 3, isRepeat: true });
    // A different category counts on its own.
    expect(recordFailedAttempt('uv-missing-after-install', t0 + 2 * HOUR)).toEqual({ attemptN: 1, isRepeat: false });
    expect(existsSync(join(dataDir, 'install-attempts.json'))).toBe(true);
  });

  it('resets the counter after 24 hours without a failure', () => {
    const t0 = Date.parse('2026-09-28T10:00:00Z');
    recordFailedAttempt('bun-missing-after-install', t0);
    expect(previousFailureInWindow('bun-missing-after-install', t0 + REPEAT_WINDOW_MS - 1)).toBe(true);
    expect(previousFailureInWindow('bun-missing-after-install', t0 + REPEAT_WINDOW_MS + 1)).toBe(false);
    expect(recordFailedAttempt('bun-missing-after-install', t0 + REPEAT_WINDOW_MS + 1)).toEqual({ attemptN: 1, isRepeat: false });
  });

  it('success clears every entry', () => {
    recordFailedAttempt('bun-missing-after-install');
    clearAttempts();
    expect(readAttemptLog()).toEqual({});
    expect(previousFailureInWindow('bun-missing-after-install')).toBe(false);
    expect(recordFailedAttempt('bun-missing-after-install').isRepeat).toBe(false);
  });

  it('treats a corrupt file as empty', async () => {
    await Bun.write(join(dataDir, 'install-attempts.json'), '{not json');
    expect(readAttemptLog()).toEqual({});
    expect(recordFailedAttempt('x').attemptN).toBe(1);
  });

  it('nextAttemptLog is pure', () => {
    const log = {};
    const { log: next } = nextAttemptLog(log, 'a', 0);
    expect(log).toEqual({});
    expect(next.a.count).toBe(1);
  });
});
