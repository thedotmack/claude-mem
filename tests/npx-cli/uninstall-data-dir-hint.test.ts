import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { preservedDataDirectoryHint } from '../../src/npx-cli/commands/uninstall.js';

/**
 * Uninstall keeps the data directory and prints how to remove it. The hint
 * must name the directory actually in use (CLAUDE_MEM_DATA_DIR) and give a
 * command the platform's shell can run: `rm -rf` fails in PowerShell and cmd.
 */
describe('uninstall: preserved data directory hint', () => {
  it('keeps the short hint for the default directory on macOS and Linux', () => {
    expect(preservedDataDirectoryHint('/home/alice/.claude-mem', 'linux', '/home/alice'))
      .toEqual({ location: '~/.claude-mem', removeCommand: 'rm -rf ~/.claude-mem' });
  });

  it('names a CLAUDE_MEM_DATA_DIR elsewhere, quoted for sh', () => {
    expect(preservedDataDirectoryHint("/srv/claude mem/bob's", 'darwin', '/Users/bob')).toEqual({
      location: "/srv/claude mem/bob's",
      removeCommand: "rm -rf '/srv/claude mem/bob'\\''s'",
    });
  });

  it('gives Windows a PowerShell removal instead of rm -rf', () => {
    expect(preservedDataDirectoryHint("C:\\Users\\O'Neil\\.claude-mem", 'win32', "C:\\Users\\O'Neil")).toEqual({
      location: "C:\\Users\\O'Neil\\.claude-mem",
      removeCommand: `powershell -c "Remove-Item -LiteralPath 'C:\\Users\\O''Neil\\.claude-mem' -Recurse -Force"`,
    });
  });
});

describe("uninstall: the hint's command removes the directory", () => {
  function scratchDataDirectory(): { parent: string; dataDirectory: string } {
    const parent = mkdtempSync(join(tmpdir(), 'claude-mem-uninstall-hint-'));
    const dataDirectory = join(parent, "it's data");
    mkdirSync(join(dataDirectory, 'logs'), { recursive: true });
    writeFileSync(join(dataDirectory, 'logs', 'claude-mem.log'), 'line\n');
    return { parent, dataDirectory };
  }

  it.skipIf(process.platform !== 'win32')('in cmd on Windows', () => {
    const { parent, dataDirectory } = scratchDataDirectory();
    try {
      const { removeCommand } = preservedDataDirectoryHint(dataDirectory, 'win32');
      const run = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${removeCommand}"`], {
        encoding: 'utf-8',
        windowsVerbatimArguments: true,
        timeout: 30_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(dataDirectory)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === 'win32')('in sh on macOS and Linux', () => {
    const { parent, dataDirectory } = scratchDataDirectory();
    try {
      const { removeCommand } = preservedDataDirectoryHint(dataDirectory, process.platform);
      const run = spawnSync('/bin/sh', ['-c', removeCommand], { encoding: 'utf-8' });
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(dataDirectory)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
