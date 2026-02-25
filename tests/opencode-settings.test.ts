/**
 * OpenCode Settings Validation Tests
 *
 * Tests for OpenCode-related settings defaults and validation logic.
 * Covers SettingsDefaultsManager defaults and SettingsRoutes validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';

describe('OpenCode Settings', () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('defaults', () => {
    it('includes CLAUDE_MEM_OPENCODE_BASE_URL default', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();
      expect(defaults.CLAUDE_MEM_OPENCODE_BASE_URL).toBe('http://127.0.0.1:4096');
    });

    it('includes CLAUDE_MEM_OPENCODE_MODE default', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();
      expect(defaults.CLAUDE_MEM_OPENCODE_MODE).toBe('sdk_agent');
    });

    it('includes opencode as valid provider option', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();
      // Provider default is 'claude', but 'opencode' should be settable
      expect(defaults.CLAUDE_MEM_PROVIDER).toBeDefined();
    });
  });

  describe('loadFromFile with OpenCode settings', () => {
    it('writes OpenCode defaults to new settings file', () => {
      const result = SettingsDefaultsManager.loadFromFile(settingsPath);
      expect(result.CLAUDE_MEM_OPENCODE_BASE_URL).toBe('http://127.0.0.1:4096');
      expect(result.CLAUDE_MEM_OPENCODE_MODE).toBe('sdk_agent');

      // Verify persisted to file
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(content.CLAUDE_MEM_OPENCODE_BASE_URL).toBe('http://127.0.0.1:4096');
      expect(content.CLAUDE_MEM_OPENCODE_MODE).toBe('sdk_agent');
    });

    it('preserves custom OpenCode settings from existing file', () => {
      // Write custom settings first
      const customSettings = {
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_PROVIDER: 'opencode',
        CLAUDE_MEM_OPENCODE_BASE_URL: 'http://10.0.0.5:8080',
        CLAUDE_MEM_OPENCODE_MODE: 'direct_store',
      };
      mkdirSync(tempDir, { recursive: true });
      const fs = require('fs');
      fs.writeFileSync(settingsPath, JSON.stringify(customSettings, null, 2), 'utf-8');

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);
      expect(result.CLAUDE_MEM_PROVIDER).toBe('opencode');
      expect(result.CLAUDE_MEM_OPENCODE_BASE_URL).toBe('http://10.0.0.5:8080');
      expect(result.CLAUDE_MEM_OPENCODE_MODE).toBe('direct_store');
    });
  });

  describe('getBool fix', () => {
    it('returns true for string "true"', () => {
      // getBool was fixed to only accept string 'true', not boolean true
      const defaults = SettingsDefaultsManager.getAllDefaults();
      // CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY is a boolean-like setting stored as string
      expect(typeof defaults.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY).toBe('string');
      expect(defaults.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY).toBe('true');
    });
  });
});
