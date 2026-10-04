import { strict as assert } from 'node:assert';
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
const actualFind = { ...(await import('../../../src/shared/find-claude-executable.js')) };
const actualRegistry = { ...(await import('../../../src/supervisor/process-registry.js')) };
const actualEnv = { ...(await import('../../../src/shared/EnvManager.js')) };
const cli = fileURLToPath(new URL('./queued-summary-origin-cli.cjs', import.meta.url));
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
const { ingestSummarize } = await import('../../../src/services/worker/http/shared.js');
const kind = process.argv[2];
const cleanup: Array<() => void | Promise<unknown>> = [];
try {
        const savedSettings = SettingsDefaultsManager.loadFromFile;
        cleanup.push(() => { SettingsDefaultsManager.loadFromFile = savedSettings; });
        SettingsDefaultsManager.loadFromFile = () => ({
          ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MODEL: 'haiku',
          CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
          CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
        });
        const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
        const priorMode = mode.activeMode, priorId = mode.activeModeId;
        cleanup.push(() => { mode.activeMode = priorMode; mode.activeModeId = priorId; });
        mode.loadMode('code');
        const store = new SessionStore(':memory:');
        cleanup.push(() => store.close());
        const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
          getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
        const manager = new SessionManager(db);
        const contentId = `owned-summary-${kind}`;
        const sid = store.createSDKSession(contentId, 'owned-project', 'First request');
        store.saveUserPrompt(contentId, 1, 'First request', sid);
        const firstAt = (store.db.query('SELECT created_at_epoch FROM user_prompts WHERE session_db_id = ?').get(sid) as { created_at_epoch: number }).created_at_epoch;
        const session = manager.initializeSession(sid, 'First request', 1);
        cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
        const advance = () => {
          store.saveUserPrompt(contentId, 2, 'Second request', sid);
          store.db.query('UPDATE user_prompts SET created_at_epoch = ? WHERE session_db_id = ? AND prompt_number = 2').run(firstAt + 100, sid);
          manager.initializeSession(sid, 'Second request', 2);
        };
        if (kind === 'older-observation') {
          manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: 'owned.ts' }, tool_response: 'contents', prompt_number: 1 });
          advance();
        }
        if (kind === 'spooled-stop') advance();
        const outcome = kind === 'legacy-queue'
          ? (manager.queueSummarize(sid, 'Completed the owned task'), { status: 'accepted' })
          : await ingestSummarize({ contentSessionId: contentId, platformSource: 'claude',
          lastAssistantMessage: 'Completed the owned task',
          ...(kind === 'spooled-stop' ? { enqueuedAtEpochMs: firstAt + 50 } : {}),
        }, { sessionManager: manager, dbManager: db,
          eventBroadcaster: { broadcastSummarizeQueued() {} } as any,
          ensureGeneratorRunning: async () => {},
        });
        assert.equal(outcome.status, 'accepted');
        if (kind === 'next-prompt') advance();
        const expected = kind === 'older-observation' ? 2 : 1;
await new ClaudeProvider(db, manager).startSession(session);
const rows = store.db.query('SELECT request, prompt_number FROM session_summaries').all();
console.log(JSON.stringify({kind, expected, rows}));
assert.deepEqual(rows, [{request: 'Owned summary', prompt_number: expected}]);
assert.equal(manager.getTotalQueueDepth(), 0);
} finally { for (const release of cleanup.reverse()) await release(); }
