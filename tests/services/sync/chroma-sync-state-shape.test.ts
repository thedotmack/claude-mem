import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
let dataDir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.CLAUDE_MEM_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'cm-state-shape-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  ChromaSyncState.resetCacheForTests();
});
afterEach(() => {
  ChromaSyncState.resetCacheForTests();
  if (previous === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = previous;
  rmSync(dataDir, { recursive: true, force: true });
});
describe('semantic index checkpoint shape recovery', () => {
  for (const payload of ['null', '[]', '"not a checkpoint"', '7']) {
    it(`recovers a valid JSON document with invalid root ${payload}`, () => {
      writeFileSync(join(dataDir, 'chroma-sync-state.json'), payload);
      expect(() => ChromaSyncState.get('owned')).not.toThrow();
      expect(ChromaSyncState.get('owned').observations).toBe(0);
      ChromaSyncState.bump('owned', 'observations', 8);
      ChromaSyncState.resetCacheForTests();
      expect(ChromaSyncState.get('owned').observations).toBe(8);
    });
  }
});

// #5664 — failed post-delete cleanups live in the same checkpoint as the
// watermarks: the retry record has to survive the worker that gave up on it,
// and its one array-valued entry must not disturb the project map around it.
describe('pending row-delete retry records', () => {
  const PENDING_KEY = '__pending_row_deletes__';

  it('round-trips retry records beside the project watermarks', () => {
    ChromaSyncState.replace('owned', { observations: 4, summaries: 2, prompts: 1 });
    ChromaSyncState.markPendingRowDeletes([
      { docType: 'observation', sqliteId: 12 },
      { docType: 'session_summary', sqliteId: 12 },
    ]);
    ChromaSyncState.resetCacheForTests();

    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([
      { docType: 'observation', sqliteId: 12 },
      { docType: 'session_summary', sqliteId: 12 },
    ]);
    // The retry list did not become a project, and the project kept its marks.
    expect(ChromaSyncState.get('owned')).toEqual({ observations: 4, summaries: 2, prompts: 1 });
    expect(ChromaSyncState.hasProjectState()).toBe(true);
  });

  it('drops malformed and duplicate entries instead of failing the load', () => {
    writeFileSync(join(dataDir, 'chroma-sync-state.json'), JSON.stringify({
      [PENDING_KEY]: [
        { docType: 'observation', sqliteId: 3 },
        { docType: 'observation', sqliteId: 3 },
        { docType: 'observation', sqliteId: -1 },
        { docType: 'observation', sqliteId: '4' },
        { docType: '', sqliteId: 5 },
        { sqliteId: 6 },
        'not a record',
        null,
      ],
    }));
    ChromaSyncState.resetCacheForTests();

    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([{ docType: 'observation', sqliteId: 3 }]);
  });

  it('keeps a project that happens to be named like the retry key', () => {
    writeFileSync(join(dataDir, 'chroma-sync-state.json'), JSON.stringify({
      [PENDING_KEY]: { observations: 9, summaries: 0, prompts: 0 },
    }));
    ChromaSyncState.resetCacheForTests();

    // An object is a project entry; only the array is the retry list.
    expect(ChromaSyncState.get(PENDING_KEY).observations).toBe(9);
    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
    // The reserved key keeps the watermark state, so no bootstrap is needed.
    expect(ChromaSyncState.hasProjectState()).toBe(true);

    ChromaSyncState.bump(PENDING_KEY, 'observations', 10);
    ChromaSyncState.resetCacheForTests();
    expect(ChromaSyncState.get(PENDING_KEY).observations).toBe(10);
  });

  it('says no project watermark is recorded when only retry records exist', () => {
    ChromaSyncState.markPendingRowDeletes([{ docType: 'user_prompt', sqliteId: 2 }]);

    expect(ChromaSyncState.exists()).toBe(true);
    // A file saying nothing about indexed rows still needs the one-time
    // bootstrap that trusts what Chroma already holds.
    expect(ChromaSyncState.hasProjectState()).toBe(false);
  });

  it('clearing the retry list keeps the project watermarks', () => {
    ChromaSyncState.replace('owned', { observations: 7, summaries: 0, prompts: 0 });
    ChromaSyncState.markPendingRowDeletes([{ docType: 'observation', sqliteId: 1 }]);
    ChromaSyncState.clearPendingRowDeletes([{ docType: 'observation', sqliteId: 1 }]);
    ChromaSyncState.resetCacheForTests();

    expect(ChromaSyncState.getPendingRowDeletes()).toEqual([]);
    expect(ChromaSyncState.get('owned').observations).toBe(7);
  });
});
