/**
 * Precomputed SessionStart context (liveness plan, Phase 6).
 *
 * - fillContextPlaceholders is the one fill both the hook and the live route use,
 *   so a cached block filled at T is byte-identical to the live answer at T.
 * - Every write point invalidates and the block re-renders within the debounce.
 * - The hook serves a cached block without calling the worker, falls back to
 *   the live path on a miss or a stale (>24h) file, and never leaks placeholders.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';

import {
  CONTEXT_CACHE_MAX_AGE_MS,
  CONTEXT_HEADER_TIME_PLACEHOLDER,
  HEADER_TIME_MAX_FILLED_CHARS,
  contextCacheDir,
  contextCacheFilePath,
  contextCacheKeys,
  fillContextPlaceholders,
  readContextCache,
  relativeTimePlaceholder,
  writeContextCache,
} from '../../src/shared/context-cache.js';
import { emitContextInvalidation } from '../../src/shared/context-invalidation.js';
import { formatHeaderDateTime } from '../../src/shared/timeline-formatting.js';
import { describeDuration, recordObserverFailure, recordObserverSuccess } from '../../src/shared/observer-health.js';
import { writeSyncHealth } from '../../src/shared/sync-health.js';
import { ContextCacheService, type ContextVariantRender } from '../../src/services/worker/ContextCacheService.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SyncApply, type SyncOp } from '../../src/services/sync/SyncApply.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const PLACEHOLDER_MARKER = '⟦CMEM_';

describe('fillContextPlaceholders', () => {
  const nowEpochMs = 1_790_000_000_000;

  it('fills the header time and every relative duration', () => {
    const body = [
      `# [proj] recent context, ${CONTEXT_HEADER_TIME_PLACEHOLDER}`,
      `- release: status=active, updated ${relativeTimePlaceholder(nowEpochMs - 3 * 3_600_000)} ago`,
      `  - [todo] publish, updated ${relativeTimePlaceholder(nowEpochMs - 5 * 60_000)} ago`,
    ].join('\n');

    expect(fillContextPlaceholders(body, nowEpochMs)).toBe([
      `# [proj] recent context, ${formatHeaderDateTime(new Date(nowEpochMs))}`,
      '- release: status=active, updated about 3 hours ago',
      '  - [todo] publish, updated 5 minutes ago',
    ].join('\n'));
  });

  it('never leaves a placeholder behind', () => {
    const body = `${CONTEXT_HEADER_TIME_PLACEHOLDER} ${relativeTimePlaceholder(1)} ${relativeTimePlaceholder(nowEpochMs)}`;
    expect(fillContextPlaceholders(body, nowEpochMs)).not.toContain(PLACEHOLDER_MARKER);
  });

  it('leaves placeholder look-alikes from memory text untouched', () => {
    // An observation can quote anything, including a placeholder's shape; only
    // placeholders carrying the rendering nonce are filled.
    const injected = `⟦CMEM_NOW_HEADER:000000000000⟧ ⟦CMEM_AGO:000000000000:0000000000001⟧ ⟦CMEM_AGO:99999999999999999999⟧`;
    expect(fillContextPlaceholders(injected, nowEpochMs)).toBe(injected);
    const userCopiedRealPlaceholder = `${CONTEXT_HEADER_TIME_PLACEHOLDER}`;
    expect(fillContextPlaceholders(userCopiedRealPlaceholder, nowEpochMs, 'abcdefabcdef')).toBe(userCopiedRealPlaceholder);
    expect(() => fillContextPlaceholders('x', nowEpochMs, '../not-a-nonce')).toThrow();
  });

  it('keeps fitted text within budget once filled', () => {
    // A relative-time placeholder is never shorter than the duration it becomes.
    for (const ageMs of [0, 59_000, 3_600_000, 47 * 3_600_000, 400 * 86_400_000, nowEpochMs]) {
      expect(relativeTimePlaceholder(nowEpochMs - ageMs).length)
        .toBeGreaterThanOrEqual(describeDuration(ageMs).length);
    }
    // The header reserve covers the real header time.
    expect(formatHeaderDateTime(new Date(nowEpochMs)).length).toBeLessThanOrEqual(HEADER_TIME_MAX_FILLED_CHARS);
  });
});

describe('readContextCache', () => {
  const keys = contextCacheKeys(['cache-read-parent', 'cache-read-repo'], 'claude', false);
  afterEach(() => rmSync(contextCacheFilePath(keys), { force: true }));

  it('returns a fresh file', () => {
    writeContextCache(keys, 'BODY', 1_000);
    expect(readContextCache(keys, 1_000 + CONTEXT_CACHE_MAX_AGE_MS)?.body).toBe('BODY');
  });

  it('treats a file older than 24h as a miss', () => {
    writeContextCache(keys, 'BODY', 1_000);
    expect(readContextCache(keys, 1_000 + CONTEXT_CACHE_MAX_AGE_MS + 1)).toBeNull();
  });

  it('treats a missing or unreadable file as a miss', () => {
    expect(readContextCache(keys, 1_000)).toBeNull();
    writeFileSync(contextCacheFilePath(keys), '{not json');
    expect(readContextCache(keys, 1_000)).toBeNull();
  });

  it('keys each variant separately', () => {
    writeContextCache(keys, 'AGENT', 1_000);
    expect(readContextCache(contextCacheKeys(['cache-read-parent', 'cache-read-repo'], 'claude', true), 1_000)).toBeNull();
    expect(readContextCache(contextCacheKeys(['cache-read-parent', 'cache-read-repo'], undefined, false), 1_000)).toBeNull();
    expect(readContextCache(contextCacheKeys([' cache-read-parent', 'cache-read-repo '], 'claude', false), 1_000)?.body).toBe('AGENT');
  });
});

describe('ContextCacheService invalidation', () => {
  const DEBOUNCE_MS = 20;
  const project = 'invalidate-proj';
  let service: ContextCacheService;
  let renders: string[];
  let renderCount: number;
  let tempDir: string;

  const keys = contextCacheKeys([project], 'claude', false);
  const otherKeys = contextCacheKeys(['unrelated-proj'], 'claude', false);
  /**
   * Let the debounce timer fire, then wait for the renders it queued. A fixed
   * sleep alone raced the sequential per-variant renders under a loaded full-suite
   * run (CI saw only the first of two variants rendered).
   */
  const waitPastDebounce = async () => {
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS * 4));
    await service.flushPendingRenders();
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-context-cache-'));
    renders = [];
    renderCount = 0;
    service = new ContextCacheService({
      debounceMs: DEBOUNCE_MS,
      renderVariant: async (variantKeys): Promise<ContextVariantRender> => {
        renderCount++;
        renders.push(variantKeys.projects.join(','));
        return { body: `render #${renderCount} at ${CONTEXT_HEADER_TIME_PLACEHOLDER}`, cacheable: true };
      },
      // As projectReadKeys would: a project merged into this one, stored in other casing.
      expandProjectReadKeys: projects => projects.includes(project) ? [...projects, 'Merged-Into-Invalidate-Proj'] : projects,
    });
    service.start();
    service.recordLiveRender(keys, { body: 'live', cacheable: true }, Date.now());
    service.recordLiveRender(otherKeys, { body: 'other', cacheable: true }, Date.now());
    // A started service re-renders every variant the index remembers; let that settle first.
    await service.flushPendingRenders();
    renders = [];
  });

  afterAll(() => rmSync(contextCacheDir(), { recursive: true, force: true }));

  afterEach(async () => {
    await service.flushPendingRenders();
    service.stop();
    rmSync(contextCacheFilePath(keys), { force: true });
    rmSync(contextCacheFilePath(otherKeys), { force: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function expectRerenderedOnlyFor(write: () => void | Promise<void>, expectedProjects: string[] = [project]): Promise<void> {
    await write();
    expect(renders).toEqual([]);
    await waitPastDebounce();
    expect(renders.sort()).toEqual([...expectedProjects].sort());
    expect(readContextCache(keys, Date.now())?.body).toStartWith('render #');
  }

  function memoryStore(): SessionStore {
    const store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('content-1', project, 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-1');
    return store;
  }

  const observation = {
    type: 'discovery', title: 'A title', subtitle: null, facts: [], narrative: 'n',
    concepts: [], files_read: [], files_modified: [],
  };

  it('SessionStore.storeObservations', async () => {
    const store = memoryStore();
    await expectRerenderedOnlyFor(() => {
      store.storeObservations('memory-1', project, [observation], null);
    });
    store.close();
  });

  it('SessionStore.storeSummary', async () => {
    const store = memoryStore();
    await expectRerenderedOnlyFor(() => {
      store.storeSummary('memory-1', project, {
        request: 'r', investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null,
      });
    });
    store.close();
  });

  it('SessionStore.appendWorkStateEntry', async () => {
    const store = memoryStore();
    await expectRerenderedOnlyFor(() => {
      store.appendWorkStateEntry({ project, listName: 'release', fields: { status: 'active' } });
    });
    store.close();
  });

  it('SessionStore.importObservation (matched through a read key, case-insensitively)', async () => {
    const store = memoryStore();
    await expectRerenderedOnlyFor(() => {
      store.importObservation({
        memory_session_id: 'memory-1', project: 'merged-into-invalidate-proj', text: null, type: 'discovery',
        title: 'Imported', subtitle: null, facts: null, narrative: null, concepts: null, files_read: null,
        files_modified: null, prompt_number: 1, discovery_tokens: 0, created_at: new Date().toISOString(),
        created_at_epoch: Date.now(),
      } as any);
    });
    store.close();
  });

  it('SessionStore.importSessionSummary', async () => {
    const store = memoryStore();
    await expectRerenderedOnlyFor(() => {
      store.importSessionSummary({
        memory_session_id: 'memory-1', project, request: 'r', investigated: null, learned: null, completed: null,
        next_steps: null, files_read: null, files_edited: null, notes: null, prompt_number: 1, discovery_tokens: 0,
        created_at: new Date().toISOString(), created_at_epoch: Date.now(),
      } as any);
    });
    store.close();
  });

  it('SyncApply.applyOps', async () => {
    const db = new Database(':memory:');
    new SessionStore(db);
    const apply = new SyncApply(db, { deviceId: 'device-self', now: () => Date.now() });
    const body = {
      memory_session_id: 'mem-remote', project: 'remote-proj', text: null, type: 'discovery', title: 'Remote',
      subtitle: null, facts: '[]', narrative: 'n', concepts: '[]', files_read: '[]', files_modified: '[]',
      prompt_number: 1, discovery_tokens: 0, content_hash: 'h', generated_by_model: null, agent_type: null,
      agent_id: null, metadata: null, merged_into_project: null, created_at: new Date().toISOString(),
      created_at_epoch: Date.now(),
    };
    const op: SyncOp = {
      seq: '1', kind: 'observation', origin_device: 'device-remote', origin_id: '11', rev: '1',
      body: JSON.stringify(body), server_ts: Date.now(),
    };
    // A pulled op can re-key projects (remap mutations), so every variant re-renders.
    await expectRerenderedOnlyFor(() => {
      expect(apply.applyOps([op]).applied).toBe(1);
    }, [project, 'unrelated-proj']);
    db.close();
  });

  it('DataRoutes observation delete', async () => {
    const store = memoryStore();
    const { observationIds } = store.storeObservations('memory-1', project, [observation], null);
    await waitPastDebounce();
    renders = [];
    let deleteHandler: ((req: any, res: any) => void) | undefined;
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => null } as any,
      {} as any,
      { broadcast: () => {} } as any,
      {} as any,
      Date.now(),
    );
    routes.setupRoutes({
      get: () => {}, post: () => {}, use: () => {},
      delete: (path: string, handler: (req: any, res: any) => void) => {
        if (path === '/api/observation/:id') deleteHandler = handler;
      },
    } as any);
    const res = { json: mock(() => {}), status: mock(() => res), setHeader: () => {}, headersSent: false };
    await expectRerenderedOnlyFor(() => {
      deleteHandler!({ params: { id: String(observationIds[0]) }, query: {} }, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    }, [project, 'unrelated-proj']);
    store.close();
  });

  it('observer-health writer (banner)', async () => {
    const healthPath = join(tempDir, 'observer-health.json');
    // Below the threshold the banner stays hidden, so nothing re-renders.
    recordObserverFailure('claude', 'boom', healthPath);
    recordObserverFailure('claude', 'boom', healthPath);
    await waitPastDebounce();
    expect(renders).toEqual([]);
    await expectRerenderedOnlyFor(() => recordObserverFailure('claude', 'boom', healthPath), [project, 'unrelated-proj']);
    renders = [];
    await expectRerenderedOnlyFor(() => recordObserverSuccess(healthPath), [project, 'unrelated-proj']);
  });

  it('a success while healthy (every stored observation) re-renders nothing', async () => {
    const healthPath = join(tempDir, 'observer-health.json');
    recordObserverSuccess(healthPath);
    recordObserverSuccess(healthPath);
    await waitPastDebounce();
    expect(renders).toEqual([]);
  });

  it('stopping with a re-render pending removes the stale file', async () => {
    expect(existsSync(contextCacheFilePath(keys))).toBe(true);
    emitContextInvalidation('all', 'delete-observation');
    service.stop();
    expect(existsSync(contextCacheFilePath(keys))).toBe(false);
    expect(existsSync(contextCacheFilePath(otherKeys))).toBe(false);
  });

  it('sync-health writer (banner)', async () => {
    await expectRerenderedOnlyFor(() => writeSyncHealth({
      state: 'ok', code: null, message: null, consecutiveFailures: 0, failingSinceAt: null,
      lastErrorAt: null, lastSuccessAt: Date.now(), updatedAt: Date.now(),
    }, join(tempDir, 'sync-health.json')), [project, 'unrelated-proj']);
  });

  it('settings change', async () => {
    // SettingsRoutes.handleUpdateSettings emits exactly this after persisting.
    await expectRerenderedOnlyFor(() => emitContextInvalidation('all', 'settings'), [project, 'unrelated-proj']);
  });

  it('coalesces a burst of writes into one render per variant', async () => {
    for (let index = 0; index < 5; index++) {
      emitContextInvalidation({ projects: [project] }, 'burst');
    }
    await waitPastDebounce();
    expect(renders).toEqual([project]);
  });

  it('removes the file instead of caching a block that carries the health banner', async () => {
    expect(existsSync(contextCacheFilePath(keys))).toBe(true);
    service.recordLiveRender(keys, { body: 'with banner', cacheable: false }, Date.now());
    expect(existsSync(contextCacheFilePath(keys))).toBe(false);
  });

  it('re-renders every remembered variant when a new worker starts', async () => {
    service.stop();
    renders = [];
    const booted = new ContextCacheService({
      debounceMs: DEBOUNCE_MS,
      renderVariant: async (variantKeys) => {
        renders.push(variantKeys.projects.join(','));
        return { body: 'boot render', cacheable: true };
      },
      expandProjectReadKeys: projects => projects,
    });
    booted.start();
    expect(booted.knownVariantCount()).toBeGreaterThanOrEqual(2);
    await booted.flushPendingRenders();
    expect(renders).toContain(project);
    expect(renders).toContain('unrelated-proj');
    expect(readContextCache(keys, Date.now())?.body).toBe('boot render');
    booted.stop();
  });
});

// ---------------------------------------------------------------------------
// Hook: cache hit, miss, stale, colors (worker-utils mocked; nothing is spawned)
// ---------------------------------------------------------------------------

const HOOK_PROJECTS = ['cache-hook-parent', 'cache-hook-repo'];
const workerCalls: string[] = [];
let showTerminalOutput = false;

mock.module('../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => ({
    ...realHookSettingsSnapshot.loadFromFileOnce(),
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: String(showTerminalOutput),
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'false',
    CLAUDE_MEM_PROVIDER: 'codex',
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
    CLAUDE_MEM_PRO_PLAN: '',
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  }),
}));

mock.module('../../src/utils/project-name.js', () => ({
  ...realProjectNameSnapshot,
  getProjectContext: () => ({
    primary: HOOK_PROJECTS[1],
    parent: HOOK_PROJECTS[0],
    isWorktree: true,
    allProjects: [...HOOK_PROJECTS],
  }),
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: async (path: string) => {
    workerCalls.push(path);
    return path.includes('colors=true') ? 'LIVE COLORED' : 'LIVE CONTEXT';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
  consumeWorkerOutageNotice: async () => null,
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('context hook reads the precomputed block', () => {
  const agentKeys = contextCacheKeys(HOOK_PROJECTS, 'claude', false);
  const colorKeys = contextCacheKeys(HOOK_PROJECTS, 'claude', true);
  const cachedBody = `# [cache-hook-repo] recent context, ${CONTEXT_HEADER_TIME_PLACEHOLDER}\n`
    + `- release: updated ${relativeTimePlaceholder(Date.now() - 2 * 3_600_000)} ago\n`;

  beforeEach(() => {
    workerCalls.length = 0;
    showTerminalOutput = false;
  });
  afterEach(() => {
    rmSync(contextCacheFilePath(agentKeys), { force: true });
    rmSync(contextCacheFilePath(colorKeys), { force: true });
  });

  async function runHook() {
    const { contextHandler } = await import('../../src/cli/handlers/context.js');
    return contextHandler.execute({ sessionId: 'cache-session', cwd: '/tmp/cache-hook-repo', platform: 'claude-code' });
  }

  it('serves a cached block without calling the worker', async () => {
    writeContextCache(agentKeys, cachedBody, Date.now());
    const result = await runHook();
    expect(workerCalls).toEqual([]);
    const additionalContext = result.hookSpecificOutput?.additionalContext ?? '';
    expect(additionalContext).toStartWith('# [cache-hook-repo] recent context, ');
    expect(additionalContext).toContain('- release: updated about 2 hours ago');
    expect(additionalContext).not.toContain(PLACEHOLDER_MARKER);
  });

  it('takes the live path on a miss, with the same URL as before', async () => {
    const result = await runHook();
    expect(workerCalls).toEqual(['/api/context/inject?projects=cache-hook-parent%2Ccache-hook-repo&platformSource=claude']);
    expect(result.hookSpecificOutput?.additionalContext).toBe('LIVE CONTEXT');
  });

  it('takes the live path when the cached block is older than 24h', async () => {
    writeContextCache(agentKeys, cachedBody, Date.now() - CONTEXT_CACHE_MAX_AGE_MS - 60_000);
    const result = await runHook();
    expect(workerCalls).toHaveLength(1);
    expect(result.hookSpecificOutput?.additionalContext).toBe('LIVE CONTEXT');
  });

  it('skips the colored fetch too when that variant is cached', async () => {
    showTerminalOutput = true;
    writeContextCache(agentKeys, cachedBody, Date.now());
    writeContextCache(colorKeys, `COLORED ${CONTEXT_HEADER_TIME_PLACEHOLDER}`, Date.now());
    const result = await runHook();
    expect(workerCalls).toEqual([]);
    expect(result.systemMessage).toStartWith('COLORED ');
    expect(result.systemMessage).toContain('View Observations Live @');
    expect(result.systemMessage).not.toContain(PLACEHOLDER_MARKER);
  });

  it('fetches only the colored render when only the model block is cached', async () => {
    showTerminalOutput = true;
    writeContextCache(agentKeys, cachedBody, Date.now());
    const result = await runHook();
    expect(workerCalls).toEqual(['/api/context/inject?projects=cache-hook-parent%2Ccache-hook-repo&platformSource=claude&colors=true']);
    expect(result.systemMessage).toStartWith('LIVE COLORED');
  });
});

// ---------------------------------------------------------------------------
// End to end in a child process (own data dir and database, real renderer):
// live route == cached body + fill, byte for byte; hook from cache, no fetch.
// ---------------------------------------------------------------------------

const childScript = `
  const FIXED_NOW = 1_790_000_000_000;
  Date.now = () => FIXED_NOW;
  const { SessionStore } = await import('./src/services/sqlite/SessionStore.ts');
  const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
  const { SearchRoutes } = await import('./src/services/worker/http/routes/SearchRoutes.ts');
  const { ContextCacheService } = await import('./src/services/worker/ContextCacheService.ts');
  const { projectReadKeys } = await import('./src/services/sqlite/project-read-keys.ts');
  const { getProjectContext } = await import('./src/utils/project-name.ts');
  const cache = await import('./src/shared/context-cache.ts');
  ModeManager.getInstance().loadMode('code');

  const cwd = process.env.HOOK_CWD;
  const projects = getProjectContext(cwd).allProjects;
  const primary = projects[projects.length - 1];
  const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
  const sessionDbId = store.createSDKSession('content-e2e', primary, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-e2e');
  store.storeObservations('memory-e2e', primary, [{
    type: 'discovery', title: 'FIRST_OBSERVATION', subtitle: 'sub', facts: ['fact'], narrative: 'narrative',
    concepts: ['how-it-works'], files_read: [], files_modified: [],
  }], null, 1, 0, FIXED_NOW - 3_600_000);
  store.appendWorkStateEntry({ project: primary, listName: 'release', fields: { status: 'active' }, createdAtEpoch: FIXED_NOW - 2 * 3_600_000 });

  let routes;
  const service = new ContextCacheService({
    debounceMs: 30,
    renderVariant: (keys) => routes.renderContextVariant(keys),
    expandProjectReadKeys: (p) => projectReadKeys(store.db, p),
  });
  routes = new SearchRoutes({ getSessionStore: () => store }, service);
  service.start();
  let handler;
  routes.setupRoutes({ get: (path, h) => { if (path === '/api/context/inject') handler = h; }, post: () => {}, delete: () => {}, use: () => {} });

  async function live(query) {
    return await new Promise((resolve) => {
      const res = { setHeader: () => {}, send: (body) => resolve(body), status: () => res, json: (b) => resolve(JSON.stringify(b)), headersSent: false };
      handler({ query, get: () => undefined, body: undefined }, res);
    });
  }
  const projectsParam = projects.join(',');
  const liveAgent = await live({ projects: projectsParam, platformSource: 'claude' });
  const liveColors = await live({ projects: projectsParam, platformSource: 'claude', colors: 'true' });
  const agentFile = cache.readContextCache(cache.contextCacheKeys(projects, 'claude', false), FIXED_NOW);
  const colorFile = cache.readContextCache(cache.contextCacheKeys(projects, 'claude', true), FIXED_NOW);

  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('no worker in this test'); };
  const { contextHandler } = await import('./src/cli/handlers/context.ts');
  const hook = await contextHandler.execute({ sessionId: 'e2e', cwd, platform: 'claude-code' });

  // A write re-renders the block within the debounce.
  store.storeObservations('memory-e2e', primary, [{
    type: 'discovery', title: 'SECOND_OBSERVATION', subtitle: 'sub', facts: [], narrative: 'n',
    concepts: ['how-it-works'], files_read: [], files_modified: [],
  }], null, 2, 0, FIXED_NOW - 60_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await service.flushPendingRenders();
  const agentAfterWrite = cache.readContextCache(cache.contextCacheKeys(projects, 'claude', false), FIXED_NOW);
  service.stop();
  store.close();

  console.log(JSON.stringify({
    liveAgent, liveColors,
    agentBody: agentFile?.body ?? null, agentRenderedAt: agentFile?.renderedAtEpochMs ?? null,
    colorBody: colorFile?.body ?? null,
    filledAgent: agentFile ? cache.fillContextPlaceholders(agentFile.body, FIXED_NOW, agentFile.placeholderNonce) : null,
    filledColors: colorFile ? cache.fillContextPlaceholders(colorFile.body, FIXED_NOW, colorFile.placeholderNonce) : null,
    hookContext: hook.hookSpecificOutput?.additionalContext ?? null,
    hookSystemMessage: hook.systemMessage ?? null,
    fetchCalls,
    agentAfterWrite: agentAfterWrite ? cache.fillContextPlaceholders(agentAfterWrite.body, FIXED_NOW, agentAfterWrite.placeholderNonce) : null,
  }));
  process.exit(0);
`;

describe('precomputed context end to end', () => {
  it('serves exactly what the live route sends, and keeps it fresh', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-context-cache-e2e-'));
    const hookCwd = mkdtempSync(join(tmpdir(), 'cmem-cache-e2e-project-'));
    try {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
        CLAUDE_MEM_WORKER_PORT: '1',
        CLAUDE_MEM_PROVIDER: 'codex',
        CLAUDE_MEM_CHROMA_ENABLED: 'false',
      }));
      const child = Bun.spawn(['bun', '-e', childScript], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, HOOK_CWD: hookCwd, DO_NOT_TRACK: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await child.exited;
      const line = stdout.trim().split('\n').pop() ?? '';
      if (!line.startsWith('{')) throw new Error(`child failed:\n${stdout}\n${stderr}`);
      const result = JSON.parse(line);

      // The live answer contains real content, and no placeholder ever leaves the worker.
      expect(result.liveAgent).toContain('FIRST_OBSERVATION');
      expect(result.liveAgent).toContain('updated about 2 hours ago');
      for (const text of [result.liveAgent, result.liveColors, result.hookContext, result.hookSystemMessage]) {
        expect(text).not.toContain(PLACEHOLDER_MARKER);
      }
      // The cached bodies carry placeholders where (and only where) time is formatted.
      // (The child has its own placeholder nonce, so match the shape.)
      expect(result.agentBody).toMatch(/⟦CMEM_NOW_HEADER:[0-9a-f]{12}⟧/);
      expect(result.agentBody).toMatch(/⟦CMEM_AGO:[0-9a-f]{12}:\d{13}⟧/);
      expect(result.colorBody).toMatch(/⟦CMEM_NOW_HEADER:[0-9a-f]{12}⟧/);
      expect(result.agentRenderedAt).toBe(1_790_000_000_000);

      // Byte-identical: cached body + fill == live render, agent and colors variants.
      expect(result.filledAgent).toBe(result.liveAgent);
      expect(result.filledColors).toBe(result.liveColors);

      // The hook answered from the cache without any request to the worker.
      expect(result.fetchCalls).toBe(0);
      expect(result.hookContext).toBe(result.liveAgent.trim());
      expect(result.hookSystemMessage).toStartWith(result.liveColors.trim());

      // A store write re-rendered the cached block.
      expect(result.agentAfterWrite).toContain('SECOND_OBSERVATION');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(hookCwd, { recursive: true, force: true });
    }
  }, 60_000);
});
