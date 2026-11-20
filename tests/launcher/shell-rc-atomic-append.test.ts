import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureLocalBinOnShellPath,
  shellPathSetupMarkerComment,
  type LauncherHostEnvironment,
  type LauncherInstallLogger,
} from '../../src/launcher/install-launcher.js';

// `ensureLocalBinOnShellPath` appends a PATH block to the user's shell rc. It is
// the one write the launcher installer makes to a file the user authored and
// keeps open in an editor, and it used a plain writeFileSync: a crash or a power
// loss between truncate and flush left a half-written .zshrc and a broken login
// shell. The shared helper stages the bytes in a temp file, fsyncs, then renames
// over the target, so a replacement lands as a new inode -- which is what the
// second case measures. Same shape as the earlier installer conversions.
//
// The host is constructed explicitly rather than detected, so this file runs on
// every platform; scratch homes live in the worktree, never the real HOME.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratchParentDirectory = path.join(projectRoot, '.scratch', 'shell-rc-atomic-tests');

function makeScratchHome(): string {
  return mkdtempSync(path.join(scratchParentDirectory, 'home-'));
}

function posixHost(homeDirectory: string): LauncherHostEnvironment {
  return {
    homeDirectory,
    platform: 'darwin',
    environmentVariables: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
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

describe('ensureLocalBinOnShellPath writes the rc atomically', () => {
  let home: string;

  beforeAll(() => {
    mkdirSync(scratchParentDirectory, { recursive: true });
  });

  beforeEach(() => {
    home = makeScratchHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('appends the block after the existing content and keeps it byte for byte', () => {
    const zshrc = path.join(home, '.zshrc');
    writeFileSync(zshrc, 'alias ll="ls -l"', 'utf-8');

    const outcome = ensureLocalBinOnShellPath({
      purposeLabel: 'claude-mem',
      logger: recordingLogger(),
      host: posixHost(home),
    });

    expect(outcome).toBe('rc-file-updated');
    expect(readFileSync(zshrc, 'utf-8')).toBe(
      `alias ll="ls -l"\n\n${shellPathSetupMarkerComment('claude-mem')}\nexport PATH="$HOME/.local/bin:$PATH"\n`,
    );
  });

  it('replaces the rc instead of editing it in place', () => {
    const zshrc = path.join(home, '.zshrc');
    writeFileSync(zshrc, 'alias ll="ls -l"\n', 'utf-8');
    const before = statSync(zshrc);

    ensureLocalBinOnShellPath({
      purposeLabel: 'claude-mem',
      logger: recordingLogger(),
      host: posixHost(home),
    });

    const after = statSync(zshrc);
    expect(after.size).toBeGreaterThan(0);
    expect(after.ino).not.toBe(before.ino);
  });

  it('leaves an rc that already configures the directory untouched, inode included', () => {
    const zshrc = path.join(home, '.zshrc');
    const original = 'export PATH="$HOME/.local/bin:$PATH"\n';
    writeFileSync(zshrc, original, 'utf-8');
    const before = statSync(zshrc);

    const outcome = ensureLocalBinOnShellPath({
      purposeLabel: 'claude-mem',
      logger: recordingLogger(),
      host: posixHost(home),
    });

    const after = statSync(zshrc);
    expect(outcome).toBe('rc-file-already-configured');
    expect(readFileSync(zshrc, 'utf-8')).toBe(original);
    expect(after.ino).toBe(before.ino);
  });

  it('creates the rc when the home has none', () => {
    const zshrc = path.join(home, '.zshrc');
    expect(existsSync(zshrc)).toBe(false);

    ensureLocalBinOnShellPath({
      purposeLabel: 'claude-mem',
      logger: recordingLogger(),
      host: posixHost(home),
    });

    expect(readFileSync(zshrc, 'utf-8')).toBe(
      `\n${shellPathSetupMarkerComment('claude-mem')}\nexport PATH="$HOME/.local/bin:$PATH"\n`,
    );
  });
});
