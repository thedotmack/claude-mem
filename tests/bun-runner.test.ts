import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, win32 } from 'path';

const BUN_RUNNER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');
const source = readFileSync(BUN_RUNNER_PATH, 'utf-8');

// Extract findBun() so it can be exercised with a mocked spawnSync on any
// platform (the script itself has top-level side effects and cannot be
// imported directly).
const findBunSource = source.slice(
  source.indexOf('function findBun() {'),
  source.indexOf('function isPluginDisabledInClaudeSettings')
);

interface WhereResult {
  status: number | null;
  stdout: string;
}

function runFindBun(
  whereResult: WhereResult,
  { isWindows = true, existingPaths = [] as string[] } = {}
): string | null {
  const factory = new Function(
    'spawnSync',
    'IS_WINDOWS',
    'join',
    'homedir',
    'existsSync',
    `${findBunSource}\nreturn findBun();`
  );
  return factory(
    () => whereResult,
    isWindows,
    isWindows ? win32.join : join,
    () => (isWindows ? 'C:\\Users\\test' : '/home/test'),
    (p: string) => existingPaths.includes(p)
  );
}

describe('bun-runner.js findBun: DEP0190 regression guard (#1503)', () => {
  it('does not use separate args array with shell:true (DEP0190 trigger pattern)', () => {
    const vulnerablePattern = /spawnSync\s*\(\s*(?:IS_WINDOWS\s*\?\s*['"]where['"]\s*:[^)]+|['"]where['"]),\s*\[[^\]]+\],\s*\{[^}]*shell\s*:\s*(?:true|IS_WINDOWS)/;
    expect(vulnerablePattern.test(source)).toBe(false);
  });

  it('uses a shell-free Windows where-bun lookup with hidden windows', () => {
    const windowsCallMatch = source.match(/spawnSync\('where',\s*\['bun'\],\s*\{([^}]+)\}/);
    expect(windowsCallMatch).not.toBeNull();
    expect(windowsCallMatch![1]).toContain('windowsHide: true');
    expect(windowsCallMatch![1]).not.toContain('shell');
  });

  it('uses no shell option for Unix which-bun lookup', () => {
    const unixCallMatch = source.match(/spawnSync\('which',\s*\['bun'\],\s*\{([^}]+)\}/)
    if (unixCallMatch) {
      expect(unixCallMatch[1]).not.toContain('shell');
    }
    expect(source).toContain("spawnSync('which', ['bun']");
  });
});

describe('bun-runner.js findBun: absolute bun.exe resolution (#3196)', () => {
  it('returns the resolved absolute path when where finds only bun.exe (official installer)', () => {
    const result = runFindBun({
      status: 0,
      stdout: 'C:\\Users\\test\\.bun\\bin\\bun.exe\r\n'
    });
    expect(result).toBe('C:\\Users\\test\\.bun\\bin\\bun.exe');
  });

  it('still prefers bun.cmd when an npm shim is present', () => {
    const result = runFindBun({
      status: 0,
      stdout: 'C:\\npm\\bun.cmd\r\nC:\\Users\\test\\.bun\\bin\\bun.exe\r\n'
    });
    expect(result).toBe('C:\\npm\\bun.cmd');
  });

  it('never returns the bare name when where produced a path', () => {
    const result = runFindBun({
      status: 0,
      stdout: 'C:\\some dir with spaces\\bun.exe\r\n'
    });
    expect(result).not.toBe('bun');
  });

  it('falls back to ~/.bun/bin/bun.exe when where fails', () => {
    const expected = win32.join('C:\\Users\\test', '.bun', 'bin', 'bun.exe');
    const result = runFindBun(
      { status: 1, stdout: '' },
      { existingPaths: [expected] }
    );
    expect(result).toBe(expected);
  });

  it('keeps returning bun for Unix which hits', () => {
    const result = runFindBun(
      { status: 0, stdout: '/usr/local/bin/bun\n' },
      { isWindows: false }
    );
    expect(result).toBe('bun');
  });
});

describe('bun-runner.js spawn: no cmd.exe for .exe targets (#3196)', () => {
  // cmd.exe silently drops environment variables longer than ~8191 chars.
  // The hooks prepend the login-shell PATH to the inherited PATH, which can
  // double it past that limit — inside a `shell: true` spawn, cmd then sees
  // an empty PATH and cannot resolve anything by name. A resolved .exe must
  // therefore be spawned directly; only .cmd/.bat shims require the shell.
  it('gates the Windows shell spawn on a .cmd/.bat target', () => {
    expect(source).toMatch(
      /const needsCmdShell = IS_WINDOWS && \/\\\.\(cmd\|bat\)\$\/i\.test\(bunPath\)/
    );
    expect(source).toMatch(/if \(needsCmdShell\) \{[\s\S]*?spawnOptions\.shell = true/);
  });

  it('does not enable shell mode unconditionally on Windows', () => {
    const shellAssignments = source.match(/spawnOptions\.shell = true/g) ?? [];
    expect(shellAssignments.length).toBe(1);
    expect(source).not.toMatch(/if \(IS_WINDOWS\) \{\s*const quote/);
  });
});
