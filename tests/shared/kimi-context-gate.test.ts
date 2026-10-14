import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hasInjected,
  markInjected,
  clearInjected,
} from '../../src/shared/kimi-context-gate.js';

describe('kimi-context-gate', () => {
  let dataDir: string;
  const origEnv = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kimi-gate-test-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports not-injected for an unknown session', () => {
    expect(hasInjected('session-never-seen')).toBe(false);
  });

  it('marks a session as injected', () => {
    markInjected('session-abc');
    expect(hasInjected('session-abc')).toBe(true);
  });

  it('clears an injected marker', () => {
    markInjected('session-abc');
    clearInjected('session-abc');
    expect(hasInjected('session-abc')).toBe(false);
  });

  it('treats clearing a missing marker as a no-op', () => {
    expect(() => clearInjected('session-missing')).not.toThrow();
  });

  it('sanitizes hostile session ids so markers cannot escape the gate dir', () => {
    const hostile = '../../outside';
    markInjected(hostile);
    expect(hasInjected(hostile)).toBe(true);
    const gateDir = join(dataDir, 'state', 'kimi-context-injected');
    const entries = readdirSync(gateDir);
    expect(entries.length).toBe(1);
    expect(entries[0].includes('..')).toBe(false);
    expect(entries[0].includes('/')).toBe(false);
    // nothing written outside the gate dir
    expect(existsSync(join(dataDir, 'state', 'outside'))).toBe(false);
  });

  it('fails open when the data dir is unusable', () => {
    // point DATA_DIR at a regular file: mkdir of the gate dir must fail
    const blocker = join(dataDir, 'blocked');
    writeFileSync(blocker, 'x');
    process.env.CLAUDE_MEM_DATA_DIR = blocker;
    expect(hasInjected('session-abc')).toBe(false);
    expect(() => markInjected('session-abc')).not.toThrow();
    expect(() => clearInjected('session-abc')).not.toThrow();
  });

  it('keeps markers for different sessions independent', () => {
    markInjected('session-a');
    expect(hasInjected('session-a')).toBe(true);
    expect(hasInjected('session-b')).toBe(false);
  });
});
