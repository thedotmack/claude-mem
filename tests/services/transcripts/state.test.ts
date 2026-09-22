import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadWatchState, saveWatchState } from '../../../src/services/transcripts/state.js';

describe('transcript watch state', () => {
  it('creates parent directories and persists offsets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'nested', 'watch-state.json');
    const state = { offsets: { '/tmp/session.jsonl': 42 } };

    saveWatchState(path, state);

    expect(loadWatchState(path)).toEqual(state);
    expect(existsSync(path)).toBe(true);
  });

  it('leaves no atomic-write temp files after a successful save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'watch-state.json');

    saveWatchState(path, { offsets: { '/tmp/session.jsonl': 99 } });

    expect(readdirSync(dir)).toEqual(['watch-state.json']);
    expect(readFileSync(path, 'utf8')).toContain('"99"');
  });

  it('replaces an existing state without leaving the old payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'watch-state.json');

    saveWatchState(path, { offsets: { '/tmp/session.jsonl': 1 } });
    saveWatchState(path, { offsets: { '/tmp/session.jsonl': 2, '/tmp/other.jsonl': 7 } });

    expect(loadWatchState(path)).toEqual({
      offsets: { '/tmp/session.jsonl': 2, '/tmp/other.jsonl': 7 }
    });
    expect(readFileSync(path, 'utf8')).not.toContain('"1"');
  });

  it('round-trips unicode transcript paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'watch-state.json');
    const state = { offsets: { '/tmp/项目/会话.jsonl': 128 } };

    saveWatchState(path, state);

    expect(loadWatchState(path)).toEqual(state);
  });

  it('still fails safely on malformed persisted state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'watch-state.json');
    writeFileSync(path, '{ "offsets":');

    expect(loadWatchState(path)).toEqual({ offsets: {} });
  });
});
