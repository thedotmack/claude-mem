import { describe, it, expect } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { delimiter, dirname, join, win32 } from 'path';

const BUN_RUNNER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');
const source = readFileSync(BUN_RUNNER_PATH, 'utf-8');
const findBunSource = source.slice(
  source.indexOf('function findBun() {'),
  source.indexOf('\nfunction isPluginDisabledInClaudeSettings() {')
);
type FindBun = () => string | null;
const createFindBun = new Function(
  'deps',
  `const { IS_WINDOWS, dirname, existsSync, homedir, join, spawnSync, process = globalThis.process } = deps;\n${findBunSource}\nreturn findBun;`
) as (deps: {
  IS_WINDOWS: boolean;
  dirname: typeof win32.dirname;
  existsSync: (path: string) => boolean;
  homedir: () => string;
  join: typeof join;
  spawnSync: typeof spawnSync;
  process?: { env: NodeJS.ProcessEnv; cwd: () => string };
}) => FindBun;

interface WhereResult {
  status: number | null;
  stdout: string;
}

function runFindBun(
  whereResult: WhereResult,
  { isWindows = true, existingPaths = [] as string[] } = {}
): string | null {
  return createFindBun({
    IS_WINDOWS: isWindows,
    dirname: isWindows ? win32.dirname : dirname,
    existsSync: p => existingPaths.includes(p),
    homedir: () => isWindows ? 'C:\\Users\\test' : '/home/test',
    join: isWindows ? win32.join : join,
    spawnSync: (() => whereResult) as typeof spawnSync,
  })();
}

describe('bun-runner.js findBun: DEP0190 regression guard (#1503)', () => {
  it('uses System32 where.exe without a shell and skips current-directory hits', () => {
    const calls: unknown[][] = [];
    const result = createFindBun({
      IS_WINDOWS: true,
      dirname: win32.dirname,
      existsSync: p => ['C:\\project\\bun.exe', 'C:\\tools\\bun.exe'].includes(p),
      homedir: () => 'C:\\Users\\fixture',
      join: win32.join,
      process: { env: { SystemRoot: 'C:\\Windows' }, cwd: () => 'C:\\project' },
      spawnSync: ((...args: unknown[]) => {
        calls.push(args);
        return { status: 0, stdout: 'C:\\project\\bun.exe\r\nC:\\tools\\bun.exe\r\n' };
      }) as typeof spawnSync,
    })();
    expect(result).toBe('C:\\tools\\bun.exe');
    expect(calls).toEqual([['C:\\Windows\\System32\\where.exe', ['bun'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }]]);
  });

  it('uses Unix which without a shell', () => {
    const calls: unknown[][] = [];
    expect(createFindBun({
      IS_WINDOWS: false, dirname, existsSync: () => false, homedir: () => '/home/fixture', join,
      spawnSync: ((...args: unknown[]) => {
        calls.push(args);
        return { status: 0, stdout: '/usr/local/bin/bun\n' };
      }) as typeof spawnSync,
    })()).toBe('bun');
    expect(calls).toEqual([['which', ['bun'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }]]);
  });

  it.each([true, false])('finds BUN_INSTALL when PATH is empty (Windows: %s)', isWindows => {
    const path = isWindows ? win32 : { join, dirname };
    const installation = isWindows ? 'C:\\custom-bun' : '/custom-bun';
    const expected = path.join(installation, 'bin', isWindows ? 'bun.exe' : 'bun');
    expect(createFindBun({
      IS_WINDOWS: isWindows, dirname: path.dirname, existsSync: p => p === expected,
      homedir: () => '/home/fixture', join: path.join,
      process: { env: { BUN_INSTALL: installation }, cwd: () => '/project' },
      spawnSync: (() => ({ status: 1, stdout: '' })) as typeof spawnSync,
    })()).toBe(expected);
  });
});

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;

function findBunForWhereOutput(stdout: string) {
  // Paths `where` reported count as existing: these cases exercise ordering and
  // preference among real hits, not the code-page filter (#4694 covers that).
  const whereLines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return createFindBun({
    IS_WINDOWS: true,
    dirname: win32.dirname,
    existsSync: (p: string) => whereLines.includes(p),
    homedir: () => 'C:\\Users\\fixture',
    join,
    spawnSync: (() => ({
      status: 0,
      stdout,
      stderr: ''
    })) as typeof spawnSync
  })();
}

describe('bun-runner.js Windows known paths before where (#4934)', () => {
  it('returns ~/.bun without running where when it exists', () => {
    const homeBun = win32.join('C:\\Users\\fixture', '.bun', 'bin', 'bun.exe');
    let whereCalls = 0;
    const result = createFindBun({
      IS_WINDOWS: true,
      dirname: win32.dirname,
      existsSync: (p: string) => p === homeBun || p === 'C:\\other\\bun.exe',
      homedir: () => 'C:\\Users\\fixture',
      join: win32.join,
      spawnSync: (() => {
        whereCalls++;
        return { status: 0, stdout: 'C:\\other\\bun.exe\r\n', stderr: '' };
      }) as unknown as typeof spawnSync,
    })();
    expect(result).toBe(homeBun);
    expect(whereCalls).toBe(0);
  });

  it('still asks where when no known Bun exists', () => {
    let whereCalls = 0;
    const result = createFindBun({
      IS_WINDOWS: true,
      dirname: win32.dirname,
      existsSync: (p: string) => p === 'C:\\scoop\\shims\\bun.exe',
      homedir: () => 'C:\\Users\\fixture',
      join: win32.join,
      spawnSync: (() => {
        whereCalls++;
        return { status: 0, stdout: 'C:\\scoop\\shims\\bun.exe\r\n', stderr: '' };
      }) as unknown as typeof spawnSync,
    })();
    expect(result).toBe('C:\\scoop\\shims\\bun.exe');
    expect(whereCalls).toBe(1);
  });
});

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

  function runFixture(fixtureDir: string) {
    const scriptPath = join(fixtureDir, 'fixture.js');
    const systemPath = process.env.PATH || '';

    return spawnSync(process.execPath, [BUN_RUNNER_PATH, scriptPath, 'start'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${fixtureDir};${systemPath}`,
          HOME: fixtureDir,
          USERPROFILE: fixtureDir,
          BUN: '',
          BUN_PATH: '',
          BUN_INSTALL: '',
          CLAUDE_MEM_DATA_DIR: join(fixtureDir, 'data'),
          CLAUDE_CONFIG_DIR: fixtureDir
        },
        windowsHide: true
      });
  }

  it('launches the resolved bun.exe from where', () => {
    withFixture({ 'bun.exe': null }, fixtureDir => {
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
    }, { existingPaths: ['C:\\Users\\test\\.bun\\bin\\bun.exe'] });
    expect(result).toBe('C:\\Users\\test\\.bun\\bin\\bun.exe');
  });

  it('prefers an installed ~/.bun bun.exe over an earlier npm bun.cmd shim on PATH (#4934)', () => {
    const result = runFindBun({
      status: 0,
      stdout: 'C:\\npm\\bun.cmd\r\nC:\\Users\\test\\.bun\\bin\\bun.exe\r\n'
    }, { existingPaths: ['C:\\npm\\bun.cmd', 'C:\\Users\\test\\.bun\\bin\\bun.exe'] });
    expect(result).toBe('C:\\Users\\test\\.bun\\bin\\bun.exe');
  });

  it('still prefers an earlier npm bun.cmd shim when no known Bun is installed', () => {
    const result = runFindBun({
      status: 0,
      stdout: 'C:\\npm\\bun.cmd\r\nC:\\other\\bun.exe\r\n'
    }, { existingPaths: ['C:\\npm\\bun.cmd', 'C:\\other\\bun.exe'] });
    expect(result).toBe('C:\\npm\\bun.cmd');
  });

  it('never returns the bare name when every where path is nonexistent (#4694)', () => {
    // All where hits garbled/stale AND no fallback installed: bun-runner must
    // report Bun-not-found, not hand back a bare 'bun' (or a broken path).
    const result = runFindBun({
      status: 0,
      stdout: 'C:\\some dir with spaces\\bun.exe\r\n'
    });
    expect(result).toBeNull();
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

describe('bun-runner.js findBun: code-page-garbled where output (#4694)', () => {
  // where.exe writes the console's active code page (cp949 on ko-KR) while
  // findBun decodes its stdout as UTF-8, so a non-ASCII profile folder turns
  // into U+FFFD and the reported path does not exist.
  const GARBLED_BUN = 'C:\\Users\\\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\\.bun\\bin\\bun.exe';

  it('does not return a nonexistent where hit; falls through to ~/.bun/bin/bun.exe', () => {
    const fallback = win32.join('C:\\Users\\test', '.bun', 'bin', 'bun.exe');
    const result = runFindBun(
      { status: 0, stdout: `${GARBLED_BUN}\r\n` },
      { existingPaths: [fallback] }
    );
    expect(result).toBe(fallback);
  });

  it('still returns a where hit that exists on disk (#3196 absolute-path contract)', () => {
    const existing = 'C:\\Program Files\\bun\\bun.exe';
    const result = runFindBun(
      { status: 0, stdout: `${GARBLED_BUN}\r\n${existing}\r\n` },
      { existingPaths: [existing] }
    );
    expect(result).toBe(existing);
  });

  it('prefers an existing bun.exe over an earlier garbled bun.exe line', () => {
    const goodExe = 'C:\\Second\\bun.exe';
    const result = runFindBun(
      { status: 0, stdout: `${GARBLED_BUN}\r\nC:\\Second\\bun.cmd\r\n${goodExe}\r\n` },
      { existingPaths: [goodExe] }
    );
    // The garbled first line must not anchor the first-directory preference:
    // after filtering, the only survivors are the real exe (the nonexistent
    // bun.cmd drops out), and the exe wins.
    expect(result).toBe(goodExe);
  });

  it('returns null when every where hit is nonexistent and no fallback exists', () => {
    const result = runFindBun({ status: 0, stdout: `${GARBLED_BUN}\r\n` });
    expect(result).toBeNull();
  });
});

describe('bun-runner.js spawn: no cmd.exe for .exe targets (#3196)', () => {
  // cmd.exe silently drops environment variables longer than ~8191 chars.
  // The hooks prepend the login-shell PATH to the inherited PATH, which can
  // double it past that limit — inside a `shell: true` spawn, cmd then sees
  // an empty PATH and cannot resolve anything by name. A resolved .exe must
  // therefore be spawned directly; only .cmd/.bat shims require the shell.
  it.each(['.exe', '.cmd', '.bat'])('uses a shell only for Windows command shims (%s)', extension => {
    const calls: unknown[][] = [];
    const spawnSource = source.slice(source.indexOf('const spawnOptions = {'), source.indexOf('\nif (child.stdin)'));
    const runSpawn = new Function('deps', `const { IS_WINDOWS, bunPath, args, neutralBunSpawnCwd, spawn, process } = deps;\n${spawnSource}`);
    const bunPath = `C:\\tools\\bun${extension}`;
    runSpawn({
      IS_WINDOWS: true, bunPath, args: ['fixture.js', '%USERPROFILE%'],
      neutralBunSpawnCwd: () => 'C:\\data\\run',
      process: { env: {}, cwd: () => 'C:\\project' },
      spawn: (...args: unknown[]) => { calls.push(args); return {}; },
    });
    const [command, args, options] = calls[0] as [string, string[], { shell?: boolean }];
    if (extension === '.exe') {
      expect(command).toBe(bunPath);
      expect(args).toEqual(['fixture.js', '%USERPROFILE%']);
      expect(options.shell).toBeUndefined();
    } else {
      expect(command).toBe(`"${bunPath}" "fixture.js" "%USERPROFILE%"`);
      expect(args).toEqual([]);
      expect(options.shell).toBe(true);
    }
  });

  it.skipIf(process.platform !== 'win32')('passes environment-variable arguments literally to bun.exe', () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-runner-argv-'));
    try {
      const script = join(root, 'argv.js');
      writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
      const result = spawnSync(process.execPath, [BUN_RUNNER_PATH, script, '%USERPROFILE%'], {
        encoding: 'utf-8', input: '{}', windowsHide: true,
        env: { ...process.env, BUN: '', BUN_PATH: process.execPath, CLAUDE_CONFIG_DIR: root, CLAUDE_MEM_DATA_DIR: join(root, 'data') },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(['%USERPROFILE%']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #4628: Bun reads tsconfig.json from its working directory and prints its
  // warnings to stderr, which hosts show as hook errors. The child starts in a
  // neutral directory and learns the launch directory from the environment.
  it('starts Bun outside the project, resolves a relative script, and passes the launch directory', () => {
    // Like the real hooks: the script lives outside the project (the plugin
    // dir), and only the launch directory has the warning-producing tsconfig.
    const root = mkdtempSync(join(tmpdir(), 'bun-runner-cwd-'));
    const projectDir = join(root, 'project');
    const scriptsDir = join(root, 'scripts');
    try {
      mkdirSync(projectDir);
      mkdirSync(scriptsDir);
      writeFileSync(join(projectDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleSuffixes: ['.native', ''] } }));
      writeFileSync(
        join(scriptsDir, 'report-cwd.js'),
        'console.log(JSON.stringify({ cwd: process.cwd(), launch: process.env.CLAUDE_MEM_HOOK_ORIGINAL_CWD }));\n',
      );
      // Launched with node, as the hooks do: launching the runner itself with
      // Bun from the project would read that tsconfig before the runner runs.
      // The neutral cwd is the owner-controlled run dir, not tmpdir(): Bun
      // loads bunfig.toml from cwd, and a shared /tmp lets another local user
      // plant a `preload` there.
      const dataDir = join(root, 'data');
      const res = spawnSync('node', [BUN_RUNNER_PATH, join('..', 'scripts', 'report-cwd.js')], {
        cwd: projectDir,
        env: { ...process.env, CLAUDE_CONFIG_DIR: projectDir, CLAUDE_MEM_DATA_DIR: dataDir },
        input: '{"dummy": true}',
        encoding: 'utf-8',
        windowsHide: true,
      });
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain('moduleSuffixes');
      const reported = JSON.parse(res.stdout.trim().split('\n').pop() as string);
      expect(realpathSync(reported.cwd)).toBe(realpathSync(join(dataDir, 'run')));
      expect(realpathSync(reported.launch)).toBe(realpathSync(projectDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function runReportCwd(root: string, dataDirSetting: string): { cwd: string; launch: string } {
    const projectDir = join(root, 'project');
    const scriptsDir = join(root, 'scripts');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, 'report-cwd.js'),
      'console.log(JSON.stringify({ cwd: process.cwd(), launch: process.env.CLAUDE_MEM_HOOK_ORIGINAL_CWD }));\n',
    );
    const res = spawnSync('node', [BUN_RUNNER_PATH, join('..', 'scripts', 'report-cwd.js')], {
      cwd: projectDir,
      // HOME/USERPROFILE point at the temp root, which hides the usual
      // ~/.bun install (Windows CI has Bun only there), so name this Bun.
      env: {
        ...process.env, HOME: root, USERPROFILE: root, BUN_PATH: process.execPath,
        CLAUDE_CONFIG_DIR: projectDir, CLAUDE_MEM_DATA_DIR: dataDirSetting,
      },
      input: '{"dummy": true}',
      encoding: 'utf-8',
      windowsHide: true,
    });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout.trim().split('\n').pop() as string);
  }

  it('expands a ~-prefixed CLAUDE_MEM_DATA_DIR under home, not inside the project', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-runner-tilde-')));
    try {
      const reported = runReportCwd(root, '~/mem-data');
      expect(realpathSync(reported.cwd)).toBe(join(root, 'mem-data', 'run'));
      expect(existsSync(join(root, 'project', '~'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('tightens a pre-existing 0755 run dir to 0700', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bun-runner-mode-')));
    try {
      const dataDir = join(root, 'data');
      mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o755 });
      chmodSync(join(dataDir, 'run'), 0o755);
      runReportCwd(root, dataDir);
      expect(statSync(join(dataDir, 'run')).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bun-runner.js hook routing', () => {
  // A hook must not parse the whole worker bundle: `hook` runs the hook-only
  // sibling hook-service.cjs when it exists, and falls back to worker-service.cjs.
  function runHook(withHookService: boolean, args: string[]): { status: number | null; stdout: string } {
    const sandbox = mkdtempSync(join(tmpdir(), 'bun-runner-hook-routing-'));
    try {
      const scripts = join(sandbox, 'scripts');
      mkdirSync(scripts);
      cpSync(BUN_RUNNER_PATH, join(scripts, 'bun-runner.js'));
      writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
      const stub = (name: string) => `process.stdout.write(JSON.stringify({ script: '${name}', argv: process.argv.slice(2) }));`;
      writeFileSync(join(scripts, 'worker-service.cjs'), stub('worker-service'));
      if (withHookService) writeFileSync(join(scripts, 'hook-service.cjs'), stub('hook-service'));
      const dataDir = join(sandbox, 'data');
      mkdirSync(dataDir);
      const result = spawnSync('node', [join(scripts, 'bun-runner.js'), join(scripts, 'worker-service.cjs'), ...args], {
        cwd: sandbox,
        input: '{"hook_event_name":"PostToolUse"}',
        encoding: 'utf-8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
          HOME: sandbox,
          CLAUDE_CONFIG_DIR: join(sandbox, '.claude'),
          CLAUDE_MEM_DATA_DIR: dataDir,
        },
      });
      return { status: result.status, stdout: result.stdout ?? '' };
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  it('routes hook commands to hook-service.cjs when it exists', () => {
    const result = runHook(true, ['hook', 'claude-code', 'observation']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ script: 'hook-service', argv: ['hook', 'claude-code', 'observation'] });
  });

  it('falls back to worker-service.cjs when hook-service.cjs is absent', () => {
    const result = runHook(false, ['hook', 'claude-code', 'observation']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).script).toBe('worker-service');
  });

  it('keeps non-hook commands on worker-service.cjs even when hook-service.cjs exists', () => {
    const result = runHook(true, ['start']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ script: 'worker-service', argv: ['start'] });
  });
});
