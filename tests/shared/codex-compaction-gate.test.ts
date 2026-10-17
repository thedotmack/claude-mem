import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  markTimelinePending,
  clearTimelinePending,
  takeTimelinePending,
} from '../../src/shared/codex-compaction-gate.js';

// Codex sends the root's session_id on every thread of an agent tree; a
// subagent thread is told apart by agent_id (its own thread id).
const ROOT_SESSION = '019a0000-0000-7000-8000-000000000001';
const SUBAGENT_A = '019a0000-0000-7000-8000-000000000002';
const SUBAGENT_B = '019a0000-0000-7000-8000-000000000003';

describe('codex-compaction-gate', () => {
  let dataDir: string;
  const origEnv = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-compaction-gate-test-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('has nothing pending for a thread that never compacted', () => {
    expect(takeTimelinePending(ROOT_SESSION, undefined)).toBe(false);
    expect(takeTimelinePending(ROOT_SESSION, SUBAGENT_A)).toBe(false);
  });

  it('hands a compaction to exactly one taker', () => {
    markTimelinePending(ROOT_SESSION, SUBAGENT_A);
    expect(takeTimelinePending(ROOT_SESSION, SUBAGENT_A)).toBe(true);
    expect(takeTimelinePending(ROOT_SESSION, SUBAGENT_A)).toBe(false);
  });

  it('lets a clear answer the compaction so nothing is left to take', () => {
    markTimelinePending(ROOT_SESSION, undefined);
    clearTimelinePending(ROOT_SESSION, undefined);
    expect(takeTimelinePending(ROOT_SESSION, undefined)).toBe(false);
  });

  it('treats clearing a thread with nothing pending as a no-op', () => {
    expect(() => clearTimelinePending(ROOT_SESSION, SUBAGENT_A)).not.toThrow();
  });

  it('keeps the root thread and its subagents independent despite the shared session id', () => {
    markTimelinePending(ROOT_SESSION, undefined);
    markTimelinePending(ROOT_SESSION, SUBAGENT_A);
    markTimelinePending(ROOT_SESSION, SUBAGENT_B);

    // The root's SessionStart(compact) answers only the root thread.
    clearTimelinePending(ROOT_SESSION, undefined);
    expect(takeTimelinePending(ROOT_SESSION, undefined)).toBe(false);

    expect(takeTimelinePending(ROOT_SESSION, SUBAGENT_A)).toBe(true);
    // Subagent A's take leaves subagent B's compaction pending.
    expect(takeTimelinePending(ROOT_SESSION, SUBAGENT_B)).toBe(true);
  });

  it('keeps hostile ids inside the gate directory', () => {
    markTimelinePending('../../outside', '../../agent');
    markTimelinePending('../../outside', undefined);

    const gateDir = join(dataDir, 'state', 'codex-compaction-pending');
    const entries = readdirSync(gateDir);
    expect(entries.length).toBe(2);
    for (const entry of entries) {
      expect(entry.includes('..')).toBe(false);
      expect(entry.includes('/')).toBe(false);
    }
    expect(existsSync(join(dataDir, 'state', 'outside'))).toBe(false);
    expect(takeTimelinePending('../../outside', '../../agent')).toBe(true);
    expect(takeTimelinePending('../../outside', undefined)).toBe(true);
  });

  it('fails open to "nothing pending" when the data dir is unusable', () => {
    // point DATA_DIR at a regular file: the gate dir can never be created
    const blocker = join(dataDir, 'blocked');
    writeFileSync(blocker, 'x');
    process.env.CLAUDE_MEM_DATA_DIR = blocker;

    expect(() => markTimelinePending(ROOT_SESSION, SUBAGENT_A)).not.toThrow();
    expect(takeTimelinePending(ROOT_SESSION, SUBAGENT_A)).toBe(false);
    expect(() => clearTimelinePending(ROOT_SESSION, SUBAGENT_A)).not.toThrow();
  });
});
