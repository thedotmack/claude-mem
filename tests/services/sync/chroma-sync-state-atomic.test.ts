import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
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
});
