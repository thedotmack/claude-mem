import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addOpenCodeMcpReference,
  addOpenCodePluginReference,
  deregisterOpenCodePluginFromConfig,
  getOpenCodeConfigPath,
  registerOpenCodePluginInConfig,
  removeOpenCodeMcpReference,
  removeOpenCodePluginReference,
} from '../../src/services/integrations/OpenCodeInstaller.js';
import { getMcpServerAbsolutePath } from '../../src/services/integrations/install-paths.js';

// Checked-in host contract (plan-23 step 1): the OpenCode local-MCP entry
// schema the installer must emit. `mcp.claude-mem` is validated against it
// below so a drift from the host's real schema fails CI, not a user install.
const OPENCODE_MCP_FIXTURE_PATH = join(import.meta.dir, '../../fixtures/hosts/opencode-mcp.json');
const opencodeMcpFixture = JSON.parse(
  readFileSync(OPENCODE_MCP_FIXTURE_PATH, 'utf-8'),
) as {
  entry: {
    allowed_keys: string[];
    required_keys: string[];
    type: { accepted_values: string[]; claude_mem_value: string };
    command: { min_items: number };
  };
  claude_mem_entry: { key: string; type: string; command: string[] };
};

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

  it('preserves an existing single-string plugin entry', () => {
    const config = addOpenCodePluginReference({
      plugin: 'context-mode',
    });

    expect(config.plugin).toEqual(['context-mode', './plugins/claude-mem.js']);
  });

  it('removes only claude-mem from plugin entries', () => {
    const config = removeOpenCodePluginReference({
      plugin: ['context-mode', './plugins/claude-mem.js'],
      provider: { openai: { models: {} } },
    });

    expect(config.plugin).toEqual(['context-mode']);
    expect(config.provider).toEqual({ openai: { models: {} } });
  });

  it('creates opencode.json when missing', () => {
    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(0);
    expect(existsSync(getOpenCodeConfigPath())).toBe(true);

    const config = JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8'));
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.plugin).toEqual(['./plugins/claude-mem.js']);
    expect(config.mcp?.['claude-mem']).toMatchObject({ type: 'local' });
    const mcpCommand = config.mcp['claude-mem'].command as string[];
    expect(mcpCommand[0]).toBe(process.execPath);
    expect(mcpCommand[1]).toBe(getMcpServerAbsolutePath());
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
    expect(config.mcp?.['claude-mem']).toMatchObject({ type: 'local' });
  });

  it('removes the plugin reference from opencode.json during deregistration', () => {
    writeFileSync(getOpenCodeConfigPath(), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['context-mode', './plugins/claude-mem.js'],
      mcp: { 'claude-mem': { type: 'local', command: ['node', '/x/mcp-server.cjs'] } },
    }), 'utf-8');

    const result = deregisterOpenCodePluginFromConfig();

    expect(result).toBe(0);
    const config = JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8'));
    expect(config.plugin).toEqual(['context-mode']);
    expect('mcp' in config).toBe(false);
  });

  it('adds the claude-mem MCP entry while preserving other MCP servers', () => {
    const config = addOpenCodeMcpReference({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['./plugins/claude-mem.js'],
      mcp: { context7: { enabled: true } },
    });

    expect(config.mcp).toMatchObject({ context7: { enabled: true } });
    expect(config.mcp?.['claude-mem']).toMatchObject({ type: 'local' });
    const mcpCommand = (config.mcp?.['claude-mem'] as { command: string[] }).command;
    expect(mcpCommand[0]).toBe(process.execPath);
    expect(mcpCommand[1]).toBe(getMcpServerAbsolutePath());
  });

  it('is idempotent for an already-registered claude-mem MCP entry', () => {
    const config: { $schema: string; plugin: string[]; mcp: Record<string, unknown> } = {
      $schema: 'https://opencode.ai/config.json',
      plugin: ['./plugins/claude-mem.js'],
      mcp: {
        'claude-mem': { type: 'local', command: [process.execPath, getMcpServerAbsolutePath()!] },
        context7: { enabled: true },
      },
    };

    expect(addOpenCodeMcpReference(config)).toBe(config);
  });

  it('removes only the claude-mem MCP entry, preserving other servers', () => {
    const config = removeOpenCodeMcpReference({
      plugin: ['./plugins/claude-mem.js'],
      mcp: {
        'claude-mem': { type: 'local', command: ['node', '/x/mcp-server.cjs'] },
        context7: { enabled: true },
      },
    });

    expect(config.mcp).toEqual({ context7: { enabled: true } });
  });

  it('drops the mcp block when it becomes empty', () => {
    const config = removeOpenCodeMcpReference({
      plugin: ['./plugins/claude-mem.js'],
      mcp: { 'claude-mem': { type: 'local', command: ['node', '/x/mcp-server.cjs'] } },
    });

    expect('mcp' in config).toBe(false);
  });
});

describe('OpenCode MCP entry host contract (plan-23 step 1)', () => {
  it('emits an entry that satisfies the checked-in OpenCode schema fixture', () => {
    const output = addOpenCodeMcpReference({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['./plugins/claude-mem.js'],
    });

    const entry = (output.mcp as Record<string, unknown>)[opencodeMcpFixture.claude_mem_entry.key] as
      | Record<string, unknown>
      | undefined;
    expect(entry, 'installer must emit the claude-mem MCP entry').toBeTruthy();

    const schema = opencodeMcpFixture.entry;

    // Only host-accepted keys may be present.
    for (const key of Object.keys(entry!)) {
      expect(schema.allowed_keys).toContain(key);
    }

    // Required keys must be present.
    for (const key of schema.required_keys) {
      expect(Object.keys(entry!)).toContain(key);
    }

    // Transport is the fixture's canonical local-server value.
    expect(entry!.type).toBe(schema.type.claude_mem_value);
    expect(schema.type.accepted_values).toContain(entry!.type);

    // command is an argv array with at least the node + script pair, both absolute.
    const command = entry!.command as string[];
    expect(Array.isArray(command)).toBe(true);
    expect(command.length).toBeGreaterThanOrEqual(schema.command.min_items);
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toBe(getMcpServerAbsolutePath());
  });
});
