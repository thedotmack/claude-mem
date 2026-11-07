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
