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

  it('does not consume cat boolean flags as file arguments', () => {
    const paths = extractFilePaths('Bash', {
      command: 'cat -n README.md',
    }, tmpDir);

    expect(paths).toEqual(['README.md']);
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
});
