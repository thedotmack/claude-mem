import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// "Include last message" shows the prior session's final reply, chosen by
// excluding the session that asks. A cached block is read by any session, so it
// never carries a reply: with the setting on, the live answer has the reply and
// the cached block (the hook's fallback while the worker is down) does not.
// That has to hold for the cache's own re-renders too, not only live requests.
const fixture = String.raw`
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { cwdToDashed } from './src/services/context/ObservationCompiler.ts';
  import { contextCacheKeys, listContextCacheFiles, readContextCache } from './src/shared/context-cache.ts';
  import { emitContextInvalidation, noteUserSettingsSaved } from './src/shared/context-invalidation.ts';
  ModeManager.getInstance().loadMode('code');
  const cwd = '/owned/lifecycle-checkout';
  const transcripts = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed(cwd));
  mkdirSync(transcripts, { recursive: true });
  const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
  for (const [host, observer, epoch] of [['prior-host', 'prior-observer', Date.now() - 60_000], ['active-host', 'active-observer', Date.now()]]) {
    const id = store.createSDKSession(host, 'project', 'prompt');
    store.updateMemorySessionId(id, observer);
    store.storeObservation(observer, 'project', { type: 'discovery', title: host + ' fact', subtitle: null, narrative: 'n', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1, 0, epoch);
    writeFileSync(join(transcripts, host + '.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'REPLY_FROM_' + host }] } }) + '\n');
  }
  let routes;
  const cache = new ContextCacheService({ debounceMs: 1, renderVariant: keys => routes.renderContextVariant(keys), expandProjectReadKeys: keys => store.getProjectReadKeys(keys) });
  routes = new SearchRoutes({ getSessionStore: () => store }, cache);
  let handler;
  routes.setupRoutes({ get: (path, h) => { if (path === '/api/context/inject') handler = h; }, post: () => {}, delete: () => {}, use: () => {} });
  const live = query => new Promise(resolve => {
    const res = { setHeader: () => {}, send: resolve, status: () => res, json: body => resolve(JSON.stringify(body)), headersSent: false };
    handler({ query, get: () => undefined, body: undefined }, res);
  });
  // What a viewer save does (SettingsRoutes): write, note the save, invalidate everything.
  const saveShowLastMessage = async value => {
    writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'), JSON.stringify({ CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: String(value), CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false' }));
    noteUserSettingsSaved();
    emitContextInvalidation('all', 'settings');
    await cache.flushPendingRenders();
  };
  const keys = contextCacheKeys(['project'], undefined, false, cwd);
  const snapshot = () => ({ variants: cache.knownVariantCount(), files: listContextCacheFiles().length, cached: readContextCache(keys, Date.now())?.body ?? null });

  cache.start();
  await saveShowLastMessage(false);
  const offLive = await live({ projects: 'project', cwd });
  const off = snapshot();
  await saveShowLastMessage(true);
  const onAfterRerender = snapshot();
  for (let index = 0; index < 80; index++) await live({ projects: 'project', cwd, sessionId: 'closed-host-' + index });
  const activeLive = await live({ projects: 'project', cwd, sessionId: 'active-host' });
  await cache.flushPendingRenders();
  const onAfterSessions = snapshot();
  await saveShowLastMessage(false);
  const offAgain = snapshot();
  cache.stop();
  store.close();
  console.log(JSON.stringify({ offLive, off, onAfterRerender, activeLive, onAfterSessions, offAgain }));
`;

function run(): any {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-cache-lifecycle-'));
  try {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') };
    delete env.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE;
    const result = Bun.spawnSync([process.execPath, '-e', fixture], { cwd: join(import.meta.dir, '../..'), env, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function expectOneCachedBlockWithoutReply(snapshot: { variants: number; files: number; cached: string | null }) {
  expect(snapshot.variants).toBe(1);
  expect(snapshot.files).toBe(1);
  expect(snapshot.cached).toContain('active-host fact');
  expect(snapshot.cached).not.toContain('REPLY_FROM_');
}

describe('context with the prior reply', () => {
  it('keeps the reply out of the cached block whether the setting is on or off', () => {
    const result = run();
    expect(result.offLive).not.toContain('REPLY_FROM_');
    expectOneCachedBlockWithoutReply(result.off);
    // Turning it on re-renders the cached block, which still has no reply: it
    // was rendered for no session, so any reply in it could be the reader's own.
    expectOneCachedBlockWithoutReply(result.onAfterRerender);
    // Live sessions get the prior reply, never their own, and add no variants.
    expect(result.activeLive).toContain('REPLY_FROM_prior-host');
    expect(result.activeLive).not.toContain('REPLY_FROM_active-host');
    expectOneCachedBlockWithoutReply(result.onAfterSessions);
    expectOneCachedBlockWithoutReply(result.offAgain);
  });
});
