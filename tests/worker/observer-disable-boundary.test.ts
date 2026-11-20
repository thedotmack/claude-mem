import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-disabled',
      project: 'project',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

afterEach(() => {
  mock.restore();
});

describe('observer disable at a live generator boundary', () => {
  it('drops queued work before yielding another provider turn', async () => {
    const enabled = SettingsDefaultsManager.getAllDefaults();
    const loadSettings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(enabled);
    spyOn(logger, 'info').mockImplementation(() => {});

    const manager = new SessionManager(makeDbManager());
    manager.initializeSession(71, 'do the thing', 1);
    manager.queueObservation(71, {
      tool_name: 'Read',
      tool_input: {},
      tool_response: {},
      prompt_number: 1,
      toolUseId: 'tool-1',
    });
    manager.queueObservation(71, {
      tool_name: 'Read',
      tool_input: {},
      tool_response: {},
      prompt_number: 1,
      toolUseId: 'tool-2',
    });

    const iterator = manager.getMessageIterator(71);
    expect((await iterator.next()).done).toBe(false);
    await manager.confirmClaimedMessages(71);

    loadSettings.mockReturnValue({ ...enabled, CLAUDE_MEM_OBSERVER_ENABLED: 'false' });

    expect((await iterator.next()).done).toBe(true);
    expect(manager.getMessageBuffer().getPendingCount(71)).toBe(0);
  });
});
