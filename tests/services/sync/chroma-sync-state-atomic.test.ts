import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const project = 'atomic-project';

function statePath(dataDir: string): string {
  return join(dataDir, 'chroma-sync-state.json');
}

// The module caches watermarks in a module-level variable, so each test loads a
// fresh copy to exercise the disk-read path in isolation.
let bust = 0;
async function freshState() {
  bust += 1;
  return (await import(`../../../src/services/sync/ChromaSyncState.js?bust=${bust}`)).ChromaSyncState;
}

describe('ChromaSyncState atomic persistence', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-state-atomic-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.CLAUDE_MEM_DATA_DIR;
  });

  it('treats a truncated state file as empty instead of throwing', async () => {
    writeFileSync(statePath(dataDir), '{ "broken": ', 'utf8');
    const state = await freshState();

    expect(() => state.get(project)).not.toThrow();
    expect(state.get(project).observations).toBe(0);
  });

  it('reads a state file that carries a UTF-8 BOM', async () => {
    const payload = JSON.stringify({ [project]: { observations: 7, summaries: 0, prompts: 0 } });
    writeFileSync(statePath(dataDir), '﻿' + payload, 'utf8');
    const state = await freshState();

    expect(state.get(project).observations).toBe(7);
  });

  it('persists without leaving a fixed-name temp file behind', async () => {
    const state = await freshState();
    state.replace(project, { observations: 3, summaries: 0, prompts: 0 });

    expect(existsSync(statePath(dataDir))).toBe(true);
    expect(existsSync(`${statePath(dataDir)}.tmp`)).toBe(false);
    expect(readdirSync(dataDir).filter(name => name.endsWith('.tmp'))).toEqual([]);

    const written = JSON.parse(readFileSync(statePath(dataDir), 'utf8'));
    expect(written[project].observations).toBe(3);
  });
});
