import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as toml from '@iarna/toml';
import {
  installKimiCodeHooks,
  uninstallKimiCodeHooks,
} from '../../src/services/integrations/KimiCodeHooksInstaller.js';

describe('Kimi Code CLI installer config registration', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `kimi-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    previousConfigDir = process.env.KIMI_CODE_CONFIG_DIR;
    process.env.KIMI_CODE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.KIMI_CODE_CONFIG_DIR;
    } else {
      process.env.KIMI_CODE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readConfig(): any {
    const configPath = join(tempDir, 'config.toml');
    return toml.parse(readFileSync(configPath, 'utf-8'));
  }

  it('creates config.toml when missing', async () => {
    const result = await installKimiCodeHooks();
    expect(result).toBe(0);

    const config = readConfig();
    expect(Array.isArray(config.hooks)).toBe(true);
    expect(config.hooks.length).toBe(4);
    expect(config.hooks.map((h: any) => h.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'Stop',
    ]);
    expect(config.hooks.every((h: any) => h.name === 'claude-mem')).toBe(true);
    expect(config.hooks.every((h: any) => h.timeout === 120000)).toBe(true);
  });

  it('preserves existing hooks and settings', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(
      configPath,
      [
        'default_model = "kimi-code/kimi-for-coding"',
        '',
        '[[hooks]]',
        'event = "PreToolUse"',
        'command = "bash ~/.kimi-code/hooks/pre.sh"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await installKimiCodeHooks();
    expect(result).toBe(0);

    const config = readConfig();
    expect(config.default_model).toBe('kimi-code/kimi-for-coding');
    expect(config.hooks.length).toBe(5);
    expect(config.hooks[0].event).toBe('PreToolUse');
    expect(config.hooks.slice(1).every((h: any) => h.name === 'claude-mem')).toBe(true);
  });

  it('is idempotent across repeated installs', async () => {
    await installKimiCodeHooks();
    const result = await installKimiCodeHooks();
    expect(result).toBe(0);

    const config = readConfig();
    expect(config.hooks.length).toBe(4);
  });

  it('removes only claude-mem hooks during uninstall', async () => {
    const configPath = join(tempDir, 'config.toml');
    writeFileSync(
      configPath,
      [
        '[[hooks]]',
        'event = "PreToolUse"',
        'command = "bash ~/.kimi-code/hooks/pre.sh"',
        '',
        '[[hooks]]',
        'event = "Stop"',
        'name = "claude-mem"',
        'command = "/bin/bun worker-service.cjs hook kimi-code summarize"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = uninstallKimiCodeHooks();
    expect(result).toBe(0);

    const config = readConfig();
    expect(config.hooks.length).toBe(1);
    expect(config.hooks[0].event).toBe('PreToolUse');
  });

  it('succeeds uninstall when config is missing', () => {
    const result = uninstallKimiCodeHooks();
    expect(result).toBe(0);
    expect(existsSync(join(tempDir, 'config.toml'))).toBe(false);
  });
});
