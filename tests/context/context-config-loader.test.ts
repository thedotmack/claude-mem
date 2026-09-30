import { describe, it, expect, spyOn, mock, afterAll } from 'bun:test';
import * as realModeManagerModule from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const realModeManagerSnapshot = { ...realModeManagerModule };

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [],
        observation_concepts: [],
      }),
    }),
  },
}));

afterAll(() => {
  mock.module('../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

const { loadContextConfig } = await import('../../src/services/context/ContextConfigLoader.js');

describe('loadContextConfig', () => {
  it('maps CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY to the mainAgentOnly flag', () => {
    const loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile');

    try {
      loadSpy.mockReturnValue({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY: 'false',
      });
      expect(loadContextConfig().mainAgentOnly).toBe(false);

      loadSpy.mockReturnValue({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY: 'true',
      });
      expect(loadContextConfig().mainAgentOnly).toBe(true);
    } finally {
      loadSpy.mockRestore();
    }
  });
});
