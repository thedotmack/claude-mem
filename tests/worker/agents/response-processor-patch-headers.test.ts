import { describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { extractObservationFileEvidence, processAgentResponse } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

const customUpdate = [
  '*** Begin Patch', '*** Update File: docs/guide.md', '@@',
  ' *** Update File: docs/decoy.md', '-old', '+new', '*** End Patch',
].join('\n');

function modifiedFiles(patch: string): string[] {
  return extractObservationFileEvidence([{
    type: 'observation', tool_name: 'apply_patch', tool_input: { command: patch },
    tool_response: 'Success. Updated the following files.',
  }]).files_modified;
}

describe('patch file headers versus document content', () => {
  it('does not promote custom patch context to a file header', () => {
    expect(modifiedFiles(customUpdate)).toEqual(['docs/guide.md']);
  });

  it('does not promote added custom patch text to a unified file header', () => {
    expect(modifiedFiles([
      '*** Begin Patch', '*** Add File: docs/new.md',
      '+++ b/docs/decoy-added.md', '*** End Patch',
    ].join('\n'))).toEqual(['docs/new.md']);
  });

  it('ignores header-shaped context and changes inside a unified hunk', () => {
    expect(modifiedFiles([
      '--- a/docs/guide.md', '+++ b/docs/guide.md', '@@ -1,4 +1,4 @@',
      ' *** Update File: docs/decoy-custom.md', ' +++ b/docs/decoy-context.md',
      '--- docs/decoy-old.md', '+++ b/docs/decoy-added.md', ' last',
    ].join('\n'))).toEqual(['docs/guide.md']);
  });

  it('keeps later unified files after counted, single-line and empty hunks', () => {
    expect(modifiedFiles([
      '--- a/one.md', '+++ b/one.md', '@@ -1 +1 @@', '-old',
      '\\ No newline at end of file', '+new',
      '\\ No newline at end of file',
      '--- /dev/null', '+++ b/two.md', '@@ -0,0 +1,2 @@', '+first', '+second',
      '--- a/three.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-removed',
      '--- a/four.md', '+++ b/four.md', '@@ -1,0 +1,0 @@',
    ].join('\r\n'))).toEqual(['one.md', 'two.md', 'four.md']);
  });

  it('counts a blank context line whose leading space was stripped', () => {
    expect(modifiedFiles([
      '--- a/one.md', '+++ b/one.md', '@@ -1,3 +1,3 @@', ' first', '', '-old', '+new',
      '--- a/two.md', '+++ b/two.md', '@@ -1 +1 @@', '-before', '+after',
    ].join('\n'))).toEqual(['one.md', 'two.md']);
  });

  it('keeps the next git file when a hunk overstates its line counts', () => {
    expect(modifiedFiles([
      'diff --git a/one.md b/one.md', '--- a/one.md', '+++ b/one.md', '@@ -1,9 +1,9 @@', '-old', '+new',
      'diff --git a/two.md b/two.md', '--- a/two.md', '+++ b/two.md', '@@ -1 +1 @@', '-before', '+after',
    ].join('\n'))).toEqual(['one.md', 'two.md']);
  });

  it('keeps custom update, rename, add and delete headers after their hunks', () => {
    expect(modifiedFiles([
      '*** Begin Patch', '*** Update File: old.md', '*** Move to: moved.md', '@@', '-old', '+new',
      '*** Add File: added.md', '+content', '*** Delete File: deleted.md', '*** End Patch',
    ].join('\n'))).toEqual(['old.md', 'moved.md', 'added.md', 'deleted.md']);
  });

  it('stores only the edited file when an observed patch changes documentation', async () => {
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    }));
    const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
    const priorMode = mode.activeMode, priorModeId = mode.activeModeId;
    mode.loadMode('code');
    const store = new SessionStore(':memory:');
    const dbManager = {
      getSessionById: (id: number) => store.getSessionById(id),
      getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
    } as unknown as DatabaseManager;
    const manager = new SessionManager(dbManager);
    const sid = store.createSDKSession('patch-header-content', 'patch-project', 'Update documentation');
    const session = manager.initializeSession(sid, undefined, 1);
    session.memorySessionId = 'patch-header-memory';
    store.ensureMemorySessionIdRegistered(sid, session.memorySessionId);
    session.lastGeneratorSource = 'ingest';
    manager.queueObservation(sid, {
      tool_name: 'apply_patch', tool_input: { command: customUpdate },
      tool_response: 'Success. Updated the following files:\nM docs/guide.md',
    });
    const messages = manager.getMessageIterator(sid);
    try {
      await messages.next();
      const result = await processAgentResponse(
        '<observation><type>change</type><title>Updated patch documentation</title></observation>',
        session, dbManager, manager, undefined, 10, null, 'SDK',
      );
      expect(getObservationsByFilePath(store.db, 'docs/guide.md', { projects: ['patch-project'] }).map(row => row.id))
        .toEqual(result!.observationIds);
      expect(getObservationsByFilePath(store.db, 'docs/decoy.md', { projects: ['patch-project'] })).toEqual([]);
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
