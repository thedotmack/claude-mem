import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadWatchState, saveWatchState } from '../../../src/services/transcripts/state.js';

describe('transcript watch state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates parent directories and persists offsets', () => {
    const path = join(dir, 'nested', 'watch-state.json');
    const state = { offsets: { '/tmp/session.jsonl': 42 } };

    saveWatchState(path, state);

    expect(loadWatchState(path)).toEqual(state);
    expect(existsSync(path)).toBe(true);
  });

  it('still fails safely on malformed persisted state', () => {
    const path = join(dir, 'watch-state.json');
    writeFileSync(path, '{ "offsets":');

    expect(loadWatchState(path)).toEqual({ offsets: {} });
  });
});
