import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A work-state write to a list SessionStart shows takes the cached block down at
// once, so the next SessionStart (auto-clear's fresh conversation) reads the new
// lists live instead of a block rendered before the write. Other additive
// writes, and work-state lists the section never shows, keep serving the block.
const fixture = String.raw`
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { contextCacheKeys, readContextCache } from './src/shared/context-cache.ts';
  import { emitContextInvalidation } from './src/shared/context-invalidation.ts';
  const keys = contextCacheKeys(['ws-proj'], 'claude', false);
  const outcome = {};
  const cases = {
    observation: () => emitContextInvalidation({ projects: ['ws-proj'] }, 'observation'),
    workState: () => emitContextInvalidation({ projects: ['ws-proj'] }, 'appendWorkStateEntry', 'additive', { kinds: ['work_state'], workStateLists: ['auth-refactor'] }),
    workStateNoLists: () => emitContextInvalidation({ projects: ['ws-proj'] }, 'appendWorkStateEntry', 'additive', { kinds: ['work_state'] }),
    hiddenLists: () => emitContextInvalidation('all', 'SharedWorkSync.changed', 'additive', { kinds: ['work_state'], workStateLists: ['__my_work_v1:records', 'my-rules'] }),
    otherProject: () => emitContextInvalidation({ projects: ['elsewhere'] }, 'appendWorkStateEntry', 'additive', { kinds: ['work_state'], workStateLists: ['auth-refactor'] }),
  };
  for (const [name, emit] of Object.entries(cases)) {
    const service = new ContextCacheService({ debounceMs: 60000, expandProjectReadKeys: projects => projects,
      renderVariant: async () => ({ body: 'RERENDERED', cacheable: true, readKeys: ['ws-proj'] }),
    });
    service.start();
    await service.recordLiveRender(keys, { body: 'BEFORE WRITE', cacheable: true, readKeys: ['ws-proj'] }, Date.now());
    emit();
    outcome[name] = readContextCache(keys)?.body ?? null;
    service.stop();
  }
  // A render already in flight when the work-state write lands must not write the old lists back.
  {
    let release; const gate = new Promise(resolve => release = resolve);
    let began; const started = new Promise(resolve => began = resolve);
    let renders = 0;
    const service = new ContextCacheService({ debounceMs: 60000, expandProjectReadKeys: projects => projects,
      renderVariant: async () => { renders += 1; if (renders === 1) { began(); await gate; return { body: 'IN-FLIGHT OLD LISTS', cacheable: true, readKeys: ['ws-proj'] }; } return { body: 'NEW LISTS', cacheable: true, readKeys: ['ws-proj'] }; },
    });
    service.start();
    await service.recordLiveRender(keys, { body: 'BEFORE WRITE', cacheable: true, readKeys: ['ws-proj'] }, Date.now());
    emitContextInvalidation({ projects: ['ws-proj'] }, 'observation');
    const flushing = service.flushPendingRenders(); await started;
    cases.workState();
    release(); await flushing;
    outcome.inFlightAfterRelease = readContextCache(keys)?.body ?? null;
    await service.flushPendingRenders();
    outcome.inFlightRerendered = readContextCache(keys)?.body ?? null;
    service.stop();
  }
  console.log(JSON.stringify(outcome));
`;

describe('context cache and work-state writes', () => {
  it('drops the cached block for a shown work-state list, and keeps it otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-cache-work-state-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.observation).toBe('BEFORE WRITE');
      expect(result.workState).toBeNull();
      expect(result.workStateNoLists).toBeNull();
      expect(result.hiddenLists).toBe('BEFORE WRITE');
      expect(result.otherProject).toBe('BEFORE WRITE');
      expect(result.inFlightAfterRelease).not.toBe('IN-FLIGHT OLD LISTS');
      expect(result.inFlightRerendered).toBe('NEW LISTS');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
