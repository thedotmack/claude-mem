import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getBunAbsolutePath } from '../../src/services/integrations/install-paths.js';
import { installKimiHooks } from '../../src/services/integrations/KimiHooksInstaller.js';

const originalEnv = {
  BUN_INSTALL: process.env.BUN_INSTALL,
  KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
};
let scratch: string;
let bunPath: string;

describe.skipIf(process.platform === 'win32')('installer Bun discovery', () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'installer-bun-paths-'));
    const bunInstall = join(scratch, 'custom bun runtime');
    mkdirSync(join(bunInstall, 'bin'), { recursive: true });
    bunPath = join(bunInstall, 'bin', 'bun');
    symlinkSync(process.execPath, bunPath);
    process.env.BUN_INSTALL = bunInstall;
    process.env.KIMI_CODE_HOME = join(scratch, 'kimi');
    process.env.CLAUDE_PLUGIN_ROOT = join(scratch, 'plugin');
    mkdirSync(join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts'), { recursive: true });
    writeFileSync(join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'worker-service.cjs'),
      'console.log(JSON.stringify({ marker: "fixture-worker", args: process.argv.slice(2) }));\n');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  test('resolves the configured runtime after the module was imported', () => {
    expect(getBunAbsolutePath()).toBe(bunPath);
  });

  test('installs a hook that runs the configured Bun without a host PATH', () => {
    expect(installKimiHooks()).toBe(0);
    const config = Bun.TOML.parse(readFileSync(join(process.env.KIMI_CODE_HOME!, 'config.toml'), 'utf-8'));
    const hooks = config.hooks as Array<{ event: string; command: string }>;
    const command = hooks.find(hook => hook.event === 'PostToolUse')!.command;
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: join(scratch, 'empty-path') },
      timeout: 5_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ marker: 'fixture-worker', args: ['hook', 'kimi', 'observation'] });
    expect(command).toStartWith(`"${bunPath}" `);
  });
});
