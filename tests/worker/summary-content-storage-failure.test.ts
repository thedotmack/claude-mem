import { describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { startGeneratorWithProvider, type GeneratorRunnerDependencies } from '../../src/services/worker/session/GeneratorRunner.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

describe('answered summaries do not buy inference to repair storage', () => {
  for (const failure of ['media', 'receipt'] as const) {
    it(`continues fresh work through the real runner after a ${failure} write fails`, async () => {
      const cleanup: Array<() => void> = [];
      try {
        const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
          ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'fixture-key',
          CLAUDE_MEM_GEMINI_API_KEYS: '', CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
          CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
          CLAUDE_MEM_TELEGRAM_ENABLED: 'false', CLAUDE_MEM_NOTION_ENABLED: 'false',
          CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: 'false', CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
        }));
        cleanup.push(() => settings.mockRestore());
        const errors = spyOn(logger, 'error').mockImplementation(() => {});
        cleanup.push(() => errors.mockRestore());
        const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
        const prior = [mode.activeMode, mode.activeModeId];
        cleanup.push(() => { [mode.activeMode, mode.activeModeId] = prior; });
        mode.loadMode('code');
        const store = new SessionStore(':memory:');
        cleanup.push(() => store.close());
        const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
          getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
        const manager = new SessionManager(db);
        const sid = store.createSDKSession('storage-failure', 'fixture-project', 'Inspect source');
        const session = manager.initializeSession(sid, 'Inspect source', 1);
        cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
        store.db.run(`INSERT INTO media_events (event_key,session_db_id,platform,event_identity,created_at) VALUES ('event',?,'claude','tool',?)`, [sid, Date.now()]);
        const rawId = store.upsertToolUse({ toolUseId: 'tool', contentSessionId: session.contentSessionId,
          project: session.project, sessionDbId: sid, platformSource: session.platformSource,
          toolName: 'Read', toolInput: '{}', toolResponse: 'original source' })!;
        store.db.exec(failure === 'media'
          ? "CREATE TRIGGER fail_media BEFORE UPDATE OF result_state ON media_events BEGIN SELECT RAISE(ABORT, 'private fixture error'); END"
          : "CREATE TRIGGER fail_receipt BEFORE INSERT ON committed_observation_tool_uses BEGIN SELECT RAISE(ABORT, 'private fixture error'); END");
        manager.queueObservation(sid, { tool_name: 'Read', tool_input: {}, tool_response: 'original source',
          prompt_number: 1, toolUseId: 'tool', mediaRefs: [], mediaEventKey: 'event' });
        manager.queueSummarize(sid, 'Fresh summary', 2);
        const requests: string[] = [];
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push(body.contents.at(-1).parts.map((part: { text: string }) => part.text).join(''));
          if (requests.length > 2) session.abortController.abort();
          return Response.json({ candidates: [{ content: { parts: [{ text: requests.length === 1
            ? '<summary><request>Only a title</request></summary>'
            : '<summary><completed>Fresh work</completed></summary>' }] } }] });
        });
        cleanup.push(() => fetchSpy.mockRestore());
        const finalizeSession = mock(async () => {});
        const ensureGeneratorRunning = mock(async () => {});
        const spent: number[] = [];
        const provider = new GeminiProvider(db, manager);
        const deps = { sessionManager: manager, geminiAgent: provider,
          sdkAgent: { startSession: mock(async () => { throw new Error('unexpected fallback'); }) },
          openRouterAgent: {}, completionHandler: { finalizeSession }, ensureGeneratorRunning,
          maybeSelfHealStaleClaudeSpawn: () => false,
          workerService: { broadcastProcessingStatus() {
            spent.push(session.paidSendBudget?.spentPaidSends ?? 0);
            if (manager.getTotalQueueDepth() === 0) session.abortController.abort();
          } },
        } as unknown as GeneratorRunnerDependencies;
        await startGeneratorWithProvider(session, 'gemini', 'observation', null, null, deps);
        await session.generatorPromise;
        expect(requests).toHaveLength(2);
        expect(requests[1]).toContain('Fresh summary');
        expect(spent).toEqual([1, 1]);
        expect(ensureGeneratorRunning).not.toHaveBeenCalled();
        expect(session.scheduledResumeTimer).toBeUndefined();
        expect(finalizeSession).toHaveBeenCalledTimes(1);
        expect(session.abortReason ?? null).toBeNull();
        expect(manager.getTotalQueueDepth()).toBe(0);
        expect(store.db.query('SELECT completed FROM session_summaries').all()).toEqual([{ completed: 'Fresh work' }]);
        expect(store.getToolUsesByIds([rawId])[0].tool_response).toBe('original source');
        expect(store.hasCommittedToolUse(session.platformSource, session.contentSessionId, 'tool')).toBe(failure !== 'receipt');
        expect(store.db.query('SELECT result_state FROM media_events').get()).toEqual({ result_state: failure === 'media' ? 'unprocessed' : 'skipped' });
        expect(JSON.stringify(errors.mock.calls)).toContain('no inference replay');
        expect(JSON.stringify(errors.mock.calls)).not.toContain('private fixture error');
      } finally { for (const release of cleanup.reverse()) release(); }
    });
  }
});
