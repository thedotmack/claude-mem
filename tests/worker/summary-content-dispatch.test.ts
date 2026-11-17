import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../src/services/worker/agents/types.js';

describe('summary content through the live provider loop', () => {
  it('spends once on a rejected summary, handles fresh work, and has no old work after a generator restart', async () => {
    const cleanup: Array<() => void> = [];
    try {
      const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_GEMINI_API_KEY: 'owned-fixture-key',
        CLAUDE_MEM_GEMINI_API_KEYS: '',
        CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false',
        CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
        CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
        CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
        CLAUDE_MEM_NOTION_ENABLED: 'false',
        CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: 'false',
        CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
      }));
      cleanup.push(() => settings.mockRestore());
      const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
      const previousMode = mode.activeMode, previousId = mode.activeModeId;
      cleanup.push(() => { mode.activeMode = previousMode; mode.activeModeId = previousId; });
      mode.loadMode('code');
      const store = new SessionStore(':memory:');
      cleanup.push(() => store.close());
      const db = {
        getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
        getChromaSync: () => null, getCloudSync: () => null,
      } as unknown as DatabaseManager;
      const manager = new SessionManager(db);
      const sid = store.createSDKSession('dispatch-summary', 'test-project', 'Fix login');
      const session = manager.initializeSession(sid, 'Fix login', 1);
      session.currentProvider = 'gemini';
      cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
      const rows = () => store.db.query('SELECT prompt_number, completed FROM session_summaries ORDER BY id').all();
      const requests: Array<{ attempt: string | null; prompt: string }> = [];
      const responses = [
        '<summary><request>Title without progress</request></summary>',
        '<summary><completed>Fresh work</completed></summary>',
        '<summary><completed>Work after restart</completed></summary>',
      ];
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
        const body = await req.json() as { contents: Array<{ parts: Array<{ text: string }> }> };
        requests.push({
          attempt: req.headers.get('x-client-request-id'),
          prompt: body.contents.at(-1)!.parts.map(part => part.text).join(''),
        });
        // Unexpected extra calls are recorded and cannot loop indefinitely.
        if (requests.length > responses.length) session.abortController.abort();
        return Response.json({ candidates: [{ content: { parts: [{ text: responses[requests.length - 1] ?? '<skip_summary />' }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
      } });
      cleanup.push(() => server.stop(true));
      const realFetch = globalThis.fetch;
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_input, init) => realFetch(`http://127.0.0.1:${server.port}/generate`, init));
      cleanup.push(() => fetchSpy.mockRestore());
      const outcomes: Array<{ stored: boolean | undefined; rowCount: number; spent: number | undefined }> = [];
      const worker: WorkerRef = { broadcastProcessingStatus() {
        if (manager.getTotalQueueDepth() !== 0) return;
        outcomes.push({ stored: session.lastSummaryStored, rowCount: rows().length, spent: session.paidSendBudget?.spentPaidSends });
        if (outcomes.length === 1) {
          // Fresh capture arrives only after the first answer has settled.
          manager.queueSummarize(sid, 'Finished fresh work', 2);
        } else session.abortController.abort();
      } };
      manager.queueSummarize(sid, 'First response has no progress', 1);
      const provider = new GeminiProvider(db, manager);
      await provider.startSession(session, worker);
      expect(requests).toHaveLength(2);
      expect(requests.map(request => request.prompt)).toEqual([
        expect.stringContaining('First response has no progress'),
        expect.stringContaining('Finished fresh work'),
      ]);
      expect(requests.every(request => request.attempt)).toBe(true);
      expect(new Set(requests.map(request => request.attempt)).size).toBe(2);
      expect(outcomes[0]).toEqual({ stored: false, rowCount: 0, spent: 1 });
      expect(outcomes[1].spent).toBe(1);
      expect(rows()).toEqual([{ prompt_number: 2, completed: 'Fresh work' }]);
      expect(session.lastSummaryStored).toBe(true);
      expect(session.abortReason ?? null).toBeNull();
      expect(session.currentProvider).toBe('gemini');
      expect(session.consecutiveInvalidOutputs).toBe(0);
      expect(manager.getTotalQueueDepth()).toBe(0);

      const now = Date.now();
      const clock = spyOn(Date, 'now').mockReturnValue(now + 3 * 24 * 60 * 60_000);
      cleanup.push(() => clock.mockRestore());
      expect(manager.getResumableSessionIds(true)).toEqual([]);
      expect(requests).toHaveLength(2);
      session.abortController = new AbortController();
      manager.queueSummarize(sid, 'New capture after restart', 3);
      await provider.startSession(session, worker);
      expect(requests).toHaveLength(3);
      expect(requests[2].prompt).toContain('New capture after restart');
      expect(new Set(requests.map(request => request.attempt)).size).toBe(3);
      expect(outcomes[2].spent).toBe(1);
      expect(rows()).toEqual([
        { prompt_number: 2, completed: 'Fresh work' },
        { prompt_number: 3, completed: 'Work after restart' },
      ]);
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      for (const release of cleanup.reverse()) release();
    }
  }, 10_000);
});
