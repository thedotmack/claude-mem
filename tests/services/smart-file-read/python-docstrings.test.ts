import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatFoldedView, parseFile } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = [
  '@dataclass',
  'class Point:',
  '    """A point in the plane."""',
  '    x: int',
  '',
  'def resize(',
  '    width: int,',
  '    height: int,',
  ') -> None:',
  '    """Resize the window."""',
  '',
  'def load():',
  '    """',
  '    Load the config.',
  '    """',
  '',
  'def pattern():',
  '    r"""Match \\d+ digits."""',
  '',
  '# A helper.',
  'def helper():',
  '    """Help."""',
  '',
  '@property',
  'def name(self):',
  '    pass',
  '',
  '@cached_property',
  'def size(self):',
  '    """"""',
  '    return 0',
].join('\n');

describe('Python docstring summaries', () => {
  test('read the docstring of a definition wherever its body starts', () => {
    const outline = formatFoldedView(parseFile(SOURCE, 'docs.py'));
    // after a decorator, after a multi-line signature, on the row after the
    // opening quotes, and in a raw docstring
    expect(outline).toContain('💬 A point in the plane.');
    expect(outline).toContain('💬 Resize the window.');
    expect(outline).toContain('💬 Load the config.');
    expect(outline).toContain('💬 Match \\d+ digits.');
    expect(outline).toContain('💬 Help.');
    expect(outline).not.toContain('💬 @dataclass');
    expect(outline).not.toContain('💬 # A helper.');
    // A definition without a docstring, or with an empty one, keeps the line above it.
    expect(outline).toContain('💬 @property');
    expect(outline).toContain('💬 @cached_property');
  }, 120000);

  test('search matches the docstring and still the decorator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-python-docstrings-'));
    try {
      writeFileSync(join(dir, 'docs.py'), SOURCE);
      const plane = await searchCodebase(dir, 'plane');
      expect(plane.matchingSymbols.find(symbol => symbol.symbolName === 'Point')?.matchReason).toBe('jsdoc match');
      const config = await searchCodebase(dir, 'config');
      expect(config.matchingSymbols.map(symbol => symbol.symbolName)).toContain('load');
      const dataclass = await searchCodebase(dir, 'dataclass');
      expect(dataclass.matchingSymbols.map(symbol => symbol.symbolName)).toContain('Point');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
