import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const INSTALLER = path.resolve(import.meta.dir, '../../src/services/integrations/WindsurfHooksInstaller.ts');
const OWN = { command: '"/old/bin/bun" "/old/plugin/scripts/worker-service.cjs" hook windsurf observation', show_output: false };
const USER_HOOKS = [
  { command: 'python3 /opt/windsurf/worker-service/audit.py', show_output: true },
  { command: 'printf "windsurf worker-service finished\\n" >> hooks.log', show_output: false },
  { command: '"/usr/bin/echo" "/old/plugin/scripts/worker-service.cjs" hook windsurf observation', show_output: true },
  { command: `${OWN.command} && ./notify.sh`, show_output: true },
];

describe('Windsurf install and uninstall preserve user hook commands', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'windsurf-hook-owner-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(mode: 'install' | 'uninstall', hooks: Record<string, unknown[]>) {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const hooksPath = path.join(home, '.codeium', 'windsurf', 'hooks.json');
    const pluginRoot = path.join(root, 'plugin');
    const bunRoot = path.join(root, 'runtime');
    for (const dir of [workspace, path.dirname(hooksPath), path.join(pluginRoot, 'scripts'), path.join(bunRoot, 'bin')]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(hooksPath, JSON.stringify({ hooks }));
    // Installation checks the paths but does not execute either fixture file.
    const bunPath = path.join(bunRoot, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
    writeFileSync(bunPath, 'fixture runtime');
    chmodSync(bunPath, 0o755);
    writeFileSync(path.join(pluginRoot, 'scripts', 'worker-service.cjs'), 'fixture worker');
    const scriptPath = path.join(root, 'run-installer.mjs');
    writeFileSync(scriptPath, `
      console.log = () => {};
      console.error = () => {};
      globalThis.fetch = async () => new Response('owned context');
      const { readFileSync, existsSync } = await import('node:fs');
      const installer = await import(${JSON.stringify(INSTALLER)});
      const configPath = ${JSON.stringify(hooksPath)};
      const read = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
      if (${JSON.stringify(mode)} === 'install') {
        const firstCode = await installer.installWindsurfHooks();
        const first = read();
        const secondCode = await installer.installWindsurfHooks();
        const second = read();
        const uninstallCode = installer.uninstallWindsurfHooks();
        process.stdout.write(JSON.stringify({ firstCode, secondCode, first, second, uninstallCode, remaining: read() }));
      } else {
        const uninstallCode = installer.uninstallWindsurfHooks();
        process.stdout.write(JSON.stringify({ uninstallCode, remaining: read() }));
      }
    `);
    const stdout = execFileSync(process.execPath, [scriptPath], {
      cwd: workspace,
      env: { ...process.env, HOME: home, USERPROFILE: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_MEM_DATA_DIR: path.join(home, '.claude-mem'),
        CLAUDE_PLUGIN_ROOT: pluginRoot, BUN_INSTALL: bunRoot,
        DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '0',
      },
      encoding: 'utf8', timeout: 15_000,
    });
    return JSON.parse(stdout);
  }

  it('preserves audit and notification hooks on reinstall while replacing only the installed command', () => {
    const result = run('install', { post_run_command: [...USER_HOOKS, OWN] });
    expect(result.firstCode).toBe(0);
    expect(result.secondCode).toBe(0);
    expect(result.first.hooks.post_run_command.slice(0, USER_HOOKS.length)).toEqual(USER_HOOKS);
    expect(result.first.hooks.post_run_command).toHaveLength(USER_HOOKS.length + 1);
    expect(result.second).toEqual(result.first);
    expect(result.uninstallCode).toBe(0);
    expect(result.remaining).toEqual({ hooks: { post_run_command: USER_HOOKS } });
  });

  it('uninstalls its own command without deleting a user script or shell wrapper', () => {
    const result = run('uninstall', { post_run_command: [...USER_HOOKS, OWN] });
    expect(result.uninstallCode).toBe(0);
    expect(result.remaining).toEqual({ hooks: { post_run_command: USER_HOOKS } });
  });

  it('still removes the generated command forms for bare, POSIX and Windows runtimes', () => {
    const commands = [
      '"bun" "worker-service.cjs" hook windsurf session-init',
      '"/usr/local/bin/bun" "/plugin/scripts/worker-service.cjs" hook windsurf file-edit',
      '& "C:\\Tools\\Bun.exe" "C:\\Users\\Owner\\plugin\\scripts\\worker-service.cjs" hook windsurf observation',
    ];
    const result = run('uninstall', { pre_user_prompt: commands.map(command => ({ command, show_output: false })) });
    expect(result.uninstallCode).toBe(0);
    expect(result.remaining).toBeNull();
  });
});
