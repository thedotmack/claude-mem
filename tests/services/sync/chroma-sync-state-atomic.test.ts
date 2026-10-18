import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';

const project = 'atomic-project';

function statePath(dataDir: string): string {
  return join(dataDir, 'chroma-sync-state.json');
}

describe('ChromaSyncState atomic persistence', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-state-atomic-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    ChromaSyncState.resetCacheForTests();
  });

  afterEach(() => {
    ChromaSyncState.resetCacheForTests();
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    }
  });

  it('treats a truncated state file as empty instead of throwing', () => {
    writeFileSync(statePath(dataDir), '{ "broken": ', 'utf8');

    expect(() => ChromaSyncState.get(project)).not.toThrow();
    expect(ChromaSyncState.get(project).observations).toBe(0);
  });

  it('reads a state file that carries a UTF-8 BOM', () => {
    const payload = JSON.stringify({ [project]: { observations: 7, summaries: 0, prompts: 0 } });
    writeFileSync(statePath(dataDir), '\uFEFF' + payload, 'utf8');

    expect(ChromaSyncState.get(project).observations).toBe(7);
  });

  it('persists without leaving a fixed-name temp file behind', () => {
    ChromaSyncState.replace(project, { observations: 3, summaries: 0, prompts: 0 });

    expect(existsSync(statePath(dataDir))).toBe(true);
    expect(existsSync(`${statePath(dataDir)}.tmp`)).toBe(false);
    expect(readdirSync(dataDir).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const written = JSON.parse(readFileSync(statePath(dataDir), 'utf8'));
    expect(written[project].observations).toBe(3);
  });

  it('keeps a watermark change in memory when the write fails, and writes it after the backoff', () => {
    // A directory at the state path makes the rename fail on every platform.
    mkdirSync(join(statePath(dataDir), 'blocker'), { recursive: true });

    expect(() => ChromaSyncState.bump(project, 'observations', 5)).not.toThrow();
    expect(ChromaSyncState.get(project).observations).toBe(5);
    expect(readdirSync(dataDir).filter(name => name.endsWith('.tmp'))).toEqual([]);

    rmSync(statePath(dataDir), { recursive: true });
    ChromaSyncState.bump(project, 'summaries', 1);
    expect(existsSync(statePath(dataDir))).toBe(false);

    setSystemTime(new Date(Date.now() + 10_000));
    try {
      ChromaSyncState.bump(project, 'summaries', 2);
    } finally {
      setSystemTime();
    }

    const written = JSON.parse(readFileSync(statePath(dataDir), 'utf8'));
    expect(written[project].observations).toBe(5);
    expect(written[project].summaries).toBe(2);
  });

  it('throws when the rebuild flags cannot be written', () => {
    ChromaSyncState.replace(project, { observations: 3, summaries: 0, prompts: 0 });
    rmSync(statePath(dataDir));
    mkdirSync(join(statePath(dataDir), 'blocker'), { recursive: true });

    expect(() => ChromaSyncState.markAllForRebuild()).toThrow();
  });

  it('throws when a revised row\'s repair state cannot be written', () => {
    mkdirSync(join(statePath(dataDir), 'blocker'), { recursive: true });

    expect(() => ChromaSyncState.markFragmentReconciliation(project, 'observations', 4)).toThrow();
  });
});
