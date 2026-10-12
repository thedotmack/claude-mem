import { describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { extractObservationFileEvidence, processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

describe('captured file paths containing edge whitespace', () => {
  it('keeps distinct read/write file names in the captured input', () => {
    const evidence = extractObservationFileEvidence([
      { type: 'observation', tool_name: 'Read', tool_input: { file_path: ' src/read.ts' } },
      { type: 'observation', tool_name: 'Write', tool_input: JSON.stringify({ file_path: 'src/write.ts ' }) },
      { type: 'observation', tool_name: 'Edit', tool_input: { file_path: 'src/write.ts' } },
      { type: 'observation', tool_name: 'MultiEdit', tool_input: { edits: [{ file_path: '\tsrc/tab.ts\t' }] } },
    ]);
    expect(evidence.files_read).toEqual([' src/read.ts']);
    expect(evidence.files_modified).toEqual(['src/write.ts ', 'src/write.ts', '\tsrc/tab.ts\t']);
  });

  it('stores the queued Write under its exact path for file context lookup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-edge-path-'));
    const filePath = join(directory, 'file.ts ');
    writeFileSync(filePath, 'export const value = 1;');
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath.trim())).toBe(false);
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
    const sid = store.createSDKSession('edge-path-content', 'edge-project', 'Write the file');
    const session = manager.initializeSession(sid, undefined, 1);
    session.memorySessionId = 'edge-path-memory';
    store.ensureMemorySessionIdRegistered(sid, session.memorySessionId);
    session.lastGeneratorSource = 'ingest';
    manager.queueObservation(sid, { tool_name: 'Write', tool_input: { file_path: filePath }, tool_response: 'Written' });
    const messages = manager.getMessageIterator(sid);
    try {
      await messages.next();
      const result = await processAgentResponse(
        '<observation><type>change</type><title>Wrote the file</title></observation>',
        session, dbManager, manager, undefined, 10, null, 'SDK',
      );
      expect(getObservationsByFilePath(store.db, filePath, { projects: ['edge-project'] }).map(row => row.id)).toEqual(result!.observationIds);
      expect(getObservationsByFilePath(store.db, filePath.trim(), { projects: ['edge-project'] })).toEqual([]);
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      session.abortController.abort();
      await messages.return(undefined);
      manager.removeSessionImmediate(sid);
      store.close();
      mode.activeMode = priorMode;
      mode.activeModeId = priorModeId;
      settings.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
