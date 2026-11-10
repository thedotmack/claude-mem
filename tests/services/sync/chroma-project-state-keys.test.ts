import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';

describe('ChromaSyncState project keys', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-project-state-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    ChromaSyncState.resetCacheForTests();
  });

  afterEach(() => {
    ChromaSyncState.resetCacheForTests();
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  for (const initialFile of [undefined, '{ truncated']) {
    it(`persists prototype-named projects from ${initialFile ? 'corrupt' : 'missing'} state`, () => {
      const path = join(dataDir, 'chroma-sync-state.json');
      if (initialFile) writeFileSync(path, initialFile);

      for (const project of ['__proto__', 'constructor', 'toString', 'ordinary']) {
        ChromaSyncState.bump(project, 'observations', 7);
        ChromaSyncState.markTitleOnlyRequeued(project);
      }

      const written = JSON.parse(readFileSync(path, 'utf8'));
      for (const project of ['__proto__', 'constructor', 'toString', 'ordinary']) {
        assert.equal(Object.hasOwn(written, project), true, `${project} must be serialized`);
      }
      ChromaSyncState.resetCacheForTests();
      assert.equal(ChromaSyncState.get('__proto__').observations, 7);
      assert.equal(ChromaSyncState.isTitleOnlyRequeued('__proto__'), true);
    });
  }

  it('preserves pending fragment repairs across restarts and acknowledges completed rows', () => {
    ChromaSyncState.markFragmentReconciliation('__proto__', 'observations', 4);
    ChromaSyncState.markFragmentReconciliation('__proto__', 'observations', 9);
    ChromaSyncState.resetCacheForTests();

    assert.deepEqual(ChromaSyncState.getPending('__proto__', 'observations'), [4, 9]);
    assert.equal(ChromaSyncState.needsFragmentReconciliation('__proto__', 'observations', 4), true);
    ChromaSyncState.clearFragmentReconciliation('__proto__', 'observations', 4);
    ChromaSyncState.bump('__proto__', 'observations', 4);
    ChromaSyncState.resetCacheForTests();

    assert.equal(ChromaSyncState.get('__proto__').observations, 4);
    assert.deepEqual(ChromaSyncState.getPending('__proto__', 'observations'), [9]);
    assert.equal(ChromaSyncState.needsFragmentReconciliation('__proto__', 'observations', 4), false);
    assert.equal(ChromaSyncState.needsFragmentReconciliation('__proto__', 'observations', 9), true);
  });

  it('includes prototype-named checkpoints loaded from disk in collection rebuilds', () => {
    writeFileSync(join(dataDir, 'chroma-sync-state.json'), JSON.stringify({
      ['__proto__']: { observations: 12, summaries: 3, prompts: 2 },
      ordinary: { observations: 8, summaries: 0, prompts: 0 },
    }));

    ChromaSyncState.markAllForRebuild();
    ChromaSyncState.resetCacheForTests();
    assert.equal(ChromaSyncState.isRebuildPending('__proto__'), true);
    assert.equal(ChromaSyncState.isRebuildPending('ordinary'), true);
    assert.equal(ChromaSyncState.get('__proto__').observations, 12);

    ChromaSyncState.resetForRebuild('__proto__');
    ChromaSyncState.bump('__proto__', 'observations', 5);
    ChromaSyncState.finishRebuild('__proto__');
    ChromaSyncState.resetCacheForTests();
    assert.equal(ChromaSyncState.isRebuildPending('__proto__'), false);
    assert.equal(ChromaSyncState.get('__proto__').observations, 5);
    assert.equal(ChromaSyncState.isRebuildPending('ordinary'), true);
  });
});

// #5664 — failed post-delete cleanups live in the same checkpoint as the
// watermarks: the retry record has to survive the worker that gave up on it,
// and its one array-valued entry must not disturb the project map around it.
describe('ChromaSyncState pending row-delete retry records', () => {
  const PENDING_KEY = '__pending_row_deletes__';
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-pending-deletes-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    ChromaSyncState.resetCacheForTests();
  });

  afterEach(() => {
    ChromaSyncState.resetCacheForTests();
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips retry records beside the project watermarks', () => {
    ChromaSyncState.replace('owned', { observations: 4, summaries: 2, prompts: 1 });
    ChromaSyncState.markPendingRowDeletes([
      { docType: 'observation', sqliteId: 12 },
      { docType: 'session_summary', sqliteId: 12 },
    ]);
    ChromaSyncState.resetCacheForTests();

    assert.deepEqual(ChromaSyncState.getPendingRowDeletes(), [
      { docType: 'observation', sqliteId: 12 },
      { docType: 'session_summary', sqliteId: 12 },
    ]);
    // The retry list did not become a project, and the project kept its marks.
    assert.deepEqual(ChromaSyncState.get('owned'), { observations: 4, summaries: 2, prompts: 1 });
    assert.equal(ChromaSyncState.hasProjectState(), true);
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

    assert.deepEqual(ChromaSyncState.getPendingRowDeletes(), [{ docType: 'observation', sqliteId: 3 }]);
  });

  it('keeps a project that happens to be named like the retry key', () => {
    writeFileSync(join(dataDir, 'chroma-sync-state.json'), JSON.stringify({
      [PENDING_KEY]: { observations: 9, summaries: 0, prompts: 0 },
    }));
    ChromaSyncState.resetCacheForTests();

    // An object is a project entry; only the array is the retry list.
    assert.equal(ChromaSyncState.get(PENDING_KEY).observations, 9);
    assert.deepEqual(ChromaSyncState.getPendingRowDeletes(), []);
    // The reserved key keeps the watermark state, so no bootstrap is needed.
    assert.equal(ChromaSyncState.hasProjectState(), true);

    ChromaSyncState.bump(PENDING_KEY, 'observations', 10);
    ChromaSyncState.resetCacheForTests();
    assert.equal(ChromaSyncState.get(PENDING_KEY).observations, 10);
  });

  it('says no project watermark is recorded when only retry records exist', () => {
    ChromaSyncState.markPendingRowDeletes([{ docType: 'user_prompt', sqliteId: 2 }]);

    assert.equal(ChromaSyncState.exists(), true);
    // A file saying nothing about indexed rows still needs the one-time
    // bootstrap that trusts what Chroma already holds.
    assert.equal(ChromaSyncState.hasProjectState(), false);
  });

  it('clearing the retry list keeps the project watermarks', () => {
    ChromaSyncState.replace('owned', { observations: 7, summaries: 0, prompts: 0 });
    ChromaSyncState.markPendingRowDeletes([{ docType: 'observation', sqliteId: 1 }]);
    ChromaSyncState.clearPendingRowDeletes([{ docType: 'observation', sqliteId: 1 }]);
    ChromaSyncState.resetCacheForTests();

    assert.deepEqual(ChromaSyncState.getPendingRowDeletes(), []);
    assert.equal(ChromaSyncState.get('owned').observations, 7);
  });
});
