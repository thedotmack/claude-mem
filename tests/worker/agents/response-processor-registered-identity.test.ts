import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.js';
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SSEEventPayload } from '../../../src/services/worker/agents/types.js';

describe('response metadata uses the registered memory identity', () => {
  for (const kind of ['observation', 'summary'] as const) for (const rekey of [false, true]) {
    it(`uses the stored identity for ${kind} metadata${rekey ? " after an explicit rekey" : ""}`, async () => {
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
        const durableId = rekey ? 'deliberately-rekeyed-memory' : 'first-memory';
        if (rekey) store.updateMemorySessionId(sid, durableId);
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
        expect(stored.memory_session_id).toBe(durableId);
        expect(session.memorySessionId).toBe('second-sdk-memory');
        expect(manager.getTotalQueueDepth()).toBe(0);
      } finally {
        for (const release of cleanup.reverse()) await release();
      }
    });
  }

  it('keeps prior receipts discoverable when a fresh provider registers its session identity', async () => {
    const cleanup: Array<() => void | Promise<unknown>> = [];
    try {
      const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
        CLAUDE_MEM_GEMINI_API_KEY: 'owned-fixture-key', CLAUDE_MEM_GEMINI_MODEL: 'gemini-flash-latest',
        CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
      }));
      cleanup.push(() => settings.mockRestore());
      const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
      const oldMode = mode.activeMode, oldModeId = mode.activeModeId;
      cleanup.push(() => { mode.activeMode = oldMode; mode.activeModeId = oldModeId; });
      mode.loadMode('code');
      const store = new SessionStore(':memory:');
      cleanup.push(() => store.close());
      const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
        getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
      const manager = new SessionManager(db);
      const sid = store.createSDKSession('provider-change-content', 'owned-project', 'Read file');
      store.ensureMemorySessionIdRegistered(sid, 'old-sdk-memory');
      const oldSession = manager.initializeSession(sid, undefined, 1);
      cleanup.push(() => { oldSession.abortController.abort(); manager.removeSessionImmediate(sid); });
      oldSession.memorySessionId = 'old-sdk-memory';
      const receiptId = store.upsertToolUse({ toolUseId: 'pending-tool', contentSessionId: oldSession.contentSessionId,
        sessionDbId: sid, memorySessionId: 'old-sdk-memory', project: oldSession.project, toolName: 'Read' });
      const observation = store.storeObservation('old-sdk-memory', oldSession.project, {
        type: 'discovery', title: 'Prior provider file', subtitle: null, narrative: null,
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, 1);
      store.linkToolUsesToObservation({ contentSessionId: oldSession.contentSessionId,
        toolUseIds: ['pending-tool'], observationId: observation.id, memorySessionId: 'old-sdk-memory' });
      // A fresh provider generation starts without the prior SDK's lifecycle id.
      // Abort its loop before starting: only its actual registration path runs.
      oldSession.abortController.abort();
      const newSession = { ...oldSession, memorySessionId: null };
      const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('No provider HTTP request is expected in this registration fixture');
      });
      cleanup.push(() => fetch.mockRestore());
      await new GeminiProvider(db, manager).startSession(newSession);
      const registeredId = store.getSessionById(sid).memory_session_id!;
      expect(registeredId).toStartWith('gemini-provider-change-content-');
      expect(store.queryToolUses({ memorySessionId: registeredId }).map(row => row.id)).toEqual([receiptId!]);
      expect(store.getObservationById(observation.id)?.memory_session_id).toBe(registeredId);
      const receipt = store.getToolUsesByIds([receiptId!])[0];
      expect(receipt.memory_session_id).toBe(registeredId);
      expect(receipt.observation_id).toBe(observation.id);
      expect(fetch).not.toHaveBeenCalled();
      expect(oldSession.memorySessionId).toBe('old-sdk-memory');
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      for (const release of cleanup.reverse()) await release();
    }
  });
});
