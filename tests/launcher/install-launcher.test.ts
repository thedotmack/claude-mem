import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  appendDirectoryToWindowsPathValue,
  buildLauncherCompileArguments,
  createAdhocCodesigner,
  ensureDirectoryOnWindowsUserPath,
  ensureLauncherOnPath,
  ensureLocalBinOnShellPath,
  findExecutableOnPath,
  probeLauncherVersion,
  removeInstalledLauncher,
  resolveLauncherBinaryPath,
  shellPathSetupMarkerComment,
  type LauncherCodesignRunner,
  type LauncherCompileRunner,
  type LauncherHostEnvironment,
  type LauncherInstallLogger,
  type PowerShellRunner,
  WINDOWS_USER_PATH_APPEND_SCRIPT,
} from '../../src/launcher/install-launcher.js';
import { LAUNCHER_PROTOCOL } from '../../src/launcher/launcher-protocol.js';
import { bunCommonPaths } from '../../src/npx-cli/install/tool-path.js';
import { hookLauncherCheck, windowsShimScriptPaths } from '../../src/npx-cli/commands/doctor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const pluginRoot = path.join(projectRoot, 'plugin');
const ensureLauncherScriptPath = path.join(pluginRoot, 'scripts', 'ensure-launcher.cjs');
// Scratch HOMEs live inside the worktree, never the system temp dir or the real HOME.
const scratchParentDirectory = path.join(projectRoot, '.scratch', 'install-launcher-tests');
const isPosixHost = process.platform !== 'win32';

function makeScratchHome(): string {
  return mkdtempSync(path.join(scratchParentDirectory, 'home-'));
}

function posixHost(homeDirectory: string, environmentVariables: NodeJS.ProcessEnv = {}): LauncherHostEnvironment {
  return {
    homeDirectory,
    platform: 'darwin',
    environmentVariables: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ...environmentVariables },
  };
}

function recordingLogger(): LauncherInstallLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (line) => lines.push(`info: ${line}`),
    success: (line) => lines.push(`success: ${line}`),
    warn: (line) => lines.push(`warn: ${line}`),
  };
}

/** A shell script standing in for a compiled launcher: prints `printedVersion` for --version. */
function writeFakeLauncher(binaryPath: string, printedVersion: string): void {
  mkdirSync(path.dirname(binaryPath), { recursive: true });
  writeFileSync(binaryPath, `#!/bin/sh\necho ${printedVersion}\n`);
  chmodSync(binaryPath, 0o755);
}

/** Records the compile invocation and writes a fake launcher at --outfile. */
function fakeCompile(printedVersion = String(LAUNCHER_PROTOCOL)): LauncherCompileRunner & { calls: Array<{ bunPath: string; compileArguments: string[]; workingDirectory: string }> } {
  const calls: Array<{ bunPath: string; compileArguments: string[]; workingDirectory: string }> = [];
  const runner = ((bunPath: string, compileArguments: string[], workingDirectory: string) => {
    calls.push({ bunPath, compileArguments, workingDirectory });
    writeFakeLauncher(compileArguments[compileArguments.indexOf('--outfile') + 1], printedVersion);
    return { status: 0, stderr: '' };
  }) as LauncherCompileRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

const compileMustNotRun: LauncherCompileRunner = () => {
  throw new Error('compile must not run when the launcher is current');
};

/** Records the codesign invocation; optionally rewrites the binary to `printedVersion` (stand-in for a valid signature). */
function fakeCodesign(rewritePrintedVersion?: string): LauncherCodesignRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner = ((binaryPath: string) => {
    calls.push(binaryPath);
    if (rewritePrintedVersion !== undefined) writeFakeLauncher(binaryPath, rewritePrintedVersion);
    return { status: 0, stderr: '' };
  }) as LauncherCodesignRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

const codesignMustNotRun: LauncherCodesignRunner = () => {
  throw new Error('codesign must not run off darwin');
};

/** Signing is a no-op for fake compiles, so no test reaches the real `codesign`. */
const codesignNoop: LauncherCodesignRunner = () => ({ status: 0, stderr: '' });

/** The thrown error's message, so a test can assert on more than one fragment of it. */
function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the action to throw');
}

/**
 * Zeroes the signature blob of a 64-bit Mach-O, so `codesign --force --sign -`
 * refuses it with "invalid or unsupported format for signature" — the way it
 * refuses Bun 1.3.12's `--compile` output (#4947). Corrupting the blob rather
 * than trusting the installed Bun to emit a malformed signature keeps the
 * regression test meaningful if a later Bun signs its output correctly.
 */
function zeroMachOCodeSignature(binaryPath: string): void {
  const binary = readFileSync(binaryPath);
  if (binary.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${binaryPath} is not a 64-bit Mach-O`);
  }
  const loadCommandCount = binary.readUInt32LE(16);
  let loadCommandOffset = 32;
  for (let loadCommandIndex = 0; loadCommandIndex < loadCommandCount; loadCommandIndex++) {
    // LC_CODE_SIGNATURE, the load command that points at the embedded blob.
    if (binary.readUInt32LE(loadCommandOffset) === 0x1d) {
      const signatureOffset = binary.readUInt32LE(loadCommandOffset + 8);
      const signatureSize = binary.readUInt32LE(loadCommandOffset + 12);
      writeFileSync(binaryPath, binary.fill(0, signatureOffset, signatureOffset + signatureSize));
      return;
    }
    loadCommandOffset += binary.readUInt32LE(loadCommandOffset + 4);
  }
  throw new Error(`${binaryPath} has no LC_CODE_SIGNATURE load command to corrupt`);
}

beforeAll(() => {
  mkdirSync(scratchParentDirectory, { recursive: true });
});

afterAll(() => {
  rmSync(scratchParentDirectory, { recursive: true, force: true });
});

describe('launcher bin dir and compile arguments per platform', () => {
  it('places claude-mem in ~/.local/bin on POSIX', () => {
    expect(resolveLauncherBinaryPath(posixHost('/home/alex'))).toBe('/home/alex/.local/bin/claude-mem');
  });

  it('places claude-mem.exe in %LOCALAPPDATA%\\claude-mem\\bin on Windows', () => {
    const windowsHost: LauncherHostEnvironment = {
      homeDirectory: 'C:\\Users\\alex',
      platform: 'win32',
      environmentVariables: { LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' },
    };
    expect(resolveLauncherBinaryPath(windowsHost)).toBe('C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin\\claude-mem.exe');
    expect(resolveLauncherBinaryPath({ ...windowsHost, environmentVariables: {} }))
      .toBe('C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin\\claude-mem.exe');
  });

  it('compiles with .env and bunfig autoload disabled', () => {
    expect(buildLauncherCompileArguments('/p/scripts/claude-mem-launcher.cjs', '/h/.local/bin/x')).toEqual([
      'build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
      '/p/scripts/claude-mem-launcher.cjs', '--outfile', '/h/.local/bin/x',
    ]);
  });
});

describe.skipIf(!isPosixHost)('ensureLauncherOnPath', () => {
  it('compiles into ~/.local/bin, renames into place and adds ~/.local/bin to the zsh rc', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const compile = fakeCompile();
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compile, runCodesign: codesignNoop, invocationContext: 'npx-installer',
    });

    const binDirectory = path.join(scratchHome, '.local', 'bin');
    expect(ensureResult).toEqual({
      status: 'installed',
      binaryPath: path.join(binDirectory, 'claude-mem'),
      pathSetupOutcome: 'rc-file-updated',
    });
    expect(compile.calls).toHaveLength(1);
    const [{ bunPath, compileArguments, workingDirectory }] = compile.calls;
    expect(bunPath).toBe('/fake/bun');
    expect(workingDirectory).toBe(binDirectory);
    expect(compileArguments.slice(0, 4)).toEqual(['build', '--compile', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig']);
    expect(compileArguments[4]).toBe(path.join(pluginRoot, 'scripts', 'claude-mem-launcher.cjs'));
    expect(path.dirname(compileArguments[6])).toBe(binDirectory);
    // The temp outfile was renamed over the target; nothing else is left behind.
    expect(readdirSync(binDirectory)).toEqual(['claude-mem']);
    expect(logger.lines.filter((line) => line.includes('codesign'))).toEqual([]);

    const zshrc = readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8');
    expect(zshrc).toContain(shellPathSetupMarkerComment('claude-mem'));
    expect(zshrc).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(host.environmentVariables.PATH).toBe(`${binDirectory}:/usr/bin:/bin`);
  });

  it('skips the compile when the placed launcher is current, but still runs the rc check', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL));
    let bunLookups = 0;

    const ensureResult = ensureLauncherOnPath({
      pluginRoot,
      resolveBunPath: () => { bunLookups++; return '/fake/bun'; },
      logger: recordingLogger(),
      host,
      runCompile: compileMustNotRun,
      invocationContext: 'session-start-self-heal',
    });

    expect(ensureResult).toMatchObject({ status: 'already-current', pathSetupOutcome: 'rc-file-updated' });
    expect(bunLookups).toBe(0);
    expect(readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8')).toContain(shellPathSetupMarkerComment('claude-mem'));
  });

  it('self-heal treats a newer installed protocol as current (never downgrades)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, String(LAUNCHER_PROTOCOL + 1));
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compileMustNotRun, invocationContext: 'session-start-self-heal',
    });

    expect(ensureResult.status).toBe('already-current');
    expect(readFileSync(binaryPath, 'utf-8')).toContain(String(LAUNCHER_PROTOCOL + 1));
    expect(logger.lines.filter((line) => line.startsWith('warn:'))).toEqual([]);
  });

  it('the installer keeps a newer installed protocol and warns', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL + 1));
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult).toMatchObject({ status: 'newer-protocol-kept', pathSetupOutcome: 'rc-file-updated' });
    expect(logger.lines.some((line) => line.startsWith('warn:') && line.includes('newer than this installer'))).toBe(true);
  });

  it('never replaces a claude-mem whose --version is not a bare integer', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, '13.28.0');
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult).toEqual({ status: 'foreign-binary-kept', binaryPath, pathSetupOutcome: null });
    expect(logger.lines).toEqual([`warn: ${binaryPath} exists and is not the claude-mem hook launcher (--version printed "13.28.0" instead of a protocol number); not replacing`]);
    expect(readFileSync(binaryPath, 'utf-8')).toContain('13.28.0');
  });

  it('never replaces a symlink, even one pointing at a launcher', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    const linkTargetPath = path.join(scratchHome, 'elsewhere', 'claude-mem');
    writeFakeLauncher(linkTargetPath, String(LAUNCHER_PROTOCOL - 1));
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    symlinkSync(linkTargetPath, binaryPath);

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('foreign-binary-kept');
    expect(lstatSync(binaryPath).isSymbolicLink()).toBe(true);
  });

  it('replaces a dangling symlink (e.g. into a deleted plugin cache)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    symlinkSync(path.join(scratchHome, 'plugins', 'cache', '12.0.0', 'bin', 'claude-mem'), binaryPath);

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: fakeCompile(), runCodesign: codesignNoop, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('installed');
    expect(lstatSync(binaryPath).isSymbolicLink()).toBe(false);
    expect(spawnSync(binaryPath, ['--version'], { encoding: 'utf-8' }).stdout.trim()).toBe(String(LAUNCHER_PROTOCOL));
  });

  it('recompiles a launcher that prints an older protocol', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome, { PATH: `${path.join(scratchHome, '.local', 'bin')}:/usr/bin` });
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL - 1));
    const compile = fakeCompile();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compile, runCodesign: codesignNoop, invocationContext: 'npx-installer',
    });

    expect(compile.calls).toHaveLength(1);
    expect(ensureResult).toMatchObject({ status: 'installed', pathSetupOutcome: 'already-on-path' });
  });

  // #4934/#4940: the Bun discovery fixes live in the compiled launcher, so a
  // protocol-1 binary already on PATH must be recompiled, by the installer and
  // by the SessionStart self-heal alike, for existing installs to get them.
  it('recompiles a protocol-1 launcher from before the Bun discovery fixes, in both contexts (#4934)', () => {
    expect(LAUNCHER_PROTOCOL).toBeGreaterThanOrEqual(2);
    for (const invocationContext of ['npx-installer', 'session-start-self-heal'] as const) {
      const scratchHome = makeScratchHome();
      const host = posixHost(scratchHome, { PATH: `${path.join(scratchHome, '.local', 'bin')}:/usr/bin` });
      writeFakeLauncher(resolveLauncherBinaryPath(host), '1');
      const compile = fakeCompile();

      const ensureResult = ensureLauncherOnPath({
        pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compile, runCodesign: codesignNoop, invocationContext,
      });

      expect(compile.calls).toHaveLength(1);
      expect(ensureResult.status).toBe('installed');
    }
  });

  it('reports bun-not-found without compiling', () => {
    const host = posixHost(makeScratchHome());
    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => null, logger: recordingLogger(), host, runCompile: compileMustNotRun, invocationContext: 'npx-installer',
    });
    expect(ensureResult.status).toBe('bun-not-found');
  });

  // #4933: Bun < 1.2.16 ignores BUN_BE_BUN, so a launcher compiled with it
  // re-execs itself forever when no `bun` is on the hook PATH.
  it('refuses to compile with a Bun older than 1.2.16, naming the version and the upgrade (#4933)', () => {
    const host = posixHost(makeScratchHome());
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', readBunVersion: () => '1.2.4', logger: recordingLogger(),
      host, runCompile: compileMustNotRun, runCodesign: codesignNoop, invocationContext: 'npx-installer',
    })).toThrow('Bun 1.2.4 at /fake/bun is older than 1.2.16');
    expect(existsSync(resolveLauncherBinaryPath(host))).toBe(false);
  });

  it('compiles with Bun 1.2.16 or newer', () => {
    for (const bunVersion of ['1.2.16', '1.3.0', '1.4.3']) {
      const ensureResult = ensureLauncherOnPath({
        pluginRoot, resolveBunPath: () => '/fake/bun', readBunVersion: () => bunVersion, logger: recordingLogger(),
        host: posixHost(makeScratchHome()), runCompile: fakeCompile(), runCodesign: codesignNoop, invocationContext: 'npx-installer',
      });
      expect(ensureResult.status).toBe('installed');
    }
  });

  it('throws on a failed compile and leaves no temp file', () => {
    const scratchHome = makeScratchHome();
    const failingCompile: LauncherCompileRunner = () => ({ status: 1, stderr: 'error: boom\n' });
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: posixHost(scratchHome), runCompile: failingCompile, runCodesign: codesignNoop, invocationContext: 'npx-installer',
    })).toThrow('bun build --compile failed (exit 1): error: boom');
    expect(readdirSync(path.join(scratchHome, '.local', 'bin'))).toEqual([]);
  });

  it('leaves no temp file when the compile succeeds but the rename fails', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    const compileThenBlockTarget: LauncherCompileRunner = (_bunPath, compileArguments) => {
      writeFakeLauncher(compileArguments[compileArguments.indexOf('--outfile') + 1], String(LAUNCHER_PROTOCOL));
      // A non-empty directory at the target makes rename(2) fail.
      mkdirSync(path.join(binaryPath, 'occupied'), { recursive: true });
      return { status: 0, stderr: '' };
    };
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: compileThenBlockTarget, runCodesign: codesignNoop, invocationContext: 'npx-installer',
    })).toThrow();
    expect(readdirSync(path.join(scratchHome, '.local', 'bin'))).toEqual(['claude-mem']);
  });

  it('throws before placing when the compiled binary prints the wrong protocol, leaving no temp file', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: fakeCompile('garbage'), runCodesign: codesignNoop, invocationContext: 'npx-installer',
    })).toThrow(`compiled launcher printed protocol null, expected ${LAUNCHER_PROTOCOL}`);
    expect(readdirSync(path.join(scratchHome, '.local', 'bin'))).toEqual([]);
  });

  it.skipIf(!isPosixHost)('puts the --version failure in the error when the compiled binary does not run', () => {
    const scratchHome = makeScratchHome();
    const compileCrashingLauncher: LauncherCompileRunner = (_bunPath, compileArguments) => {
      const outfilePath = compileArguments[compileArguments.indexOf('--outfile') + 1];
      writeFileSync(outfilePath, '#!/bin/sh\necho "blocked by policy" >&2\nexit 5\n');
      chmodSync(outfilePath, 0o755);
      return { status: 0, stderr: '' };
    };
    expect(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: posixHost(scratchHome), runCompile: compileCrashingLauncher, runCodesign: codesignNoop, invocationContext: 'npx-installer',
    })).toThrow(`compiled launcher printed protocol null, expected ${LAUNCHER_PROTOCOL} (--version exited 5: blocked by policy)`);
  });

  it('ad-hoc re-signs the compiled binary before the protocol probe (macOS 27 kills invalidly-signed builds, #4778)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    // The compile output prints garbage — what probeLauncherVersion sees when
    // macOS kills the binary — and only the signing step, which must run
    // first, repairs it.
    const compileThenResign: LauncherCompileRunner = (_bunPath, compileArguments) => {
      writeFakeLauncher(compileArguments[compileArguments.indexOf('--outfile') + 1], 'garbage');
      return { status: 0, stderr: '' };
    };
    const codesign = fakeCodesign(String(LAUNCHER_PROTOCOL));

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host,
      runCompile: compileThenResign, runCodesign: codesign, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('installed');
    expect(codesign.calls).toEqual([path.join(binDirectory, `.claude-mem-${process.pid}.tmp`)]);
    expect(readdirSync(binDirectory)).toEqual(['claude-mem']);
  });

  it('clears the old signature before re-signing, and reports only the sign step (#4947)', () => {
    const invocations: string[][] = [];
    const signer = createAdhocCodesigner((codesignArguments) => {
      invocations.push([...codesignArguments]);
      // The clear fails and the sign succeeds: clearing is best effort, so the
      // clear's failure must neither stop the sign nor be reported.
      return codesignArguments[0] === '--remove-signature'
        ? { status: 1, stderr: 'code object is not signed at all\n' }
        : { status: 0, stderr: '' };
    });

    expect(signer('/tmp/claude-mem')).toEqual({ status: 0, stderr: '' });
    expect(invocations).toEqual([
      ['--remove-signature', '/tmp/claude-mem'],
      ['--force', '--sign', '-', '/tmp/claude-mem'],
    ]);
  });

  it('reports the signing failure, not the successful clear, when only signing fails', () => {
    const signer = createAdhocCodesigner((codesignArguments) =>
      codesignArguments[0] === '--remove-signature'
        ? { status: 0, stderr: 'replacing existing signature\n' }
        : { status: 3, stderr: 'sign step failed\n' });

    // Returning the clear's result would hide the failure that matters.
    expect(signer('/tmp/claude-mem')).toEqual({ status: 3, stderr: 'sign step failed\n' });
  });

  it('reports the signing failure when both steps fail', () => {
    const signer = createAdhocCodesigner((codesignArguments) =>
      codesignArguments[0] === '--remove-signature'
        ? { status: 1, stderr: 'clear step failed\n' }
        : { status: 2, stderr: 'sign step failed\n' });

    expect(signer('/tmp/claude-mem')).toEqual({ status: 2, stderr: 'sign step failed\n' });
  });

  it.skipIf(process.platform !== 'darwin')('installs a real build whose signature codesign --force cannot replace (Bun 1.3.12, #4947)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const logger = recordingLogger();
    // Compile the real launcher bundle, then reproduce Bun 1.3.12's malformed
    // signature. No runCodesign: the real `codesign` runs the repair.
    const compileThenCorruptSignature: LauncherCompileRunner = (bunPath, compileArguments, workingDirectory) => {
      const compileResult = spawnSync(bunPath, compileArguments, { cwd: workingDirectory, encoding: 'utf-8' });
      zeroMachOCodeSignature(compileArguments[compileArguments.indexOf('--outfile') + 1]);
      return { status: compileResult.status, stderr: compileResult.stderr };
    };

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => process.execPath, logger, host,
      runCompile: compileThenCorruptSignature, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('installed');
    expect(logger.lines.filter((line) => line.includes('codesign'))).toEqual([]);
    const placedBinaryPath = resolveLauncherBinaryPath(host);
    expect(spawnSync(placedBinaryPath, ['--version'], { encoding: 'utf-8' }).stdout.trim())
      .toBe(String(LAUNCHER_PROTOCOL));
    // The cleared signature is replaced by an ad-hoc one, not left absent.
    expect(spawnSync('codesign', ['-dv', placedBinaryPath], { encoding: 'utf-8' }).stderr)
      .toContain('flags=0x2(adhoc)');
  }, 60_000);

  it('quotes the signing failure when the probe cannot run the binary', () => {
    const scratchHome = makeScratchHome();
    // What macOS does to an invalidly-signed launcher: the exec fails before
    // the protocol can be printed.
    const compileCrashingLauncher: LauncherCompileRunner = (_bunPath, compileArguments) => {
      const outfilePath = compileArguments[compileArguments.indexOf('--outfile') + 1];
      writeFileSync(outfilePath, '#!/bin/sh\necho "killed on exec" >&2\nexit 137\n');
      chmodSync(outfilePath, 0o755);
      return { status: 0, stderr: '' };
    };
    const failingCodesign: LauncherCodesignRunner = () => ({
      status: 1,
      stderr: 'warning: first line\n.claude-mem-1.tmp: invalid or unsupported format for signature\n',
    });

    const message = thrownMessage(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: posixHost(scratchHome),
      runCompile: compileCrashingLauncher, runCodesign: failingCodesign, invocationContext: 'npx-installer',
    }));

    // The protocol message still says what the probe saw ...
    expect(message).toContain(`compiled launcher printed protocol null, expected ${LAUNCHER_PROTOCOL}`);
    // ... and the actionable half names the signing failure, last stderr line only.
    expect(message).toContain('codesign --force --sign - failed (exit 1): .claude-mem-1.tmp: invalid or unsupported format for signature');
    expect(message).not.toContain('warning: first line');
  });

  it('does not blame signing when signing succeeded but the probe still failed', () => {
    const scratchHome = makeScratchHome();
    const message = thrownMessage(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: posixHost(scratchHome),
      runCompile: fakeCompile('garbage'), runCodesign: codesignNoop, invocationContext: 'npx-installer',
    }));

    expect(message).toContain(`compiled launcher printed protocol null, expected ${LAUNCHER_PROTOCOL}`);
    expect(message).not.toContain('codesign');
  });

  it('does not mention signing on a host where codesign never runs', () => {
    const scratchHome = makeScratchHome();
    const linuxHost: LauncherHostEnvironment = {
      homeDirectory: scratchHome, platform: 'linux', environmentVariables: { PATH: '/usr/bin', SHELL: '/bin/bash' },
    };
    const message = thrownMessage(() => ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: linuxHost,
      runCompile: fakeCompile('garbage'), runCodesign: codesignMustNotRun, invocationContext: 'npx-installer',
    }));

    expect(message).toContain(`compiled launcher printed protocol null, expected ${LAUNCHER_PROTOCOL}`);
    expect(message).not.toContain('codesign');
  });

  it('warns and still installs when ad-hoc signing fails (codesign missing or broken)', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const compile = fakeCompile();
    const failingCodesign: LauncherCodesignRunner = () => ({ status: 1, stderr: 'fake codesign failure\n' });
    const logger = recordingLogger();

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger, host,
      runCompile: compile, runCodesign: failingCodesign, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('installed');
    expect(logger.lines.some((line) => line.startsWith('warn:')
      && line.includes('codesign --force --sign - failed (exit 1): fake codesign failure')
      && line.includes('may not start on macOS'))).toBe(true);
    expect(spawnSync(resolveLauncherBinaryPath(host), ['--version'], { encoding: 'utf-8' }).stdout.trim())
      .toBe(String(LAUNCHER_PROTOCOL));
  });

  it('only signs on darwin', () => {
    const scratchHome = makeScratchHome();
    const linuxHost: LauncherHostEnvironment = {
      homeDirectory: scratchHome, platform: 'linux', environmentVariables: { PATH: '/usr/bin', SHELL: '/bin/bash' },
    };

    const ensureResult = ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host: linuxHost,
      runCompile: fakeCompile(), runCodesign: codesignMustNotRun, invocationContext: 'npx-installer',
    });

    expect(ensureResult.status).toBe('installed');
  });

  it('cleans stale placement leftovers but keeps a temp file a concurrent compile may own', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    mkdirSync(binDirectory, { recursive: true });
    const staleTemporaryPath = path.join(binDirectory, '.claude-mem-111.tmp');
    const freshTemporaryPath = path.join(binDirectory, '.claude-mem-222.tmp');
    // A pid no process can hold: that placement has exited, so its copy is stale.
    const renamedAsidePath = path.join(binDirectory, 'claude-mem.old-2147483646.exe');
    // A running placement's rollback copy must survive a concurrent cleanup.
    const liveRenamedAsideName = `claude-mem.old-${process.pid}.exe`;
    const liveRenamedAsidePath = path.join(binDirectory, liveRenamedAsideName);
    for (const leftoverPath of [staleTemporaryPath, freshTemporaryPath, renamedAsidePath, liveRenamedAsidePath]) writeFileSync(leftoverPath, '');
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(staleTemporaryPath, anHourAgo, anHourAgo);

    ensureLauncherOnPath({
      pluginRoot, resolveBunPath: () => '/fake/bun', logger: recordingLogger(), host, runCompile: fakeCompile(), runCodesign: codesignNoop, invocationContext: 'npx-installer',
    });

    expect(readdirSync(binDirectory).sort()).toEqual(['.claude-mem-222.tmp', 'claude-mem', liveRenamedAsideName].sort());
  });

  it('throws when the plugin root has no launcher bundle', () => {
    expect(() => ensureLauncherOnPath({
      pluginRoot: path.join(scratchParentDirectory, 'no-such-plugin'),
      resolveBunPath: () => '/fake/bun',
      logger: recordingLogger(),
      host: posixHost(makeScratchHome()),
      runCompile: compileMustNotRun,
      invocationContext: 'npx-installer',
    })).toThrow('launcher bundle missing');
  });
});

describe.skipIf(!isPosixHost)('ensureLocalBinOnShellPath keeps the Claude Code appender behavior', () => {
  it('is a no-op when ~/.local/bin is already on PATH', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome, { PATH: `/usr/bin:${path.join(scratchHome, '.local', 'bin')}` });
    expect(ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger: recordingLogger(), host })).toBe('already-on-path');
    expect(existsSync(path.join(scratchHome, '.zshrc'))).toBe(false);
  });

  it('leaves an rc that already exports ~/.local/bin untouched', () => {
    const scratchHome = makeScratchHome();
    const zshrcPath = path.join(scratchHome, '.zshrc');
    writeFileSync(zshrcPath, 'export PATH="$HOME/.local/bin:$PATH"\n');
    const logger = recordingLogger();
    expect(ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger, host: posixHost(scratchHome) })).toBe('rc-file-already-configured');
    expect(readFileSync(zshrcPath, 'utf-8')).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
    expect(logger.lines).toEqual([`info: Claude Code PATH already configured in ${zshrcPath}`]);
  });

  it('appends the Claude Code block after existing content, keeping it intact', () => {
    const scratchHome = makeScratchHome();
    const zshrcPath = path.join(scratchHome, '.zshrc');
    writeFileSync(zshrcPath, 'alias ll="ls -l"');
    ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger: recordingLogger(), host: posixHost(scratchHome) });
    expect(readFileSync(zshrcPath, 'utf-8')).toBe(
      'alias ll="ls -l"\n\n# Added by claude-mem installer for Claude Code\nexport PATH="$HOME/.local/bin:$PATH"\n',
    );
  });

  it('writes fish syntax to config.fish', () => {
    const scratchHome = makeScratchHome();
    ensureLocalBinOnShellPath({
      purposeLabel: 'claude-mem', logger: recordingLogger(), host: posixHost(scratchHome, { SHELL: '/usr/bin/fish' }),
    });
    expect(readFileSync(path.join(scratchHome, '.config', 'fish', 'config.fish'), 'utf-8'))
      .toContain(`set -gx PATH ${path.join(scratchHome, '.local', 'bin')} $PATH`);
  });
});

describe.skipIf(!isPosixHost)('probeLauncherVersion says why no protocol came back', () => {
  function writeScript(body: string): string {
    const scriptPath = path.join(makeScratchHome(), 'claude-mem');
    writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  it('returns the protocol and no failure for the launcher', () => {
    expect(probeLauncherVersion(writeScript(`echo ${LAUNCHER_PROTOCOL}`))).toEqual({ protocol: LAUNCHER_PROTOCOL, failure: null, failedToStart: false });
  });

  it('reports a non-zero exit with the last stderr line', () => {
    expect(probeLauncherVersion(writeScript('echo first >&2\necho "access denied" >&2\nexit 3')))
      .toEqual({ protocol: null, failure: 'exited 3: access denied', failedToStart: false });
  });

  it('reports a kill signal', () => {
    expect(probeLauncherVersion(writeScript('kill -KILL $$')).failure).toBe('killed by SIGKILL');
  });

  it('reports a timeout', () => {
    expect(probeLauncherVersion(writeScript('exec sleep 5'), 200).failure).toBe('timed out after 200 ms');
  });

  it('reports a binary that cannot start as a spawn failure', () => {
    const scriptPath = writeScript('echo 1');
    chmodSync(scriptPath, 0o644);
    const versionProbe = probeLauncherVersion(scriptPath);
    expect(versionProbe.protocol).toBeNull();
    expect(versionProbe.failedToStart).toBe(true);
    expect(versionProbe.failure).toStartWith('could not start: ');
    expect(versionProbe.failure).toContain('EACCES');
  });

  it('reports a missing file', () => {
    expect(probeLauncherVersion(path.join(makeScratchHome(), 'claude-mem')).failure).toBe('file not found');
  });
});

describe('Windows user Path append (pure)', () => {
  const launcherDirectory = 'C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin';

  it('appends when absent', () => {
    expect(appendDirectoryToWindowsPathValue('C:\\a;C:\\b', launcherDirectory))
      .toEqual({ alreadyPresent: false, updatedPathValue: `C:\\a;C:\\b;${launcherDirectory}` });
  });

  it('does not double a trailing semicolon and handles an empty Path', () => {
    expect(appendDirectoryToWindowsPathValue('C:\\a;', launcherDirectory).updatedPathValue).toBe(`C:\\a;${launcherDirectory}`);
    expect(appendDirectoryToWindowsPathValue('', launcherDirectory).updatedPathValue).toBe(launcherDirectory);
  });

  it('is idempotent, ignoring case, quotes and trailing separators', () => {
    const once = appendDirectoryToWindowsPathValue('C:\\a', launcherDirectory).updatedPathValue;
    expect(appendDirectoryToWindowsPathValue(once, launcherDirectory)).toEqual({ alreadyPresent: true, updatedPathValue: once });
    for (const existingSpelling of [launcherDirectory.toUpperCase(), `${launcherDirectory}\\`, `"${launcherDirectory}"`]) {
      expect(appendDirectoryToWindowsPathValue(`C:\\a;${existingSpelling}`, launcherDirectory).alreadyPresent).toBe(true);
    }
  });

  it('never truncates, even far past setx\'s 1024-character limit', () => {
    const longPath = Array.from({ length: 120 }, (_, index) => `C:\\tools\\very-long-directory-name-${index}`).join(';');
    expect(longPath.length).toBeGreaterThan(4000);
    const { updatedPathValue } = appendDirectoryToWindowsPathValue(longPath, launcherDirectory);
    expect(updatedPathValue.startsWith(longPath)).toBe(true);
    expect(updatedPathValue.length).toBe(longPath.length + 1 + launcherDirectory.length);
  });
});

describe('ensureDirectoryOnWindowsUserPath', () => {
  const launcherDirectory = 'C:\\Users\\alex\\AppData\\Local\\claude-mem\\bin';
  const windowsHost = (): LauncherHostEnvironment => ({
    homeDirectory: 'C:\\Users\\alex', platform: 'win32', environmentVariables: { PATH: 'C:\\Windows' },
  });

  function fakePowerShell(result: Partial<{ status: number | null; stdout: string; stderr: string; spawnErrorMessage: string | null }>): PowerShellRunner & { calls: Array<{ script: string; extraEnvironment: Record<string, string> }> } {
    const calls: Array<{ script: string; extraEnvironment: Record<string, string> }> = [];
    const runner = ((script: string, extraEnvironment: Record<string, string>) => {
      calls.push({ script, extraEnvironment });
      return { status: 0, stdout: '', stderr: '', spawnErrorMessage: null, ...result };
    }) as PowerShellRunner & { calls: typeof calls };
    runner.calls = calls;
    return runner;
  }

  it('reads, checks and writes the raw registry value in ONE PowerShell call, passing only the directory', () => {
    const runPowerShell = fakePowerShell({ stdout: 'added\r\n' });
    const host = windowsHost();
    expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger: recordingLogger(), host, runPowerShell })).toBe('user-path-updated');
    expect(runPowerShell.calls).toHaveLength(1);
    const [{ script, extraEnvironment }] = runPowerShell.calls;
    expect(script).toBe(WINDOWS_USER_PATH_APPEND_SCRIPT);
    expect(script).toContain("GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
    expect(script).toContain("SetValue('Path', $updatedUserPath, $pathValueKind)");
    expect(script).toContain("SetEnvironmentVariable('CLAUDE_MEM_PATH_BROADCAST', $null, 'User')");
    expect(script).not.toContain(launcherDirectory);
    expect(script).not.toContain('setx');
    expect(extraEnvironment).toEqual({ CLAUDE_MEM_LAUNCHER_DIRECTORY: launcherDirectory });
    expect(host.environmentVariables.PATH).toBe(`C:\\Windows;${launcherDirectory}`);
  });

  it('reports already-on-user-path when PowerShell prints present', () => {
    const runPowerShell = fakePowerShell({ stdout: 'present\r\n' });
    expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger: recordingLogger(), host: windowsHost(), runPowerShell })).toBe('already-on-user-path');
    expect(runPowerShell.calls).toHaveLength(1);
  });

  it('includes the spawn error (timeout, ENOENT) instead of "exit null"', () => {
    const logger = recordingLogger();
    const runPowerShell = fakePowerShell({ status: null, spawnErrorMessage: 'spawnSync powershell.exe ETIMEDOUT' });
    expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger, host: windowsHost(), runPowerShell })).toBe('user-path-update-failed');
    expect(logger.lines[0]).toBe('warn: Could not update the user Path: spawnSync powershell.exe ETIMEDOUT');
  });

  it('fails on a non-zero exit or an unexpected status word, leaving the process PATH alone', () => {
    for (const result of [{ status: 1, stderr: 'Access denied' }, { stdout: 'something else' }]) {
      const host = windowsHost();
      const logger = recordingLogger();
      expect(ensureDirectoryOnWindowsUserPath({ directory: launcherDirectory, logger, host, runPowerShell: fakePowerShell(result) })).toBe('user-path-update-failed');
      expect(logger.lines[0]).toStartWith('warn: Could not update the user Path: ');
      expect(host.environmentVariables.PATH).toBe('C:\\Windows');
    }
  });
});

describe.skipIf(!isPosixHost)('removeInstalledLauncher (uninstall)', () => {
  it('removes the placed launcher and names the rc line to remove, leaving the rc untouched', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, String(LAUNCHER_PROTOCOL));
    ensureLocalBinOnShellPath({ purposeLabel: 'claude-mem', logger: recordingLogger(), host: posixHost(scratchHome) });
    const zshrcBefore = readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8');

    const removal = removeInstalledLauncher(host);

    expect(removal.removedBinaryPath).toBe(binaryPath);
    expect(existsSync(binaryPath)).toBe(false);
    expect(removal.pathCleanupHint).toContain(path.join(scratchHome, '.zshrc'));
    expect(removal.pathCleanupHint).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8')).toBe(zshrcBefore);
  });

  it('names the fish PATH line the installer actually wrote', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome, { SHELL: '/usr/local/bin/fish' });
    writeFakeLauncher(resolveLauncherBinaryPath(host), String(LAUNCHER_PROTOCOL));
    ensureLocalBinOnShellPath({ purposeLabel: 'claude-mem', logger: recordingLogger(), host: posixHost(scratchHome, { SHELL: '/usr/local/bin/fish' }) });
    const configFish = path.join(scratchHome, '.config', 'fish', 'config.fish');
    const fishLine = `set -gx PATH ${path.join(scratchHome, '.local', 'bin')} $PATH`;
    expect(readFileSync(configFish, 'utf-8')).toContain(fishLine);

    const removal = removeInstalledLauncher(host);

    expect(removal.pathCleanupHint).toContain(configFish);
    expect(removal.pathCleanupHint).toContain(fishLine);
    expect(removal.pathCleanupHint).not.toContain('export PATH=');
  });

  it('leaves a claude-mem that is not our launcher in place', () => {
    const scratchHome = makeScratchHome();
    const host = posixHost(scratchHome);
    const binaryPath = resolveLauncherBinaryPath(host);
    writeFakeLauncher(binaryPath, '13.28.0');
    expect(removeInstalledLauncher(host)).toEqual({ removedBinaryPath: null, pathCleanupHint: null });
    expect(existsSync(binaryPath)).toBe(true);
  });
});

describe.skipIf(!isPosixHost)('doctor hook launcher row', () => {
  it('fails (required) with the hook error string and the install fix when claude-mem is not on PATH', () => {
    const row = hookLauncherCheck(posixHost(makeScratchHome()));
    expect(row).toMatchObject({ name: 'Hook launcher', status: 'fail', required: true });
    expect(row.detail).toContain('Executable not found in $PATH: "claude-mem"');
    expect(row.detail).toContain('npx claude-mem install');
  });

  it('reports where, the protocol and the --version round trip when current', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), String(LAUNCHER_PROTOCOL));
    const row = hookLauncherCheck(posixHost(scratchHome, { PATH: `${binDirectory}:/usr/bin` }));
    expect(row).toMatchObject({ status: 'ok', required: true });
    expect(row.detail).toMatch(new RegExp(`^${path.join(binDirectory, 'claude-mem')} \\(protocol ${LAUNCHER_PROTOCOL}, --version \\d+ ms\\)$`));
  });

  it('flags a claude-mem on PATH that is not the launcher (e.g. the npm CLI)', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, 'npm-global', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), '13.28.0');
    const row = hookLauncherCheck(posixHost(scratchHome, { PATH: binDirectory }));
    expect(row).toMatchObject({ status: 'fail', required: true });
    expect(row.detail).toContain('did not report a launcher protocol (--version printed "13.28.0" instead of a protocol number)');
  });

  it('finds the first PATH hit without spawning', () => {
    const scratchHome = makeScratchHome();
    const firstDirectory = path.join(scratchHome, 'first');
    const secondDirectory = path.join(scratchHome, 'second');
    writeFakeLauncher(path.join(secondDirectory, 'claude-mem'), '1');
    writeFakeLauncher(path.join(firstDirectory, 'claude-mem'), '1');
    expect(findExecutableOnPath('claude-mem', `/nope:${firstDirectory}:${secondDirectory}`, 'darwin')).toBe(path.join(firstDirectory, 'claude-mem'));
    expect(findExecutableOnPath('claude-mem', '/nope', 'darwin')).toBeNull();
  });

});

describe('Windows cmd-shim script paths', () => {
  it('resolves a cmd-shim %dp0% target and a pwsh $basedir target to the CLI script', () => {
    const shimPath = 'C:\\cache\\_npx\\hash\\node_modules\\.bin\\claude-mem.cmd';
    const cliScript = 'C:\\cache\\_npx\\hash\\node_modules\\claude-mem\\dist\\npx-cli\\index.js';
    const cmdText = '"%_prog%"  "%dp0%\\..\\claude-mem\\dist\\npx-cli\\index.js" %*\r\n';
    const ps1Text = '& "node$exe" "$basedir/../claude-mem/dist/npx-cli/index.js" $args\n';
    expect(windowsShimScriptPaths(shimPath, cmdText)).toEqual([cliScript]);
    expect(windowsShimScriptPaths(shimPath.replace(/\.cmd$/, '.ps1'), ps1Text)).toEqual([cliScript]);
  });
});

describe.skipIf(process.platform !== 'win32')('doctor hook launcher row on Windows', () => {
  function windowsHost(homeDirectory: string, environmentVariables: NodeJS.ProcessEnv): LauncherHostEnvironment {
    return { homeDirectory, platform: 'win32', environmentVariables };
  }

  function writeProtocolCmd(cmdPath: string, printedVersion: string): void {
    mkdirSync(path.dirname(cmdPath), { recursive: true });
    writeFileSync(cmdPath, `@echo off\r\necho ${printedVersion}\r\n`);
  }

  function writeCmdShim(cmdPath: string, relativeScriptPath: string): void {
    mkdirSync(path.dirname(cmdPath), { recursive: true });
    writeFileSync(
      cmdPath,
      `@ECHO off\r\n"%_prog%"  "%dp0%\\${relativeScriptPath}" %*\r\n`,
    );
  }

  it('reports an earlier npm .cmd shim, in PATHEXT order', () => {
    const scratchHome = makeScratchHome();
    const npmDirectory = path.join(scratchHome, 'npm');
    const launcherDirectory = path.join(scratchHome, 'launcher');
    mkdirSync(npmDirectory, { recursive: true });
    mkdirSync(launcherDirectory, { recursive: true });
    writeFileSync(path.join(npmDirectory, 'claude-mem.cmd'), '');
    writeFileSync(path.join(launcherDirectory, 'claude-mem.exe'), '');
    expect(findExecutableOnPath('claude-mem', `${npmDirectory};${launcherDirectory}`, 'win32'))
      .toBe(path.join(npmDirectory, 'claude-mem.cmd'));
    expect(findExecutableOnPath('claude-mem', `${npmDirectory};${launcherDirectory}`, 'win32', '.EXE'))
      .toBe(path.join(launcherDirectory, 'claude-mem.exe'));
  });

  it('skips npx\'s claude-mem.cmd wrapper and reports the launcher', () => {
    const scratchHome = makeScratchHome();
    // npx runs packages from npm's cache, `<cache>\\_npx\\<hash>\\node_modules`.
    const cliScript = path.join(scratchHome, '_npx', 'abc123', 'node_modules', 'claude-mem', 'dist', 'npx-cli', 'index.js');
    const npxBinDirectory = path.join(scratchHome, '_npx', 'abc123', 'node_modules', '.bin');
    mkdirSync(path.dirname(cliScript), { recursive: true });
    writeFileSync(cliScript, 'console.log("13.41.0")\n');
    writeCmdShim(path.join(npxBinDirectory, 'claude-mem.cmd'), '..\\claude-mem\\dist\\npx-cli\\index.js');
    const launcherDirectory = path.join(scratchHome, 'launcher');
    writeProtocolCmd(path.join(launcherDirectory, 'claude-mem.cmd'), String(LAUNCHER_PROTOCOL));

    const row = hookLauncherCheck(
      windowsHost(scratchHome, { PATH: `${npxBinDirectory};${launcherDirectory}` }),
      cliScript,
    );

    expect(row).toMatchObject({ status: 'ok', required: true });
    expect(row.detail).toContain(path.join(launcherDirectory, 'claude-mem.cmd'));
    expect(row.detail).toContain(`protocol ${LAUNCHER_PROTOCOL}`);
  });

  it('fails when a permanent claude-mem.cmd wrapper is the running CLI and hides the launcher', () => {
    const scratchHome = makeScratchHome();
    const cliScript = path.join(scratchHome, 'npm-global', 'node_modules', 'claude-mem', 'dist', 'npx-cli', 'index.js');
    const globalBinDirectory = path.join(scratchHome, 'npm-global');
    mkdirSync(path.dirname(cliScript), { recursive: true });
    writeFileSync(cliScript, 'console.log("13.41.0")\n');
    writeCmdShim(path.join(globalBinDirectory, 'claude-mem.cmd'), 'node_modules\\claude-mem\\dist\\npx-cli\\index.js');
    const launcherDirectory = path.join(scratchHome, 'launcher');
    writeProtocolCmd(path.join(launcherDirectory, 'claude-mem.cmd'), String(LAUNCHER_PROTOCOL));

    const row = hookLauncherCheck(
      windowsHost(scratchHome, { PATH: `${globalBinDirectory};${launcherDirectory}` }),
      cliScript,
    );

    expect(row).toMatchObject({ status: 'fail', required: true });
    expect(row.detail).toContain(path.join(globalBinDirectory, 'claude-mem.cmd'));
    expect(row.detail).toContain('is not the claude-mem hook launcher');
  });
});

describe.skipIf(!isPosixHost)('plugin/scripts/ensure-launcher.cjs under plain node', () => {
  const nodeExecutablePath = Bun.which('node');
  const bunExecutablePath = Bun.which('bun');
  // Bun's well-known system locations are searched regardless of PATH, so the
  // missing-Bun case only holds on a machine without one of those.
  const systemBunPresent = bunCommonPaths({}).some((candidate) => !candidate.startsWith(process.env.HOME ?? '\0') && existsSync(candidate));

  function runEnsureLauncherScript(scratchHome: string, extraEnvironment: Record<string, string>) {
    return spawnSync(nodeExecutablePath!, [ensureLauncherScriptPath], {
      encoding: 'utf-8',
      cwd: scratchHome,
      timeout: 60_000,
      // Built from scratch: nothing from the real HOME or this session leaks in.
      env: { HOME: scratchHome, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ...extraEnvironment },
    });
  }

  it('is built', () => {
    expect(nodeExecutablePath).toBeTruthy();
    expect(existsSync(ensureLauncherScriptPath)).toBe(true);
  });

  /**
   * A plugin root holding only the built launcher bundle (and optionally a
   * package.json): the checkout's plugin/ has no node_modules, which the
   * dependency check would report.
   */
  function ensureLauncherPluginRoot(packageManifest?: Record<string, unknown>): string {
    const fixtureRoot = mkdtempSync(path.join(scratchParentDirectory, 'plugin-root-'));
    mkdirSync(path.join(fixtureRoot, 'scripts'));
    copyFileSync(path.join(pluginRoot, 'scripts', 'claude-mem-launcher.cjs'), path.join(fixtureRoot, 'scripts', 'claude-mem-launcher.cjs'));
    if (packageManifest) writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify(packageManifest));
    return fixtureRoot;
  }

  const REINSTALL_FIX = 'Fix: run `npx claude-mem install`, then restart Claude Code.';
  const RESTART_FIX = 'Fix: restart Claude Code from a new terminal so it picks up the updated PATH.';

  /** The exact stdout contract for a failure: one JSON object, one line, nothing else. */
  function expectOneSystemMessage(stdout: string, failureReason: string, fix: string = REINSTALL_FIX): void {
    const systemMessage = `claude-mem: memory hooks are not active: ${failureReason}. ${fix}`;
    expect(stdout).toBe(`${JSON.stringify({ systemMessage })}\n`);
  }

  /** A `bun` on PATH that answers --version and fakes `build --compile`, so no real compile runs. */
  function writeFakeBun(scratchHome: string, compileOutcome: 'writes-current-launcher' | 'fails'): string {
    const fakeBunDirectory = path.join(scratchHome, 'fake-bun-bin');
    mkdirSync(fakeBunDirectory, { recursive: true });
    const compileBody = compileOutcome === 'fails'
      ? 'echo "error: fake compile failure" >&2\nexit 1\n'
      : `while [ "$#" -gt 0 ]; do if [ "$1" = "--outfile" ]; then printf '#!/bin/sh\\necho ${LAUNCHER_PROTOCOL}\\n' > "$2"; chmod 755 "$2"; fi; shift; done\nexit 0\n`;
    writeFileSync(
      path.join(fakeBunDirectory, 'bun'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.9; exit 0; fi\n${compileBody}`,
    );
    chmodSync(path.join(fakeBunDirectory, 'bun'), 0o755);
    return fakeBunDirectory;
  }

  it('prints one systemMessage when CLAUDE_PLUGIN_ROOT is missing', () => {
    const scriptRun = runEnsureLauncherScript(makeScratchHome(), {});
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(scriptRun.stdout, 'CLAUDE_PLUGIN_ROOT is not set');
    expect(scriptRun.stderr).toBe('claude-mem ensure-launcher: CLAUDE_PLUGIN_ROOT is not set\n');
  });

  it('prints one systemMessage when the plugin root has no launcher bundle', () => {
    const missingPluginRoot = path.join(scratchParentDirectory, 'no-such-plugin');
    const scriptRun = runEnsureLauncherScript(makeScratchHome(), { CLAUDE_PLUGIN_ROOT: missingPluginRoot });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(scriptRun.stdout, `launcher bundle missing at ${path.join(missingPluginRoot, 'scripts', 'claude-mem-launcher.cjs')}`);
    expect(scriptRun.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('exits 0 silently when the launcher is current and on PATH', () => {
    const scratchHome = makeScratchHome();
    writeFakeLauncher(path.join(scratchHome, '.local', 'bin', 'claude-mem'), String(LAUNCHER_PROTOCOL));
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${path.join(scratchHome, '.local', 'bin')}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    expect(scriptRun.stderr).toBe('');
  });

  it('exits 0 silently when PATH reaches the launcher through a symlinked directory', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), String(LAUNCHER_PROTOCOL));
    const symlinkedBinDirectory = path.join(scratchHome, 'linked-bin');
    symlinkSync(binDirectory, symlinkedBinDirectory);
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${symlinkedBinDirectory}:${binDirectory}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
  });

  it('asks for a reinstall when the launcher is current but its directory is still not on the hook PATH', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), String(LAUNCHER_PROTOCOL));
    writeFileSync(path.join(scratchHome, '.zshrc'), 'export PATH="$HOME/.local/bin:$PATH"\n');
    const scriptRun = runEnsureLauncherScript(scratchHome, { CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot() });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(
      scriptRun.stdout,
      `the launcher was installed at ${path.join(binDirectory, 'claude-mem')} but Claude Code's PATH does not include ${binDirectory}`,
    );
  });

  it('prints one systemMessage naming the missing plugin dependencies', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    writeFakeLauncher(path.join(binDirectory, 'claude-mem'), String(LAUNCHER_PROTOCOL));
    const fixtureRoot = ensureLauncherPluginRoot({ dependencies: { zod: '^3', '@scope/present': '1' } });
    mkdirSync(path.join(fixtureRoot, 'node_modules', '@scope', 'present'), { recursive: true });
    writeFileSync(path.join(fixtureRoot, 'node_modules', '@scope', 'present', 'package.json'), '{}');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: fixtureRoot,
      PATH: `${binDirectory}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(scriptRun.stdout, 'plugin dependencies are missing (zod)');
  });

  it('prints one systemMessage naming the shadowing claude-mem when another one comes first on PATH', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    const placedLauncherPath = path.join(binDirectory, 'claude-mem');
    writeFakeLauncher(placedLauncherPath, String(LAUNCHER_PROTOCOL));
    const shadowingDirectory = path.join(scratchHome, 'npm-global', 'bin');
    writeFakeLauncher(path.join(shadowingDirectory, 'claude-mem'), '13.28.0');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${shadowingDirectory}:${binDirectory}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(
      scriptRun.stdout,
      `another claude-mem at ${path.join(shadowingDirectory, 'claude-mem')} shadows the hook launcher at ${placedLauncherPath}`,
    );
  });

  it('prints one systemMessage when a foreign claude-mem sits at the launcher path', () => {
    const scratchHome = makeScratchHome();
    const placedLauncherPath = path.join(scratchHome, '.local', 'bin', 'claude-mem');
    writeFakeLauncher(placedLauncherPath, '13.28.0');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${path.dirname(placedLauncherPath)}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(scriptRun.stdout, `${placedLauncherPath} is not the claude-mem hook launcher and was left in place`);
  });

  it.skipIf(systemBunPresent)('prints one systemMessage when Bun is missing', () => {
    const scratchHome = makeScratchHome();
    const scriptRun = runEnsureLauncherScript(scratchHome, { CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot() });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(scriptRun.stdout, 'Bun was not found, so the claude-mem launcher could not be compiled');
    expect(existsSync(path.join(scratchHome, '.local', 'bin', 'claude-mem'))).toBe(false);
  });

  it('prints one systemMessage when the compile fails', () => {
    const scratchHome = makeScratchHome();
    const fakeBunDirectory = writeFakeBun(scratchHome, 'fails');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${fakeBunDirectory}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expectOneSystemMessage(scriptRun.stdout, 'bun build --compile failed (exit 1): error: fake compile failure');
    expect(existsSync(path.join(scratchHome, '.local', 'bin', 'claude-mem'))).toBe(false);
  });

  it('places the launcher and prints one systemMessage when the hook PATH does not include its directory', () => {
    const scratchHome = makeScratchHome();
    const fakeBunDirectory = writeFakeBun(scratchHome, 'writes-current-launcher');
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${fakeBunDirectory}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    // This run just added the directory to the rc file, so only a restart is needed.
    expectOneSystemMessage(
      scriptRun.stdout,
      `the launcher was just installed at ${path.join(binDirectory, 'claude-mem')} and ${binDirectory} was added to your PATH, which this Claude Code session started without`,
      RESTART_FIX,
    );
    // The rc file is still fixed for the next Claude Code launch.
    expect(readFileSync(path.join(scratchHome, '.zshrc'), 'utf-8')).toContain(shellPathSetupMarkerComment('claude-mem'));
  });

  it('places the launcher silently when the hook PATH already includes its directory', () => {
    const scratchHome = makeScratchHome();
    const fakeBunDirectory = writeFakeBun(scratchHome, 'writes-current-launcher');
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${binDirectory}:${fakeBunDirectory}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    expect(scriptRun.stderr).toContain(`claude-mem launcher installed at ${path.join(binDirectory, 'claude-mem')}`);
  });

  it.skipIf(!bunExecutablePath)('compiles a real launcher that prints the protocol, with empty stdout', () => {
    const scratchHome = makeScratchHome();
    const binDirectory = path.join(scratchHome, '.local', 'bin');
    const scriptRun = runEnsureLauncherScript(scratchHome, {
      CLAUDE_PLUGIN_ROOT: ensureLauncherPluginRoot(),
      PATH: `${binDirectory}:${path.dirname(bunExecutablePath!)}:/usr/bin:/bin`,
    });
    expect(scriptRun.status).toBe(0);
    expect(scriptRun.stdout).toBe('');
    const placedBinaryPath = path.join(binDirectory, 'claude-mem');
    expect(scriptRun.stderr).toContain(`claude-mem launcher installed at ${placedBinaryPath}`);
    expect(spawnSync(placedBinaryPath, ['--version'], { encoding: 'utf-8' }).stdout.trim()).toBe(String(LAUNCHER_PROTOCOL));
  });
});
