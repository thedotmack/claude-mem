import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SSEEventPayload } from '../../../src/services/worker/agents/types.js';

describe('response metadata uses the registered memory identity', () => {
  for (const kind of ['observation', 'summary'] as const) {
    it(`uses the stored identity for ${kind} metadata`, async () => {
      const cleanup: Array<() => void | Promise<unknown>> = [];
      try {
        const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
          ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
        }));
        cleanup.push(() => settings.mockRestore());
        const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
        const priorMode = mode.activeMode;
        const priorModeId = mode.activeModeId;
        cleanup.push(() => { mode.activeMode = priorMode; mode.activeModeId = priorModeId; });
        mode.loadMode('code');
        const store = new SessionStore(':memory:');
        cleanup.push(() => store.close());
        const synced: Array<{ id: number; memorySessionId: string }> = [];
        const chroma = {
          async syncObservation(id: number, memorySessionId: string) { synced.push({ id, memorySessionId }); },
          async syncSummary(id: number, memorySessionId: string) { synced.push({ id, memorySessionId }); },
        };
        const dbManager = {
          getSessionById: (id: number) => store.getSessionById(id),
          getSessionStore: () => store, getChromaSync: () => chroma, getCloudSync: () => null,
        } as unknown as DatabaseManager;
        const manager = new SessionManager(dbManager);
        const sid = store.createSDKSession('registered-content', 'registered-project', 'Capture a second turn');
        store.ensureMemorySessionIdRegistered(sid, 'first-memory');
        const session = manager.initializeSession(sid, undefined, 2);
        cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
        // Claude starts a fresh SDK process per turn; the database retains the first identity.
        session.memorySessionId = 'second-sdk-memory';
        expect(store.ensureMemorySessionIdRegistered(sid, session.memorySessionId)).toBe('first-memory');
        const receiptId = store.upsertToolUse({ toolUseId: 'second-tool', contentSessionId: session.contentSessionId,
          sessionDbId: sid, project: session.project, toolName: 'Read', toolInput: '{}', toolResponse: 'Read file' });
        if (kind === 'summary') manager.queueSummarize(sid, 'Read example');
        else manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: 'src/example.ts' }, tool_response: 'Read file', toolUseId: 'second-tool' });
        const messages = manager.getMessageIterator(sid);
        cleanup.push(() => messages.return(undefined));
        const events: SSEEventPayload[] = [];
        await messages.next();
        const xml = kind === 'summary' ? '<summary><request>Read example</request></summary>'
          : '<observation><type>discovery</type><title>Read example</title></observation>';
        const result = await processAgentResponse(xml,
          session, dbManager, manager, { sseBroadcaster: { broadcast: event => events.push(event) } }, 10, null, 'SDK');
        const stored = kind === 'observation' ? store.getObservationById(result!.observationIds[0])!
          : store.db.query('SELECT id, memory_session_id FROM session_summaries WHERE id = ?').get(result!.summaryId!) as { id: number; memory_session_id: string };
        expect(synced).toEqual([{ id: stored.id, memorySessionId: stored.memory_session_id }]);
        if (kind === 'observation') {
          const receipt = store.getToolUsesByIds([receiptId!])[0];
          expect(receipt.observation_id).toBe(stored.id);
          expect(receipt.memory_session_id).toBe(stored.memory_session_id);
          const event = events.find(event => event.type === 'new_observation');
          expect(event?.type === 'new_observation' ? event.observation.memory_session_id : null).toBe(stored.memory_session_id);
        } else {
          const event = events.find(event => event.type === 'new_summary');
          expect(event?.type === 'new_summary' ? event.summary.id : null).toBe(stored.id);
          expect(event?.type === 'new_summary' ? event.summary.session_id : null).toBe(session.contentSessionId);
        }
        expect(stored.memory_session_id).toBe('first-memory');
        expect(session.memorySessionId).toBe('second-sdk-memory');
        expect(manager.getTotalQueueDepth()).toBe(0);
      } finally {
        for (const release of cleanup.reverse()) await release();
      }
    });
  }
});
