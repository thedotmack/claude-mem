import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { ingestSummarize } from '../../src/services/worker/http/shared.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

describe('queued summary origin', () => {
  for (const kind of ['next-prompt', 'older-observation', 'spooled-stop', 'legacy-queue', 'control']) {
    it(`stores the prompt that produced the Stop: ${kind}`, async () => {
      const cleanup: Array<() => void> = [];
      try {
        const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
          ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'owned-fixture-key',
          CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
          CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
        }));
        cleanup.push(() => settings.mockRestore());
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
        expect(outcome.status).toBe('accepted');
        if (kind === 'next-prompt') advance();
        const expected = kind === 'older-observation' ? 2 : 1;
        const realFetch = globalThis.fetch;
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
          const body = await req.json() as { contents: Array<{ parts: Array<{ text: string }> }> };
          const text = body.contents.at(-1)!.parts.map(p => p.text).join('');
          const summary = text.includes('MODE SWITCH: PROGRESS SUMMARY');
          return Response.json({ candidates: [{ content: { parts: [{ text: summary
            ? '<summary><request>Owned summary</request><completed>Completed the owned task</completed></summary>'
            : '<observation><type>discovery</type><title>Owned file</title></observation>' }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
        } });
        cleanup.push(() => server.stop(true));
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_input, init) => realFetch(`http://127.0.0.1:${server.port}/generate`, init));
        cleanup.push(() => fetchSpy.mockRestore());
        await new GeminiProvider(db, manager).startSession(session, { broadcastProcessingStatus() {
          if (manager.getTotalQueueDepth() === 0) session.abortController.abort();
        } });
        const rows = store.db.query('SELECT request, prompt_number FROM session_summaries').all();
        console.log(JSON.stringify({ kind, expected, rows }));
        expect(rows).toEqual([{ request: 'Owned summary', prompt_number: expected }]);
        expect(manager.getTotalQueueDepth()).toBe(0);
      } finally {
        for (const release of cleanup.reverse()) release();
      }
    }, 10000);
  }
});
