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
});
