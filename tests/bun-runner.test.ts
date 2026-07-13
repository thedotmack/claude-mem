import { describe, it, expect } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { join } from 'path';

const BUN_RUNNER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');
const source = readFileSync(BUN_RUNNER_PATH, 'utf-8');
const findBunSource = source.slice(
  source.indexOf('function findBun() {'),
  source.indexOf('\nfunction isPluginDisabledInClaudeSettings() {')
);
type FindBun = () => string | null;
const createFindBun = new Function(
  'deps',
  `const { IS_WINDOWS, existsSync, homedir, join, spawnSync } = deps;\n${findBunSource}\nreturn findBun;`
) as (deps: {
  IS_WINDOWS: boolean;
  existsSync: (path: string) => boolean;
  homedir: () => string;
  join: typeof join;
  spawnSync: typeof spawnSync;
}) => FindBun;

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

  function findBunForWhereOutput(stdout: string) {
    return createFindBun({
      IS_WINDOWS: true,
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
