import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

// Regression test for issue #4764: `npx claude-mem install --help` should
// print help text, not run the install.

describe('install --help flag', () => {
  const NODE_BIN = process.execPath;
  const CLI_PATH = join(import.meta.dir, '../../dist/npx-cli/index.js');

  it('shows help when --help is passed to install command', () => {
    const result = spawnSync(NODE_BIN, [CLI_PATH, 'install', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
    expect(result.stdout).toContain('npx claude-mem install');
    // Should NOT contain install prompts or attempts to run
    expect(result.stdout).not.toContain('Installing');
    expect(result.stderr).toBe('');
  });

  it('shows help when -h is passed to install command', () => {
    const result = spawnSync(NODE_BIN, [CLI_PATH, 'install', '-h'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
  });

  it('shows version when --version is passed to install command', () => {
    const result = spawnSync(NODE_BIN, [CLI_PATH, 'install', '--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(result.stdout).not.toContain('Install Commands');
  });

  it('shows help when --help is passed to repair command', () => {
    const result = spawnSync(NODE_BIN, [CLI_PATH, 'repair', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
  });

  it('shows help when --help is passed to update command', () => {
    const result = spawnSync(NODE_BIN, [CLI_PATH, 'update', '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('claude-mem');
    expect(result.stdout).toContain('Install Commands');
  });
});
