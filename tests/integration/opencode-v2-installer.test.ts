import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { Schema } from 'effect';
import { Config } from '@opencode/schema/config';
import {
  getInstalledPluginPath, getOpenCodeConfigPath, installOpenCodePlugin, registerOpenCodePluginInConfig,
  resolveOpenCodePluginAPI, uninstallOpenCodePlugin,
} from '../../src/services/integrations/OpenCodeInstaller.js';

let folder: string;
let previous: Record<string, string | undefined>;
const keys = ['OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_MEM_OPENCODE_API', 'PATH'];
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cmem-opencode-v2-install-'));
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.OPENCODE_CONFIG_DIR = join(folder, 'config');
  process.env.CLAUDE_CONFIG_DIR = join(folder, 'claude');
  process.env.CLAUDE_PLUGIN_ROOT = join(folder, 'plugin');
  process.env.CLAUDE_MEM_OPENCODE_API = 'v2';
  mkdirSync(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
  mkdirSync(join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts'), { recursive: true });
  writeFileSync(join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'mcp-server.cjs'), '// installed MCP');
  const bundles = join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack', 'dist', 'opencode-plugin');
  mkdirSync(bundles, { recursive: true });
  writeFileSync(join(bundles, 'index.js'), '// v1 factory');
  writeFileSync(join(bundles, 'v2.js'), '// v2 definition');
  writeFileSync(join(bundles, 'THIRD-PARTY-LICENSE.txt'), readFileSync(join(process.cwd(), 'src/integrations/opencode-plugin/THIRD-PARTY-LICENSE.txt')));
});
afterEach(() => {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  rmSync(folder, { recursive: true, force: true });
});
const read = () => parse(readFileSync(getOpenCodeConfigPath(), 'utf8'));

describe('version-aware OpenCode installation', () => {
  it('respects a custom XDG config root when no explicit OpenCode directory is set', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = join(folder, 'xdg-config');
    expect(installOpenCodePlugin()).toBe(0);
    expect(getInstalledPluginPath()).toBe(join(folder, 'xdg-config', 'opencode', 'plugins', 'claude-mem.js'));
  });
  it('selects the v2 bundle and emits the current host configuration/MCP schema', () => {
    expect(installOpenCodePlugin()).toBe(0);
    expect(readFileSync(getInstalledPluginPath(), 'utf8')).toBe('// v2 definition');
    const config = read();
    expect(config.plugins).toEqual(['./plugins/claude-mem.js']);
    expect(config.plugin).toBeUndefined();
    expect(config.mcp.servers['claude-mem']).toMatchObject({ type: 'local', codemode: false });
    expect(config.mcp.servers['claude-mem'].command[0]).toBe(process.execPath);
    expect(() => Schema.decodeUnknownSync(Config.Info)(config, { onExcessProperty: 'error' })).not.toThrow();
    expect(readFileSync(join(folder, 'config', 'plugins', 'claude-mem.LICENSE.txt'), 'utf8')).toContain('Copyright (c) 2026 Bryan');
  });

  it('keeps v1 support and replaces the same installed file instead of adding another automatic plugin', () => {
    expect(installOpenCodePlugin()).toBe(0);
    process.env.CLAUDE_MEM_OPENCODE_API = 'v1';
    expect(installOpenCodePlugin()).toBe(0);
    expect(readFileSync(getInstalledPluginPath(), 'utf8')).toBe('// v1 factory');
    expect(read().plugin).toEqual(['./plugins/claude-mem.js']);
    expect(read().plugins).toBeUndefined();
    expect(read().mcp.servers).toBeUndefined();
    expect(read().mcp['claude-mem'].type).toBe('local');
  });

  it('migrates its old entries, preserves JSONC comments/options and uninstalls only owned configuration', () => {
    const file = join(folder, 'config', 'opencode.jsonc');
    writeFileSync(file, `{
      // Keep the operator's comments.
      "username": "Alex",
      "plugin": ["./plugins/claude-mem.js"],
      "plugins": [
        // Keep this plugin and its options.
        {"package": "another-v2-plugin", "options": {"custom": true}},
      ],
      "mcp": {
        "claude-mem": {"type": "local", "command": ["node", "/old/server.cjs"], "enabled": false, "environment": {"CUSTOM": "keep"}},
        "servers": {
          // Keep this server.
          "other": {"type": "remote", "url": "https://example.com/mcp", "disabled": true},
        },
      },
    }`);
    expect(installOpenCodePlugin()).toBe(0);
    expect(registerOpenCodePluginInConfig(2)).toBe(0);
    const config = read();
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toEqual([{ package: 'another-v2-plugin', options: { custom: true } }, './plugins/claude-mem.js']);
    expect(config.mcp['claude-mem']).toBeUndefined();
    expect(config.mcp.servers['claude-mem']).toMatchObject({ disabled: true, environment: { CUSTOM: 'keep' } });
    expect(config.mcp.servers['claude-mem'].enabled).toBeUndefined();
    writeFileSync(join(folder, 'config', 'plugins', 'personal.txt'), 'Keep');
    expect(uninstallOpenCodePlugin()).toBe(0);
    expect(read().plugins).toEqual([{ package: 'another-v2-plugin', options: { custom: true } }]);
    expect(read().mcp.servers).toEqual({ other: { type: 'remote', url: 'https://example.com/mcp', disabled: true } });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain("Keep the operator's comments");
    expect(text).toContain('Keep this plugin and its options');
    expect(text).toContain('Keep this server');
    expect(readFileSync(join(folder, 'config', 'plugins', 'personal.txt'), 'utf8')).toBe('Keep');
    expect(existsSync(getInstalledPluginPath())).toBe(false);
  });

  it.each([
    { plugins: ['@ephemushroom/opencode-claude-mem@0.6.2'] },
    { plugin: ['another-v1-plugin'] },
    { mcp: { 'another-v1-server': { type: 'local', command: ['server'] } } },
  ])('refuses duplicate capture or unrelated v1 migration before changing files (%j)', config => {
    const original = JSON.stringify(config);
    writeFileSync(getOpenCodeConfigPath(), original);
    expect(installOpenCodePlugin()).toBe(1);
    expect(readFileSync(getOpenCodeConfigPath(), 'utf8')).toBe(original);
    expect(existsSync(getInstalledPluginPath())).toBe(false);
  });

  it('preserves malformed configuration and validates an invalid API override before writing a plugin', () => {
    writeFileSync(getOpenCodeConfigPath(), '{invalid');
    expect(installOpenCodePlugin()).toBe(1);
    expect(readFileSync(getOpenCodeConfigPath(), 'utf8')).toBe('{invalid');
    expect(existsSync(getInstalledPluginPath())).toBe(false);
    process.env.CLAUDE_MEM_OPENCODE_API = 'unsupported';
    expect(installOpenCodePlugin()).toBe(1);
    expect(existsSync(getInstalledPluginPath())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('detects the native CLI major version without a global config override', () => {
    delete process.env.CLAUDE_MEM_OPENCODE_API;
    const bin = join(folder, 'bin'); mkdirSync(bin);
    const cli = join(bin, 'opencode');
    process.env.PATH = bin + ':' + previous.PATH;
    writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("2.0.22");\n', { mode: 0o755 });
    expect(resolveOpenCodePluginAPI()).toBe(2);
    expect(installOpenCodePlugin()).toBe(0);
    expect(readFileSync(getInstalledPluginPath(), 'utf8')).toBe('// v2 definition');
    writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("1.17.8");\n', { mode: 0o755 });
    expect(resolveOpenCodePluginAPI()).toBe(1);
  });
});
