import { describe, it, expect } from 'bun:test';
import { resolveTreeSitterBinPath } from '../../../src/services/smart-file-read/parser.js';

// Windows portability audit (#3644): tree-sitter-cli installs `tree-sitter.exe`
// on Windows, not a bare `tree-sitter`. The old lookup joined the package dir
// with the POSIX name only, so existsSync() always missed on win32 and the
// resolver silently fell through to a bare `tree-sitter` on PATH — smart file
// parsing / structural search then returned empty results with no error.

describe('Windows #3644 - tree-sitter binary resolution', () => {
  it('resolves a tree-sitter.exe path on win32', () => {
    const binPath = resolveTreeSitterBinPath('win32');
    expect(binPath.toLowerCase().endsWith('tree-sitter.exe')).toBe(true);
  });

  it('never resolves a .exe path on POSIX platforms', () => {
    const linuxPath = resolveTreeSitterBinPath('linux');
    const darwinPath = resolveTreeSitterBinPath('darwin');
    expect(linuxPath.toLowerCase().endsWith('.exe')).toBe(false);
    expect(darwinPath.toLowerCase().endsWith('.exe')).toBe(false);
    expect(linuxPath.endsWith('tree-sitter')).toBe(true);
    expect(darwinPath.endsWith('tree-sitter')).toBe(true);
  });
});
