import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

// A batch the observer turns into several observations links each of its tool
// uses to all of them (tool_use_batch_observations), so Endless Mode's
// timeline gets a row per observation; tool_uses.observation_id still names
// the batch's first.
describe('a batch with several observations', () => {
  it('links its tool uses to every observation it stored', async () => {
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
      const dbManager = {
        getSessionById: (id: number) => store.getSessionById(id),
        getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
      } as unknown as DatabaseManager;
      const manager = new SessionManager(dbManager);
      const sid = store.createSDKSession('batch-content', 'batch-project', 'Fix the parser');
      store.ensureMemorySessionIdRegistered(sid, 'batch-memory');
      const session = manager.initializeSession(sid, undefined, 1);
      cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
      session.memorySessionId = 'batch-memory';
      for (const toolUseId of ['read-tool', 'edit-tool']) {
        store.upsertToolUse({ toolUseId, contentSessionId: session.contentSessionId, sessionDbId: sid, project: session.project, toolName: 'Read', toolInput: '{}', toolResponse: 'ok' });
        manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: `src/${toolUseId}.ts` }, tool_response: 'ok', toolUseId });
      }
      const messages = manager.getMessageIterator(sid);
      cleanup.push(() => messages.return(undefined));
      await messages.next();
      await messages.next();
      const result = await processAgentResponse(
        '<observation><type>discovery</type><title>Parser read</title></observation><observation><type>bugfix</type><title>Parser fixed</title></observation>',
        session, dbManager, manager, { sseBroadcaster: { broadcast: () => undefined } }, 10, null, 'SDK');
      const [first, second] = result!.observationIds;
      expect(second).toBeGreaterThan(first);
      const linked = store.getToolUseObservations({ contentSessionId: session.contentSessionId, toolUseIds: ['read-tool', 'edit-tool'] });
      const claimed = linked.map(row => row.tool_use_id);
      // Every tool use the batch claimed has both observations; the link column keeps the first.
      for (const toolUseId of new Set(claimed)) {
        expect(linked.filter(row => row.tool_use_id === toolUseId).map(row => [row.observation_id, row.title])).toEqual([[first, 'Parser read'], [second, 'Parser fixed']]);
      }
      expect(claimed.length).toBeGreaterThan(0);
      for (const row of store.queryToolUses({ contentSessionId: session.contentSessionId })) {
        if (claimed.includes(row.tool_use_id)) expect(row.observation_id).toBe(first);
      }
    } finally {
      for (const release of cleanup.reverse()) await release();
    }
  });
});
