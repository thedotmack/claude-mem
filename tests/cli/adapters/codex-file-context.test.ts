import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { extractFilePaths } from '../../../src/cli/adapters/codex-file-context.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'codex-file-context-'));
  writeFileSync(join(tmpDir, 'README.md'), 'readme');
  writeFileSync(join(tmpDir, 'src.ts'), 'source');
  writeFileSync(join(tmpDir, 'notes.txt'), 'notes');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractFilePaths', () => {
  it('extracts existing files from Codex Bash read commands', () => {
    const paths = extractFilePaths('Bash', {
      command: 'cat README.md && head -n 20 src.ts && cat missing.md',
    }, tmpDir);

    expect(paths).toEqual(['README.md', 'src.ts']);
  });

  it('expands ~/ to the home directory, as the shell does, instead of resolving it under cwd', () => {
    // tmpDir stands in for the home directory; cwd is elsewhere.
    const paths = extractFilePaths('Bash', { command: 'cat ~/README.md ~/missing.md' }, '/nonexistent-cwd', tmpDir);

    expect(paths).toEqual([join(tmpDir, 'README.md')]);
  });

  it('does not consume cat boolean flags as file arguments', () => {
    const paths = extractFilePaths('Bash', {
      command: 'cat -n README.md',
    }, tmpDir);

    expect(paths).toEqual(['README.md']);
  });

  it('extracts plus-prefixed read operands', () => {
    writeFileSync(join(tmpDir, '+page.svelte'), 'synthetic page');
    expect(extractFilePaths('Bash', { command: 'cat +page.svelte' }, tmpDir)).toEqual(['+page.svelte']);
  });

  it.each(['my notes.md', 'notes;draft.md'])('preserves the %s operand in a read-command argv', (name) => {
    writeFileSync(join(tmpDir, name), 'contents');
    expect(extractFilePaths('Bash', { command: ['cat', name] }, tmpDir)).toEqual([name]);
  });

  it('still excludes plus-prefixed positioning options for tail', () => {
    writeFileSync(join(tmpDir, '+2'), 'not an operand');
    expect(extractFilePaths('Bash', { command: 'tail +2 README.md' }, tmpDir)).toEqual(['README.md']);
  });

  it('honors the option terminator before a hyphen-prefixed filename', () => {
    writeFileSync(join(tmpDir, '-notes.md'), 'literal filename');
    expect(extractFilePaths('Bash', { command: 'cat -- -notes.md' }, tmpDir)).toEqual(['-notes.md']);
  });

  it('keeps flag values before the terminator and filenames after it distinct', () => {
    writeFileSync(join(tmpDir, '-n'), 'literal filename');
    expect(extractFilePaths('Bash', { command: 'head -n 1 -- -n' }, tmpDir)).toEqual(['-n']);
  });

  it('treats a second terminator token as a filename once options have ended', () => {
    writeFileSync(join(tmpDir, '--'), 'literal filename');
    expect(extractFilePaths('Bash', { command: 'cat -- --' }, tmpDir)).toEqual(['--']);
  });

  it('resets option parsing at each shell command segment', () => {
    writeFileSync(join(tmpDir, '-notes.md'), 'literal filename');
    expect(extractFilePaths('Bash', { command: 'cat -- -notes.md && cat -n README.md' }, tmpDir))
      .toEqual(['-notes.md', 'README.md']);
  });

  it('ignores non-read Bash commands', () => {
    const paths = extractFilePaths('Bash', {
      command: 'rm README.md; echo src.ts',
    }, tmpDir);

    expect(paths).toEqual([]);
  });

  it('extracts MCP read tool path arrays', () => {
    const paths = extractFilePaths('mcp__local_filesystem__read_file', {
      paths: ['README.md', 'notes.txt', 'missing.txt'],
    }, tmpDir);

    expect(paths).toEqual(['README.md', 'notes.txt']);
  });

  it('extracts MCP exact read/view/cat tool names', () => {
    expect(extractFilePaths('mcp__fs__read', { path: 'README.md' }, tmpDir)).toEqual(['README.md']);
    expect(extractFilePaths('mcp__fs__view_files', { paths: ['README.md'] }, tmpDir)).toEqual(['README.md']);
  });

  it('ignores MCP tool names that only contain read verbs as a prefix', () => {
    expect(extractFilePaths('mcp__fs__read_write', { path: 'README.md' }, tmpDir)).toEqual([]);
    expect(extractFilePaths('mcp__server__readonly', { path: 'README.md' }, tmpDir)).toEqual([]);
  });

  // #3688: `parse` throws "Bad substitution" on `${}`. The throw escaped this
  // best-effort enrichment and reached the generic hook handler, which answers
  // BLOCKING_ERROR — so an ordinary shell command was blocked and the tool call
  // discarded, to add a convenience field.
  it('yields no paths instead of throwing on an unparseable substitution', () => {
    expect(() => extractFilePaths('Bash', { command: 'cat ${}' }, tmpDir)).not.toThrow();
    expect(extractFilePaths('Bash', { command: 'cat ${}' }, tmpDir)).toEqual([]);
  });
});
