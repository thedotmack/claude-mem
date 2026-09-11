import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addOpenCodePluginReference,
  deregisterOpenCodePluginFromConfig,
  getOpenCodeConfigPath,
  getOpenCodeAgentsMdPath,
  installOpenCodeIntegration,
  removeOpenCodePluginReference,
  registerOpenCodePluginInConfig,
} from '../../src/services/integrations/OpenCodeInstaller.js';
import { logger } from '../../src/utils/logger.js';

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

  it('removes the plugin reference from opencode.json during deregistration', () => {
    writeFileSync(getOpenCodeConfigPath(), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['context-mode', './plugins/claude-mem.js'],
    }), 'utf-8');

    const result = deregisterOpenCodePluginFromConfig();

    expect(result).toBe(0);
    const config = JSON.parse(readFileSync(getOpenCodeConfigPath(), 'utf-8'));
    expect(config.plugin).toEqual(['context-mode']);
  });
});

describe('OpenCode installer context retrieval', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;
  let previousClaudeConfigDir: string | undefined;
  let previousFetch: typeof globalThis.fetch;
  let previousDebug: typeof logger.debug;
  let previousInfo: typeof logger.info;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const marketplacePluginPath = join(tempDir, 'plugins', 'marketplaces', 'thedotmack', 'dist', 'opencode-plugin', 'index.js');
    mkdirSync(join(marketplacePluginPath, '..'), { recursive: true });
    writeFileSync(marketplacePluginPath, 'export default {}\n', 'utf-8');

    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    previousFetch = globalThis.fetch;
    previousDebug = logger.debug;
    previousInfo = logger.info;
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    logger.debug = previousDebug;
    logger.info = previousInfo;
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function stubWorkerContext(body: unknown, diagnostics: string[]): void {
    logger.debug = (_component, message) => diagnostics.push(message);
    logger.info = () => {};
    globalThis.fetch = async (input) => ({
      ok: true,
      text: async () => input.toString().includes('/api/context/inject') ? body : '',
    }) as Response;
  }

  it('rejects a wrapped object body without coercion or unavailable-worker diagnostics', async () => {
    const diagnostics: string[] = [];
    const wrappedBody = Object.freeze({ wrapped: true, value: '# Existing memory' });
    stubWorkerContext(wrappedBody, diagnostics);

    expect(await installOpenCodeIntegration()).toBe(0);

    const agentsMd = readFileSync(getOpenCodeAgentsMdPath(), 'utf-8');
    expect(agentsMd).toContain('*No context yet. Complete your first session and context will appear here.*');
    expect(agentsMd).not.toContain('# Existing memory');
    expect(diagnostics).toEqual([]);
  });

  it('preserves valid existing context exactly', async () => {
    const diagnostics: string[] = [];
    const context = '  # Existing memory  ';
    stubWorkerContext(context, diagnostics);

    expect(await installOpenCodeIntegration()).toBe(0);

    expect(readFileSync(getOpenCodeAgentsMdPath(), 'utf-8')).toContain(context);
    expect(diagnostics).toEqual([]);
  });

  it('uses placeholder context for blank strings', async () => {
    const diagnostics: string[] = [];
    stubWorkerContext(' \t\n ', diagnostics);

    expect(await installOpenCodeIntegration()).toBe(0);

    expect(readFileSync(getOpenCodeAgentsMdPath(), 'utf-8')).toContain('*No context yet. Complete your first session and context will appear here.*');
    expect(diagnostics).toEqual([]);
  });
});
