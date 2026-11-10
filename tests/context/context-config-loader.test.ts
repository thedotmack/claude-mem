import { describe, it, expect, spyOn, mock, afterAll } from 'bun:test';
import * as realModeManagerModule from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

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

  it('warns when a count that is not a whole number >= 0 falls back to the default', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    const loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const warningKeys = () => warnSpy.mock.calls.map(([, message]) => message.split(' ')[0]);

    try {
      loadSpy.mockReturnValue({
        ...defaults,
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: '-1',
        CLAUDE_MEM_CONTEXT_FULL_COUNT: '3.5',
        CLAUDE_MEM_CONTEXT_SESSION_COUNT: '',
      });
      const config = loadContextConfig();
      expect([config.totalObservationCount, config.fullObservationCount, config.sessionCount]).toEqual([
        Number(defaults.CLAUDE_MEM_CONTEXT_OBSERVATIONS),
        Number(defaults.CLAUDE_MEM_CONTEXT_FULL_COUNT),
        Number(defaults.CLAUDE_MEM_CONTEXT_SESSION_COUNT),
      ]);
      expect(warningKeys()).toEqual([
        'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
        'CLAUDE_MEM_CONTEXT_FULL_COUNT',
        'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
      ]);

      // Valid counts, zero and large values included, load as written without a warning.
      warnSpy.mockClear();
      loadSpy.mockReturnValue({ ...defaults, CLAUDE_MEM_CONTEXT_OBSERVATIONS: '0', CLAUDE_MEM_CONTEXT_SESSION_COUNT: '500' });
      const custom = loadContextConfig();
      expect([custom.totalObservationCount, custom.sessionCount]).toEqual([0, 500]);
      expect(warningKeys()).toEqual([]);
    } finally {
      loadSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
