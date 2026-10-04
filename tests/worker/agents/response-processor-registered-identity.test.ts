import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { SSEEventPayload } from '../../../src/services/worker/agents/types.js';

describe('response metadata uses the registered memory identity', () => {
  it('links tool receipts and broadcasts the same memory session as the stored row', async () => {
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
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
    const sid = store.createSDKSession('registered-content', 'registered-project', 'Capture a second turn');
    store.ensureMemorySessionIdRegistered(sid, 'first-memory');
    const session = manager.initializeSession(sid, undefined, 2);
    // Claude starts a fresh SDK process per turn; the database retains the first identity.
    session.memorySessionId = 'second-sdk-memory';
    expect(store.ensureMemorySessionIdRegistered(sid, session.memorySessionId)).toBe('first-memory');
    const receiptId = store.upsertToolUse({ toolUseId: 'second-tool', contentSessionId: session.contentSessionId,
      sessionDbId: sid, project: session.project, toolName: 'Read', toolInput: '{}', toolResponse: 'Read file' });
    manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: 'src/example.ts' }, tool_response: 'Read file', toolUseId: 'second-tool' });
    const messages = manager.getMessageIterator(sid);
    const events: SSEEventPayload[] = [];
    try {
      await messages.next();
      const result = await processAgentResponse('<observation><type>discovery</type><title>Read example</title></observation>',
        session, dbManager, manager, { sseBroadcaster: { broadcast: event => events.push(event) } }, 10, null, 'SDK');
      const stored = store.getObservationById(result!.observationIds[0])!;
      const receipt = store.getToolUsesByIds([receiptId!])[0];
      expect(receipt.observation_id).toBe(stored.id);
      expect(receipt.memory_session_id).toBe(stored.memory_session_id);
      const event = events.find(event => event.type === 'new_observation');
      expect(event?.type === 'new_observation' ? event.observation.memory_session_id : null).toBe(stored.memory_session_id);
      expect(stored.memory_session_id).toBe('first-memory');
      expect(session.memorySessionId).toBe('second-sdk-memory');
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      session.abortController.abort();
      await messages.return(undefined);
      manager.removeSessionImmediate(sid);
      store.close();
      mode.activeMode = priorMode;
      mode.activeModeId = priorModeId;
      settings.mockRestore();
    }
  });
});
