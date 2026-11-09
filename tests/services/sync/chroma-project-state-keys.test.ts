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
