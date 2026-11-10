import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeGooseYamlConfig } from '../../src/services/integrations/McpIntegrations.js';
import { getNodeAbsolutePath } from '../../src/services/integrations/install-paths.js';

for (const serverPath of [
  '/tmp/release #1/mcp-server.cjs',
  '/tmp/release: stable/mcp-server.cjs',
  '/tmp/line\nbreak/mcp-server.cjs',
  '/tmp/back\\slash/"quoted"/mcp-server.cjs',
  'C:\\Users\\Example\\claude-mem\\mcp-server.cjs',
]) {
  test(`Goose receives the exact MCP path ${JSON.stringify(serverPath)}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'goose-yaml-path-'));
    const configPath = join(directory, 'config.yaml');
    try {
      writeFileSync(configPath, 'GOOSE_PROVIDER: ollama\nextensions:\n  other:\n    type: builtin\n    enabled: true\n');
      mergeGooseYamlConfig(configPath, serverPath);
      const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as any;
      assert.deepEqual(parsed.extensions['claude-mem'].args, [serverPath]);
      assert.equal(parsed.extensions['claude-mem'].cmd, getNodeAbsolutePath());
      assert.equal(parsed.GOOSE_PROVIDER, 'ollama');
      assert.deepEqual(parsed.extensions.other, { type: 'builtin', enabled: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const command of [
  '/opt/Node #1/bin/node',
  '/opt/Node: stable/bin/node',
  '/opt/line\nbreak/bin/node',
]) {
  test(`Goose receives the exact runtime command ${JSON.stringify(command)}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'goose-yaml-command-'));
    const configPath = join(directory, 'config.yaml');
    const originalExecPath = process.execPath;
    try {
      // The production resolver deliberately bakes process.execPath. Control
      // that input so cmd is tested independently of the MCP script argument.
      process.execPath = command;
      mergeGooseYamlConfig(configPath, '/opt/claude-mem/mcp-server.cjs');
      process.execPath = originalExecPath;
      const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as any;
      assert.equal(parsed.extensions['claude-mem'].cmd, command);
      assert.deepEqual(parsed.extensions['claude-mem'].args, ['/opt/claude-mem/mcp-server.cjs']);
    } finally {
      process.execPath = originalExecPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
