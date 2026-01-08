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

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('SettingsDefaultsManager', () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        expect(() => JSON.parse(content)).not.toThrow();
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
        const parsed = JSON.parse(content);
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
        const parsed = JSON.parse(content);
        expect(parsed.env).toBeUndefined();
        expect(parsed.CLAUDE_MEM_MODEL).toBe('migrated-model');
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
      expect(defaults.CLAUDE_MEM_OPENROUTER_API_KEY).toBeDefined();

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

  describe('environment variable overrides', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save original env values
      originalEnv.CLAUDE_MEM_WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT;
      originalEnv.CLAUDE_MEM_MODEL = process.env.CLAUDE_MEM_MODEL;
      originalEnv.CLAUDE_MEM_LOG_LEVEL = process.env.CLAUDE_MEM_LOG_LEVEL;
    });

    afterEach(() => {
      // Restore original env values
      if (originalEnv.CLAUDE_MEM_WORKER_PORT === undefined) {
        delete process.env.CLAUDE_MEM_WORKER_PORT;
      } else {
        process.env.CLAUDE_MEM_WORKER_PORT = originalEnv.CLAUDE_MEM_WORKER_PORT;
      }
      if (originalEnv.CLAUDE_MEM_MODEL === undefined) {
        delete process.env.CLAUDE_MEM_MODEL;
      } else {
        process.env.CLAUDE_MEM_MODEL = originalEnv.CLAUDE_MEM_MODEL;
      }
      if (originalEnv.CLAUDE_MEM_LOG_LEVEL === undefined) {
        delete process.env.CLAUDE_MEM_LOG_LEVEL;
      } else {
        process.env.CLAUDE_MEM_LOG_LEVEL = originalEnv.CLAUDE_MEM_LOG_LEVEL;
      }
    });

    it('should prioritize env var over file setting', () => {
      // File has port 12345, env var has 54321
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '12345',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      process.env.CLAUDE_MEM_WORKER_PORT = '54321';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
    });

    it('should prioritize env var over default', () => {
      // No file, env var set
      process.env.CLAUDE_MEM_WORKER_PORT = '99999';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('99999');
    });

    it('should use file setting when env var is not set', () => {
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '11111',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      delete process.env.CLAUDE_MEM_WORKER_PORT;

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('11111');
    });

    it('should apply env var override even on file parse error', () => {
      writeFileSync(settingsPath, 'invalid json {{{');
      process.env.CLAUDE_MEM_WORKER_PORT = '88888';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('88888');
    });

    it('should apply multiple env var overrides', () => {
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '12345',
        CLAUDE_MEM_MODEL: 'file-model',
        CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));

      process.env.CLAUDE_MEM_WORKER_PORT = '54321';
      process.env.CLAUDE_MEM_MODEL = 'env-model';
      // LOG_LEVEL not set in env, should use file value

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
      expect(result.CLAUDE_MEM_MODEL).toBe('env-model');
      expect(result.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG'); // From file
    });

    it('should document priority: env > file > defaults', () => {
      // This test documents the expected priority order
      const defaults = SettingsDefaultsManager.getAllDefaults();

      // Set file to something different from default
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '22222', // Different from default 37777
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));

      // Set env to something different from both
      process.env.CLAUDE_MEM_WORKER_PORT = '33333';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      // Priority check:
      // Default is 37777, file is 22222, env is 33333
      // Result should be env (33333) because env > file > default
      expect(defaults.CLAUDE_MEM_WORKER_PORT).toBe('37777'); // Confirm default
      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('33333'); // Env wins
    });
  });
});
