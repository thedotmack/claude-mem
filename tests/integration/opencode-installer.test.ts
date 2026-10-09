import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addOpenCodeMcpReference,
  addOpenCodePluginReference,
  deregisterOpenCodePluginFromConfig,
  detectOpenCodeVersion,
  getInstalledPluginPath,
  getOpenCodeAgentsMdPath,
  getOpenCodeConfigPath,
  installOpenCodeIntegration,
  installOpenCodePlugin,
  OPENCODE_OLD_CONTEXT_BLOCK_LEFT,
  parseOpenCodeVersion,
  registerOpenCodePluginInConfig,
  removeOpenCodeMcpReference,
  removeOpenCodePluginReference,
} from '../../src/services/integrations/OpenCodeInstaller.js';
import { getMcpServerAbsolutePath } from '../../src/services/integrations/install-paths.js';
import { logger } from '../../src/utils/logger.js';

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

// R5-9: OpenCode loads ~/.config/opencode/AGENTS.md for every project, so a
// memory block there is one stale block in all of them (it was read from the
// `opencode` key, which nothing has written since #3803). The plugin injects
// each project's own context into the system prompt instead.
describe('OpenCode installer leaves the global AGENTS.md to the user', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;
  let previousClaudeConfigDir: string | undefined;
  let previousFetch: typeof globalThis.fetch;
  let previousInfo: typeof logger.info;
  let requestedUrls: string[];

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const marketplacePluginPath = join(tempDir, 'plugins', 'marketplaces', 'thedotmack', 'dist', 'opencode-plugin', 'index.js');
    mkdirSync(join(marketplacePluginPath, '..'), { recursive: true });
    writeFileSync(marketplacePluginPath, 'export default {}\n', 'utf-8');

    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousFetch = globalThis.fetch;
    previousInfo = logger.info;
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    logger.info = () => {};
    requestedUrls = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response('# memory from the opencode key', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    logger.info = previousInfo;
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes no memory into the global AGENTS.md and never calls the worker', async () => {
    expect(await installOpenCodeIntegration()).toBe(0);

    expect(existsSync(getOpenCodeAgentsMdPath())).toBe(false);
    expect(requestedUrls).toEqual([]);
  });

  it('reports an old block it could not remove instead of a clean success', async () => {
    // A path that cannot be read as a file stands in for an unreadable AGENTS.md.
    mkdirSync(getOpenCodeAgentsMdPath());

    expect(await installOpenCodeIntegration()).toBe(OPENCODE_OLD_CONTEXT_BLOCK_LEFT);
  });

  it("strips the block an older install wrote and keeps the user's own instructions", async () => {
    writeFileSync(
      getOpenCodeAgentsMdPath(),
      '# My rules\n\nAlways run the tests.\n\n<claude-mem-context>\n# Memory Context from Past Sessions\n\nstale memory\n</claude-mem-context>\n',
      'utf-8',
    );

    expect(await installOpenCodeIntegration()).toBe(0);

    const agentsMd = readFileSync(getOpenCodeAgentsMdPath(), 'utf-8');
    expect(agentsMd).toContain('# My rules');
    expect(agentsMd).toContain('Always run the tests.');
    expect(agentsMd).not.toContain('claude-mem-context');
    expect(agentsMd).not.toContain('stale memory');
  });

  it('strips only the old block when the user text mentions a closing tag before it', async () => {
    writeFileSync(
      getOpenCodeAgentsMdPath(),
      '# My rules\n\nNever edit the </claude-mem-context> tag by hand.\n\n<claude-mem-context>\nstale memory\n</claude-mem-context>\n',
      'utf-8',
    );

    expect(await installOpenCodeIntegration()).toBe(0);

    expect(readFileSync(getOpenCodeAgentsMdPath(), 'utf-8'))
      .toBe('# My rules\n\nNever edit the </claude-mem-context> tag by hand.\n');
  });

  it('removes the file when the old block was all it held', async () => {
    writeFileSync(
      getOpenCodeAgentsMdPath(),
      '# Claude-Mem Memory Context\n\n<claude-mem-context>\n*No context yet. Complete your first session and context will appear here.*\n</claude-mem-context>\n',
      'utf-8',
    );

    expect(await installOpenCodeIntegration()).toBe(0);

    expect(existsSync(getOpenCodeAgentsMdPath())).toBe(false);
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

// OpenCode 2 loads plugins/claude-mem.js from its plugin directory itself and
// drops a configured plugin path that is a file, warning "configured plugin
// path must be a directory" on every start (#4578). OpenCode 1 keeps the
// `plugin` entry every install has written.
describe('OpenCode installer per OpenCode version', () => {
  let tempDir: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-version-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const bundle = join(tempDir, 'claude', 'plugins', 'marketplaces', 'thedotmack', 'dist', 'opencode-plugin', 'index.js');
    mkdirSync(join(bundle, '..'), { recursive: true });
    writeFileSync(bundle, 'export default { id: "claude-mem" };\n', 'utf-8');
    mkdirSync(join(tempDir, 'opencode'), { recursive: true });
    previous = {
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      PATH: process.env.PATH,
    };
    process.env.OPENCODE_CONFIG_DIR = join(tempDir, 'opencode');
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  const readConfig = () => JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8'));

  it('reads the version lines OpenCode prints', () => {
    expect(parseOpenCodeVersion('1.18.35\n')).toEqual([1, 18, 35]);
    expect(parseOpenCodeVersion('2.0.22\n')).toEqual([2, 0, 22]);
    // 2.0.23 prefixes the version (seen on a live host in #4519).
    expect(parseOpenCodeVersion('opencode v2.0.23\n')).toEqual([2, 0, 23]);
    expect(parseOpenCodeVersion('An update is available\nopencode2 2.0.25\n')).toEqual([2, 0, 25]);
    expect(parseOpenCodeVersion('command not found')).toBeNull();
  });

  it('installs for OpenCode 2 without a plugin entry and removes the one an earlier install wrote', () => {
    writeFileSync(getOpenCodeConfigPath(), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['context-mode', './plugins/claude-mem.js'],
      plugins: ['./plugins/claude-mem.js', 'another-v2-plugin'],
    }), 'utf-8');

    expect(installOpenCodePlugin([2, 0, 23])).not.toBe(1);

    expect(readFileSync(getInstalledPluginPath(), 'utf-8')).toContain('claude-mem');
    const config = readConfig();
    expect(config.plugin).toEqual(['context-mode']);
    expect(config.plugins).toEqual(['another-v2-plugin']);
  });

  it('writes no plugin keys into a new OpenCode 2 config', () => {
    expect(registerOpenCodePluginInConfig(2)).not.toBe(1);

    const config = readConfig();
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toBeUndefined();
  });

  it('keeps the plugin entry for OpenCode 1, and when no OpenCode CLI answers', () => {
    expect(installOpenCodePlugin([1, 18, 35])).not.toBe(1);
    expect(readConfig().plugin).toEqual(['./plugins/claude-mem.js']);

    rmSync(getOpenCodeConfigPath());
    expect(installOpenCodePlugin(null)).not.toBe(1);
    expect(readConfig().plugin).toEqual(['./plugins/claude-mem.js']);
  });

  it('warns that OpenCode older than 1.3.4 cannot load the plugin', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      expect(installOpenCodePlugin([1, 3, 3])).not.toBe(1);
      expect(installOpenCodePlugin([1, 3, 4])).not.toBe(1);
    } finally {
      console.warn = originalWarn;
    }
    const floorWarnings = warnings.filter((warning) => warning.includes('needs OpenCode 1.3.4 or later'));
    expect(floorWarnings).toHaveLength(1);
    expect(floorWarnings[0]).toContain('OpenCode 1.3.3');
  });

  it.skipIf(process.platform === 'win32')('detects the newest OpenCode CLI on PATH', () => {
    const bin = join(tempDir, 'bin');
    mkdirSync(bin);
    const fakeCli = (name: string, output: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${output}"\n`, 'utf-8');
      chmodSync(join(bin, name), 0o755);
    };
    process.env.PATH = bin;

    expect(detectOpenCodeVersion()).toBeNull();

    fakeCli('opencode', 'opencode v2.0.23');
    expect(detectOpenCodeVersion()).toEqual([2, 0, 23]);

    // OpenCode 2 installs `opencode2` beside it; the newer CLI decides.
    fakeCli('opencode', '1.18.35');
    fakeCli('opencode2', '2.0.22');
    expect(detectOpenCodeVersion()).toEqual([2, 0, 22]);
  });
});
