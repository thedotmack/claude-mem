import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// install/uninstall must treat ~/.cursor/hooks.json as shared with the user:
// only entries running `worker-service ... hook cursor` are claude-mem's.
describe('Cursor hooks.json install/uninstall preserves user hooks', () => {
  let tmp: string;
  let home: string;
  let hooksJsonPath: string;
  let originalCwd: string;
  const saved: Record<string, string | undefined> = {};

  const userHook = { command: './my-audit.sh' };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'cursor-hooks-')));
    home = path.join(tmp, 'workspace');
    const pluginRoot = path.join(tmp, 'plugin');
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'scripts', 'worker-service.cjs'), '');
    hooksJsonPath = path.join(home, '.cursor', 'hooks.json');
    for (const key of ['CLAUDE_PLUGIN_ROOT']) saved[key] = process.env[key];
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    // Use the 'project' target (.cursor under cwd): never touches the real ~/.cursor.
    originalCwd = process.cwd();
    process.chdir(home);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function installer() {
    const mod = await import('../../src/services/integrations/CursorHooksInstaller.js');
    // Safety: the hooks.json under test must live in the temp workspace.
    expect(path.dirname(hooksJsonPath)).toBe(mod.getTargetDir('project')!);
    return mod;
  }

  const read = () => JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
  const isOurs = (h: { command: string }) => h.command.includes('worker-service') && h.command.includes('hook cursor');

  it('install keeps the user\'s hooks and is idempotent', async () => {
    writeFileSync(hooksJsonPath, JSON.stringify({
      version: 1,
      hooks: { stop: [userHook], beforeShellExecution: [{ command: './guard.sh' }] },
    }));
    const { installCursorHooks } = await installer();

    expect(await installCursorHooks('project')).toBe(0);
    expect(await installCursorHooks('project')).toBe(0);

    const config = read();
    expect(config.hooks.stop.filter(isOurs)).toHaveLength(1);
    expect(config.hooks.stop).toContainEqual(userHook);
    expect(config.hooks.beforeShellExecution).toEqual([{ command: './guard.sh' }]);
    expect(config.hooks.beforeSubmitPrompt.filter(isOurs)).toHaveLength(2);
  });

  it('install refuses to overwrite an unparseable hooks.json', async () => {
    writeFileSync(hooksJsonPath, '{ not json');
    const { installCursorHooks } = await installer();

    expect(await installCursorHooks('project')).toBe(1);
    expect(readFileSync(hooksJsonPath, 'utf-8')).toBe('{ not json');
  });

  it('uninstall removes only claude-mem entries and keeps the user\'s', async () => {
    writeFileSync(hooksJsonPath, JSON.stringify({ version: 1, hooks: { stop: [userHook] } }));
    const { installCursorHooks, uninstallCursorHooks } = await installer();
    expect(await installCursorHooks('project')).toBe(0);

    expect(uninstallCursorHooks('project')).toBe(0);

    expect(existsSync(hooksJsonPath)).toBe(true);
    expect(read()).toEqual({ version: 1, hooks: { stop: [userHook] } });
  });

  it('uninstall deletes hooks.json when claude-mem was its only author', async () => {
    const { installCursorHooks, uninstallCursorHooks } = await installer();
    expect(await installCursorHooks('project')).toBe(0);

    expect(uninstallCursorHooks('project')).toBe(0);

    expect(existsSync(hooksJsonPath)).toBe(false);
  });

  it('uninstall leaves an unparseable hooks.json untouched', async () => {
    writeFileSync(hooksJsonPath, '{ not json');
    const { uninstallCursorHooks } = await installer();

    expect(uninstallCursorHooks('project')).toBe(0);
    expect(readFileSync(hooksJsonPath, 'utf-8')).toBe('{ not json');
  });

  // Older installers pointed hooks.json at scripts copied into .cursor/hooks/.
  const legacyEntry = { command: './.cursor/hooks/session-init.sh' };
  const legacyPowerShellEntry = { command: 'powershell.exe -ExecutionPolicy Bypass -File "C:\\Users\\me\\.cursor\\hooks/session-summary.ps1"' };
  const lookalikeUserHook = { command: './my-session-init.sh' };

  it('install replaces legacy script entries instead of running both', async () => {
    writeFileSync(hooksJsonPath, JSON.stringify({
      version: 1,
      hooks: { beforeSubmitPrompt: [legacyEntry, lookalikeUserHook], stop: [legacyPowerShellEntry] },
    }));
    const { installCursorHooks } = await installer();

    expect(await installCursorHooks('project')).toBe(0);

    const config = read();
    expect(config.hooks.beforeSubmitPrompt).not.toContainEqual(legacyEntry);
    expect(config.hooks.beforeSubmitPrompt).toContainEqual(lookalikeUserHook);
    expect(config.hooks.beforeSubmitPrompt.filter(isOurs)).toHaveLength(2);
    expect(config.hooks.stop).not.toContainEqual(legacyPowerShellEntry);
    expect(config.hooks.stop.filter(isOurs)).toHaveLength(1);
  });

  it('uninstall removes legacy script entries along with their scripts', async () => {
    const legacyScript = path.join(home, '.cursor', 'hooks', 'session-init.sh');
    mkdirSync(path.dirname(legacyScript), { recursive: true });
    writeFileSync(legacyScript, '#!/bin/sh\n');
    writeFileSync(hooksJsonPath, JSON.stringify({
      version: 1,
      hooks: { beforeSubmitPrompt: [legacyEntry, lookalikeUserHook] },
    }));
    const { uninstallCursorHooks } = await installer();

    expect(uninstallCursorHooks('project')).toBe(0);

    expect(read()).toEqual({ version: 1, hooks: { beforeSubmitPrompt: [lookalikeUserHook] } });
    expect(existsSync(legacyScript)).toBe(false);
  });

  for (const [label, malformed] of [
    ['an event value that is not an array', { version: 1, hooks: { stop: { command: 'x' } } }],
    ['a hooks value that is not an object', { version: 1, hooks: ['x'] }],
  ] as const) {
    it(`install and uninstall leave hooks.json untouched when it has ${label}`, async () => {
      const original = JSON.stringify(malformed);
      writeFileSync(hooksJsonPath, original);
      const { installCursorHooks, uninstallCursorHooks } = await installer();

      expect(await installCursorHooks('project')).toBe(1);
      expect(readFileSync(hooksJsonPath, 'utf-8')).toBe(original);

      expect(uninstallCursorHooks('project')).toBe(0);
      expect(readFileSync(hooksJsonPath, 'utf-8')).toBe(original);
    });
  }

  async function projectStatusLines(): Promise<string[]> {
    const { checkCursorHooksStatus } = await installer();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      expect(checkCursorHooksStatus()).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const start = lines.findIndex((line) => line.startsWith('Project:'));
    const end = lines.indexOf('', start);
    return lines.slice(start, end);
  }

  it('status reports not installed when only the user\'s hooks remain after uninstall', async () => {
    writeFileSync(hooksJsonPath, JSON.stringify({ version: 1, hooks: { stop: [userHook] } }));
    const { installCursorHooks, uninstallCursorHooks } = await installer();
    expect(await installCursorHooks('project')).toBe(0);
    expect(uninstallCursorHooks('project')).toBe(0);

    expect((await projectStatusLines())[0]).toBe('Project: Not installed (hooks.json has 1 user hook)');
  });

  it('status reports unified mode even when a user hook comes first', async () => {
    const { installCursorHooks } = await installer();
    expect(await installCursorHooks('project')).toBe(0);
    const config = read();
    config.hooks.beforeSubmitPrompt.unshift(userHook);
    writeFileSync(hooksJsonPath, JSON.stringify(config));

    const status = await projectStatusLines();
    expect(status[0]).toBe('Project: Installed');
    expect(status).toContain('   Mode: Unified CLI (bun worker-service.cjs)');
    expect(status).toContain('   Other hooks: 1 (preserved)');
  });

  it('status recognises a legacy script install', async () => {
    writeFileSync(hooksJsonPath, JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [legacyEntry] } }));

    const status = await projectStatusLines();
    expect(status[0]).toBe('Project: Installed');
    expect(status).toContain('   Mode: Legacy shell scripts (consider reinstalling for unified CLI)');
    expect(status).toContain('   Platform: Unix (bash)');
  });
});
