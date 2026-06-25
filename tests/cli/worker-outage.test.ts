import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import path from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

// Import after paths — DATA_DIR resolves to its module-level value regardless of when
// the env var was set. Write test fixtures to the actual data dir the module uses.
import { DATA_DIR } from '../../src/shared/paths.js';
import { consumeWorkerOutageHint } from '../../src/shared/worker-utils.js';

const stateDir = path.join(DATA_DIR, 'state');
const hookFailuresPath = path.join(stateDir, 'hook-failures.json');
const outageWarningPath = path.join(stateDir, 'last-outage-warning.json');

function writeFailures(count: number, lastFailureAt = Date.now()): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(hookFailuresPath, JSON.stringify({ consecutiveFailures: count, lastFailureAt }));
}

function writeWarning(lastWarnedAt: number, lastSessionId?: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(outageWarningPath, JSON.stringify({ lastWarnedAt, lastSessionId }));
}

// Snapshots of the state files at the start of each test, restored afterward so
// these tests don't mutate real ~/.claude-mem state permanently.
let savedFailures: string | null = null;
let savedWarning: string | null = null;

beforeEach(() => {
  mkdirSync(stateDir, { recursive: true });
  try { savedFailures = require('fs').readFileSync(hookFailuresPath, 'utf-8'); } catch { savedFailures = null; }
  try { savedWarning = require('fs').readFileSync(outageWarningPath, 'utf-8'); } catch { savedWarning = null; }
  try { rmSync(hookFailuresPath); } catch {}
  try { rmSync(outageWarningPath); } catch {}
});

afterEach(() => {
  if (savedFailures !== null) writeFileSync(hookFailuresPath, savedFailures);
  else try { rmSync(hookFailuresPath); } catch {}
  if (savedWarning !== null) writeFileSync(outageWarningPath, savedWarning);
  else try { rmSync(outageWarningPath); } catch {}
});

describe('consumeWorkerOutageHint', () => {
  it('returns null when worker is healthy (consecutiveFailures = 0)', () => {
    writeFailures(0);
    expect(consumeWorkerOutageHint('session-1')).toBeNull();
  });

  it('returns banner string when worker is unreachable', () => {
    writeFailures(5);
    const hint = consumeWorkerOutageHint('session-1');
    expect(hint).toBeTypeOf('string');
    expect(hint!).toContain('background worker offline');
  });

  it('returns null on second call with same session (throttled)', () => {
    writeFailures(5);
    consumeWorkerOutageHint('session-1');
    const second = consumeWorkerOutageHint('session-1');
    expect(second).toBeNull();
  });

  it('returns banner again for a new session even within throttle window', () => {
    writeFailures(5);
    consumeWorkerOutageHint('session-1');
    const second = consumeWorkerOutageHint('session-2');
    expect(second).toBeTypeOf('string');
  });

  it('returns banner after throttle window expires', () => {
    writeFailures(5);
    const expiredTime = Date.now() - 31 * 60 * 1000;
    writeWarning(expiredTime, 'session-1');
    const hint = consumeWorkerOutageHint('session-1');
    expect(hint).toBeTypeOf('string');
  });

  it('bypassThrottle always returns banner when worker is down', () => {
    writeFailures(3);
    consumeWorkerOutageHint('session-1');
    const forced = consumeWorkerOutageHint('session-1', true);
    expect(forced).toBeTypeOf('string');
  });

  it('returns null when state file does not exist (no failures)', () => {
    expect(consumeWorkerOutageHint('session-1')).toBeNull();
  });
});

describe('consumeWorkerOutageHint — no process.exit when reading high failure count', () => {
  it('does not call process.exit regardless of failure count', () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called unexpectedly');
    });

    try {
      writeFailures(99);
      // consumeWorkerOutageHint reads the same state; calling it verifies
      // the code path runs without triggering exit(2).
      consumeWorkerOutageHint('session-check');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
