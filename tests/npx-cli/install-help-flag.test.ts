import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'child_process';

// Regression test for issue #4764: `npx claude-mem install --help` should
// print help text, not run the install.

describe('install --help flag', () => {
  const REPO_ROOT = join(import.meta.dir, '../..');
  const CLI_PATH = join(REPO_ROOT, 'dist/npx-cli/index.js');
  let tempDirs: string[] = [];

  beforeAll(() => {
    // Build the CLI so tests exercise current source without stale artifacts
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error('Build failed');
    }
  });

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  function runCli(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
    const tempHome = mkdtempSync(join(tmpdir(), 'claude-mem-home-'));
    tempDirs.push(tempHome);
    const env = {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      CLAUDE_CONFIG_DIR: join(tempHome, '.config', 'claude'),
      CLAUDE_MEM_DATA_DIR: join(tempHome, '.claude-mem'),
      XDG_CONFIG_HOME: join(tempHome, '.config'),
      XDG_DATA_HOME: join(tempHome, '.local', 'share'),
      CLAUDE_MEM_TELEMETRY: '0',
      DO_NOT_TRACK: '1',
    };
    const proc = Bun.spawnSync({
      cmd: [process.execPath, CLI_PATH, ...args],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  it('shows help when --help is passed to install command', () => {
    const result = runCli(['install', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
    expect(result.stdout).toContain('npx claude-mem install');
    // Should NOT contain install prompts or attempts to run
    expect(result.stdout).not.toContain('Installing');
    expect(result.stderr).toBe('');
  });

  it('shows help when -h is passed to install command', () => {
    const result = runCli(['install', '-h']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
  });

  it('shows version when --version is passed to install command', () => {
    const result = runCli(['install', '--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(result.stdout).not.toContain('Install Commands');
  });

  it('shows help when --help is passed to repair command', () => {
    const result = runCli(['repair', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
  });

  it('shows help when --help is passed to update command', () => {
    const result = runCli(['update', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
  });
});
