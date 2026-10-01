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

  it('reads CLAUDE_MEM_REINFORCE_ALPHA from settings.json; off unless a positive number', () => {
    const loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile');
    const withAlpha = (value: string) => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_REINFORCE_ALPHA: value,
    });

    try {
      loadSpy.mockReturnValue(SettingsDefaultsManager.getAllDefaults());
      expect(loadContextConfig().reinforcementAlpha).toBe(0);

      loadSpy.mockReturnValue(withAlpha('0.5'));
      expect(loadContextConfig().reinforcementAlpha).toBe(0.5);

      for (const off of ['-1', 'abc', '']) {
        loadSpy.mockReturnValue(withAlpha(off));
        expect(loadContextConfig().reinforcementAlpha).toBe(0);
      }
    } finally {
      loadSpy.mockRestore();
    }
  });
});
