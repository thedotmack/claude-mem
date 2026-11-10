import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { stripLegacyClaudeMemAlias } from '../../src/npx-cli/commands/uninstall.js';

// The shell rc a user already has open in an editor is not a file an uninstall
// may truncate. The alias strip read the whole file and wrote the whole file
// back with a plain writeFileSync, so a crash or a power loss in the window
// left a half-written .bashrc and a broken login shell. The shared helper
// writes its bytes to a temp file in the same directory, fsyncs, then renames
// over the target: a replacement lands as a new inode, which is what the second
// test measures. This is the same shape the earlier installer conversions use.
describe('uninstall strips the legacy shell alias atomically', () => {
  let home: string;
  let bashrc: string;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'uninstall-alias-'));
    bashrc = path.join(home, '.bashrc');
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  });

  const aliasLine = 'alias claude-mem="npx claude-mem@latest"';
  const keep = ['export EDITOR=vim', 'alias gs="git status"', 'alias ll="ls -la"'];

  it('removes only the alias line and keeps every other line', () => {
    writeFileSync(bashrc, [keep[0], aliasLine, keep[1], keep[2], ''].join('\n'), 'utf-8');

    stripLegacyClaudeMemAlias(home);

    expect(readFileSync(bashrc, 'utf-8')).toBe([keep[0], keep[1], keep[2], ''].join('\n'));
  });

  it('leaves a file without the alias untouched, inode included', () => {
    writeFileSync(bashrc, [keep[0], keep[1], ''].join('\n'), 'utf-8');
    const before = statSync(bashrc);

    stripLegacyClaudeMemAlias(home);

    const after = statSync(bashrc);
    expect(readFileSync(bashrc, 'utf-8')).toBe([keep[0], keep[1], ''].join('\n'));
    expect(after.ino).toBe(before.ino);
  });

  it('replaces the rewritten file instead of editing it in place', () => {
    writeFileSync(bashrc, [keep[0], aliasLine, keep[1], ''].join('\n'), 'utf-8');
    const before = statSync(bashrc);

    stripLegacyClaudeMemAlias(home);

    const after = statSync(bashrc);
    expect(after.ino).not.toBe(before.ino);
  });
});
