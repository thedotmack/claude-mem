import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uninstallT3Code } from '../../src/services/integrations/T3CodeInstaller.js';

describe('T3 Code removal reads native TOML boolean settings', () => {
  let root: string;
  let settingsPath: string;
  let configPath: string;
  let log: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 't3-toml-state-'));
    const codexHome = join(root, 'codex');
    mkdirSync(codexHome);
    configPath = join(codexHome, 'config.toml');
    settingsPath = join(root, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ providerInstances: {
      codex: { driver: 'codex', config: { homePath: codexHome } },
      claudeAgent: { driver: 'claudeAgent', enabled: false, config: { homePath: join(root, 'absent-claude') } },
    } }));
    log = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    `[plugins.'claude-mem@claude-mem-local']\nenabled = true\n`,
    `[ "plugins" . "claude-mem@claude-mem-local" ] # selected plugin\n"enabled" = true\n`,
    `[plugins."claude-mem@claude-mem-local"]\n'enabled' = true\n`,
    `[plugins."claude-mem@claude-mem-local"]\n"en\\u0061bled" = true\n`,
  ])('disables an enabled plugin written with valid equivalent keys: %s', content => {
    expect((Bun.TOML.parse(content) as any).plugins['claude-mem@claude-mem-local'].enabled).toBe(true);
    writeFileSync(configPath, content + '\n[plugins.other]\nenabled = true\n');
    expect(uninstallT3Code({ settingsPath, environment: {} })).toBe(0);
    const parsed = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as any;
    expect(parsed.plugins['claude-mem@claude-mem-local'].enabled).toBe(false);
    expect(parsed.plugins.other.enabled).toBe(true);
  });

  it('does not treat a plugin-looking example inside a multiline string as an active plugin', () => {
    const content = `example = '''\n[plugins."claude-mem@claude-mem-local"]\nenabled = true\n'''\n`;
    writeFileSync(configPath, content);
    expect(uninstallT3Code({ settingsPath, environment: {} })).toBe(0);
    expect(readFileSync(configPath, 'utf8')).toBe(content);
  });
});
