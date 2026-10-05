import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { writeFileSync, readFileSync, existsSync } from 'node:fs';
  import { join } from 'node:path';
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { contextCacheKeys, contextCacheDir, contextCacheFilePath, readContextCache, writeContextCache } from './src/shared/context-cache.ts';
  import { emitContextInvalidation } from './src/shared/context-invalidation.ts';
  const shared = contextCacheKeys(['project'], 'claude', false, '/owned/checkout');
  const sessions = Array.from({ length: 80 }, (_, index) => contextCacheKeys(['project'], 'claude', false, '/owned/checkout', 'closed-host-' + index));
  const calls = [];
  const options = { now: () => 1000, debounceMs: 1, expandProjectReadKeys: keys => keys, renderVariant: async keys => { calls.push(keys); return { body: 'REFRESHED SHARED', cacheable: true }; } };
  if (process.env.CACHE_PHASE === 'legacy') {
    // Files and index written by the previous session-variant implementation.
    writeContextCache(shared, 'USEFUL SHARED', 1000);
    for (const keys of sessions) writeContextCache(keys, 'CLOSED SESSION', 1000);
    writeFileSync(join(contextCacheDir(), 'variants.json'), JSON.stringify({ variants: [shared, ...sessions].map((keys, index) => ({ keys, learnedAtEpochMs: index })) }));
  } else {
    const live = new ContextCacheService(options);
    live.start();
    live.recordLiveRender(shared, { body: 'USEFUL SHARED', cacheable: true }, 1000);
    for (const keys of sessions) live.recordLiveRender(keys, { body: 'CLOSED SESSION', cacheable: true }, 1000);
    live.stop();
  }
  const usefulBeforeBoot = readContextCache(shared, 1000)?.body;
  const booted = new ContextCacheService(options);
  booted.start(); await booted.flushPendingRenders();
  const startupCalls = calls.splice(0);
  emitContextInvalidation({ projects: ['project'] }, 'owned-policy-test');
  await booted.flushPendingRenders();
  const invalidationCalls = calls.splice(0);
  const variants = JSON.parse(readFileSync(join(contextCacheDir(), 'variants.json'), 'utf8')).variants;
  console.log(JSON.stringify({ usefulBeforeBoot, useful: readContextCache(shared, 1000)?.body, startupCalls, invalidationCalls, variants, remainingSessionFiles: sessions.filter(keys => existsSync(contextCacheFilePath(keys))).length }));
  booted.stop();
`;

function run(phase: string): any {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-cache-policy-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], { cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CACHE_PHASE: phase }, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('session-specific transcript context stays live', () => {
  for (const phase of ['live', 'legacy']) {
    it(`preserves useful shared context and skips 80 closed variants from ${phase} sessions`, () => {
      const result = run(phase);
      console.info(JSON.stringify({ phase, usefulBeforeBoot: result.usefulBeforeBoot ?? null, startupRenders: result.startupCalls.length, invalidationRenders: result.invalidationCalls.length, persistedVariants: result.variants.length, remainingSessionFiles: result.remainingSessionFiles }));
      expect(result.usefulBeforeBoot).toBe('USEFUL SHARED');
      expect(result.useful).toBe('REFRESHED SHARED');
      expect(result.startupCalls).toHaveLength(1);
      expect(result.invalidationCalls).toHaveLength(1);
      expect(result.startupCalls[0].sessionId).toBeUndefined();
      expect(result.invalidationCalls[0].sessionId).toBeUndefined();
      expect(result.variants).toHaveLength(1);
      expect(result.variants[0].keys.sessionId).toBeUndefined();
      expect(result.remainingSessionFiles).toBe(0);
    });
  }
});
