import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertT3CodePluginLoading,
  discoverT3CodeProviders,
  installT3Code,
  t3CodeSettingsPath,
  t3CodeStatus,
  uninstallT3Code,
  type T3CodeProvider,
} from '../../src/services/integrations/T3CodeInstaller.js';
import { canonicalIntegrationId } from '../../src/shared/integration-id.js';

const temporary: string[] = [];
const repository = resolve(import.meta.dir, '../..');
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(settings: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-t3code-'));
  temporary.push(directory);
  const settingsPath = join(directory, 'userdata', 'settings.json');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { directory, settingsPath };
}

/** Real subprocess fixture: the native plugin managers write their own registries. */
function nativeCli(directory: string) {
  const command = join(directory, 'native cli');
  const log = join(directory, 'native-calls.jsonl');
  writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.T3_TEST_DRIVER === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, home, secret: process.env.T3_TEST_SECRET}) + '\\n');
if (args[0] === '--version') { console.log('codex-cli 0.156.1'); process.exit(0); }
if (process.env.FAIL_NATIVE_INSTALL === '1') { console.error('fixture plugin install failed'); process.exit(2); }
if (args[0] !== 'plugin') process.exit(3);
if (args[1] === 'marketplace' && args[2] === 'add') {
  const root = args[3];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/marketplace.json')));
  fs.mkdirSync(path.join(home, 'plugins'), {recursive: true});
  fs.writeFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify({[manifest.name]: {installLocation: root}}));
}
if (args[1] === 'install' || args[1] === 'enable') {
  const file = path.join(home, 'settings.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  if (args[1] === 'enable' && settings.enabledPlugins?.[args[2]] === true) { console.error('plugin is already enabled'); process.exit(1); }
  settings.enabledPlugins = {...settings.enabledPlugins, [args[2]]: true};
  fs.writeFileSync(file, JSON.stringify(settings));
}
`);
  chmodSync(command, 0o755);
  return { command, log };
}

describe('T3 Code provider discovery', () => {
  it('honors explicit instances, disabled flags, legacy homes, and nonsecret environment', () => {
    const { directory, settingsPath } = fixture({
      providers: { codex: { homePath: '/legacy-not-used' }, claudeAgent: { homePath: '/legacy-claude', binaryPath: '/tools/claude' } },
      providerInstances: {
        codex: { driver: 'codex', enabled: false, config: { homePath: '/disabled' } },
        work: { driver: 'codex', config: { homePath: '/codex-work', shadowHomePath: '/codex-shadow', binaryPath: '/tools/codex' }, environment: [
          { name: 'T3_TEST_SECRET', sensitive: true, value: 'never-forward' },
          { name: 'PATH', value: '/provider/bin', sensitive: false },
        ] },
        off: { driver: 'claudeAgent', config: { enabled: false } },
        future: { driver: 'custom-provider', config: { ownSetting: 'preserved' } },
      },
    });
    const before = readFileSync(settingsPath, 'utf-8');
    const providers = discoverT3CodeProviders(settingsPath, { PATH: '/base/bin' });
    expect(providers.map(provider => provider.id)).toEqual(['work', 'claudeAgent']);
    expect(providers[0].homePath).toBe(resolve('/codex-work'));
    expect(providers[0].environment.CODEX_HOME).toBe(resolve('/codex-work'));
    expect(providers[0].environment.PATH).toBe('/provider/bin');
    expect(providers[0].environment.T3_TEST_SECRET).toBeUndefined();
    expect(providers[1].command).toBe('/tools/claude');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    expect(existsSync(join(directory, 'statev2.sqlite'))).toBe(false);
  });

  it('resolves T3-managed Codex and installs into its shared source home', () => {
    const { directory, settingsPath } = fixture({ providerInstances: { personal: { driver: 'codex', config: { setupMode: 'managed', homePath: '/shared', shadowHomePath: '/shadow', binaryPath: '/ignored' } } } });
    const root = join(directory, 'tools', 'codex');
    const command = join(root, '0.156.1', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    mkdirSync(dirname(command), { recursive: true });
    writeFileSync(command, 'fixture');
    writeFileSync(join(root, 'active.json'), '{"version":"0.156.1"}');
    const [provider] = discoverT3CodeProviders(settingsPath, { CODEX_HOME: '/ambient-not-used' });
    expect(provider.command).toBe(command);
    expect(provider.homePath).toBe(resolve('/shared'));
  });

  it('uses a default Codex provider for an initialized empty document and accepts BOMs', () => {
    const { settingsPath } = fixture({});
    writeFileSync(settingsPath, '\uFEFF{}');
    expect(discoverT3CodeProviders(settingsPath)[0].id).toBe('codex');
  });

  it('resolves custom settings and CLI aliases', () => {
    expect(t3CodeSettingsPath({ environment: { T3CODE_HOME: '/custom-t3' } })).toBe(resolve('/custom-t3/userdata/settings.json'));
    expect(t3CodeSettingsPath({ settingsPath: '/chosen.json', environment: { CLAUDE_MEM_T3CODE_SETTINGS_PATH: '/other.json' } })).toBe(resolve('/chosen.json'));
    expect(canonicalIntegrationId('t3')).toBe('t3code');
    expect(canonicalIntegrationId('t3-code')).toBe('t3code');
  });

  it('rejects malformed provider configuration instead of silently ignoring it', () => {
    const { settingsPath } = fixture({ providerInstances: { codex: { driver: 'codex', config: [] } } });
    expect(() => discoverT3CodeProviders(settingsPath)).toThrow('Invalid config');
  });
});

describe('T3 Code launch compatibility', () => {
  const provider = (driver: T3CodeProvider['driver'], launchArgs: string): T3CodeProvider => ({ id: 'test', driver, launchArgs, homePath: '/home', command: 'fixture', environment: {} });
  it('preserves current SDK defaults and explicitly enabled settings', () => {
    expect(() => assertT3CodePluginLoading(provider('claudeAgent', ''))).not.toThrow();
    expect(() => assertT3CodePluginLoading(provider('claudeAgent', '--chrome --setting-sources "user,project,local"'))).not.toThrow();
    expect(() => assertT3CodePluginLoading(provider('codex', '-c features.hooks=true'))).not.toThrow();
  });
  it.each(['--setting-sources ""', '--setting-sources=project,local', '--disable-all-hooks', '--strict-mcp-config=true'])('refuses Claude overrides that block memory: %s', launchArgs => {
    expect(() => assertT3CodePluginLoading(provider('claudeAgent', launchArgs))).toThrow();
  });
  it.each(['-c features.hooks=false', '--config=features.hooks=false', '--disable hooks', '--disable=hooks', '-c \'plugins."claude-mem@claude-mem-local".enabled=false\''])('refuses Codex overrides that block memory: %s', launchArgs => {
    expect(() => assertT3CodePluginLoading(provider('codex', launchArgs))).toThrow();
  });
});

describe('T3 Code native plugin installation', () => {
  it.skipIf(process.platform === 'win32')('installs both providers using their real subprocess environments; repeats safely and removes only Claude-Mem', async () => {
    const { directory, settingsPath } = fixture({});
    const { command, log } = nativeCli(directory);
    const codexHome = join(directory, 'codex home');
    const claudeHome = join(directory, 'claude home');
    mkdirSync(codexHome);
    mkdirSync(claudeHome);
    writeFileSync(join(codexHome, 'config.toml'), 'model = "keep-model"\n\n[mcp_servers.other]\ncommand = "keep-command"\n\n[unrelated]\nhooks = false\n');
    writeFileSync(join(claudeHome, 'settings.json'), '{"enabledPlugins":{"other@marketplace":true},"permissions":{"allow":["Read"]}}');
    writeFileSync(settingsPath, JSON.stringify({ providerInstances: {
      codex: { driver: 'codex', environment: [{ name: 'T3_TEST_DRIVER', value: 'codex' }], config: { binaryPath: command, homePath: codexHome, shadowHomePath: join(directory, 'never-write-shadow'), launchArgs: '--config model="keep-model"' } },
      claude: { driver: 'claudeAgent', environment: [{ name: 'T3_TEST_DRIVER', value: 'claude' }], config: { binaryPath: command, homePath: claudeHome } },
    }, futureSetting: { keep: true } }));
    const before = readFileSync(settingsPath, 'utf-8');
    const ambientHome = process.env.CODEX_HOME;
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await installT3Code(repository, { settingsPath })).toBe(0);
      expect(await installT3Code(repository, { settingsPath })).toBe(0);
      expect(t3CodeStatus({ settingsPath })).toBe(0);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
      expect(process.env.CODEX_HOME).toBe(ambientHome);
      expect(existsSync(join(directory, 'never-write-shadow'))).toBe(false);
      const codexConfig = readFileSync(join(codexHome, 'config.toml'), 'utf-8');
      expect(codexConfig).toContain('[features]\nhooks = true');
      expect(codexConfig).toContain('[plugins."claude-mem@claude-mem-local"]\nenabled = true');
      expect(codexConfig).toContain('[mcp_servers.other]\ncommand = "keep-command"');
      const claudeSettings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'));
      expect(claudeSettings.enabledPlugins['claude-mem@thedotmack']).toBe(true);
      expect(claudeSettings.enabledPlugins['other@marketplace']).toBe(true);
      const calls = readFileSync(log, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.filter(call => call.args[1] === 'install').every(call => call.home === claudeHome)).toBe(true);
      expect(calls.filter(call => call.args[1] === 'add').every(call => call.home === codexHome)).toBe(true);
      expect(uninstallT3Code({ settingsPath })).toBe(0);
      expect(t3CodeStatus({ settingsPath })).toBe(1);
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf-8')).toContain('[plugins."claude-mem@claude-mem-local"]\nenabled = false');
      const removed = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'));
      expect(removed.enabledPlugins['claude-mem@thedotmack']).toBe(false);
      expect(removed.enabledPlugins['other@marketplace']).toBe(true);
      expect(removed.permissions).toEqual({ allow: ['Read'] });
      expect(readFileSync(settingsPath, 'utf-8')).toBe(before);
    } finally { logSpy.mockRestore(); }
  });

  it('fails incompatible launch arguments before installing either provider', async () => {
    const { settingsPath } = fixture({ providers: { codex: {}, claudeAgent: { launchArgs: '--setting-sources project' } } });
    const spawn = () => { throw new Error('must not spawn'); };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await installT3Code(repository, { settingsPath, spawn })).toBe(1); }
    finally { errorSpy.mockRestore(); }
  });

  it('reports a failed provider while completing other enabled providers', async () => {
    const { directory, settingsPath } = fixture({ providers: { codex: { homePath: '/unavailable' }, claudeAgent: { homePath: '/other' } } });
    const calls: string[] = [];
    const spawn = (provider: T3CodeProvider, args: string[]) => {
      calls.push(provider.id);
      return { status: provider.driver === 'codex' && args[0] !== '--version' ? 2 : 0, stdout: args[0] === '--version' ? 'codex-cli 0.156.1' : '', stderr: 'fixture error', pid: 0, output: [], signal: null };
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await installT3Code(repository, { settingsPath, spawn })).toBe(1);
      expect(calls).toContain('codex');
      expect(calls).toContain('claudeAgent');
      expect(existsSync(join(directory, 'statev2.sqlite'))).toBe(false);
    } finally { errorSpy.mockRestore(); logSpy.mockRestore(); }
  });

  it('removes disabled providers even after a managed executable was deleted', () => {
    const { directory, settingsPath } = fixture({});
    const homePath = join(directory, 'shared');
    mkdirSync(homePath);
    writeFileSync(join(homePath, 'config.toml'), '[plugins."claude-mem@claude-mem-local"]\nenabled = true\n\n[features]\nhooks = false\n');
    writeFileSync(settingsPath, JSON.stringify({ providerInstances: { codex: { driver: 'codex', enabled: false, config: { homePath, setupMode: 'managed' } } } }));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(uninstallT3Code({ settingsPath })).toBe(0);
      expect(readFileSync(join(homePath, 'config.toml'), 'utf-8')).toContain('enabled = false');
    } finally { logSpy.mockRestore(); }
  });
});
