import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real handler/worker HTTP/cache files. Autostart is disabled before imports;
// the only listening endpoint is this child-owned loopback Express fixture.
const fixture = String.raw`
  import express from 'express';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  const app = express(); app.use(express.json());
  let healthCalls = 0;
  app.get('/api/health', (_req, res) => { healthCalls++; res.status(503).send('owned unavailable worker'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  process.env.CLAUDE_MEM_WORKER_PORT = String(server.address().port);
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
  const { cwdToDashed } = await import('./src/services/context/ObservationCompiler.ts');
  const { getProjectContext } = await import('./src/utils/project-name.ts');
  const { contextCacheKeys, readContextCache, writeContextCache, CONTEXT_CACHE_MAX_AGE_MS } = await import('./src/shared/context-cache.ts');
  const { SessionStore } = await import('./src/services/sqlite/SessionStore.ts');
  const { ContextCacheService } = await import('./src/services/worker/ContextCacheService.ts');
  const { SearchRoutes } = await import('./src/services/worker/http/routes/SearchRoutes.ts');
  ModeManager.getInstance().loadMode('code');
  const cwd = join(process.env.CLAUDE_MEM_DATA_DIR, 'checkout'); mkdirSync(cwd, { recursive: true });
  const projects = getProjectContext(cwd).allProjects, project = projects.at(-1);
  const sharedKeys = contextCacheKeys(projects, 'claude', false, cwd);
  const safeKeys = { ...sharedKeys, omitPriorMessage: true };
  const legacySessionKeys = contextCacheKeys(projects, 'claude', false, cwd, 'current-host');
  const mode = process.env.CACHE_OUTAGE_MODE;
  const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
  let cache, routes, safe, live, known, refreshedBeforeBoot;
  if (mode === 'producer') {
    const session = store.createSDKSession('prior-host', project, 'prompt'); store.updateMemorySessionId(session, 'prior-observer');
    store.storeObservation('prior-observer', project, { type: 'discovery', title: 'MEMORY FROM THE DATABASE', subtitle: null, narrative: 'Useful memory', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
    const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed(cwd)); mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, 'prior-host.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PRIOR HOST REPLY' }] } }) + '\n');
    cache = new ContextCacheService({ debounceMs: 1, renderVariant: keys => routes.renderContextVariant(keys), expandProjectReadKeys: keys => store.getProjectReadKeys(keys) });
    routes = new SearchRoutes({ getSessionStore: () => store }, cache); cache.start(); routes.setupRoutes(app);
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    for (let index = 0; index < 80; index++) {
      live = await (await fetch(baseUrl + '/api/context/inject?' + new URLSearchParams({ projects: projects.join(','), platformSource: 'claude', cwd, sessionId: 'closed-host-' + index }))).text();
    }
    await cache.flushPendingRenders();
    safe = readContextCache(safeKeys, Date.now())?.body;
    writeContextCache(safeKeys, 'STALE SAFE CACHE', Date.now() - CONTEXT_CACHE_MAX_AGE_MS - 1);
    await (await fetch(baseUrl + '/api/context/inject?' + new URLSearchParams({ projects: projects.join(','), platformSource: 'claude', cwd, sessionId: 'new-host' }))).text();
    await cache.flushPendingRenders();
    refreshedBeforeBoot = readContextCache(safeKeys, Date.now())?.body;
    // Persisted omitPriorMessage must survive startup and still control rendering.
    cache.stop();
    cache = new ContextCacheService({ debounceMs: 1, renderVariant: keys => routes.renderContextVariant(keys), expandProjectReadKeys: keys => store.getProjectReadKeys(keys) });
    cache.start(); await cache.flushPendingRenders();
    known = cache.knownVariantCount();
    // Project changes must refresh only the plain variant, without a transcript.
    const { emitContextInvalidation } = await import('./src/shared/context-invalidation.ts');
    emitContextInvalidation({ projects }, 'owned-fallback-test'); await cache.flushPendingRenders();
    safe = readContextCache(safeKeys, Date.now())?.body;
    cache.stop();
    await new Promise(resolve => server.close(resolve));
  } else {
    if (mode === 'safe-outage') writeContextCache(safeKeys, 'SAFE MEMORY ONLY', Date.now());
    writeContextCache(sharedKeys, mode === 'default-outage' ? 'SHARED MEMORY' : 'UNSAFE LEGACY PRIOR HOST REPLY', Date.now());
    writeContextCache(legacySessionKeys, 'UNSAFE LEGACY ACTIVE HOST REPLY', Date.now());
  }
  const { contextHandler } = await import('./src/cli/handlers/context.ts');
  const result = await contextHandler.execute({ sessionId: 'current-host', cwd, platform: 'claude-code' });
  console.log(JSON.stringify({ result, safe, live, known, healthCalls, refreshedBeforeBoot }));
  if (mode !== 'producer') await new Promise(resolve => server.close(resolve));
  store.close();
`;

function run(mode: string): any {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-cache-outage-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_AUTOSTART: 'false', CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: String(mode !== 'default-outage'), CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false', CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false', CLAUDE_MEM_PROVIDER: 'codex' }));
    const result = Bun.spawnSync([process.execPath, '-e', fixture], { cwd: join(import.meta.dir, '../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_WORKER_AUTOSTART: 'false', CACHE_OUTAGE_MODE: mode }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('prior transcript outages use only explicitly plain cached memory', () => {
  it('uses the plain variant after the actual worker health probe fails', () => {
    const result = run('safe-outage');
    expect(result.healthCalls).toBeGreaterThan(0);
    expect(result.result.hookSpecificOutput.additionalContext).toBe('SAFE MEMORY ONLY');
  });
  it('rejects generic and session-specific legacy blocks that can contain a prior reply', () => {
    const result = run('legacy-outage');
    expect(result.healthCalls).toBeGreaterThan(0);
    expect(result.result.hookSpecificOutput.additionalContext).toBe('');
  });
  it('keeps the ordinary shared cache fast path when prior messages are disabled', () => {
    const result = run('default-outage');
    expect(result.healthCalls).toBe(0);
    expect(result.result.hookSpecificOutput.additionalContext).toBe('SHARED MEMORY');
  });
  it('warms one transcript-free variant through the real worker and uses it after shutdown', () => {
    const result = run('producer');
    expect(result.live).toContain('PRIOR HOST REPLY');
    expect(result.known).toBe(1);
    expect(result.refreshedBeforeBoot).toContain('MEMORY FROM THE DATABASE');
    expect(result.safe).toContain('MEMORY FROM THE DATABASE');
    expect(result.safe).not.toContain('PRIOR HOST REPLY');
    expect(result.result.hookSpecificOutput.additionalContext).toContain('MEMORY FROM THE DATABASE');
    expect(result.result.hookSpecificOutput.additionalContext).not.toContain('PRIOR HOST REPLY');
  });
});
