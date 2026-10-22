import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

// The Rust query had no pattern for mod_item, so the functions of an inline
// module, such as the `#[cfg(test)] mod tests` of most Rust files, were listed
// at the top of the file next to the ones they test.
const SOURCE = [
  'pub mod config {',
  '    pub fn load() -> u32 { 1 }',
  '    fn parse(raw: &str) -> u32 { raw.len() as u32 }',
  '}',
  '',
  'mod parser;',
  '',
  'pub fn run() -> u32 { config::load() }',
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '',
  '    #[test]',
  '    fn runs() { assert_eq!(run(), 1); }',
  '}',
].join('\n');

describe('Rust module outlines', () => {
  test('nests the items of an inline module under it', () => {
    const symbols = parseFile(SOURCE, 'lib.rs').symbols;
    expect(symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([
      ['config', 'namespace', true],
      ['parser', 'namespace', false],
      ['run', 'function', true],
      ['tests', 'namespace', false],
    ]);
    expect(symbols[0].children?.map(symbol => [symbol.name, symbol.exported])).toEqual([['load', true], ['parse', false]]);
    expect(symbols[1].children).toEqual([]);
    expect(symbols[3].children?.map(symbol => symbol.name)).toEqual(['runs']);
  }, 120000);

  test('unfolds a module and qualifies its items in search', async () => {
    expect(unfoldSymbol(SOURCE, 'lib.rs', 'config')).toContain('fn parse(raw: &str)');
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-rust-modules-'));
    try {
      writeFileSync(join(dir, 'lib.rs'), SOURCE);
      const result = await searchCodebase(dir, 'runs');
      expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['tests.runs']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
