import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import {
  buildDevinHooks,
  checkDevinHooksStatus,
  configureDevinMcp,
  devinConfigPath,
  devinMcpConfigPath,
  installDevinHooks,
  isClaudeMemDevinCommand,
  mergeDevinHooks,
  removeDevinHooks,
  removeDevinMcpServer,
  uninstallDevinHooks,
} from '../../src/services/integrations/DevinHooksInstaller.js';

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function scratchConfigPath(): string {
  scratch = path.join(tmpdir(), `devin-install-test-${process.pid}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  return path.join(scratch, 'devin', 'config.json');
}

const readConfig = (configPath: string) => JSON.parse(readFileSync(configPath, 'utf-8'));

const USER_HOOK = { matcher: 'exec', hooks: [{ type: 'command', command: './scripts/audit.sh', timeout: 10 }] };

describe('devinConfigPath', () => {
  test('uses ~/.config/devin on POSIX and %APPDATA%\\devin on Windows', () => {
    expect(devinConfigPath('darwin', {})).toBe(path.join(homedir(), '.config', 'devin', 'config.json'));
    expect(devinConfigPath('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }))
      .toBe('C:\\Users\\a\\AppData\\Roaming\\devin\\config.json');
  });
});

describe('devinMcpConfigPath', () => {
  test('sits next to config.json on POSIX and Windows', () => {
    expect(devinMcpConfigPath('darwin', {})).toBe(path.join(homedir(), '.config', 'devin', 'mcp_config.json'));
    expect(devinMcpConfigPath('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }))
      .toBe('C:\\Users\\a\\AppData\\Roaming\\devin\\mcp_config.json');
  });
});

describe('hook merge', () => {
  const ours = buildDevinHooks('/usr/local/bin/bun', '/plugin/scripts/worker-service.cjs');

  test('registers the Claude Code handlers Devin has, context again after compaction, and no PreToolUse', () => {
    expect(Object.keys(ours)).toEqual(['SessionStart', 'PostCompaction', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
    const commands = Object.values(ours).flatMap((rules) => rules.flatMap((rule) => rule.hooks.map((hook) => hook.command)));
    expect(commands).toEqual([
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" start',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin context',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin context',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin session-init',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin observation',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin summarize',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin session-end',
    ]);
  });

  test('keeps user hooks, and replaces rather than duplicates its own', () => {
    const once = mergeDevinHooks({ PostToolUse: [USER_HOOK] }, ours);
    const twice = mergeDevinHooks(once, ours);
    expect(twice).toEqual(once);
    expect(twice.PostToolUse[0]).toEqual(USER_HOOK);
    expect(twice.PostToolUse).toHaveLength(2);
  });

  test('removes only its own commands, even inside a shared rule', () => {
    const ownCommand = ours.Stop[0].hooks[0];
    const shared = { matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }, ownCommand] };
    const removed = removeDevinHooks({ ...mergeDevinHooks({ PostToolUse: [USER_HOOK] }, ours), Stop: [shared] });
    expect(removed).toEqual({ PostToolUse: [USER_HOOK], Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send done' }] }] });
  });

  test('does not claim a foreign command that only mentions the worker', () => {
    expect(isClaudeMemDevinCommand({ type: 'command', command: 'echo worker-service.cjs" hook devin observation && rm -rf x' })).toBe(false);
    expect(isClaudeMemDevinCommand({ type: 'prompt' })).toBe(false);
    for (const command of [
      'echo "/tmp/worker-service.cjs" start',
      '"/bin/echo" "/tmp/scripts/worker-service.cjs" start',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook devin observation && rm -rf x',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook cursor observation',
    ]) {
      expect(isClaudeMemDevinCommand({ type: 'command', command })).toBe(false);
    }
  });

  test('claims every command it writes, with bare, POSIX and Windows runtime paths', () => {
    for (const [bun, worker] of [
      ['bun', '/plugin/scripts/worker-service.cjs'],
      ['C:\\Users\\a\\.bun\\bin\\bun.exe', 'C:\\Users\\a\\.claude\\plugins\\marketplaces\\thedotmack\\plugin\\scripts\\worker-service.cjs'],
    ]) {
      const hooks = Object.values(buildDevinHooks(bun, worker)).flatMap((rules) => rules.flatMap((rule) => rule.hooks));
      expect(hooks.every(isClaudeMemDevinCommand)).toBe(true);
    }
  });
});

describe('installDevinHooks', () => {
  test('writes the hooks, keeps other settings and user hooks, backs up once, is idempotent', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ model: 'swe-1', hooks: { PostToolUse: [USER_HOOK] } }, null, 2));
    expect(installDevinHooks(configPath)).toBe(0);
    const config = readConfig(configPath);
    expect(config.model).toBe('swe-1');
    expect(config.hooks.PostToolUse[0]).toEqual(USER_HOOK);
    expect(JSON.stringify(config.hooks)).toContain('hook devin observation');
    expect(readdirSync(path.dirname(configPath)).filter((name) => name.startsWith('config.json.bak-'))).toHaveLength(1);
    expect(installDevinHooks(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual(config);
  });

  test.skipIf(process.platform === 'win32')('writes the backup owner-only, even from a readable config', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ model: 'swe-1' }));
    chmodSync(configPath, 0o644);
    expect(installDevinHooks(configPath)).toBe(0);
    const backup = readdirSync(path.dirname(configPath)).find((name) => name.startsWith('config.json.bak-'));
    expect(statSync(path.join(path.dirname(configPath), backup!)).mode & 0o777).toBe(0o600);
  });

  test('creates the config directory when Devin has never written one', () => {
    const configPath = scratchConfigPath();
    expect(installDevinHooks(configPath)).toBe(0);
    expect(Object.keys(readConfig(configPath).hooks)).toContain('SessionStart');
  });

  test('refuses to overwrite a config that is not a JSON object', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    for (const content of ['{ not json', '[]', JSON.stringify({ hooks: [] })]) {
      writeFileSync(configPath, content);
      expect(installDevinHooks(configPath)).toBe(1);
      expect(readFileSync(configPath, 'utf-8')).toBe(content);
    }
  });

  test('status reports installed state; uninstall removes only claude-mem hooks', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ model: 'swe-1', hooks: { PostToolUse: [USER_HOOK] } }));
    expect(checkDevinHooksStatus(configPath)).toBe(1);
    expect(installDevinHooks(configPath)).toBe(0);
    expect(checkDevinHooksStatus(configPath)).toBe(0);
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(checkDevinHooksStatus(configPath)).toBe(1);
    expect(readConfig(configPath)).toEqual({ model: 'swe-1', hooks: { PostToolUse: [USER_HOOK] } });
  });

  test('install and uninstall keep a user hook that only mentions the worker, and back up first', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    const lookalike = { matcher: '', hooks: [{ type: 'command', command: 'echo "/tmp/worker-service.cjs" start' }] };
    const original = { hooks: { SessionStart: [lookalike] } };
    writeFileSync(configPath, JSON.stringify(original));
    expect(installDevinHooks(configPath)).toBe(0);
    expect(readConfig(configPath).hooks.SessionStart[0]).toEqual(lookalike);
    rmSync(`${configPath}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`);
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual(original);
    const backups = readdirSync(path.dirname(configPath)).filter((name) => name.startsWith('config.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(readFileSync(path.join(path.dirname(configPath), backups[0]), 'utf-8')))).toContain('hook devin observation');
  });

  // Windows refuses symlinkSync without Developer Mode or admin (EPERM).
  // Probe once instead of assuming the platform.
  const canCreateSymlinks = (() => {
    const probeDir = mkdtempSync(path.join(tmpdir(), 'devin-symlink-probe-'));
    try {
      symlinkSync(path.join(probeDir, 'missing.json'), path.join(probeDir, 'link.json'));
      return true;
    } catch {
      return false;
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  })();

  test.skipIf(!canCreateSymlinks)('writes through a symlinked config.json and leaves no temp file behind', () => {
    const configPath = scratchConfigPath();
    const target = path.join(path.dirname(path.dirname(configPath)), 'dotfiles-devin.json');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(target, JSON.stringify({ model: 'swe-1' }));
    symlinkSync(target, configPath);
    expect(installDevinHooks(configPath)).toBe(0);
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(readConfig(target).hooks.PostToolUse).toHaveLength(1);
    expect(readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('uninstall drops an emptied hooks key and leaves a missing config alone', () => {
    const configPath = scratchConfigPath();
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(existsSync(configPath)).toBe(false);
    expect(installDevinHooks(configPath)).toBe(0);
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual({});
  });

  test('uninstall also removes the claude-mem server from the sibling mcp_config.json', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ model: 'swe-1' }));
    const mcpPath = path.join(path.dirname(configPath), 'mcp_config.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { 'claude-mem': { command: 'node', args: ['/x/mcp-server.cjs'] }, other: { command: 'y' } } }));
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(readConfig(mcpPath).mcpServers).toEqual({ other: { command: 'y' } });
  });

  test('a corrupt mcp_config.json still lets uninstall remove the hooks, and reports the failure', () => {
    const configPath = scratchConfigPath();
    expect(installDevinHooks(configPath)).toBe(0);
    const mcpPath = path.join(path.dirname(configPath), 'mcp_config.json');
    const corruptMcpConfig = '{ not json';
    writeFileSync(mcpPath, corruptMcpConfig);

    expect(uninstallDevinHooks(configPath)).toBe(1);

    expect(readConfig(configPath).hooks).toBeUndefined();
    expect(readFileSync(mcpPath, 'utf-8')).toBe(corruptMcpConfig);
  });

  test('a corrupt mcp_config.json is reported even when there are no hooks left to remove', () => {
    const configPath = scratchConfigPath();
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(path.join(path.dirname(configPath), 'mcp_config.json'), '{ not json');

    expect(uninstallDevinHooks(configPath)).toBe(1);

    writeFileSync(configPath, JSON.stringify({ model: 'swe-1' }));
    expect(uninstallDevinHooks(configPath)).toBe(1);

    writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [] } }));
    expect(uninstallDevinHooks(configPath)).toBe(1);
  });
});

describe('configureDevinMcp', () => {
  const scratchMcpPath = (): string => {
    scratch = path.join(tmpdir(), `devin-mcp-test-${process.pid}-${Date.now()}`);
    mkdirSync(scratch, { recursive: true });
    return path.join(scratch, 'mcp_config.json');
  };

  test('creates the file and registers the claude-mem stdio server, keeping other servers', () => {
    const mcpPath = scratchMcpPath();
    expect(configureDevinMcp(mcpPath)).toBe(0);
    const config = readConfig(mcpPath);
    expect(config.mcpServers['claude-mem'].command).toBe(process.execPath);
    expect(String(config.mcpServers['claude-mem'].args[0])).toContain('mcp-server.cjs');

    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'y' } } }));
    expect(configureDevinMcp(mcpPath)).toBe(0);
    expect(readConfig(mcpPath).mcpServers.other).toEqual({ command: 'y' });
    expect(readConfig(mcpPath).mcpServers['claude-mem']).toBeTruthy();
  });

  test('refuses to overwrite a config that is not a JSON object', () => {
    const mcpPath = scratchMcpPath();
    for (const content of ['{ not json', '[]', JSON.stringify({ mcpServers: [] })]) {
      writeFileSync(mcpPath, content);
      expect(configureDevinMcp(mcpPath)).toBe(1);
      expect(readFileSync(mcpPath, 'utf-8')).toBe(content);
    }
  });

  test('removeDevinMcpServer drops only the claude-mem entry and tolerates a missing file', () => {
    const mcpPath = scratchMcpPath();
    expect(removeDevinMcpServer(mcpPath)).toBe(false);
    expect(configureDevinMcp(mcpPath)).toBe(0);
    expect(removeDevinMcpServer(mcpPath)).toBe(true);
    expect(readConfig(mcpPath).mcpServers).toEqual({});
    expect(removeDevinMcpServer(mcpPath)).toBe(false);
  });
});
