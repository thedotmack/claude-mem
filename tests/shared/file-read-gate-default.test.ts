import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { paths } from '../../src/shared/paths.js';

describe('CLAUDE_MEM_FILE_READ_GATE_ENABLED default', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalEnvValue: string | undefined;

  beforeEach(() => {
    // Inside the per-run data dir tests/preload.ts pins, not the system temp dir.
    tempDir = join(paths.dataDir(), `file-read-gate-default-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    originalEnvValue = process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED;
    delete process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED;
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED;
    } else {
      process.env.CLAUDE_MEM_FILE_READ_GATE_ENABLED = originalEnvValue;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('is set to "true" in getAllDefaults()', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_FILE_READ_GATE_ENABLED).toBe('true');
  });

  it('resolves to "true" when settings file is missing (auto-created with defaults)', () => {
    expect(existsSync(settingsPath)).toBe(false);

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.CLAUDE_MEM_FILE_READ_GATE_ENABLED).toBe('true');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('resolves to "true" when settings file is empty JSON object', () => {
    writeFileSync(settingsPath, '{}', 'utf-8');

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.CLAUDE_MEM_FILE_READ_GATE_ENABLED).toBe('true');
  });
});
