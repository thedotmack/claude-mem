import { expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFilesBatch, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

test('large callback batches retain exported functions and grouped callable fields', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'cm-large-callback-batch-'));
 try {
  const files = Array.from({ length: 80 }, (_, index) => {
   const relativePath = `callbacks-${index}.ts`;
   const content = `export function entry_${index}(items: number[]) {\n`
    + ' items.map(value => (((value + 1))));\n'.repeat(80)
    + ` return "owned entry ${index}";\n}\nclass Store { grouped = (((() => { return 42; }))); }\n`;
   const absolutePath = join(dir, relativePath);
   writeFileSync(absolutePath, content);
   return { relativePath, absolutePath, content };
  });
  const parsed = parseFilesBatch(files);
  expect(parsed.size).toBe(80);
  for (const [index, file] of files.entries()) {
   const symbols = parsed.get(file.relativePath)!.symbols;
   expect(symbols.map(symbol => symbol.name)).toEqual([`entry_${index}`, 'Store']);
   expect(symbols[1].children?.map(symbol => symbol.name)).toEqual(['grouped']);
  }
  const match = (await searchCodebase(dir, 'entry_79')).matchingSymbols.find(symbol => symbol.symbolName === 'entry_79');
  expect(match).toBeDefined();
  expect(unfoldSymbol(files[79].content, files[79].relativePath, match!.symbolName)).toContain('owned entry 79');
 } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
