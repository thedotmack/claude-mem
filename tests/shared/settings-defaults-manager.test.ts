/**
 * SettingsDefaultsManager Tests
 *
 * Tests for the settings file auto-creation feature in loadFromFile().
 * Uses temp directories for file system isolation.
 *
 * Test cases:
 * 1. File doesn't exist - should create file with defaults and return defaults
 * 2. File exists with valid content - should return parsed content
 * 3. File exists but is empty/corrupt - should return defaults
 * 4. Directory doesn't exist - should create directory and file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';

/** Shape of parsed settings JSON */
interface ParsedSettings {
  env?: Record<string, string>;
  CLAUDE_MEM_MODEL?: string;
  CLAUDE_MEM_PROVIDER?: string;
  CLAUDE_MEM_OPENAI_COMPAT_API_KEY?: string;
  CLAUDE_MEM_OPENAI_COMPAT_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  [key: string]: unknown;
}
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('SettingsDefaultsManager', () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `settings-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadFromFile', () => {
    describe('file does not exist', () => {
      it('should create file with defaults when file does not exist', () => {
        expect(existsSync(settingsPath)).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(existsSync(settingsPath)).toBe(true);
        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should write valid JSON to the created file', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        expect(() => JSON.parse(content) as unknown).not.toThrow();
      });

      it('should write pretty-printed JSON (2-space indent)', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        expect(content).toContain('\n');
        expect(content).toContain('  "CLAUDE_MEM_MODEL"');
      });

      it('should write all default keys to the file', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content) as ParsedSettings;
        const defaults = SettingsDefaultsManager.getAllDefaults();

        for (const key of Object.keys(defaults)) {
          expect(parsed).toHaveProperty(key);
        }
      });
    });

    describe('directory does not exist', () => {
      it('should create directory and file when parent directory does not exist', () => {
        const nestedPath = join(tempDir, 'nested', 'deep', 'settings.json');
        expect(existsSync(join(tempDir, 'nested'))).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(nestedPath);

        expect(existsSync(join(tempDir, 'nested', 'deep'))).toBe(true);
        expect(existsSync(nestedPath)).toBe(true);
        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should create deeply nested directories recursively', () => {
        const deepPath = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'settings.json');

        SettingsDefaultsManager.loadFromFile(deepPath);

        expect(existsSync(join(tempDir, 'a', 'b', 'c', 'd', 'e'))).toBe(true);
        expect(existsSync(deepPath)).toBe(true);
      });
    });

    describe('file exists with valid content', () => {
      it('should return parsed content when file has valid JSON', () => {
        const customSettings = {
          CLAUDE_MEM_MODEL: 'custom-model',
          CLAUDE_MEM_WORKER_PORT: '12345',
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('custom-model');
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe('12345');
      });

      it('should merge file settings with defaults for missing keys', () => {
        // Only set one value, defaults should fill the rest
        const partialSettings = {
          CLAUDE_MEM_MODEL: 'partial-model',
        };
        writeFileSync(settingsPath, JSON.stringify(partialSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);
        const defaults = SettingsDefaultsManager.getAllDefaults();

        expect(result.CLAUDE_MEM_MODEL).toBe('partial-model');
        // Other values should come from defaults
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe(defaults.CLAUDE_MEM_WORKER_PORT);
        expect(result.CLAUDE_MEM_WORKER_HOST).toBe(defaults.CLAUDE_MEM_WORKER_HOST);
        expect(result.CLAUDE_MEM_LOG_LEVEL).toBe(defaults.CLAUDE_MEM_LOG_LEVEL);
      });

      it('should not modify existing file when loading', () => {
        const customSettings = {
          CLAUDE_MEM_MODEL: 'do-not-change',
          CUSTOM_KEY: 'should-persist', // Extra key not in defaults
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings, null, 2));
        const originalContent = readFileSync(settingsPath, 'utf-8');

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const afterContent = readFileSync(settingsPath, 'utf-8');
        expect(afterContent).toBe(originalContent);
      });

      it('should handle all settings keys correctly', () => {
        const fullSettings = SettingsDefaultsManager.getAllDefaults();
        fullSettings.CLAUDE_MEM_MODEL = 'all-keys-model';
        fullSettings.CLAUDE_MEM_PROVIDER = 'gemini';
        writeFileSync(settingsPath, JSON.stringify(fullSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('all-keys-model');
        expect(result.CLAUDE_MEM_PROVIDER).toBe('gemini');
      });
    });

    describe('file exists but is empty or corrupt', () => {
      it('should return defaults when file is empty', () => {
        writeFileSync(settingsPath, '');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains invalid JSON', () => {
        writeFileSync(settingsPath, 'not valid json {{{{');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains only whitespace', () => {
        writeFileSync(settingsPath, '   \n\t  ');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains null', () => {
        writeFileSync(settingsPath, 'null');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains array instead of object', () => {
        writeFileSync(settingsPath, '["array", "not", "object"]');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains primitive value', () => {
        writeFileSync(settingsPath, '"just a string"');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });
    });

    describe('nested schema migration', () => {
      it('should migrate old nested { env: {...} } schema to flat schema', () => {
        const nestedSettings = {
          env: {
            CLAUDE_MEM_MODEL: 'nested-model',
            CLAUDE_MEM_WORKER_PORT: '54321',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('nested-model');
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
      });

      it('should auto-migrate file from nested to flat schema', () => {
        const nestedSettings = {
          env: {
            CLAUDE_MEM_MODEL: 'migrated-model',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        SettingsDefaultsManager.loadFromFile(settingsPath);

        // File should now be flat schema
        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content) as ParsedSettings;
        expect(parsed.env).toBeUndefined();
        expect(parsed.CLAUDE_MEM_MODEL).toBe('migrated-model');
      });
    });

    describe('OpenRouter to OpenAI-compat migration', () => {
      it('should migrate CLAUDE_MEM_OPENROUTER_* keys to CLAUDE_MEM_OPENAI_COMPAT_*', () => {
        const oldSettings = {
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test-key',
          CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
          CLAUDE_MEM_OPENROUTER_SITE_URL: 'https://example.com',
          CLAUDE_MEM_OPENROUTER_APP_NAME: 'test-app',
          CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '30',
          CLAUDE_MEM_OPENROUTER_MAX_TOKENS: '200000',
        };
        writeFileSync(settingsPath, JSON.stringify(oldSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        // Verify in-memory result has new keys
        expect(result.CLAUDE_MEM_PROVIDER).toBe('openai-compat');
        expect(result.CLAUDE_MEM_OPENAI_COMPAT_API_KEY).toBe('sk-or-test-key');
        expect(result.CLAUDE_MEM_OPENAI_COMPAT_MODEL).toBe('xiaomi/mimo-v2-flash:free');
        expect(result.CLAUDE_MEM_OPENAI_COMPAT_SITE_URL).toBe('https://example.com');
        expect(result.CLAUDE_MEM_OPENAI_COMPAT_APP_NAME).toBe('test-app');
        expect(result.CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES).toBe('30');
        expect(result.CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS).toBe('200000');
      });

      it('should auto-migrate file on disk from OpenRouter to OpenAI-compat keys', () => {
        const oldSettings = {
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-migrate-key',
          CLAUDE_MEM_OPENROUTER_MODEL: 'test-model',
        };
        writeFileSync(settingsPath, JSON.stringify(oldSettings));

        SettingsDefaultsManager.loadFromFile(settingsPath);

        // Verify file was rewritten with new keys
        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content) as ParsedSettings;
        expect(parsed.CLAUDE_MEM_PROVIDER).toBe('openai-compat');
        expect(parsed.CLAUDE_MEM_OPENAI_COMPAT_API_KEY).toBe('sk-or-migrate-key');
        expect(parsed.CLAUDE_MEM_OPENAI_COMPAT_MODEL).toBe('test-model');
        // Old keys should be removed
        expect(parsed.CLAUDE_MEM_OPENROUTER_API_KEY).toBeUndefined();
        expect(parsed.CLAUDE_MEM_OPENROUTER_MODEL).toBeUndefined();
      });

      it('should not migrate if new keys already exist', () => {
        const settings = {
          CLAUDE_MEM_PROVIDER: 'openai-compat',
          CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'new-key',
          CLAUDE_MEM_OPENROUTER_API_KEY: 'old-key',  // Should be ignored
        };
        writeFileSync(settingsPath, JSON.stringify(settings));
        const originalContent = readFileSync(settingsPath, 'utf-8');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_OPENAI_COMPAT_API_KEY).toBe('new-key');
        // File should not be rewritten since provider is already openai-compat
        // and new key already exists
        const afterContent = readFileSync(settingsPath, 'utf-8');
        expect(afterContent).toBe(originalContent);
      });

      it('should migrate CLAUDE_MEM_OPENROUTER_BASE_URL to CLAUDE_MEM_OPENAI_COMPAT_BASE_URL', () => {
        const oldSettings = {
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_OPENROUTER_API_KEY: 'key',
          CLAUDE_MEM_OPENROUTER_BASE_URL: 'http://localhost:8317/v1/chat/completions',
        };
        writeFileSync(settingsPath, JSON.stringify(oldSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL).toBe('http://localhost:8317/v1/chat/completions');
      });
    });

    describe('edge cases', () => {
      it('should handle empty object in file', () => {
        writeFileSync(settingsPath, '{}');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should ignore unknown keys in file', () => {
        const settingsWithUnknown = {
          CLAUDE_MEM_MODEL: 'known-model',
          UNKNOWN_KEY: 'should-be-ignored',
          ANOTHER_UNKNOWN: 12345,
        };
        writeFileSync(settingsPath, JSON.stringify(settingsWithUnknown));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('known-model');
        expect((result as Record<string, unknown>).UNKNOWN_KEY).toBeUndefined();
      });

      it('should handle file with BOM', () => {
        const bom = '\uFEFF';
        const settings = { CLAUDE_MEM_MODEL: 'bom-model' };
        writeFileSync(settingsPath, bom + JSON.stringify(settings));

        // JSON.parse handles BOM, but let's verify behavior
        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        // If it fails to parse due to BOM, it should return defaults
        // If it succeeds, it should return the parsed value
        // Either way, should not throw
        expect(result).toBeDefined();
      });
    });
  });

  describe('getAllDefaults', () => {
    it('should return a copy of defaults', () => {
      const defaults1 = SettingsDefaultsManager.getAllDefaults();
      const defaults2 = SettingsDefaultsManager.getAllDefaults();

      expect(defaults1).toEqual(defaults2);
      expect(defaults1).not.toBe(defaults2); // Different object references
    });

    it('should include all expected keys', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      // Core settings
      expect(defaults.CLAUDE_MEM_MODEL).toBeDefined();
      expect(defaults.CLAUDE_MEM_WORKER_PORT).toBeDefined();
      expect(defaults.CLAUDE_MEM_WORKER_HOST).toBeDefined();

      // Provider settings
      expect(defaults.CLAUDE_MEM_PROVIDER).toBeDefined();
      expect(defaults.CLAUDE_MEM_GEMINI_API_KEY).toBeDefined();
      expect(defaults.CLAUDE_MEM_OPENAI_COMPAT_API_KEY).toBeDefined();

      // System settings
      expect(defaults.CLAUDE_MEM_DATA_DIR).toBeDefined();
      expect(defaults.CLAUDE_MEM_LOG_LEVEL).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return default value for key', () => {
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_MODEL')).toBe('claude-sonnet-4-5');
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT')).toBe('37777');
    });
  });

  describe('getInt', () => {
    it('should return integer value for numeric string', () => {
      expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_WORKER_PORT')).toBe(37777);
      expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_CONTEXT_OBSERVATIONS')).toBe(50);
    });
  });

  describe('getBool', () => {
    it('should return true for "true" string', () => {
      expect(SettingsDefaultsManager.getBool('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')).toBe(true);
    });

    it('should return false for non-"true" string', () => {
      expect(SettingsDefaultsManager.getBool('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')).toBe(false);
    });
  });
});
