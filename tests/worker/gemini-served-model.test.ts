import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

describe('Gemini served-model attribution', () => {
  for (const modelVersion of ['gemini-3.5-flash-001', undefined]) {
    it(`stores ${modelVersion ?? 'the requested model when no version is reported'}`, async () => {
      const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_GEMINI_API_KEY: 'fixture-key',
        CLAUDE_MEM_GEMINI_MODEL: 'gemini-flash-latest',
        CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
        CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
        CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
      }));
      const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
      const priorMode = mode.activeMode;
      const priorModeId = mode.activeModeId;
      mode.loadMode('code');
      const store = new SessionStore(':memory:');
      const dbManager = {
        getSessionById: (id: number) => store.getSessionById(id),
        getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
      } as unknown as DatabaseManager;
      const manager = new SessionManager(dbManager);
      const sid = store.createSDKSession(`gemini-version-${modelVersion}`, 'version-project', 'Record the edit');
      const session = manager.initializeSession(sid, undefined, 1);
      session.memorySessionId = `memory-${sid}`;
      store.ensureMemorySessionIdRegistered(sid, session.memorySessionId);
      manager.queueObservation(sid, { tool_name: 'Write', tool_input: { file_path: 'src/file.ts' }, tool_response: 'Written' });
      const realFetch = globalThis.fetch;
      let requestUrl = '';
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
        return Response.json({ modelVersion, candidates: [{ content: { parts: [{
          text: '<observation><type>change</type><title>Updated the file</title></observation>',
        }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 } });
      } });
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        requestUrl = String(input);
        return realFetch(`http://127.0.0.1:${server.port}/v1`, init);
      });
      try {
        await new GeminiProvider(dbManager, manager).startSession(session, {
          broadcastProcessingStatus() {
            if (manager.getTotalQueueDepth() === 0) session.abortController.abort();
          },
        });
        expect(requestUrl).toContain('/models/gemini-flash-latest:generateContent');
        const rows = store.db.query('SELECT generated_by_model FROM observations').all() as Array<{ generated_by_model: string }>;
        expect(rows).toEqual([{ generated_by_model: modelVersion ?? 'gemini-flash-latest' }]);
        expect(manager.getTotalQueueDepth()).toBe(0);
      } finally {
        session.abortController.abort();
        manager.removeSessionImmediate(sid);
        fetchSpy.mockRestore();
        server.stop(true);
        store.close();
        mode.activeMode = priorMode;
        mode.activeModeId = priorModeId;
        settings.mockRestore();
      }
    });
  }
});
