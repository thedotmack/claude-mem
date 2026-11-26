import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import * as realInstallPathsModule from '../../src/services/integrations/install-paths.js';
import {
  buildZCodeHooks,
  checkZCodeStatus,
  installZCode,
  isClaudeMemZCodeHook,
  mergeZCodeHooks,
  readZCodeStatus,
  removeZCodeHooks,
  uninstallZCode,
  ZCODE_STATUS_LABELS,
  zcodeConfigPath,
  type ZCodeStatus,
} from '../../src/services/integrations/ZCodeHooksInstaller.js';

const realInstallPathsSnapshot = { ...realInstallPathsModule };

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  mock.restore();
});

// Every test writes under a temp dir; the real ~/.zcode is never touched.
function scratchConfigPath(dirName = 'zcode-install-test'): string {
  scratch = path.join(tmpdir(), `${dirName}-${process.pid}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  return path.join(scratch, '.zcode', 'cli', 'config.json');
}

function writeConfig(configPath: string, content: unknown): string {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeFileSync(configPath, text);
  return text;
}

const readConfig = (configPath: string) => JSON.parse(readFileSync(configPath, 'utf-8'));
const backups = (configPath: string) => readdirSync(path.dirname(configPath)).filter((name) => name.startsWith('config.json.bak-'));
const quiet = () => {
  spyOn(console, 'log').mockImplementation(() => {});
  return spyOn(console, 'error').mockImplementation(() => {});
};

const BUN = '/usr/local/bin/bun';
const WORKER = '/plugin/scripts/worker-service.cjs';
const USER_HOOK = { matcher: 'Bash', hooks: [{ type: 'process', command: '/usr/bin/audit', args: ['--log'] }] };

describe('zcodeConfigPath', () => {
  test('is ~/.zcode/cli/config.json', () => {
    expect(zcodeConfigPath()).toBe(path.join(homedir(), '.zcode', 'cli', 'config.json'));
  });
});

describe('ZCode hook building and merge', () => {
  const ours = buildZCodeHooks(BUN, WORKER);

  test('registers process hooks with matcher * and per-hook timeouts for the handled events', () => {
    expect(Object.keys(ours)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
    const hooks = Object.values(ours).flatMap((rules) => rules.map((rule) => ({ matcher: rule.matcher, ...rule.hooks[0] })));
    expect(hooks).toEqual([
      { matcher: '*', type: 'process', command: BUN, args: [WORKER, 'start'], timeoutMs: 60000 },
      { matcher: '*', type: 'process', command: BUN, args: [WORKER, 'hook', 'zcode', 'context'], timeoutMs: 60000 },
      { matcher: '*', type: 'process', command: BUN, args: [WORKER, 'hook', 'zcode', 'session-init'], timeoutMs: 15000 },
      { matcher: '*', type: 'process', command: BUN, args: [WORKER, 'hook', 'zcode', 'observation'], timeoutMs: 120000 },
      { matcher: '*', type: 'process', command: BUN, args: [WORKER, 'hook', 'zcode', 'observation'], timeoutMs: 120000 },
      { matcher: '*', type: 'process', command: BUN, args: [WORKER, 'hook', 'zcode', 'summarize'], timeoutMs: 120000 },
    ]);
  });

  test('keeps a user hook on the same event and appends ours once, even on a second merge', () => {
    const once = mergeZCodeHooks({ PostToolUse: [USER_HOOK] }, ours);
    const twice = mergeZCodeHooks(once, ours);
    expect(twice).toEqual(once);
    expect(twice.PostToolUse).toEqual([USER_HOOK, ...ours.PostToolUse]);
  });

  test('replaces a stale entry from an older worker path', () => {
    const stale = buildZCodeHooks(BUN, '/old/plugin/scripts/worker-service.cjs');
    const merged = mergeZCodeHooks(mergeZCodeHooks({}, stale), ours);
    expect(merged).toEqual(ours);
  });

  test('does not claim a user hook that only mentions the worker or uses another type', () => {
    for (const hook of [
      { type: 'process', command: BUN, args: [WORKER, 'hook', 'zcode', 'observation', '--extra'] },
      { type: 'process', command: BUN, args: [WORKER, 'hook', 'cursor', 'observation'] },
      { type: 'process', command: BUN, args: [WORKER, 'stop'] },
      { type: 'process', command: '/usr/bin/node', args: [WORKER, 'start'] },
      { type: 'process', command: BUN, args: ['/tmp/worker-service.cjs', 'start'] },
      { type: 'process', command: BUN, args: `${WORKER} start` },
      { type: 'command', command: `"${BUN}" "${WORKER}" start` },
      { type: 'command', command: BUN, args: [WORKER, 'start'] },
    ]) {
      expect(isClaudeMemZCodeHook(hook)).toBe(false);
    }
  });

  test('claims every hook it writes, with bare, spaced POSIX and Windows paths', () => {
    for (const [bun, worker] of [
      ['bun', WORKER],
      ['/Users/a b/.bun/bin/bun', '/Users/a b/plugin dir/scripts/worker-service.cjs'],
      ['C:\\Users\\a b\\.bun\\bin\\bun.exe', 'C:\\Users\\a b\\plugin\\scripts\\worker-service.cjs'],
    ]) {
      const built = buildZCodeHooks(bun, worker);
      const hooks = Object.values(built).flatMap((rules) => rules.flatMap((rule) => rule.hooks));
      expect(hooks.every(isClaudeMemZCodeHook)).toBe(true);
      expect(hooks.every((hook) => (hook.args as string[])[0] === worker)).toBe(true);
      expect(removeZCodeHooks(built)).toEqual({});
    }
  });

  test('removes only its own hooks, even inside a shared rule, and drops emptied events', () => {
    const shared = { matcher: '*', hooks: [{ type: 'process', command: '/usr/bin/notify' }, ...ours.Stop[0].hooks] };
    const removed = removeZCodeHooks({ ...mergeZCodeHooks({ PostToolUse: [USER_HOOK] }, ours), Stop: [shared] });
    expect(removed).toEqual({ PostToolUse: [USER_HOOK], Stop: [{ matcher: '*', hooks: [{ type: 'process', command: '/usr/bin/notify' }] }] });
  });
});

describe('installZCode', () => {
  test('creates config.json with only hooks (enabled) and the claude-mem MCP server, and no backup', () => {
    quiet();
    const configPath = scratchConfigPath();
    expect(installZCode(configPath)).toBe(0);
    const config = readConfig(configPath);
    expect(Object.keys(config).sort()).toEqual(['hooks', 'mcp']);
    expect(config.hooks.enabled).toBe(true);
    expect(Object.keys(config.hooks.events)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
    expect(Object.keys(config.mcp.servers)).toEqual(['claude-mem']);
    expect(config.mcp.servers['claude-mem'].command).toBe(process.execPath);
    expect(String(config.mcp.servers['claude-mem'].args[0])).toEndWith('mcp-server.cjs');
    expect(backups(configPath)).toEqual([]);
  });

  test('keeps other keys, user hooks and MCP servers; backs up once with mode 0o600; is idempotent', () => {
    quiet();
    const configPath = scratchConfigPath();
    const original = {
      provider: { name: 'zai', model: 'GLM-5.4' },
      theme: 'dark',
      hooks: { timeoutMs: 10000, events: { PostToolUse: [USER_HOOK] } },
      mcp: { servers: { other: { command: 'y', args: [] } } },
    };
    writeConfig(configPath, original);
    expect(installZCode(configPath)).toBe(0);
    const config = readConfig(configPath);
    expect(config.provider).toEqual(original.provider);
    expect(config.theme).toBe('dark');
    expect(config.hooks.timeoutMs).toBe(10000);
    expect(config.hooks.events.PostToolUse[0]).toEqual(USER_HOOK);
    expect(config.hooks.events.PostToolUse).toHaveLength(2);
    expect(config.mcp.servers.other).toEqual(original.mcp.servers.other);
    expect(backups(configPath)).toHaveLength(1);
    const backupPath = path.join(path.dirname(configPath), backups(configPath)[0]);
    if (process.platform !== 'win32') expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(readConfig(backupPath)).toEqual(original);

    expect(installZCode(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual(config);
    expect(backups(configPath)).toHaveLength(1);
  });

  test('keeps hooks.enabled false set by the user and warns', () => {
    const errors = quiet();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = scratchConfigPath();
    writeConfig(configPath, { hooks: { enabled: false } });
    expect(installZCode(configPath)).toBe(0);
    expect(readConfig(configPath).hooks.enabled).toBe(false);
    const printed = [...warn.mock.calls, ...errors.mock.calls].flat().join('\n');
    expect(printed).toContain('hooks.enabled');
  });

  test('refuses a config that is not usable JSON and leaves it unchanged', () => {
    quiet();
    const configPath = scratchConfigPath();
    for (const content of [
      '{ not json', '[]', 'null',
      { hooks: [] }, { hooks: { events: [] } }, { hooks: { events: null } }, { mcp: 'x' }, { mcp: { servers: [] } },
    ]) {
      const text = writeConfig(configPath, content);
      expect(installZCode(configPath)).toBe(1);
      expect(readFileSync(configPath, 'utf-8')).toBe(text);
    }
    expect(backups(configPath)).toEqual([]);
  });

  test('stores a worker path with spaces as one args item and recognises it on uninstall', () => {
    quiet();
    const configPath = scratchConfigPath('zcode install test with spaces');
    const spacedWorker = path.join(scratch!, 'plugin dir', 'scripts', 'worker-service.cjs');
    mock.module('../../src/services/integrations/install-paths.js', () => ({
      ...realInstallPathsSnapshot,
      getWorkerServiceAbsolutePath: () => spacedWorker,
    }));
    try {
      expect(installZCode(configPath)).toBe(0);
    } finally {
      mock.module('../../src/services/integrations/install-paths.js', () => realInstallPathsSnapshot);
    }
    expect(readConfig(configPath).hooks.events.Stop[0].hooks[0].args[0]).toBe(spacedWorker);
    expect(checkZCodeStatus(configPath)).toBe(0);
    expect(uninstallZCode(configPath)).toBe(0);
    expect(readConfig(configPath).hooks).toBeUndefined();
  });

  test('exits 1 without writing when worker-service.cjs is not found', () => {
    const errors = quiet();
    const configPath = scratchConfigPath();
    mock.module('../../src/services/integrations/install-paths.js', () => ({
      ...realInstallPathsSnapshot,
      getWorkerServiceAbsolutePath: () => null,
    }));
    try {
      expect(installZCode(configPath)).toBe(1);
    } finally {
      mock.module('../../src/services/integrations/install-paths.js', () => realInstallPathsSnapshot);
    }
    expect(existsSync(configPath)).toBe(false);
    expect(errors.mock.calls.flat().join('\n')).toContain('worker-service.cjs');
  });

  test('exits 1 without writing when mcp-server.cjs is not found', () => {
    const errors = quiet();
    const configPath = scratchConfigPath();
    mock.module('../../src/services/integrations/install-paths.js', () => ({
      ...realInstallPathsSnapshot,
      getMcpServerAbsolutePath: () => null,
    }));
    try {
      expect(installZCode(configPath)).toBe(1);
    } finally {
      mock.module('../../src/services/integrations/install-paths.js', () => realInstallPathsSnapshot);
    }
    expect(existsSync(configPath)).toBe(false);
    expect(errors.mock.calls.flat().join('\n')).toContain('mcp-server.cjs');
  });
});

describe('uninstallZCode and checkZCodeStatus', () => {
  test('removes only our hooks and our MCP server; keeps every user key', () => {
    quiet();
    const configPath = scratchConfigPath();
    const original = {
      theme: 'dark',
      hooks: { enabled: true, timeoutMs: 10000, events: { PostToolUse: [USER_HOOK] } },
      mcp: { servers: { other: { command: 'y' } } },
    };
    writeConfig(configPath, original);
    expect(checkZCodeStatus(configPath)).toBe(1);
    expect(installZCode(configPath)).toBe(0);
    expect(checkZCodeStatus(configPath)).toBe(0);
    expect(uninstallZCode(configPath)).toBe(0);
    expect(checkZCodeStatus(configPath)).toBe(1);
    expect(readConfig(configPath)).toEqual(original);
  });

  test('drops hooks when only enabled is left, and keeps other MCP servers', () => {
    quiet();
    const configPath = scratchConfigPath();
    expect(installZCode(configPath)).toBe(0);
    const config = readConfig(configPath);
    config.mcp.servers.other = { command: 'y' };
    writeConfig(configPath, config);
    expect(uninstallZCode(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual({ mcp: { servers: { other: { command: 'y' } } } });
  });

  test('after a fresh install, uninstall leaves an empty config', () => {
    quiet();
    const configPath = scratchConfigPath();
    expect(installZCode(configPath)).toBe(0);
    expect(uninstallZCode(configPath)).toBe(0);
    expect(readConfig(configPath)).toEqual({});
  });

  test('keeps a user hooks.enabled false through install and uninstall', () => {
    quiet();
    spyOn(console, 'warn').mockImplementation(() => {});
    const configPath = scratchConfigPath();
    writeConfig(configPath, { hooks: { enabled: false } });
    expect(installZCode(configPath)).toBe(0);
    expect(uninstallZCode(configPath)).toBe(0);
    expect(readConfig(configPath).hooks).toEqual({ enabled: false });
  });

  test('with no config.json exits 0 and creates nothing', () => {
    quiet();
    const configPath = scratchConfigPath();
    expect(uninstallZCode(configPath)).toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  test('does not rewrite the file when none of ours is present', () => {
    quiet();
    const configPath = scratchConfigPath();
    const text = writeConfig(configPath, { theme: 'dark', hooks: { events: { PostToolUse: [USER_HOOK] } } });
    expect(uninstallZCode(configPath)).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(text);
    expect(backups(configPath)).toEqual([]);
  });

  test('exits 1 on a corrupt config and leaves it unchanged', () => {
    quiet();
    const configPath = scratchConfigPath();
    const text = writeConfig(configPath, '{ not json');
    expect(uninstallZCode(configPath)).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(text);
  });

  test('status: not installed exits 1 and says so', () => {
    const errors = quiet();
    const configPath = scratchConfigPath();
    expect(checkZCodeStatus(configPath)).toBe(1);
    expect(errors.mock.calls.flat().join('\n')).not.toContain('unreadable config');
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n')).toContain('not installed');
  });

  test('status: an unreadable config exits 1 and says unreadable, not not installed', () => {
    const errors = quiet();
    const configPath = scratchConfigPath();
    writeConfig(configPath, '[]');
    expect(checkZCodeStatus(configPath)).toBe(1);
    expect(errors.mock.calls.flat().join('\n')).toContain('unreadable config');
    expect((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n')).not.toContain('not installed');
  });
});

describe('readZCodeStatus', () => {
  const fullConfig = () => ({
    hooks: { enabled: true, events: buildZCodeHooks(BUN, WORKER) },
    mcp: { servers: { 'claude-mem': { command: 'node' }, other: { command: 'y' } } },
  });
  const statusOf = (content: unknown) => {
    const configPath = scratchConfigPath();
    writeConfig(configPath, content);
    return readZCodeStatus(configPath);
  };

  test('installed: every hook, hooks.enabled true and the MCP entry', () => {
    expect(statusOf(fullConfig()).status).toBe('installed');
  });

  test('installed also with a user hook on the same event', () => {
    const config = fullConfig();
    config.hooks.events.PostToolUse.unshift(USER_HOOK);
    expect(statusOf(config).status).toBe('installed');
  });

  test.each([
    ['missing', undefined],
    ['false', false],
    ['not a boolean', 'true'],
  ])('disabled when hooks.enabled is %s', (_label, enabled) => {
    const config: Record<string, any> = fullConfig();
    if (enabled === undefined) delete config.hooks.enabled;
    else config.hooks.enabled = enabled;
    expect(statusOf(config).status).toBe('disabled');
  });

  test('incomplete when one event is missing, and names it', () => {
    const config = fullConfig();
    delete (config.hooks.events as Record<string, unknown>).Stop;
    expect(statusOf(config)).toEqual({ status: 'incomplete', detail: 'missing Stop' });
  });

  test('incomplete when SessionStart has start but not context', () => {
    const config = fullConfig();
    config.hooks.events.SessionStart = config.hooks.events.SessionStart.slice(0, 1);
    expect(statusOf(config)).toEqual({ status: 'incomplete', detail: 'missing SessionStart' });
  });

  test('incomplete when the claude-mem MCP entry is missing', () => {
    const config = fullConfig();
    delete (config.mcp.servers as Record<string, unknown>)['claude-mem'];
    expect(statusOf(config)).toEqual({ status: 'incomplete', detail: 'missing the claude-mem MCP server' });
  });

  test('incomplete before disabled, so install is the first fix', () => {
    const config: Record<string, any> = fullConfig();
    delete config.hooks.enabled;
    delete config.mcp.servers['claude-mem'];
    expect(statusOf(config).status).toBe('incomplete');
  });

  test('incomplete when only the MCP entry is left', () => {
    const status = statusOf({ mcp: { servers: { 'claude-mem': { command: 'node' } } } });
    expect(status.status).toBe('incomplete');
    expect(status.detail).toContain('SessionStart');
  });

  test('not installed with no config, or with only user hooks and servers', () => {
    expect(readZCodeStatus(path.join(scratchConfigPath(), 'none.json')).status).toBe('not-installed');
    expect(statusOf({ hooks: { enabled: true, events: { PostToolUse: [USER_HOOK] } }, mcp: { servers: { other: {} } } }).status)
      .toBe('not-installed');
  });

  test('unreadable on invalid JSON or a wrong shape', () => {
    expect(statusOf('{ not json').status).toBe('unreadable');
    expect(statusOf({ hooks: [] }).status).toBe('unreadable');
  });

  test('status prints the label for the state and exits 0 only when installed', () => {
    const errors = quiet();
    const cases: Array<[ZCodeStatus, unknown]> = [
      ['installed', fullConfig()],
      ['disabled', { ...fullConfig(), hooks: { events: buildZCodeHooks(BUN, WORKER) } }],
      ['incomplete', { hooks: fullConfig().hooks }],
      ['not-installed', {}],
      ['unreadable', '[]'],
    ];
    for (const [status, content] of cases) {
      const configPath = scratchConfigPath();
      writeConfig(configPath, content);
      (console.log as unknown as { mockClear: () => void }).mockClear();
      errors.mockClear();
      expect(checkZCodeStatus(configPath)).toBe(status === 'installed' ? 0 : 1);
      const printed = [...(console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls, ...errors.mock.calls].flat().join('\n');
      expect(printed).toContain(`ZCode hooks: ${ZCODE_STATUS_LABELS[status]}`);
      rmSync(scratch!, { recursive: true, force: true });
    }
  });
});
