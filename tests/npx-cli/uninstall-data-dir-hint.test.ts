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
 * Pasting it must remove that directory and nothing else.
 */
describe('uninstall: preserved data directory hint', () => {
  it('keeps the short hint for the default directory on macOS and Linux', () => {
    expect(preservedDataDirectoryHint('/home/alice/.claude-mem', 'linux', '/home/alice'))
      .toEqual({ location: '~/.claude-mem', removeCommand: 'rm -rf ~/.claude-mem', shell: 'sh' });
  });

  it('names a CLAUDE_MEM_DATA_DIR elsewhere, quoted for sh and after --', () => {
    expect(preservedDataDirectoryHint("/srv/claude mem/bob's", 'darwin', '/Users/bob')).toEqual({
      location: "/srv/claude mem/bob's",
      removeCommand: "rm -rf -- '/srv/claude mem/bob'\\''s'",
      shell: 'sh',
    });
    expect(preservedDataDirectoryHint('-memory', 'linux', '/home/alice').removeCommand).toBe("rm -rf -- '-memory'");
  });

  it('gives Windows a PowerShell command with the path in single quotes', () => {
    expect(preservedDataDirectoryHint("C:\\Users\\O'Neil\\.claude-mem", 'win32', "C:\\Users\\O'Neil")).toEqual({
      location: "C:\\Users\\O'Neil\\.claude-mem",
      removeCommand: "Remove-Item -LiteralPath 'C:\\Users\\O''Neil\\.claude-mem' -Recurse -Force",
      shell: 'PowerShell',
    });
  });

  it('doubles the curly single quotes PowerShell also ends a string at', () => {
    expect(preservedDataDirectoryHint('C:\\data\\\u2018a\u2019 \u201Ab\u201B', 'win32').removeCommand)
      .toBe("Remove-Item -LiteralPath 'C:\\data\\\u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B' -Recurse -Force");
  });
});

describe("uninstall: pasting the hint's command removes only the data directory", () => {
  // Characters a shell could expand or end a quote at. Under the old
  // `powershell -c "…"` hint, `$archive` expanded to nothing in the pasting
  // shell and Remove-Item took the parent directory instead.
  const hostileName = "$archive `$(Get-Date) it's \u2019 data";

  function scratchDataDirectory(name: string): { parent: string; dataDirectory: string; sibling: string } {
    const parent = mkdtempSync(join(tmpdir(), 'claude-mem-uninstall-hint-'));
    const dataDirectory = join(parent, name);
    mkdirSync(join(dataDirectory, 'logs'), { recursive: true });
    writeFileSync(join(dataDirectory, 'logs', 'claude-mem.log'), 'line\n');
    const sibling = join(parent, 'another-project.txt');
    writeFileSync(sibling, 'keep\n');
    return { parent, dataDirectory, sibling };
  }

  it.skipIf(process.platform !== 'win32')('in PowerShell on Windows', () => {
    for (const name of ['$archive', hostileName]) {
      const { parent, dataDirectory, sibling } = scratchDataDirectory(name);
      try {
        const { removeCommand } = preservedDataDirectoryHint(dataDirectory, 'win32');
        // A script file is parsed exactly like a pasted line. The BOM makes
        // Windows PowerShell 5.1 read it as UTF-8.
        const script = join(tmpdir(), `claude-mem-uninstall-hint-${process.pid}.ps1`);
        writeFileSync(script, `\uFEFF${removeCommand}\r\n`);
        const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
          encoding: 'utf-8',
          timeout: 30_000,
        });
        rmSync(script, { force: true });
        expect(run.status, run.stderr).toBe(0);
        expect(existsSync(sibling), `${name}: the parent directory was removed`).toBe(true);
        expect(existsSync(dataDirectory), `${name}: still there`).toBe(false);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it.skipIf(process.platform === 'win32')('in sh on macOS and Linux, a relative name starting with - included', () => {
    for (const name of [hostileName, "-memory $HOME it's"]) {
      const { parent, dataDirectory, sibling } = scratchDataDirectory(name);
      try {
        for (const target of [dataDirectory, name]) {
          mkdirSync(join(dataDirectory, 'logs'), { recursive: true });
          const { removeCommand } = preservedDataDirectoryHint(target, process.platform);
          const run = spawnSync('/bin/sh', ['-c', removeCommand], { cwd: parent, encoding: 'utf-8' });
          expect(run.status, run.stderr).toBe(0);
          expect(existsSync(dataDirectory)).toBe(false);
          expect(existsSync(sibling)).toBe(true);
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });
});
