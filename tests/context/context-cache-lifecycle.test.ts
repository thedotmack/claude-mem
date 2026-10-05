import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { contextCacheKeys, readContextCache } from './src/shared/context-cache.ts';
  import { emitContextInvalidation } from './src/shared/context-invalidation.ts';
  const keys = contextCacheKeys(['lifecycle'], 'claude', false);
  const other = contextCacheKeys(['other'], 'claude', false);
  const outcome = {};
  for (const action of ['stop', 'evict', 'replace']) {
    let release; const gate = new Promise(resolve => release = resolve);
    let began; const started = new Promise(resolve => began = resolve);
    const service = new ContextCacheService({ debounceMs: 60000, maxVariants: 1, expandProjectReadKeys: projects => projects,
      renderVariant: async () => { began(); await gate; return { body: 'OLD IN-FLIGHT', cacheable: true }; }
    });
    service.start(); service.recordLiveRender(keys, { body: 'BEFORE WRITE', cacheable: true });
    emitContextInvalidation({ projects: ['lifecycle'] }, 'observation');
    const flushing = service.flushPendingRenders(); await started;
    if (action === 'stop') service.stop();
    else service.recordLiveRender(other, { body: 'OTHER', cacheable: true }, Date.now() + 1);
    if (action === 'replace') service.recordLiveRender(keys, { body: 'NEW LIVE', cacheable: true }, Date.now() + 2);
    outcome[action + 'BeforeRelease'] = readContextCache(keys)?.body ?? null;
    release(); await flushing;
    outcome[action] = readContextCache(keys)?.body ?? null;
    service.stop();
  }
  console.log(JSON.stringify(outcome));
`;

describe('context cache in-flight lifecycle', () => {
  it('does not resurrect stopped or evicted variants, or overwrite a replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-cache-lifecycle-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.stopBeforeRelease).toBeNull();
      expect(result.stop).toBeNull();
      expect(result.evictBeforeRelease).toBeNull();
      expect(result.evict).toBeNull();
      expect(result.replaceBeforeRelease).toBe('NEW LIVE');
      expect(result.replace).toBe('NEW LIVE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
