import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// `npx claude-mem install --ide cursor` adds claude-mem's hooks to
// ~/.cursor/hooks.json and its MCP server to ~/.cursor/mcp.json, and uninstall
// removes them. uninstallCursorHooks() also removes hooks and scripts named like
// the legacy ones (session-init.sh, common.sh, ...), so uninstall must leave a
// ~/.cursor without claude-mem's entries alone. The installer finds ~/.cursor
// through the home directory, so the calls run in a child process whose home
// directory is under the temp dir.
const CURSOR_INSTALLER = path.resolve(import.meta.dir, '../../src/services/integrations/CursorHooksInstaller.ts');
const UNINSTALL_COMMAND = path.resolve(import.meta.dir, '../../src/npx-cli/commands/uninstall.ts');

describe('uninstall: Cursor hooks + MCP', () => {
  let tmp: string;
  let home: string;
  let project: string;
  let plugin: string;
  let userCursorDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'uninstall-cursor-'));
    home = path.join(tmp, 'home');
    project = path.join(tmp, 'project');
    plugin = path.join(tmp, 'plugin');
    userCursorDir = path.join(home, '.cursor');
    mkdirSync(userCursorDir, { recursive: true });
    mkdirSync(project);
    mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    writeFileSync(path.join(plugin, 'scripts', 'worker-service.cjs'), '');
    writeFileSync(path.join(plugin, 'scripts', 'mcp-server.cjs'), '');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Runs `body` in a child process, with `cursor` and `uninstall` imported, and returns its result. */
  function run(body: string): unknown {
    const child = Bun.spawnSync([process.execPath, '-e', [
      `const cursor = await import(${JSON.stringify(CURSOR_INSTALLER)});`,
      `const uninstall = await import(${JSON.stringify(UNINSTALL_COMMAND)});`,
      `console.log(JSON.stringify(await (async () => { ${body} })()));`,
    ].join('\n')], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        CLAUDE_MEM_DATA_DIR: path.join(home, '.claude-mem'),
        CLAUDE_PLUGIN_ROOT: plugin,
      },
    });
    if (child.exitCode !== 0) throw new Error(`child exited with ${child.exitCode}: ${child.stderr.toString()}`);
    return JSON.parse(child.stdout.toString().trim().split(/\r?\n/).at(-1)!);
  }

  // Hooks the user wrote, laid out like the example in Cursor's hooks docs
  // (~/.cursor/hooks/format.sh, run as ./hooks/format.sh). Some share the
  // legacy script names.
  const userScripts = ['format.sh', 'session-init.sh', 'session-summary.sh', 'common.sh'];
  const userHooksJson = JSON.stringify({
    version: 1,
    hooks: {
      afterFileEdit: [{ command: './hooks/format.sh' }],
      beforeSubmitPrompt: [{ command: './hooks/session-init.sh' }],
      stop: [{ command: './hooks/session-summary.sh' }],
    },
  }, null, 2);
  const userMcpJson = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } });

  function writeUserHooks(cursorDir: string): void {
    mkdirSync(path.join(cursorDir, 'hooks'), { recursive: true });
    writeFileSync(path.join(cursorDir, 'hooks.json'), userHooksJson);
    for (const script of userScripts) writeFileSync(path.join(cursorDir, 'hooks', script), '#!/bin/sh\n');
  }

  it('leaves a ~/.cursor with only the user\'s own hooks as it is', () => {
    writeUserHooks(userCursorDir);

    expect(run('return uninstall.removeCursorIntegration();')).toBe(0);

    expect(readFileSync(path.join(userCursorDir, 'hooks.json'), 'utf-8')).toBe(userHooksJson);
    for (const script of userScripts) expect(existsSync(path.join(userCursorDir, 'hooks', script))).toBe(true);
  });

  it('leaves a hooks.json the user created without hooks in place', () => {
    const emptyHooksJson = JSON.stringify({ version: 1, hooks: {} });
    writeFileSync(path.join(userCursorDir, 'hooks.json'), emptyHooksJson);

    expect(run('return uninstall.removeCursorIntegration();')).toBe(0);

    expect(readFileSync(path.join(userCursorDir, 'hooks.json'), 'utf-8')).toBe(emptyHooksJson);
  });

  it('removes the hooks and MCP server install --ide cursor added, and keeps the user\'s', () => {
    const userHooks = { version: 1, hooks: { beforeShellExecution: [{ command: './guard.sh' }] } };
    writeFileSync(path.join(userCursorDir, 'hooks.json'), JSON.stringify(userHooks));
    writeFileSync(path.join(userCursorDir, 'mcp.json'), userMcpJson);

    expect(run(`return [
      await cursor.installCursorHooks('user'),
      cursor.configureCursorMcp('user'),
      await uninstall.removeCursorIntegration(),
    ];`)).toEqual([0, 0, 0]);

    expect(JSON.parse(readFileSync(path.join(userCursorDir, 'hooks.json'), 'utf-8'))).toEqual(userHooks);
    expect(JSON.parse(readFileSync(path.join(userCursorDir, 'mcp.json'), 'utf-8'))).toEqual(JSON.parse(userMcpJson));
  });

  it('still removes claude-mem\'s hooks when mcp.json does not parse, and fails', () => {
    writeFileSync(path.join(userCursorDir, 'mcp.json'), '{ not json');

    expect(run(`return [await cursor.installCursorHooks('user'), await uninstall.removeCursorIntegration()];`)).toEqual([0, 1]);

    expect(existsSync(path.join(userCursorDir, 'hooks.json'))).toBe(false);
    expect(readFileSync(path.join(userCursorDir, 'mcp.json'), 'utf-8')).toBe('{ not json');
  });

  for (const target of ['user', 'project'] as const) {
    describe(`hasCursorIntegration('${target}')`, () => {
      const cursorDir = () => (target === 'user' ? userCursorDir : path.join(project, '.cursor'));

      it('is false when the hooks there are the user\'s own', () => {
        writeUserHooks(cursorDir());
        writeFileSync(path.join(cursorDir(), 'mcp.json'), userMcpJson);

        expect(run(`return cursor.hasCursorIntegration('${target}');`)).toBe(false);
      });

      it('is true after installCursorHooks', () => {
        writeUserHooks(cursorDir());

        expect(run(`return [await cursor.installCursorHooks('${target}'), cursor.hasCursorIntegration('${target}')];`)).toEqual([0, true]);
      });

      it('is true after configureCursorMcp', () => {
        writeUserHooks(cursorDir());

        expect(run(`return [cursor.configureCursorMcp('${target}'), cursor.hasCursorIntegration('${target}')];`)).toEqual([0, true]);
      });
    });
  }
});
