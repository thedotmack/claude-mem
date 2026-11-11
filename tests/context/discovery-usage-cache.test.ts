import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Separate process: paths, context generation and cache events all use the
// fixture's owned SQLite file, without process-wide module mocks.
const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { contextCacheKeys, readContextCache } from './src/shared/context-cache.ts';
  import { onContextInvalidation } from './src/shared/context-invalidation.ts';
  import { DB_PATH } from './src/shared/paths.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const scenario = process.env.FIXTURE_SCENARIO;
  const human = scenario === 'human';
  const project = scenario === 'adopted' ? 'legacy-project' : 'usage-project';
  const requested = scenario === 'adopted' ? 'parent-project' : project;
  const store = new SessionStore(DB_PATH, { syncOpsEnabled: false });
  const seed = (key, tokens) => {
    const id = store.createSDKSession('content-' + key, key, 'Owned task', undefined, 'claude');
    store.updateMemorySessionId(id, 'memory-' + key);
    return store.storeObservations('memory-' + key, key, [{
      type: 'discovery', title: 'Owned ' + key, subtitle: null,
      facts: ['The parsed result is stored.'], narrative: 'The parsed result is stored.',
      concepts: ['how-it-works'], files_read: [], files_modified: [],
    }], { request: 'Complete ' + key, investigated: '', learned: '', completed: 'Stored',
      next_steps: '', notes: null }, 1, tokens);
  };
  const row = seed(project, 40);
  const other = seed('unrelated-project', 73);
  if (scenario === 'adopted') store.db.run(
    'UPDATE observations SET merged_into_project = ? WHERE id = ?',
    [requested, row.observationIds[0]]);
  const config = {
    totalObservationCount: 20, fullObservationCount: 20, sessionCount: 0,
    showReadTokens: false, showWorkTokens: true,
    observationTypes: new Set(['discovery']), observationConcepts: new Set(['how-it-works']),
    fullObservationField: 'narrative', showLastSummary: false,
    showLastMessage: false, mainAgentOnly: true,
  };
  const keys = contextCacheKeys([requested], 'claude', human, process.cwd());
  const unrelatedKeys = contextCacheKeys(['unrelated-project'], 'claude', human, process.cwd());
  const renders = [];
  const events = [];
  const render = async key => {
    const result = await generateContextWithStats({
      projects: key.projects, platformSource: 'claude', cwd: process.cwd(),
      includeHealthWarning: false, includePriorMessage: false,
    }, key.colors, { config });
    return { body: result.text, cacheable: true, readKeys: result.readKeys };
  };
  const service = new ContextCacheService({
    debounceMs: 60000, expandProjectReadKeys: projects => store.getProjectReadKeys(projects),
    renderVariant: async key => { renders.push(key.projects.join(',')); return render(key); },
  });
  const unsubscribe = onContextInvalidation(event => {
    events.push({ reason: event.reason, scope: event.scope, kind: event.kind,
      inTransaction: store.db.inTransaction,
      tokens: store.db.query('SELECT discovery_tokens FROM observations WHERE id = ?').get(row.observationIds[0]).discovery_tokens });
  });
  service.start();
  await service.recordLiveRender(keys, await render(keys), Date.now());
  await service.recordLiveRender(unrelatedKeys, await render(unrelatedKeys), Date.now());
  const before = readContextCache(keys, Date.now()).body;
  const otherBefore = readContextCache(unrelatedKeys, Date.now()).body;
  let error = null;
  try {
    if (scenario === 'unchanged') {
      store.updateDiscoveryTokens([...row.observationIds, 999999], row.summaryId, 40);
      store.updateDiscoveryTokens([], row.summaryId, 10);
      store.updateDiscoveryTokens([], row.summaryId, 100);
      store.updateDiscoveryTokens([], null, 4096);
    } else if (scenario === 'rollback') {
      store.db.exec("CREATE TEMP TRIGGER reject_usage BEFORE UPDATE OF discovery_tokens ON session_summaries BEGIN SELECT RAISE(ABORT, 'owned usage rejection'); END");
      try { store.updateDiscoveryTokens(row.observationIds, row.summaryId, 4096); }
      catch (failure) { error = failure.message; }
    } else {
      store.updateDiscoveryTokens([...row.observationIds, ...row.observationIds], null, 4096);
    }
    await service.flushPendingRenders();
    const after = readContextCache(keys, Date.now()).body;
    const direct = (await render(keys)).body;
    const value = store.db.query('SELECT discovery_tokens FROM observations WHERE id = ?').get(row.observationIds[0]).discovery_tokens;
    const result = {
      before, after, direct, value, renders, events, error,
      otherUnchanged: readContextCache(unrelatedKeys, Date.now()).body === otherBefore,
      summaryTokens: store.db.query('SELECT discovery_tokens FROM session_summaries WHERE id = ?').get(row.summaryId).discovery_tokens,
      finalTokenLabel: (4096).toLocaleString(),
    };
    console.log(JSON.stringify(result));
  } finally { unsubscribe(); service.stop(); store.close(); }
`;

function run(scenario: string) {
  const directory = mkdtempSync(join(tmpdir(), 'owned-discovery-cache-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: {
        ...process.env, FIXTURE_SCENARIO: scenario,
        CLAUDE_MEM_DATA_DIR: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'config'),
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
        CLAUDE_MEM_DEDUP_ENABLED: 'false',
        CLAUDE_MEM_MODES_DIR: join(import.meta.dir, '../../plugin/modes'),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const scenario of ['agent', 'human', 'adopted']) {
  it('refreshes completed discovery usage in the ' + scenario + ' context cache', () => {
    const result = run(scenario);
    expect(result.value).toBe(4096);
    expect(result.direct).toContain(result.finalTokenLabel);
    expect(result.before).not.toContain(result.finalTokenLabel);
    expect(result.after).toBe(result.direct);
    expect(result.renders).toEqual([scenario === 'adopted' ? 'parent-project' : 'usage-project']);
    expect(result.otherUnchanged).toBe(true);
    expect(result.events).toEqual([{
      reason: 'updateDiscoveryTokens',
      scope: { projects: [scenario === 'adopted' ? 'legacy-project' : 'usage-project'] },
      kind: 'additive', inTransaction: false, tokens: 4096,
    }]);
  });
}

it('leaves unchanged observations and summary-only corrections out of the render queue', () => {
  const result = run('unchanged');
  expect(result.value).toBe(40);
  expect(result.summaryTokens).toBe(100);
  expect(result.after).toBe(result.before);
  expect(result.renders).toEqual([]);
  expect(result.events).toEqual([]);
  expect(result.otherUnchanged).toBe(true);
});

it('does not announce or render a usage update that its transaction rolled back', () => {
  const result = run('rollback');
  expect(result.error).toContain('owned usage rejection');
  expect(result.value).toBe(40);
  expect(result.summaryTokens).toBe(40);
  expect(result.after).toBe(result.before);
  expect(result.renders).toEqual([]);
  expect(result.events).toEqual([]);
  expect(result.otherUnchanged).toBe(true);
});
