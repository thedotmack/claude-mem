import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import {
  buildDevinHooks,
  checkDevinHooksStatus,
  devinConfigPath,
  installDevinHooks,
  isClaudeMemDevinCommand,
  mergeDevinHooks,
  removeDevinHooks,
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

describe('hook merge', () => {
  const ours = buildDevinHooks('/usr/local/bin/bun', '/plugin/scripts/worker-service.cjs');

  test('registers the Claude Code handlers Devin has, and no PreToolUse', () => {
    expect(Object.keys(ours)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
    const commands = Object.values(ours).flatMap((rules) => rules.flatMap((rule) => rule.hooks.map((hook) => hook.command)));
    expect(commands).toEqual([
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" start',
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

  test('uninstall drops an emptied hooks key and leaves a missing config alone', () => {
    const configPath = scratchConfigPath();
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(existsSync(configPath)).toBe(false);
    expect(installDevinHooks(configPath)).toBe(0);
    expect(uninstallDevinHooks(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual({});
  });
});
