import { describe, it, expect } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { dirname, join, win32 } from 'path';

const BUN_RUNNER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');
const source = readFileSync(BUN_RUNNER_PATH, 'utf-8');
const findBunSource = source.slice(
  source.indexOf('function findBun() {'),
  source.indexOf('\nfunction isPluginDisabledInClaudeSettings() {')
);
type FindBun = () => string | null;
const createFindBun = new Function(
  'deps',
  `const { IS_WINDOWS, dirname, existsSync, homedir, join, spawnSync } = deps;\n${findBunSource}\nreturn findBun;`
) as (deps: {
  IS_WINDOWS: boolean;
  dirname: typeof win32.dirname;
  existsSync: (path: string) => boolean;
  homedir: () => string;
  join: typeof join;
  spawnSync: typeof spawnSync;
}) => FindBun;

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
    'dirname',
    'homedir',
    'existsSync',
    `${findBunSource}\nreturn findBun();`
  );
  return factory(
    () => whereResult,
    isWindows,
    isWindows ? win32.join : join,
    isWindows ? win32.dirname : dirname,
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

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;

function findBunForWhereOutput(stdout: string) {
  return createFindBun({
    IS_WINDOWS: true,
    dirname: win32.dirname,
    existsSync: () => false,
    homedir: () => 'C:\\Users\\fixture',
    join,
    spawnSync: (() => ({
      status: 0,
      stdout,
      stderr: ''
    })) as typeof spawnSync
  })();
}

describe('bun-runner.js Windows PATH ordering', () => {
  it('keeps an earlier bun.cmd ahead of a later bun.exe', () => {
    expect(findBunForWhereOutput([
      'C:\\First\\bun.cmd',
      'C:\\Second\\bun.exe'
    ].join('\r\n'))).toBe('C:\\First\\bun.cmd');
  });

  it('prefers bun.exe when bun.cmd and bun.exe share the first directory', () => {
    expect(findBunForWhereOutput([
      'C:\\First\\bun.cmd',
      'C:\\First\\bun.exe',
      'C:\\Second\\bun.exe'
    ].join('\r\n'))).toBe('C:\\First\\bun.exe');
  });
});

windowsDescribe('bun-runner.js Windows executable resolution', () => {
  function withFixture<T>(files: Record<string, string | null>, run: (fixtureDir: string) => T) {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'bun-runner-'));
    const scriptPath = join(fixtureDir, 'fixture.js');
    const bunExecutable = process.execPath;

    try {
      writeFileSync(scriptPath, 'console.log("fixture launched");\n');
      for (const [name, content] of Object.entries(files)) {
        const filePath = join(fixtureDir, name);
        if (name.toLowerCase().endsWith('.exe')) {
          cpSync(bunExecutable, filePath);
        } else {
          writeFileSync(filePath, content || '');
        }
      }

      return run(fixtureDir);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }

  function findBunBaseForWhereOutput(stdout: string) {
    const bunCmdPath = stdout.split('\n').find(line => line.trim().endsWith('bun.cmd'));
    if (bunCmdPath) {
      return bunCmdPath.trim();
    }
    return 'bun';
  }

  function runFixture(fixtureDir: string) {
    const scriptPath = join(fixtureDir, 'fixture.js');
    const systemPath = process.env.PATH || '';

    return spawnSync(process.execPath, [BUN_RUNNER_PATH, scriptPath, 'start'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${fixtureDir};${systemPath}`,
          CLAUDE_CONFIG_DIR: fixtureDir
        },
        windowsHide: true
      });
  }

  it('launches the resolved bun.exe from where', () => {
    withFixture({ 'bun.exe': null }, fixtureDir => {
      const bunExePath = join(fixtureDir, 'bun.exe');
      expect(findBunBaseForWhereOutput(`${bunExePath}\r\n`)).toBe('bun');
      expect(findBunForWhereOutput(`${bunExePath}\r\n`)).toBe(bunExePath);

      const result = runFixture(fixtureDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('fixture launched');
      expect(result.stderr).not.toContain('Failed to start Bun');
      expect(result.stderr).not.toContain('doubled-quote');
    });
  });

  it('prefers bun.exe over bun.cmd from where', () => {
    withFixture({
      'bun.exe': null,
      'bun.cmd': '@echo off\r\nexit /b 91\r\n'
    }, fixtureDir => {
      const bunExePath = join(fixtureDir, 'bun.exe');
      const bunCmdPath = join(fixtureDir, 'bun.cmd');
      const whereOutput = `${bunExePath}\r\n${bunCmdPath}\r\n`;

      expect(findBunBaseForWhereOutput(whereOutput)).toBe(bunCmdPath);
      expect(findBunForWhereOutput(whereOutput)).toBe(bunExePath);

      const result = runFixture(fixtureDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('fixture launched');
    });
  });

  it('keeps bun.cmd as the Windows fallback', () => {
    const bunExecutable = process.execPath.replace(/\\/g, '\\\\');
    withFixture({
      'bun.cmd': `@echo off\r\n"${bunExecutable}" %*\r\n`
    }, fixtureDir => {
      const bunCmdPath = join(fixtureDir, 'bun.cmd');
      expect(findBunBaseForWhereOutput(`${bunCmdPath}\r\n`)).toBe(bunCmdPath);
      expect(findBunForWhereOutput(`${bunCmdPath}\r\n`)).toBe(bunCmdPath);

      const result = runFixture(fixtureDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('fixture launched');
    });
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
