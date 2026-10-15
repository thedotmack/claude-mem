import { describe, expect, it, spyOn, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';

// Regression test for issue #4764: `npx claude-mem install --help` should
// print help text, not run the install.

describe('install --help flag', () => {
  const CLI_PATH = join(import.meta.dir, '../../src/npx-cli/index.ts');
  let consoleLogSpy: ReturnType<typeof spyOn> | null = null;
  let exitSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  it('shows help when --help is passed to install command', async () => {
    const captured: string[] = [];
    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args) => {
      captured.push(args.join(' '));
    });
    exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Simulate: npx claude-mem install --help
    process.argv = ['node', 'claude-mem', 'install', '--help'];

    try {
      await import(`${CLI_PATH}?t=${Date.now()}`);
    } catch (e) {
      // Expected if process.exit is called
    }

    const output = captured.join('\n');
    expect(output).toContain('claude-mem');
    expect(output).toContain('Install Commands');
    expect(output).toContain('npx claude-mem install');
    // Should NOT contain install prompts or progress
    expect(output).not.toContain('Installing');
  });

  it('shows help when -h is passed to install command', async () => {
    const captured: string[] = [];
    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args) => {
      captured.push(args.join(' '));
    });
    exitSpy = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Simulate: npx claude-mem install -h
    process.argv = ['node', 'claude-mem', 'install', '-h'];

    try {
      await import(`${CLI_PATH}?t=${Date.now()}`);
    } catch (e) {
      // Expected if process.exit is called
    }

    const output = captured.join('\n');
    expect(output).toContain('claude-mem');
    expect(output).toContain('Install Commands');
  });

  it('shows version when --version is passed to install command', async () => {
    const captured: string[] = [];
    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args) => {
      captured.push(args.join(' '));
    });

    // Simulate: npx claude-mem install --version
    process.argv = ['node', 'claude-mem', 'install', '--version'];

    try {
      await import(`${CLI_PATH}?t=${Date.now()}`);
    } catch (e) {
      // Expected if process.exit is called
    }

    const output = captured.join('\n');
    // Should print version string (e.g., "13.39.0")
    expect(output).toMatch(/\d+\.\d+\.\d+/);
    expect(output).not.toContain('Install Commands');
  });

  it('shows help when --help is passed to repair command', async () => {
    const captured: string[] = [];
    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args) => {
      captured.push(args.join(' '));
    });

    // Simulate: npx claude-mem repair --help
    process.argv = ['node', 'claude-mem', 'repair', '--help'];

    try {
      await import(`${CLI_PATH}?t=${Date.now()}`);
    } catch (e) {
      // Expected if process.exit is called
    }

    const output = captured.join('\n');
    expect(output).toContain('claude-mem');
    expect(output).toContain('Install Commands');
  });

  it('shows help when --help is passed to update command', async () => {
    const captured: string[] = [];
    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args) => {
      captured.push(args.join(' '));
    });

    // Simulate: npx claude-mem update --help
    process.argv = ['node', 'claude-mem', 'update', '--help'];

    try {
      await import(`${CLI_PATH}?t=${Date.now()}`);
    } catch (e) {
      // Expected if process.exit is called
    }

    const output = captured.join('\n');
    expect(output).toContain('claude-mem');
    expect(output).toContain('Install Commands');
  });
});
