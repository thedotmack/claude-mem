import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { getZedSettingsPath } from '../../src/services/integrations/McpIntegrations.js';
import { parseJsonc } from '../../src/shared/atomic-json.js';

// Zed reads MCP servers from the `context_servers` key of settings.json —
// ~/.config/zed/settings.json on Linux/macOS, %APPDATA%\Zed\settings.json on
// Windows (zed.dev/docs/ai/mcp). The `mcpServers` key is silently ignored by
// Zed, so every test below pins the key name, not just the entry shape. The
// installer resolves the home directory when the module loads, so each call
// runs in a child process with HOME set and any inherited XDG_CONFIG_HOME
// removed.
const integrations = path.resolve(import.meta.dir, '../../src/services/integrations/McpIntegrations.ts');
const fixturesDir = path.resolve(import.meta.dir, '../fixtures/zed');
const { XDG_CONFIG_HOME: _inheritedXdgConfigHome, ...inheritedEnv } = process.env;
describe('Zed MCP config', () => {
  let tmp: string;
  let home: string;
  let appdata: string;
  let plugin: string;
  let serverPath: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'zed-mcp-'));
    home = path.join(tmp, 'home');
    appdata = path.join(tmp, 'appdata');
    plugin = path.join(tmp, 'plugin');
    serverPath = path.join(plugin, 'scripts', 'mcp-server.cjs');
    configPath = path.join(home, '.config', 'zed', 'settings.json');
    mkdirSync(home);
    mkdirSync(path.join(tmp, 'project'));
    mkdirSync(path.dirname(serverPath), { recursive: true });
    writeFileSync(serverPath, '');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Env for spawned children: the temp HOME/USERPROFILE/APPDATA/CLAUDE_PLUGIN_ROOT, plus overrides. */
  function childEnv(extra: Record<string, string> = {}): Record<string, string> {
    // APPDATA is set explicitly: on Windows the installer resolves
    // %APPDATA%\Zed\settings.json, and a real APPDATA inherited from the
    // developer's environment would make the tests install and uninstall
    // against their real settings file.
    return { ...inheritedEnv, HOME: home, USERPROFILE: home, APPDATA: appdata, CLAUDE_PLUGIN_ROOT: plugin, ...extra };
  }

  /** Calls `call` on McpIntegrations in a child process and returns its exit code and stderr. */
  function run(call: string, env: Record<string, string> = {}): { exitCode: number | null; stderr: string } {
    const child = Bun.spawnSync(
      [process.execPath, '-e', `const integrations = await import(${JSON.stringify(integrations)}); process.exit(await integrations.${call});`],
      { cwd: path.join(tmp, 'project'), env: childEnv(env) },
    );
    return { exitCode: child.exitCode, stderr: child.stderr.toString() };
  }
  const install = (env?: Record<string, string>) => run(`MCP_IDE_INSTALLERS['zed']()`, env);
  const uninstall = () => run('uninstallZedMcpIntegration()');
  const readConfig = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));
  const backupName = () => `settings.json.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  // The user's own server, shaped like the Zed docs' local-server example.
  const filesystem = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/alex/notes'] };

  it('registers claude-mem under context_servers, never under mcpServers', () => {
    expect(install().exitCode).toBe(0);

    const config = readConfig(configPath);
    expect(config.context_servers['claude-mem'].args).toEqual([serverPath]);
    expect(config.context_servers['claude-mem'].command).toBe(process.execPath);
    expect(config).not.toHaveProperty('mcpServers');
  });

  it('writes settings.json under the directory XDG_CONFIG_HOME names', () => {
    const configHome = path.join(tmp, 'xdg home');

    expect(install({ XDG_CONFIG_HOME: configHome }).exitCode).toBe(0);

    const xdgPath = path.join(configHome, 'zed', 'settings.json');
    expect(readConfig(xdgPath).context_servers['claude-mem'].args).toEqual([serverPath]);
    expect(existsSync(path.join(home, '.config'))).toBe(false);
  });

  it('preserves other context servers and unrelated settings, and re-install is a no-op', () => {
    const original = JSON.stringify({
      theme: 'One Dark',
      agent: { tool_permissions: { default: 'confirm', 'mcp:filesystem:read_file': 'allow' } },
      context_servers: { filesystem },
    }, null, 2) + '\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(install().exitCode).toBe(0);
    const afterFirst = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(afterFirst);
    expect(config.context_servers).toEqual({ filesystem, 'claude-mem': { command: process.execPath, args: [serverPath] } });
    expect(config.theme).toBe('One Dark');
    expect(config.agent.tool_permissions).toEqual({ default: 'confirm', 'mcp:filesystem:read_file': 'allow' });

    expect(install().exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
    expect(afterFirst.match(/"claude-mem":/g)).toHaveLength(1);
  });

  it('re-install replaces its own entry when the server path moved', () => {
    expect(install().exitCode).toBe(0);
    const movedServer = path.join(tmp, 'moved plugin', 'scripts', 'mcp-server.cjs');
    mkdirSync(path.dirname(movedServer), { recursive: true });
    writeFileSync(movedServer, '');
    // CLAUDE_PLUGIN_ROOT is read when the module loads; point the child at the moved plugin.
    const moved = run(`MCP_IDE_INSTALLERS['zed']()`, { CLAUDE_PLUGIN_ROOT: path.join(tmp, 'moved plugin') });
    expect(moved.exitCode).toBe(0);

    const config = readConfig(configPath);
    expect(config.context_servers['claude-mem'].args).toEqual([movedServer]);
    expect(readFileSync(configPath, 'utf-8').match(/"claude-mem":/g)).toHaveLength(1);
  });

  it('backs up a pre-existing settings.json once, owner-only, before writing', () => {
    const original = JSON.stringify({ theme: 'One Dark', context_servers: { filesystem } }, null, 2) + '\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);
    const backupPath = path.join(path.dirname(configPath), backupName());

    expect(install().exitCode).toBe(0);
    expect(readFileSync(backupPath, 'utf-8')).toBe(original);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);

    // A second install the same day does not overwrite the backup.
    writeFileSync(configPath, JSON.stringify({ theme: 'Solarized Dark' }, null, 2) + '\n');
    expect(install().exitCode).toBe(0);
    expect(readFileSync(backupPath, 'utf-8')).toBe(original);
  });

  it('creates no backup when there was no settings.json to back up', () => {
    expect(install().exitCode).toBe(0);
    expect(readdirSync(path.dirname(configPath))).toEqual(['settings.json']);
  });

  it('uninstall removes claude-mem and leaves the rest of settings.json byte for byte', () => {
    const original = JSON.stringify({ theme: 'One Dark', context_servers: { filesystem } }, null, 2) + '\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);
    expect(install().exitCode).toBe(0);

    expect(uninstall().exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);

    // Nothing left to remove: a second run says so and leaves the file alone.
    expect(uninstall().exitCode).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('uninstall leaves an empty context_servers object when claude-mem was the only server', () => {
    expect(install().exitCode).toBe(0);
    expect(uninstall().exitCode).toBe(0);

    expect(readConfig(configPath)).toEqual({ context_servers: {} });
  });

  it('uninstall leaves a claude-mem entry it did not write alone', () => {
    // A user-owned server that happens to share the name: its args do not
    // end in mcp-server.cjs, so it is not ours to remove.
    const original = JSON.stringify({
      context_servers: { 'claude-mem': { command: 'npx', args: ['-y', 'someone-elses-claude-mem'] } },
    }, null, 2) + '\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('uninstall creates no settings.json when there is none', () => {
    expect(uninstall().exitCode).toBe(1);
    expect(existsSync(configPath)).toBe(false);
  });

  it('uninstall leaves a settings.json that does not parse as it is', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ not json');

    const result = uninstall();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Corrupt JSON file, refusing to overwrite');
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });

  it('install refuses a settings.json that does not parse and leaves it untouched', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ not json');

    const result = install();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Corrupt JSON file, refusing to overwrite');
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
    // The backup still holds the user's bytes even though the merge refused.
    expect(readFileSync(path.join(path.dirname(configPath), backupName()), 'utf-8')).toBe('{ not json');
  });

  it('install refuses a non-object context_servers value and leaves it untouched', () => {
    const original = JSON.stringify({ theme: 'One Dark', context_servers: 'oops' }, null, 2) + '\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(install().exitCode).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('merges into a settings.json saved with a byte order mark', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '\uFEFF' + JSON.stringify({ theme: 'One Dark', context_servers: { filesystem } }, null, 2) + '\n');

    expect(install().exitCode).toBe(0);

    const config = readConfig(configPath);
    expect(config.theme).toBe('One Dark');
    expect(config.context_servers).toEqual({ filesystem, 'claude-mem': { command: process.execPath, args: [serverPath] } });
  });

  it('merges into JSONC settings (comments and trailing commas) and uninstall restores it byte for byte', () => {
    // Zed accepts // and /* */ comments and trailing commas in
    // settings.json; a strict JSON.parse refuses such a file, so install
    // must not fail on it — and must not strip the user's comments either.
    const original = readFileSync(path.join(fixturesDir, 'linux-settings-comments.json'), 'utf-8');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(install().exitCode).toBe(0);

    const afterInstall = readFileSync(configPath, 'utf-8');
    expect(afterInstall).toContain('// Zed settings are JSONC');
    expect(afterInstall).toContain('// My notes server.');
    expect(afterInstall).toContain('"default": "confirm", // ask before running MCP tools');
    const config = JSON.parse(afterInstall.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1'));
    expect(config.theme).toBe('One Dark');
    expect(config.context_servers.filesystem).toEqual(filesystem);
    expect(config.context_servers['claude-mem'].args).toEqual([serverPath]);

    expect(uninstall().exitCode).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('adds context_servers to JSONC settings that have none, preserving comments', () => {
    const original = '{\n  // Zed settings.\n  "theme": "One Dark",\n}\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(install().exitCode).toBe(0);
    const afterInstall = readFileSync(configPath, 'utf-8');
    expect(afterInstall).toContain('// Zed settings.');
    expect(JSON.parse(afterInstall.replace(/\/\/.*$/gm, '')).context_servers['claude-mem'].args).toEqual([serverPath]);

    expect(uninstall().exitCode).toBe(0);
    // Uninstall leaves an empty context_servers object (the same behaviour
    // as the plain-JSON path), but the comment survives and no entry remains.
    const afterUninstall = readFileSync(configPath, 'utf-8');
    expect(afterUninstall).toContain('// Zed settings.');
    expect(JSON.parse(afterUninstall.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))).toEqual({
      theme: 'One Dark',
      context_servers: {},
    });
  });

  it('install refuses JSONC that is still malformed and leaves it untouched', () => {
    const original = '{\n  // hi\n  "theme": "One Dark",\n  /* unclosed comment';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    const result = install();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Corrupt JSON file, refusing to overwrite');
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  // Greptile P1 (PR #6111): removeJsoncMember left the removed member's own
  // trailing comma behind, so uninstall wrote `{"other":{},,}` (last member)
  // or `{,}` (only member) straight to settings.json — invalid JSONC that
  // Zed cannot read. parseJsonc alone does not catch those (it tolerates a
  // stray comma), so the tests below assert the raw text has no doubled or
  // leading comma as well as parsing cleanly.
  const claudeMemJsonc = '{\n      "command": "node",\n      "args": ["/x/mcp-server.cjs"]\n    }';

  it('uninstall of a last claude-mem entry with a trailing comma leaves valid JSONC, not `,,`', () => {
    const original = `{\n  "context_servers": {\n    "other": {},\n    "claude-mem": ${claudeMemJsonc},\n  },\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(0);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain(',,');
    expect(after).toBe('{\n  "context_servers": {\n    "other": {},\n  },\n}\n');
    expect(parseJsonc(after)).toEqual({ context_servers: { other: {} } });
  });

  it('uninstall of an only claude-mem entry with a trailing comma leaves valid JSONC, not `{,}`', () => {
    const original = `{\n  "context_servers": {\n    "claude-mem": ${claudeMemJsonc},\n  },\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(0);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain('{,}');
    expect(after).not.toContain(',,');
    expect(after).toBe('{\n  "context_servers": {\n  },\n}\n');
    expect(parseJsonc(after)).toEqual({ context_servers: {} });
  });

  it('uninstall of a middle claude-mem entry with a trailing comma leaves its neighbours intact', () => {
    const original = `{\n  "context_servers": {\n    "claude-mem": ${claudeMemJsonc},\n    "other": {},\n  },\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(0);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain(',,');
    expect(after).toBe('{\n  "context_servers": {\n    "other": {},\n  },\n}\n');
    expect(parseJsonc(after)).toEqual({ context_servers: { other: {} } });
  });

  it('uninstall of a last claude-mem entry keeps a trailing comment and leaves valid JSONC', () => {
    const original = `{\n  "context_servers": {\n    "other": {},\n    "claude-mem": ${claudeMemJsonc}, // our server\n  },\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(0);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain(',,');
    expect(after).toBe('{\n  "context_servers": {\n    "other": {}, // our server\n  },\n}\n');
    expect(parseJsonc(after)).toEqual({ context_servers: { other: {} } });
  });

  it('uninstall of a last claude-mem entry in a BOM file keeps the BOM and leaves valid JSONC', () => {
    const original = `\uFEFF{\n  "context_servers": {\n    "other": {},\n    "claude-mem": ${claudeMemJsonc},\n  },\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(0);
    const after = readFileSync(configPath, 'utf-8');
    expect(after.startsWith('\uFEFF')).toBe(true);
    expect(after).not.toContain(',,');
    expect(after).toBe('\uFEFF{\n  "context_servers": {\n    "other": {},\n  },\n}\n');
    expect(parseJsonc(after)).toEqual({ context_servers: { other: {} } });
  });

  it('uninstall of a last claude-mem entry without a trailing comma leaves valid JSONC', () => {
    // JSONC only because of the comment; context_servers itself has no
    // trailing comma after claude-mem. The separating comma stays behind
    // as a trailing comma, which JSONC allows.
    const original = `{\n  // Zed settings.\n  "context_servers": {\n    "other": {},\n    "claude-mem": ${claudeMemJsonc}\n  }\n}\n`;
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(uninstall().exitCode).toBe(0);
    const after = readFileSync(configPath, 'utf-8');
    expect(after).not.toContain(',,');
    expect(after).toBe('{\n  // Zed settings.\n  "context_servers": {\n    "other": {},\n  }\n}\n');
    expect(parseJsonc(after)).toEqual({ context_servers: { other: {} } });
  });

  it('install refuses a non-object context_servers value in a JSONC file', () => {
    const original = '{\n  // Zed settings.\n  "theme": "One Dark",\n  "context_servers": "oops",\n}\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, original);

    expect(install().exitCode).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('spawned children resolve %APPDATA% from a temporary directory, never the real one', () => {
    // On Windows the installer resolves %APPDATA%\Zed\settings.json. The
    // spawned children must see a temporary APPDATA, or the tests install
    // and uninstall against the developer's real settings file.
    const script = [
      `const { getZedSettingsPath } = await import(${JSON.stringify(integrations)});`,
      `console.log(getZedSettingsPath('win32'));`,
    ].join('\n');
    const child = Bun.spawnSync([process.execPath, '-e', script], { env: childEnv() });
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString().trim()).toBe(path.win32.join(appdata, 'Zed', 'settings.json'));
  });

  it('handles paths with spaces in the home and plugin directories', () => {
    const spacedTmp = mkdtempSync(path.join(tmpdir(), 'zed mcp config '));
    const spacedHome = path.join(spacedTmp, 'my home');
    const spacedPlugin = path.join(spacedTmp, 'my plugin');
    const spacedServer = path.join(spacedPlugin, 'scripts', 'mcp-server.cjs');
    mkdirSync(spacedHome);
    mkdirSync(path.dirname(spacedServer), { recursive: true });
    writeFileSync(spacedServer, '');
    try {
      const result = run(`MCP_IDE_INSTALLERS['zed']()`, { HOME: spacedHome, USERPROFILE: spacedHome, CLAUDE_PLUGIN_ROOT: spacedPlugin });
      expect(result.exitCode).toBe(0);
      expect(readConfig(path.join(spacedHome, '.config', 'zed', 'settings.json')).context_servers['claude-mem'].args)
        .toEqual([spacedServer]);
    } finally {
      rmSync(spacedTmp, { recursive: true, force: true });
    }
  });

  for (const fixture of ['linux-settings.json', 'macos-settings.json', 'windows-settings.json', 'linux-settings-bom.json']) {
    it(`merges into the real ${fixture} fixture and uninstall restores it`, () => {
      const original = readFileSync(path.join(fixturesDir, fixture), 'utf-8');
      const originalParsed = JSON.parse(original.replace(/^\uFEFF/, ''));
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, original);

      expect(install().exitCode).toBe(0);

      const config = readConfig(configPath);
      for (const [key, value] of Object.entries(originalParsed)) {
        if (key === 'context_servers') continue;
        expect(config[key]).toEqual(value);
      }
      expect(config.context_servers['claude-mem'].args).toEqual([serverPath]);
      expect(config.context_servers.filesystem ?? config.context_servers.github ?? config.context_servers.everything).toBeDefined();
      expect(config).not.toHaveProperty('mcpServers');

      expect(uninstall().exitCode).toBe(0);
      if (fixture.endsWith('-bom.json')) {
        // The merge re-serializes without the BOM, so the restored file
        // matches the fixture parsed, not byte for byte.
        expect(readConfig(configPath)).toEqual(originalParsed);
      } else {
        expect(readFileSync(configPath, 'utf-8')).toBe(original);
      }
    });
  }
});

// Zed takes its settings from etcetera-style paths: ~/.config/zed on macOS
// and Linux (XDG_CONFIG_HOME when set), %APPDATA%\Zed on Windows.
describe('getZedSettingsPath', () => {
  it('uses ~/.config/zed on macOS and Linux', () => {
    const expected = path.join(homedir(), '.config', 'zed', 'settings.json');
    expect(getZedSettingsPath('darwin', {})).toBe(expected);
    expect(getZedSettingsPath('linux', {})).toBe(expected);
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    expect(getZedSettingsPath('linux', { XDG_CONFIG_HOME: '/home/alex/.config-custom' }))
      .toBe('/home/alex/.config-custom/zed/settings.json');
  });

  it('uses %APPDATA%\\Zed on Windows', () => {
    expect(getZedSettingsPath('win32', { APPDATA: 'C:\\Users\\alex\\AppData\\Roaming' }))
      .toBe('C:\\Users\\alex\\AppData\\Roaming\\Zed\\settings.json');
  });

  it('keeps spaces in a %APPDATA% path on Windows', () => {
    expect(getZedSettingsPath('win32', { APPDATA: 'C:\\Users\\alex smith\\AppData\\Roaming' }))
      .toBe('C:\\Users\\alex smith\\AppData\\Roaming\\Zed\\settings.json');
  });

  it('falls back to the default Roaming path on Windows without APPDATA', () => {
    expect(getZedSettingsPath('win32', {})).toBe(
      path.win32.join(homedir(), 'AppData', 'Roaming', 'Zed', 'settings.json'));
  });
});

// The installer wiring: `npx claude-mem install --ide zed` must dispatch to
// the Zed MCP task, and detection must see a Zed settings directory. Both
// run in a child process so the installer import chain (telemetry, prompts)
// never touches this test process.
describe('Zed installer wiring', () => {
  it('detects Zed from its settings directory and dispatches install --ide zed', () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'zed-wiring-'));
    try {
      mkdirSync(path.join(tmpHome, '.config', 'zed'), { recursive: true });
      const detectionTs = path.resolve(import.meta.dir, '../../src/npx-cli/commands/ide-detection.ts');
      const installTs = path.resolve(import.meta.dir, '../../src/npx-cli/commands/install.ts');
      const reporterTs = path.resolve(import.meta.dir, '../../src/npx-cli/install/error-reporter.ts');
      const script = [
        `const { detectInstalledIDEs } = await import(${JSON.stringify(detectionTs)});`,
        `const { makeIDETask } = await import(${JSON.stringify(installTs)});`,
        `const { createInstallSummary } = await import(${JSON.stringify(reporterTs)});`,
        `const zed = detectInstalledIDEs().find(ide => ide.id === 'zed');`,
        `if (!zed || !zed.detected) { console.error('zed not detected'); process.exit(2); }`,
        `const task = makeIDETask('zed', createInstallSummary());`,
        `if (!task) { console.error('no install task for zed'); process.exit(3); }`,
        `console.log(task.title);`,
      ].join('\n');
      const child = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...inheritedEnv, HOME: tmpHome, USERPROFILE: tmpHome, APPDATA: path.join(tmpHome, 'appdata') },
      });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toContain('Zed');
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
