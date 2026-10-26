import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { mergeGooseYamlConfig, uninstallGooseMcpIntegration } from '../../src/services/integrations/McpIntegrations.js';

// Goose starts MCP servers only from the top-level `extensions` mapping of
// ~/.config/goose/config.yaml (stdio entries with `cmd` and `args`); a
// `mcpServers` block there is never read.
describe('Goose install registers claude-mem as a Goose extension', () => {
  let tmp: string;
  let configPath: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'goose-config-'));
    configPath = path.join(tmp, 'config.yaml');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  const read = () => Bun.YAML.parse(readFileSync(configPath, 'utf-8')) as Record<string, any>;
  const claudeMemExtension = (serverPath: string) => ({
    enabled: true,
    type: 'stdio',
    name: 'claude-mem',
    cmd: process.execPath,
    args: [serverPath],
    timeout: 300,
  });
  const developer = { bundled: true, enabled: true, name: 'developer', timeout: 300, type: 'builtin' };

  it('creates a config whose extensions include claude-mem', () => {
    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(read().extensions).toEqual({ 'claude-mem': claudeMemExtension('/plugin/scripts/mcp-server.cjs') });
  });

  it('adds claude-mem to the existing extensions and keeps the rest of the file', () => {
    writeFileSync(configPath, [
      'GOOSE_PROVIDER: anthropic',
      'extensions:',
      '  developer:',
      '    bundled: true',
      '    enabled: true',
      '    name: developer',
      '    timeout: 300',
      '    type: builtin',
      'GOOSE_MODE: smart_approve',
      // Left by earlier installs, which wrote here; Goose never reads it.
      'mcpServers:',
      '  claude-mem:',
      '    command: node',
      '    args:',
      '      - /old/mcp-server.cjs',
      '',
    ].join('\n'));

    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    const config = read();
    expect(config.extensions).toEqual({
      'claude-mem': claudeMemExtension('/plugin/scripts/mcp-server.cjs'),
      developer,
    });
    expect(config.GOOSE_PROVIDER).toBe('anthropic');
    expect(config.GOOSE_MODE).toBe('smart_approve');
  });

  it('replaces its own extension on re-install', () => {
    mergeGooseYamlConfig(configPath, '/old/mcp-server.cjs');
    mergeGooseYamlConfig(configPath, '/new/mcp-server.cjs');

    expect(readFileSync(configPath, 'utf-8').match(/claude-mem:/g)).toHaveLength(1);
    expect(read().extensions['claude-mem']).toEqual(claudeMemExtension('/new/mcp-server.cjs'));
  });

  it('replaces an extension written with a commented key, comments and blank lines', () => {
    writeFileSync(configPath, [
      'extensions:',
      '  claude-mem: # memory tools',
      '    enabled: true',
      '',
      '    # pinned by hand',
      '    cmd: /old/node',
      '    args:',
      '      - /old/mcp-server.cjs',
      '  developer:',
      '    bundled: true',
      '    enabled: true',
      '    name: developer',
      '    timeout: 300',
      '    type: builtin',
      '',
    ].join('\n'));

    mergeGooseYamlConfig(configPath, '/new/mcp-server.cjs');

    const content = readFileSync(configPath, 'utf-8');
    expect(content.match(/claude-mem:|cmd:/g)).toEqual(['claude-mem:', 'cmd:']);
    expect(read().extensions).toEqual({ 'claude-mem': claudeMemExtension('/new/mcp-server.cjs'), developer });
  });

  it('finds an extensions key written in quotes', () => {
    writeFileSync(configPath, '"extensions":\n  developer:\n    bundled: true\n    enabled: true\n    name: developer\n    timeout: 300\n    type: builtin\n');

    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(readFileSync(configPath, 'utf-8').match(/extensions/g)).toHaveLength(1);
    expect(read().extensions).toEqual({
      'claude-mem': claudeMemExtension('/plugin/scripts/mcp-server.cjs'),
      developer,
    });
  });

  it('appends an extensions mapping to a config without one', () => {
    writeFileSync(configPath, 'GOOSE_PROVIDER: ollama\n');

    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(read()).toEqual({
      GOOSE_PROVIDER: 'ollama',
      extensions: { 'claude-mem': claudeMemExtension('/plugin/scripts/mcp-server.cjs') },
    });
  });

  it('finds the extensions mapping of a config saved with a byte order mark', () => {
    writeFileSync(configPath, '\uFEFF' + 'extensions:\n  developer:\n    bundled: true\n    enabled: true\n    name: developer\n    timeout: 300\n    type: builtin\n');

    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(read().extensions).toEqual({
      'claude-mem': claudeMemExtension('/plugin/scripts/mcp-server.cjs'),
      developer,
    });
  });

  it('indents the extension like the entries already there', () => {
    writeFileSync(configPath, [
      'extensions:',
      '    developer:',
      '        bundled: true',
      '        enabled: true',
      '        name: developer',
      '        timeout: 300',
      '        type: builtin',
      '',
    ].join('\n'));

    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(read().extensions).toEqual({
      'claude-mem': claudeMemExtension('/plugin/scripts/mcp-server.cjs'),
      developer,
    });
  });

  it('refuses to rewrite an extensions value written inline', () => {
    writeFileSync(configPath, 'extensions: {}\n');

    expect(() => mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs')).toThrow(/extensions/);
    expect(readFileSync(configPath, 'utf-8')).toBe('extensions: {}\n');
  });
});

describe('Goose uninstall removes the claude-mem extension', () => {
  let tmp: string;
  let configPath: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'goose-uninstall-'));
    configPath = path.join(tmp, 'config.yaml');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('restores a config with other extensions byte for byte', () => {
    const original = [
      'GOOSE_PROVIDER: anthropic',
      'extensions:',
      '  developer:',
      '    bundled: true',
      '    enabled: true',
      '    name: developer',
      '    timeout: 300',
      '    type: builtin',
      'GOOSE_MODE: smart_approve',
      '',
    ].join('\n');
    writeFileSync(configPath, original);
    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(uninstallGooseMcpIntegration(configPath)).toBe(0);

    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect((Bun.YAML.parse(readFileSync(configPath, 'utf-8')) as any).extensions['claude-mem']).toBeUndefined();
  });

  it('drops the extensions key it created when claude-mem was the only entry', () => {
    writeFileSync(configPath, 'GOOSE_PROVIDER: ollama\n');
    mergeGooseYamlConfig(configPath, '/plugin/scripts/mcp-server.cjs');

    expect(uninstallGooseMcpIntegration(configPath)).toBe(0);

    expect(Bun.YAML.parse(readFileSync(configPath, 'utf-8'))).toEqual({ GOOSE_PROVIDER: 'ollama' });
  });

  it('removes an entry that sits between other extensions', () => {
    writeFileSync(configPath, [
      'extensions:',
      '  alpha:',
      '    enabled: true',
      '  claude-mem:',
      '    enabled: true',
      '    cmd: node',
      '  omega:',
      '    enabled: false',
      '',
    ].join('\n'));

    expect(uninstallGooseMcpIntegration(configPath)).toBe(0);

    expect((Bun.YAML.parse(readFileSync(configPath, 'utf-8')) as any).extensions).toEqual({
      alpha: { enabled: true },
      omega: { enabled: false },
    });
  });

  it('leaves the file alone when there is nothing to remove', () => {
    const original = 'extensions:\n  developer:\n    enabled: true\n';
    writeFileSync(configPath, original);

    expect(uninstallGooseMcpIntegration(configPath)).toBe(1);
    expect(uninstallGooseMcpIntegration(path.join(tmp, 'missing.yaml'))).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });
});
