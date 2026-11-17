import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTest as test } from './native-prerequisite.js';
import { formatFoldedView, parseFile, parseFilesBatch, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const source = [
  'module.exports = function createReader(options = { strict: true }) {',
  '  return options;',
  '};',
  'exports.read = async (source) => {',
  '  return source.trim();',
  '};',
  'Reader.prototype.values = function* () {',
  '  yield "value";',
  '};',
  'cache["refresh"] = (function () {',
  '  return "refreshed";',
  '});',
  'format = value => value.toUpperCase();',
  'function local() { return "local"; }',
  'exports.version = 1;',
  'exports.wrapped = wrap(() => "callback");',
].join('\n');
const names = ['module.exports', 'exports.read', 'Reader.prototype.values', 'cache["refresh"]', 'format', 'local'];

for (const extension of ['js', 'cjs', 'ts', 'tsx']) {
  describe(`assigned function definitions in ${extension}`, () => {
    test('retains assignment names and native function signature boundaries', () => {
      const parsed = parseFile(source, `reader.${extension}`);
      expect(parsed.symbols.map(symbol => symbol.name)).toEqual(names);
      expect(parsed.symbols.every(symbol => symbol.kind === 'function')).toBe(true);
      expect(parsed.symbols[0].signature).toBe('module.exports = function createReader(options = { strict: true })');
      expect(parsed.symbols[4].signature).toBe('format = value =>');
      expect(formatFoldedView(parsed)).toContain('exports.read = async (source) =>');
      expect(unfoldSymbol(source, `reader.${extension}`, 'Reader.prototype.values')).toContain('yield "value"');
      const refreshed = unfoldSymbol(source, `reader.${extension}`, 'cache["refresh"]');
      expect(refreshed).toContain('return "refreshed"');
      expect(refreshed).not.toContain('format =');
    }, 120000);

    test('keeps declarations and class fields separate from non-function assignments', () => {
      const content = 'const named = () => 1;\nclass Reader { read = () => 2; }\nexports.value = 3;\nexports.run = wrap(() => 4);';
      const parsed = parseFile(content, `control.${extension}`);
      expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['named', 'Reader']);
      expect(parsed.symbols[1].children?.map(symbol => symbol.name)).toEqual(['read']);
    }, 120000);
  });
}

test('native batches and repository search retain CommonJS and prototype entry points', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cm-assigned-functions-'));
  try {
    const absolutePath = join(directory, 'reader.cjs');
    writeFileSync(absolutePath, source);
    const files = [{ absolutePath, relativePath: 'reader.cjs', content: source }];
    expect(parseFilesBatch(files).get('reader.cjs')?.symbols.map(symbol => symbol.name)).toEqual(names);
    const result = await searchCodebase(directory, 'Reader.prototype.values');
    expect(result.matchingSymbols.map(symbol => [symbol.filePath, symbol.symbolName])).toEqual([
      ['reader.cjs', 'Reader.prototype.values'],
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);
