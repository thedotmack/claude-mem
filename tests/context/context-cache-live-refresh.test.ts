import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { contextCacheKeys, readContextCache } from './src/shared/context-cache.ts';
  import { emitContextInvalidation } from './src/shared/context-invalidation.ts';
  const action = process.env.PROBE_ACTION;
  const keys = contextCacheKeys(['same-live-project'], 'claude', false);
  let release; const gate = new Promise(resolve => release = resolve);
  let began; const started = new Promise(resolve => began = resolve);
  const service = new ContextCacheService({ debounceMs: 60000, expandProjectReadKeys: projects => projects,
    renderVariant: async () => {
      began(); await gate;
      if (action === 'reject') throw new Error('older queued render failed');
      return { body: 'QUEUED BODY', cacheable: true };
    }
  });
  service.start();
  service.recordLiveRender(keys, { body: 'FIRST LIVE', cacheable: true }, Date.now());
  emitContextInvalidation({ projects: keys.projects }, 'storeObservations');
  const flushing = service.flushPendingRenders(); await started;
  if (action !== 'queued-only') service.recordLiveRender(keys, { body: 'NEWER LIVE BODY', cacheable: action !== 'uncacheable' }, Date.now() + 2);
  const beforeRelease = readContextCache(keys)?.body ?? null;
  release(); await flushing;
  console.log(JSON.stringify({ beforeRelease, afterRelease: readContextCache(keys)?.body ?? null, variants: service.knownVariantCount() }));
  service.stop();
`;

function run(action: string) {
  const dir = mkdtempSync(join(tmpdir(), 'context-cache-live-refresh-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, PROBE_ACTION: action, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
      stdout: 'pipe', stderr: 'pipe', timeout: 3000,
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('context cache queued render versus newer live render', () => {
  for (const action of ['resolve', 'reject']) {
    it(`keeps a newer live render of the existing variant when the older render ${action}s`, () => {
      const result = run(action);
      expect(result.variants).toBe(1);
      expect(result.beforeRelease).toBe('NEWER LIVE BODY');
      expect(result.afterRelease).toBe('NEWER LIVE BODY');
    });
  }
  it('does not resurrect a variant made uncacheable by its newer live render', () => {
    const result = run('uncacheable');
    expect(result.variants).toBe(1);
    expect(result.beforeRelease).toBeNull();
    expect(result.afterRelease).toBeNull();
  });
  it('still persists the queued render when no newer live render replaced it', () => {
    const result = run('queued-only');
    expect(result.variants).toBe(1);
    expect(result.beforeRelease).toBe('FIRST LIVE');
    expect(result.afterRelease).toBe('QUEUED BODY');
  });
});
