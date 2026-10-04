import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
const actualFind = { ...(await import('../../../src/shared/find-claude-executable.js')) };
const actualRegistry = { ...(await import('../../../src/supervisor/process-registry.js')) };
const actualEnv = { ...(await import('../../../src/shared/EnvManager.js')) };
const cli = fileURLToPath(new URL('./claude-served-model-cli.cjs', import.meta.url));
mock.module('../../../src/shared/find-claude-executable.js', () => ({ ...actualFind, findClaudeExecutable: () => cli }));
mock.module('../../../src/supervisor/process-registry.js', () => ({ ...actualRegistry,
  createSdkSpawnFactory: (...args: Parameters<typeof actualRegistry.createSdkSpawnFactory>) => {
    const spawn = actualRegistry.createSdkSpawnFactory(...args);
    return (options: Parameters<typeof spawn>[0]) => spawn({ ...options, command: process.execPath, args: [cli, ...options.args] });
  },
}));
mock.module('../../../src/shared/EnvManager.js', () => ({ ...actualEnv,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH!, ANTHROPIC_API_KEY: 'owned-fixture-key' }),
  getAuthMethodDescription: () => 'owned-fixture-api-key',
}));
const { ClaudeProvider } = await import('../../../src/services/worker/ClaudeProvider.js');
const { SessionStore } = await import('../../../src/services/sqlite/SessionStore.js');
const { SessionManager } = await import('../../../src/services/worker/SessionManager.js');
const { SettingsDefaultsManager } = await import('../../../src/shared/SettingsDefaultsManager.js');
const { ModeManager } = await import('../../../src/services/domain/ModeManager.js');
const kind = process.argv[2] ?? 'observation';
const requestedModel = kind === 'control' ? 'claude-haiku-4-5-20251001' : 'haiku';
const cleanup: Array<() => void | Promise<unknown>> = [];
try {
  const settings = SettingsDefaultsManager.loadFromFile;
  cleanup.push(() => { SettingsDefaultsManager.loadFromFile = settings; });
  SettingsDefaultsManager.loadFromFile = () => ({ ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_MODEL: kind === 'override' ? 'claude-haiku-4-5-20251001' : requestedModel, CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false' });
  const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
  const priorMode = mode.activeMode, priorId = mode.activeModeId;
  cleanup.push(() => { mode.activeMode = priorMode; mode.activeModeId = priorId; });
  mode.loadMode('code');
  const store = new SessionStore(':memory:');
  cleanup.push(() => store.close());
  const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
    getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
  const manager = new SessionManager(db);
  const sid = store.createSDKSession('owned-claude-content', 'owned-project', 'Read file');
  const session = manager.initializeSession(sid, 'Read file', 1);
  if (kind === 'override') session.modelOverride = 'haiku';
  cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
  if (kind === 'summary') manager.queueSummarize(sid, 'Read owned file');
  else manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: 'owned-file.ts' }, tool_response: 'Owned contents', prompt_number: 1 });
  await new ClaudeProvider(db, manager).startSession(session);
  const rows = store.db.query(kind === 'summary'
    ? 'SELECT request AS title FROM session_summaries'
    : 'SELECT title, generated_by_model FROM observations').all();
  console.log(JSON.stringify({ kind, requestedModel, rows }));
  assert.equal(manager.getTotalQueueDepth(), 0);
  assert.equal(session.lastModelId, requestedModel);
  assert.deepEqual(rows, [{ title: 'Owned SDK model attribution',
    ...(kind === 'summary' ? {} : { generated_by_model: 'claude-haiku-4-5-20251001' }) }]);
} finally {
  for (const release of cleanup.reverse()) await release();
}
