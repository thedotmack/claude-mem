import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { MARKETPLACE_ROOT } from '../src/shared/paths.js';
import {
  findHermesPluginSource,
  hermesHome,
  hermesPluginDirectory,
  installHermesIntegration,
  uninstallHermesIntegration,
} from '../src/services/integrations/HermesInstaller.js';
import {
  HermesConfigShapeError,
  putMcpServer,
  removeMcpServer,
  restoreMemoryProvider,
  selectMemoryProvider,
} from '../src/services/integrations/hermes-config-yaml.js';

const parseYaml = (text: string) => (Bun as unknown as { YAML: { parse(text: string): any } }).YAML.parse(text);

// A config shaped like the one Hermes writes, with the user's own comments.
const HERMES_CONFIG = `# Hermes configuration
model:
  default: some-model
memory:
  memory_enabled: true   # built-in memory stays on
  user_profile_enabled: true
  memory_char_limit: 2200
plugins:
  enabled:
  - herdr-agent-state
mcp_servers:
  other-tool:
    command: node
    args:
    - /opt/other/server.js
    enabled: true

platform_toolsets:
  cli:
  - hermes-cli
`;

let home: string;
let saved: Record<string, string | undefined>;
let logs: ReturnType<typeof spyOn>[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-mem-hermes-home-'));
  saved = { HERMES_HOME: process.env.HERMES_HOME, CLAUDE_MEM_DEV_HOOK_SOURCE: process.env.CLAUDE_MEM_DEV_HOOK_SOURCE };
  process.env.HERMES_HOME = home;
  // The test runs from the repository root, where hermes/claude-mem/ is the source.
  process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = '1';
  logs = [spyOn(console, 'log').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {})];
});

afterEach(() => {
  for (const spy of logs) spy.mockRestore();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, 'config.yaml');
const config = () => readFileSync(configPath(), 'utf-8');

describe('Hermes installer', () => {
  it.each([
    ['darwin', '/unused', 'unix'],
    ['linux', '/unused', 'unix'],
    ['win32', 'local-app-data', 'local'],
    ['win32', undefined, 'fallback'],
    ['win32', '   ', 'fallback'],
  ] as const)('uses the native Hermes default home on %s with LOCALAPPDATA=%s', (platform, localAppData, expected) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const previous = process.env.LOCALAPPDATA;
    delete process.env.HERMES_HOME;
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData === 'local-app-data' ? join(home, 'LocalAppData') : localAppData;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const target = expected === 'unix' ? join(homedir(), '.hermes')
        : expected === 'local' ? join(home, 'LocalAppData', 'hermes')
        : join(homedir(), 'AppData', 'Local', 'hermes');
      expect(hermesHome()).toBe(target);
      expect(hermesPluginDirectory()).toBe(join(target, 'plugins', 'claude-mem'));
      process.env.HERMES_HOME = home;
      expect(hermesHome()).toBe(home);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
  });

  it('finds the provider shipped in hermes/claude-mem', () => {
    // The installed marketplace copy wins over the checkout when both exist, so
    // on a machine with claude-mem installed either root is a correct answer.
    expect([
      join(process.cwd(), 'hermes', 'claude-mem'),
      join(MARKETPLACE_ROOT, 'hermes', 'claude-mem'),
    ]).toContain(findHermesPluginSource());
  });

  it('installs the plugin, selects it and adds the MCP server, then uninstall puts the config back byte for byte', () => {
    writeFileSync(configPath(), HERMES_CONFIG);
    expect(installHermesIntegration()).toBe(0);

    const plugin = hermesPluginDirectory();
    expect(plugin).toBe(join(home, 'plugins', 'claude-mem'));
    for (const name of ['__init__.py', 'client.py', 'plugin.yaml', 'README.md']) {
      expect(readFileSync(join(plugin, name))).toEqual(readFileSync(join(process.cwd(), 'hermes', 'claude-mem', name)));
    }

    const parsed = parseYaml(config());
    expect(parsed.memory).toEqual({ provider: 'claude-mem', memory_enabled: true, user_profile_enabled: true, memory_char_limit: 2200 });
    expect(parsed.mcp_servers['other-tool']).toEqual({ command: 'node', args: ['/opt/other/server.js'], enabled: true });
    expect(parsed.mcp_servers['claude-mem'].command).toBe(process.execPath);
    expect(parsed.mcp_servers['claude-mem'].args).toHaveLength(1);
    expect(parsed.mcp_servers['claude-mem'].args[0]).toEndWith(join('plugin', 'scripts', 'mcp-server.cjs'));
    expect(existsSync(parsed.mcp_servers['claude-mem'].args[0])).toBe(true);
    expect(parsed.mcp_servers['claude-mem'].enabled).toBe(true);
    expect(parsed.plugins).toEqual({ enabled: ['herdr-agent-state'] });
    // Every line the installer does not own is untouched, comments included.
    for (const line of HERMES_CONFIG.split('\n')) expect(config()).toContain(line);

    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(HERMES_CONFIG);
    expect(existsSync(plugin)).toBe(false);
  });

  it('remembers the provider it replaced and puts it back', () => {
    const original = HERMES_CONFIG.replace('  memory_enabled: true', '  provider: "another-provider"  # mine\n  memory_enabled: true');
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(0);
    expect(parseYaml(config()).memory.provider).toBe('claude-mem');
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(original);
  });

  it('keeps comments on existing block headers through install and uninstall', () => {
    const original = HERMES_CONFIG.replace('memory:\n', 'memory: # shared settings\n')
      .replace('mcp_servers:\n', 'mcp_servers: # shared tools\n')
      .replace('  memory_enabled: true', '  provider: another-provider\n  memory_enabled: true');
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(0);
    expect(config()).toContain('memory: # shared settings\n');
    expect(config()).toContain('mcp_servers: # shared tools\n');
    expect(parseYaml(config()).memory.provider).toBe('claude-mem');
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(original);
  });

  it.each(['', '{}', 'null', '~'])('keeps commented empty mappings through install and uninstall: %s', (value) => {
    const inline = value ? ' ' + value : '';
    const original = `memory:${inline} # shared settings\nmcp_servers:${inline} # shared tools\n`;
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(0);
    expect(config()).toContain('memory: # shared settings\n');
    expect(config()).toContain('mcp_servers: # shared tools\n');
    expect(parseYaml(config()).memory).toEqual({ provider: 'claude-mem' });
    expect(parseYaml(config()).mcp_servers['claude-mem'].enabled).toBe(true);
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(original);
  });

  it.each(['...\n', '... # end\n'])('inserts missing blocks before a document-end marker: %s', (ending) => {
    const original = 'model:\n  default: some-model\n' + ending;
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(0);
    expect(config()).toEndWith(ending);
    const parsed = parseYaml(config());
    expect(parsed.model).toEqual({ default: 'some-model' });
    expect(parsed.memory).toEqual({ provider: 'claude-mem' });
    expect(parsed.mcp_servers['claude-mem'].enabled).toBe(true);
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(original);
  });

  it('installs twice without stacking changes, and the second receipt still restores the original', () => {
    const original = HERMES_CONFIG.replace('  memory_enabled: true', '  provider: another-provider\n  memory_enabled: true');
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(0);
    const once = config();
    expect(installHermesIntegration()).toBe(0);
    expect(config()).toBe(once);
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(original);
  });

  it('leaves a provider the user picked after install, and an MCP entry it did not add', () => {
    const handWritten = HERMES_CONFIG.replace('mcp_servers:\n', 'mcp_servers:\n  claude-mem:\n    command: my-own-node\n    args: []\n');
    writeFileSync(configPath(), handWritten);
    expect(installHermesIntegration()).toBe(0);
    expect(parseYaml(config()).mcp_servers['claude-mem']).toEqual({ command: 'my-own-node', args: [] });
    writeFileSync(configPath(), config().replace('provider: claude-mem', 'provider: another-provider'));
    const userChoice = config();
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(userChoice);
  });

  it.each([
    ['command', false], ['args', false], ['command', true], ['args', true],
  ] as const)('preserves user-edited MCP %s through uninstall (reinstall: %s)', (field, reinstall) => {
    writeFileSync(configPath(), HERMES_CONFIG);
    expect(installHermesIntegration()).toBe(0);
    const installed = config();
    const entry = parseYaml(installed).mcp_servers['claude-mem'];
    const before = field === 'command' ? entry.command : entry.args[0];
    const after = field === 'command' ? '/custom/node' : '/custom/server.cjs';
    const edited = installed.replace(JSON.stringify(before), JSON.stringify(after));
    expect(edited).not.toBe(installed);
    writeFileSync(configPath(), edited);
    if (reinstall) {
      expect(installHermesIntegration()).toBe(0);
      expect(config()).toBe(edited);
    }
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(edited.replace('  provider: claude-mem\n', ''));
  });

  it('does not reclaim an MCP entry after a user edit relinquishes ownership', () => {
    writeFileSync(configPath(), HERMES_CONFIG);
    expect(installHermesIntegration()).toBe(0);
    const installed = config();
    const command = parseYaml(installed).mcp_servers['claude-mem'].command;
    writeFileSync(configPath(), installed.replace(JSON.stringify(command), '"/custom/node"'));
    expect(installHermesIntegration()).toBe(0);
    writeFileSync(configPath(), installed);
    expect(installHermesIntegration()).toBe(0);
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(installed.replace('  provider: claude-mem\n', ''));
  });

  it('creates config.yaml when Hermes has none and removes it again on uninstall', () => {
    expect(installHermesIntegration()).toBe(0);
    const parsed = parseYaml(config());
    expect(parsed.memory).toEqual({ provider: 'claude-mem' });
    expect(Object.keys(parsed.mcp_servers)).toEqual(['claude-mem']);
    expect(uninstallHermesIntegration()).toBe(0);
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(hermesPluginDirectory())).toBe(false);
  });

  it('turns empty flow mappings into blocks and back', () => {
    const original = 'memory: {}\nmcp_servers: {}\n';
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(0);
    expect(parseYaml(config()).memory).toEqual({ provider: 'claude-mem' });
    expect(uninstallHermesIntegration()).toBe(0);
    expect(config()).toBe(original);
  });

  it('keeps the permissions of config.yaml', () => {
    writeFileSync(configPath(), HERMES_CONFIG, { mode: 0o600 });
    chmodSync(configPath(), 0o600);
    // Windows chmod represents the writable bit, not POSIX owner/group modes.
    const originalMode = statSync(configPath()).mode & 0o777;
    if (process.platform !== 'win32') expect(originalMode).toBe(0o600);
    expect(installHermesIntegration()).toBe(0);
    expect(statSync(configPath()).mode & 0o777).toBe(originalMode);
    expect(uninstallHermesIntegration()).toBe(0);
    expect(statSync(configPath()).mode & 0o777).toBe(originalMode);
  });

  it('refuses a config shape it cannot edit and changes nothing', () => {
    const original = 'memory: {provider: another-provider}\n';
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(1);
    expect(config()).toBe(original);
    expect(existsSync(hermesPluginDirectory())).toBe(false);
  });

  it.each([
    'memory:\n  provider: |\n    another-provider\n',
    'memory:\n  provider: >\n    another-provider\n',
    'memory:\n  provider:\n    name: another-provider\n',
    'memory:\n  provider: "another\n    provider"\n',
    'memory:\n  provider: first\n  provider: second\n',
    'memory:\n  provider: first\nmemory:\n  provider: second\n',
    'memory :\n  provider: another-provider\n',
    'mcp_servers:\n  claude-mem:\n    command: first\n  "claude-mem":\n    command: second\n',
  ])('refuses ambiguous or multiline config without changing it: %s', (original) => {
    writeFileSync(configPath(), original);
    expect(installHermesIntegration()).toBe(1);
    expect(config()).toBe(original);
    expect(existsSync(hermesPluginDirectory())).toBe(false);
  });

  it('uninstall keeps files in the plugin folder that it did not install', () => {
    expect(installHermesIntegration()).toBe(0);
    const plugin = hermesPluginDirectory();
    mkdirSync(join(plugin, '__pycache__'));
    writeFileSync(join(plugin, '__pycache__', 'client.cpython-312.pyc'), 'compiled');
    writeFileSync(join(plugin, 'notes.txt'), 'mine');
    expect(uninstallHermesIntegration()).toBe(0);
    expect(readdirSync(plugin)).toEqual(['notes.txt']);
  });

  it('uninstall with nothing installed is a no-op', () => {
    expect(uninstallHermesIntegration()).toBe(0);
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('Hermes config edits', () => {
  it('keeps CRLF line endings and the indent the file already uses', () => {
    const original = 'memory:\r\n    memory_enabled: true\r\n';
    const { text, receipt } = selectMemoryProvider(original, 'claude-mem');
    expect(text).toBe('memory:\r\n    provider: claude-mem\r\n    memory_enabled: true\r\n');
    expect(restoreMemoryProvider(text, 'claude-mem', receipt)).toBe(original);
  });

  it('replaces only its own MCP entry, whichever position it holds', () => {
    const original = 'mcp_servers:\n  a:\n    command: x\n  claude-mem:\n    command: old\n    args:\n    - one\n  z:\n    command: y\n';
    const { text, receipt } = putMcpServer(original, 'claude-mem', { command: '/bin/node', args: ['/p/mcp-server.cjs'] });
    const parsed = parseYaml(text);
    expect(parsed.mcp_servers.a).toEqual({ command: 'x' });
    expect(parsed.mcp_servers.z).toEqual({ command: 'y' });
    expect(parsed.mcp_servers['claude-mem']).toEqual({ command: '/bin/node', args: ['/p/mcp-server.cjs'], enabled: true });
    const removed = removeMcpServer(text, 'claude-mem', receipt);
    expect(parseYaml(removed).mcp_servers).toEqual({ a: { command: 'x' }, z: { command: 'y' } });
  });

  it('quotes paths so any character survives', () => {
    const awkward = 'C:\\Users\\a b\\#1: "x"';
    const { text } = putMcpServer('', 'claude-mem', { command: awkward, args: [awkward], env: { CLAUDE_MEM_DATA_DIR: awkward } });
    expect(parseYaml(text).mcp_servers['claude-mem']).toEqual({ command: awkward, args: [awkward], env: { CLAUDE_MEM_DATA_DIR: awkward }, enabled: true });
  });

  it('throws on inline values instead of guessing', () => {
    expect(() => selectMemoryProvider('memory: {provider: x}\n', 'claude-mem')).toThrow(HermesConfigShapeError);
    expect(() => putMcpServer('mcp_servers: [a]\n', 'claude-mem', { command: 'n', args: [] })).toThrow(HermesConfigShapeError);
    expect(() => putMcpServer('"mcp_servers":\n  a:\n    command: x\n', 'claude-mem', { command: 'n', args: [] })).toThrow(HermesConfigShapeError);
    expect(() => selectMemoryProvider("'memory':\n  memory_enabled: true\n", 'claude-mem')).toThrow(HermesConfigShapeError);
  });
});
