import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  ErrorSeverity,
  classifyError,
  ERROR_CATEGORIES,
} from '../src/npx-cli/install/error-taxonomy';
import {
  createInstallSummary,
  installerError,
  clearLastInstallError,
  flushSummary,
  InstallAbortError,
} from '../src/npx-cli/install/error-reporter';
import {
  isEresolve,
  extractEresolveBlock,
  npmChildEnv,
  npmErrorCode,
  runNpmStrict,
} from '../src/npx-cli/install/npm-install-helper';

describe('error taxonomy', () => {
  it('has no SILENT severity', () => {
    const severities = new Set(ERROR_CATEGORIES.map((c) => c.severity));
    expect(severities.has('SILENT' as ErrorSeverity)).toBe(false);
  });

  it('classifies a missing bun error as ABORT (bun-missing-after-install)', () => {
    const cat = classifyError(new Error('Bun executable not found after install attempt.'), {
      component: 'bun-install',
      phase: 'setup-runtime',
    });
    expect(cat.id).toBe('bun-missing-after-install');
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
  });

  it('classifies a missing uv error as ABORT (uv-missing-after-install)', () => {
    const cat = classifyError(new Error('uv installed but version probe failed.'), {
      component: 'uv-install',
      phase: 'setup-runtime',
    });
    expect(cat.id).toBe('uv-missing-after-install');
  });

  it('classifies ERESOLVE stderr as tree-sitter-eresolve ABORT', () => {
    const cat = classifyError(new Error('npm error code ERESOLVE\nWhile resolving: x'), {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
    });
    expect(cat.id).toBe('tree-sitter-eresolve');
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
  });

  it('classifies a non-interactive provider-selection abort with its own id', () => {
    const cat = classifyError(new Error('A provider must be explicit when stdin is not interactive.'), {
      component: 'provider-selection',
      phase: 'non-interactive-validation',
    });
    expect(cat.id).toBe('provider-selection-non-interactive');
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
    expect(cat.remediation({ platform: 'linux', dataDir: '/x' })).toContain('--provider claude');
  });

  it('classifies missing non-interactive provider credentials with its own id', () => {
    const cat = classifyError(new Error('gemini requires a preconfigured personal API key when stdin is not interactive.'), {
      component: 'provider-credentials',
      phase: 'non-interactive-validation',
    });
    expect(cat.id).toBe('provider-credentials-missing');
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
  });

  it('classifies a tree-sitter CLI provisioning failure with the repair remediation', () => {
    const cat = classifyError(new Error('tree-sitter-cli provisioning failed in /x: exited with code 2'), {
      component: 'tree-sitter-cli-cache',
      phase: 'dependency-install',
    });
    expect(cat.id).toBe('tree-sitter-cli-cache-provisioning-failed');
    const remediation = cat.remediation({ platform: 'win32', dataDir: 'C:\\temp\\claude-mem' });
    expect(remediation).toContain('npx claude-mem repair');
    expect(remediation).toContain('C:\\temp\\claude-mem/last-install-error.json');
    expect(remediation).toContain('CLAUDE_MEM_INSTALL_TIMEOUT_MS');
  });

  // #4858: on musl the download works but the glibc executable cannot run, so
  // the remediation must not blame the network.
  it('classifies a downloaded tree-sitter CLI that cannot run with the PATH workaround', () => {
    const cat = classifyError(
      new Error('tree-sitter-cli provisioning failed in /x: The downloaded tree-sitter 0.26.9 executable matches the pinned SHA-256 but cannot run on this system: spawn ENOENT'),
      { component: 'tree-sitter-cli-cache', phase: 'dependency-install' },
    );
    expect(cat.id).toBe('tree-sitter-cli-cannot-run');
    const remediation = cat.remediation({ platform: 'linux', dataDir: '/tmp/claude-mem' });
    expect(remediation).toContain('musl');
    expect(remediation).toContain('0.26 or newer');
    expect(remediation).toContain('PATH');
    expect(remediation).toContain('npx claude-mem doctor');
    expect(remediation).not.toContain('network');
    expect(remediation).not.toContain('last-install-error.json');
  });

  it('defaults unknown errors to ABORT (fail-loud)', () => {
    const cat = classifyError(new Error('something we have never seen'), {
      component: 'mystery',
      phase: 'mystery',
    });
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
    expect(cat.id).toBe('unknown-install-error');
  });

  it('remediation strings interpolate the passed dataDir, never a hardcoded path', () => {
    const cat = ERROR_CATEGORIES.find((c) => c.id === 'marketplace-dir-not-writable')!;
    const text = cat.remediation({ platform: 'linux', dataDir: '/custom/data/dir' });
    expect(text).toContain('/custom/data/dir');
  });
});

describe('installerError decision logic', () => {
  let home: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cm-installer-'));
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = home;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
    rmSync(home, { recursive: true, force: true });
  });

  it('ABORT throws InstallAbortError and writes last-install-error.json', () => {
    const summary = createInstallSummary();
    let thrown: unknown;
    try {
      installerError(ErrorSeverity.ABORT, {
        component: 'marketplace-npm-install',
        phase: 'marketplace-deps',
        cause: new Error('npm error code ERESOLVE'),
        details: 'While resolving: foo@1',
      }, summary);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InstallAbortError);
    const abort = thrown as InstallAbortError;
    expect(abort.category.id).toBe('tree-sitter-eresolve');
    expect(abort.remediation.length).toBeGreaterThan(0);

    const recordPath = join(home, 'last-install-error.json');
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(record.categoryId).toBe('tree-sitter-eresolve');
    expect(record.severity).toBe('ABORT');
    expect(record.details).toContain('While resolving');
  });

  // The record describes an aborted run. Nothing removed it, so doctor kept
  // showing an old error and its advice after later runs succeeded (#4858).
  it('a finished run clears the record of an earlier abort', () => {
    const recordPath = join(home, 'last-install-error.json');
    expect(() => installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error('npm error code ERESOLVE'),
    }, createInstallSummary())).toThrow(InstallAbortError);
    expect(existsSync(recordPath)).toBe(true);

    clearLastInstallError();
    expect(existsSync(recordPath)).toBe(false);
    // Nothing to clear is not an error.
    expect(() => clearLastInstallError()).not.toThrow();
  });

  // Clearing runs after the install already finished, so a record that cannot
  // be removed must not turn that success into a failed command; it warns.
  it('a record that cannot be removed warns instead of failing the finished run', () => {
    const recordPath = join(home, 'last-install-error.json');
    // A directory at the record's path makes the non-recursive remove throw on every platform.
    mkdirSync(join(recordPath, 'blocker'), { recursive: true });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      expect(() => clearLastInstallError()).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join('\n')).toContain('last-install-error.json');
  });

  it('install and repair clear the record only after their run finishes', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');
    expect(source).toMatch(/await runInstallCommandInner\(options, summary\);\r?\n\s*clearLastInstallError\(\);/);
    expect(source).toMatch(/await runRepairCommandInner\(summary\);\r?\n\s*clearLastInstallError\(\);/);
  });

  it('WARN_CONTINUE appends to summary and does not throw', () => {
    const summary = createInstallSummary();
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'auto-memory',
      phase: 'post-ide',
      cause: new Error('could not write settings'),
    }, summary);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0].component).toBe('auto-memory');
    expect(summary.failedIDEs).toHaveLength(0);
  });

  it('FAIL_LOUD_PER_IDE records the IDE and a warning, no throw', () => {
    const summary = createInstallSummary();
    installerError(ErrorSeverity.FAIL_LOUD_PER_IDE, {
      component: 'Cursor: hook installation failed',
      ide: 'cursor',
      phase: 'ide-install',
      cause: new Error('Cursor: hook installation failed'),
      details: 'EACCES: permission denied',
    }, summary);
    expect(summary.failedIDEs).toEqual(['cursor']);
    expect(summary.warnings[0].message).toContain('EACCES');
  });

  it('flushSummary emits each warning with remediation', () => {
    const summary = createInstallSummary();
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'auto-memory', phase: 'post-ide', cause: new Error('nope'),
    }, summary);
    const lines: string[] = [];
    flushSummary(summary, (l) => lines.push(l));
    const blob = lines.join('\n');
    expect(blob).toContain('Warnings & remediation');
    expect(blob).toContain('auto-memory');
  });
});

describe('npm install ERESOLVE detection', () => {
  it('detects an uppercase ERESOLVE token', () => {
    expect(isEresolve('npm error code ERESOLVE\nWhile resolving:')).toBe(true);
  });

  it('does NOT treat a generic failure as ERESOLVE', () => {
    expect(isEresolve('npm error 404 Not Found')).toBe(false);
  });

  it('extracts the While-resolving conflict block', () => {
    const stderr = 'npm error code ERESOLVE\nnpm error While resolving: a@1\nnpm error Conflicting peer dependency: b@2';
    const block = extractEresolveBlock(stderr);
    expect(block).toContain('While resolving');
    expect(block).toContain('Conflicting peer dependency');
  });

  it('returns raw stderr when the block markers are absent (defensive)', () => {
    const block = extractEresolveBlock('ERESOLVE happened but no markers');
    expect(block).toContain('ERESOLVE happened');
  });
});

/**
 * EALLOWSCRIPTS (#3697, #3835, #3774). npx on npm 11.16–12.1 exports a user's
 * `allow-scripts=` line from ~/.npmrc to the installer as
 * npm_config_allow_scripts; the installer's child `npm install` then counts it
 * as a command-line setting and aborts before reading any manifest. Verified
 * against npm 11.16.0, 11.17.0, 11.18.0 and 12.0.1.
 */
describe('npm install EALLOWSCRIPTS', () => {
  it('drops an inherited allow-scripts setting from the child npm env, in every spelling', () => {
    const env = npmChildEnv({
      PATH: '/usr/bin',
      npm_config_allow_scripts: 'esbuild',
      NPM_CONFIG_ALLOW_SCRIPTS: 'esbuild',
      'npm_config_allow-scripts': 'esbuild',
      npm_config_registry: 'https://registry.example',
    });
    expect(env).toEqual({ PATH: '/usr/bin', npm_config_registry: 'https://registry.example' });
  });

  it.skipIf(process.platform === 'win32')('never hands an inherited allow-scripts value to the npm it spawns', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'claude-mem-fake-npm-'));
    const saved = {
      PATH: process.env.PATH,
      lower: process.env.npm_config_allow_scripts,
      upper: process.env.NPM_CONFIG_ALLOW_SCRIPTS,
    };
    try {
      // A stand-in npm that reports what it inherited.
      writeFileSync(
        join(binDir, 'npm'),
        '#!/bin/sh\nprintf "%s|%s" "${npm_config_allow_scripts-unset}" "${NPM_CONFIG_ALLOW_SCRIPTS-unset}"\n',
      );
      chmodSync(join(binDir, 'npm'), 0o755);
      process.env.PATH = `${binDir}:${saved.PATH ?? ''}`;
      process.env.npm_config_allow_scripts = 'esbuild';
      process.env.NPM_CONFIG_ALLOW_SCRIPTS = 'esbuild';

      const result = await runNpmStrict(binDir, ['install', '--omit=dev', '--ignore-scripts']);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('unset|unset');
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.lower === undefined) delete process.env.npm_config_allow_scripts;
      else process.env.npm_config_allow_scripts = saved.lower;
      if (saved.upper === undefined) delete process.env.NPM_CONFIG_ALLOW_SCRIPTS;
      else process.env.NPM_CONFIG_ALLOW_SCRIPTS = saved.upper;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("reads npm's error code from both stderr formats", () => {
    expect(npmErrorCode('npm error code EALLOWSCRIPTS\nnpm error --allow-scripts is not allowed')).toBe('EALLOWSCRIPTS');
    expect(npmErrorCode('npm ERR! code E404\nnpm ERR! 404 Not Found')).toBe('E404');
    expect(npmErrorCode('segmentation fault')).toBeNull();
  });

  it('classifies an EALLOWSCRIPTS marketplace failure with the ~/.npmrc remediation', () => {
    const cat = classifyError(new Error('npm install failed (exit 1): EALLOWSCRIPTS'), {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
    });
    expect(cat.id).toBe('npm-allow-scripts-policy');
    const remediation = cat.remediation({ platform: 'linux', dataDir: '/tmp/cm' });
    expect(remediation).toContain('~/.npmrc');
    expect(remediation).toContain('allow-scripts');
  });
});

describe('failure remediation', () => {
  let prevMatrixDataDir: string | undefined;
  beforeEach(() => {
    prevMatrixDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'cm-matrix-'));
  });
  afterEach(() => {
    const dir = process.env.CLAUDE_MEM_DATA_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
    // Restore (not delete): the preload tripwire (tests/preload.ts) pins a
    // per-run default temp dir, and unconditionally deleting the env var
    // would expose later test files to the real ~/.claude-mem fallback in
    // call-time resolvers.
    if (prevMatrixDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = prevMatrixDataDir;
  });

  it.each([
    ['uv-install', 'setup-runtime', 'uv binary not found after auto-install attempt', 'uv'],
    ['bun-install', 'setup-runtime', 'Bun executable not found after auto-install attempt', 'Bun'],
    ['marketplace-npm-install', 'marketplace-deps', 'npm error code ERESOLVE\nWhile resolving: tree-sitter', 'ERESOLVE'],
  ])('%s reports actionable remediation', (component, phase, message, expected) => {
    try {
      installerError(ErrorSeverity.ABORT, {
        component,
        phase,
        cause: new Error(message),
      }, createInstallSummary());
      throw new Error('Expected InstallAbortError');
    } catch (error) {
      expect(error).toBeInstanceOf(InstallAbortError);
      expect((error as InstallAbortError).remediation).toContain(expected);
    }
  });
});
