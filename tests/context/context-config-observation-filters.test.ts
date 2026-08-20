import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { loadContextConfig } from '../../src/services/context/ContextConfigLoader.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

const TYPES_KEY = 'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES';
const CONCEPTS_KEY = 'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS';

describe('CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES / _CONCEPTS reach the injection query', () => {
  let modeTypes: string[];
  let modeConcepts: string[];

  beforeAll(() => {
    const mode = ModeManager.getInstance().loadMode('code');
    modeTypes = mode.observation_types.map(t => t.id);
    modeConcepts = mode.observation_concepts.map(c => c.id);
  });

  afterEach(() => {
    delete process.env[TYPES_KEY];
    delete process.env[CONCEPTS_KEY];
  });

  // Half one of the defect: loadFromFile only copies keys that exist in
  // DEFAULTS, so a documented setting written to settings.json was dropped
  // before any consumer could read it.
  describe('SettingsDefaultsManager.loadFromFile', () => {
    it('preserves the observation filter keys written to settings.json', () => {
      const dir = mkdtempSync(join(tmpdir(), 'claude-mem-settings-'));
      const settingsPath = join(dir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify({ [TYPES_KEY]: 'bugfix,decision,discovery', [CONCEPTS_KEY]: 'gotcha' }),
        'utf-8'
      );

      try {
        const settings = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(settings[TYPES_KEY]).toBe('bugfix,decision,discovery');
        expect(settings[CONCEPTS_KEY]).toBe('gotcha');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Half two: loadContextConfig built both sets from the mode file alone, so
  // even a setting that survived the load never narrowed the injected context.
  describe('loadContextConfig', () => {
    it('honors a configured observation type list', () => {
      process.env[TYPES_KEY] = 'bugfix,decision,discovery';

      expect([...loadContextConfig().observationTypes].sort()).toEqual(['bugfix', 'decision', 'discovery']);
    });

    it('honors a configured observation concept list', () => {
      process.env[CONCEPTS_KEY] = 'gotcha,how-it-works';

      expect([...loadContextConfig().observationConcepts].sort()).toEqual(['gotcha', 'how-it-works']);
    });

    it('tolerates whitespace and empty entries', () => {
      process.env[TYPES_KEY] = ' bugfix , ,decision, ';

      expect([...loadContextConfig().observationTypes].sort()).toEqual(['bugfix', 'decision']);
    });

    it('falls back to the active mode lists when the settings are empty', () => {
      process.env[TYPES_KEY] = '';
      process.env[CONCEPTS_KEY] = '';

      const config = loadContextConfig();

      expect([...config.observationTypes].sort()).toEqual([...modeTypes].sort());
      expect([...config.observationConcepts].sort()).toEqual([...modeConcepts].sort());
    });
  });
});
