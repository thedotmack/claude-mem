import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addOpenCodePluginReference,
  getOpenCodeConfigPath,
  registerOpenCodePluginInConfig,
} from '../../src/services/integrations/OpenCodeInstaller.js';

describe('OpenCode installer config registration', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('adds claude-mem to an existing plugin array', () => {
    const config = addOpenCodePluginReference({
      plugin: ['context-mode'],
      mcp: { context7: { enabled: true } },
    });

    expect(config.plugin).toEqual(['context-mode', './plugins/claude-mem.js']);
    expect(config.mcp).toEqual({ context7: { enabled: true } });
  });

  it('does not duplicate an existing claude-mem plugin reference', () => {
    const config = addOpenCodePluginReference({
      plugin: ['context-mode', './plugins/claude-mem.js'],
    });

    expect(config.plugin).toEqual(['context-mode', './plugins/claude-mem.js']);
  });

  it('creates opencode.json when missing', () => {
    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(0);
    expect(existsSync(getOpenCodeConfigPath())).toBe(true);

    const config = JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8'));
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.plugin).toEqual(['./plugins/claude-mem.js']);
  });

  it('preserves existing config fields when registering the plugin', () => {
    writeFileSync(getOpenCodeConfigPath(), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['context-mode'],
      provider: { openai: { models: {} } },
    }), 'utf-8');

    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(0);
    const config = JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8'));
    expect(config.plugin).toEqual(['context-mode', './plugins/claude-mem.js']);
    expect(config.provider).toEqual({ openai: { models: {} } });
  });
});
