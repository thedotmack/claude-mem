import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadWatchState, saveWatchState } from '../../../src/services/transcripts/state.js';

describe('transcript watch state', () => {
  it('loads the state written by saveWatchState', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'nested', 'watch-state.json');
    const state = { offsets: { '/tmp/session.jsonl': 42 } };

    saveWatchState(path, state);

    expect(loadWatchState(path)).toEqual(state);
    expect(existsSync(path)).toBe(true);
  });

  it('preserves the last valid state when a write is interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
    const path = join(dir, 'watch-state.json');
    const original = { offsets: { '/tmp/session.jsonl': 42 } };
    saveWatchState(path, original);
    const raw = readFileSync(path, 'utf8');

    expect(() => writeFileSync(path, raw.slice(0, Math.floor(raw.length / 2)))).not.toThrow();
    expect(loadWatchState(path)).toEqual({ offsets: {} });
  });
});
