import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { removeContextTagBlock } from '../../src/services/integrations/AntigravityCliHooksInstaller.js';

// The context block lives inside GEMINI.md, a user-owned markdown file that
// agy and the user both edit. Removing the block rewrote the file in place, so
// an interrupted uninstall could leave a truncated GEMINI.md. A temp-file-plus-
// rename write yields a new file; an in-place truncate keeps the same one.
//
// Only removeContextTagBlock is driven here: the other Antigravity write sites
// resolve their paths from the real `~/.gemini` at module load, so a test
// cannot redirect them without patching os.homedir before import. They use the
// same two helpers as this one.
describe('Antigravity removes the context block atomically', () => {
  let tmp: string;
  let markdownPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'antigravity-atomic-'));
    markdownPath = path.join(tmp, 'GEMINI.md');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces GEMINI.md instead of truncating it in place', () => {
    writeFileSync(
      markdownPath,
      ['# My rules', '', '<claude-mem-context>', 'injected', '</claude-mem-context>', '', 'tail section', ''].join('\n'),
    );
    const first = statSync(markdownPath);

    expect(removeContextTagBlock(markdownPath)).toBe(true);
    const second = statSync(markdownPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
    const text = readFileSync(markdownPath, 'utf-8');
    expect(text).toContain('# My rules');
    expect(text).toContain('tail section');
    expect(text).not.toContain('injected');
  });

  it('leaves a file without the block untouched', () => {
    writeFileSync(markdownPath, '# My rules\n');
    const first = statSync(markdownPath);

    expect(removeContextTagBlock(markdownPath)).toBe(false);
    const second = statSync(markdownPath);

    expect(second.mtimeMs).toBe(first.mtimeMs);
    expect(readFileSync(markdownPath, 'utf-8')).toBe('# My rules\n');
  });
});