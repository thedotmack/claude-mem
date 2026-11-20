import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTest as test } from './native-prerequisite.js';
import { docCommentSummary, formatFoldedView, parseFile } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const source = [
  'def inline(): """Cobalt inline summary."""; return "unrelated return"',
  '',
  'def short():',
  '    "Amber short summary."',
  '    return "unrelated return"',
  '',
  "class Tiny: 'Ivory class summary.'",
  '',
  'class Owner:',
  "    def method(self): 'Jasper method summary.'; return 1",
  '',
  "def raw(): r'Saffron raw summary with \\d.'",
  '',
  'def unicode(): u"""Jade Unicode summary."""',
  '',
  'def wrapped(',
  '    value: int,',
  '): """Indigo wrapped summary."""; return value',
  '',
  'def commented():',
  '    # first comment',
  '    # second comment',
  '    """',
  '    Existing multiline summary.',
  '    """',
  '    return 2',
  '',
  'def concatenate():',
  '    """Existing concatenated""" " summary."',
  '',
  'def late():',
  '    value = 1',
  '    """Not documentation after an executable statement."""',
  '    return value',
  '',
  'def formatted(): f"""Not a docstring {1}."""',
  'def bytes_only(): b"""Not a text docstring."""',
  'def empty(): """"""; return 3',
].join('\n');

describe('Python docstrings follow their native statement ranges', () => {
  for (const [name, summary] of [
    ['inline', 'Cobalt inline summary.'],
    ['short', 'Amber short summary.'],
    ['Tiny', 'Ivory class summary.'],
    ['raw', 'Saffron raw summary with \\d.'],
    ['unicode', 'Jade Unicode summary.'],
    ['wrapped', 'Indigo wrapped summary.'],
  ]) {
    test(`outlines retain the exact docstring of ${name}`, () => {
      const symbol = parseFile(source, 'docs.py').symbols.find(item => item.name === name)!;
      expect(symbol.jsdoc && docCommentSummary(symbol.jsdoc)).toBe(summary);
      expect(symbol.jsdoc).not.toContain('unrelated return');
    }, 120000);
  }

  test('method docstrings stay attached to their owning class', () => {
    const parsed = parseFile(source, 'docs.py');
    const method = parsed.symbols.find(item => item.name === 'Owner')?.children?.find(item => item.name === 'method');
    expect(method?.jsdoc && docCommentSummary(method.jsdoc)).toBe('Jasper method summary.');
    expect(formatFoldedView(parsed)).toContain('💬 Jasper method summary.');
  }, 120000);

  test('adjacent literals form one docstring without retaining their quote markers', () => {
    const symbol = parseFile(source, 'docs.py').symbols.find(item => item.name === 'concatenate');
    expect(symbol?.jsdoc).toBe('Existing concatenated summary.');
  }, 120000);

  test('ordinary multiline docstrings and non-docstring controls retain their meaning', () => {
    const symbols = parseFile(source, 'docs.py').symbols;
    const existing = symbols.find(item => item.name === 'commented')!;
    expect(existing.jsdoc && docCommentSummary(existing.jsdoc)).toBe('Existing multiline summary.');
    for (const name of ['late', 'formatted', 'bytes_only', 'empty']) {
      expect(symbols.find(item => item.name === name)?.jsdoc).toBeUndefined();
    }
  }, 120000);

  test('smart search finds the documented definitions without indexing adjacent statements', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cmem-docstring-statements-'));
    try {
      writeFileSync(join(directory, 'docs.py'), source);
      for (const [query, name] of [['cobalt', 'inline'], ['amber', 'short'], ['ivory', 'Tiny'], ['jasper', 'Owner.method']]) {
        const result = await searchCodebase(directory, query);
        expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toContain(name);
      }
      expect((await searchCodebase(directory, 'unrelated')).matchingSymbols).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120000);
});
