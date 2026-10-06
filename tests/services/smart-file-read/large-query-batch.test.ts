import { expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFilesBatch, unfoldSymbol, _resetGrammarLibOptOut } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

// One TypeScript batch of 100 files × 100 exported functions prints about
// 3 MiB of captures with the plain function and export patterns alone, past
// the 1 MiB stdout buffer execFileSync allows by default. Overflowing it used
// to drop every symbol in the batch and opt the language out of its compiled
// grammar.
test('a language batch with more than 1 MiB of captures keeps every symbol', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'cm-large-query-batch-'));
 const functionNames = (fileIndex: number) => Array.from({ length: 100 }, (_, index) => `f_${fileIndex}_${index}`);
 try {
  const files = Array.from({ length: 100 }, (_, fileIndex) => {
   const relativePath = `module-${fileIndex}.ts`;
   const content = functionNames(fileIndex).map(name => `export function ${name}() { return "${name} body"; }`).join('\n') + '\n';
   const absolutePath = join(dir, relativePath);
   writeFileSync(absolutePath, content);
   return { relativePath, absolutePath, content };
  });
  const parsed = parseFilesBatch(files);
  for (const [fileIndex, file] of files.entries()) {
   expect(parsed.get(file.relativePath)!.symbols.map(symbol => symbol.name)).toEqual(functionNames(fileIndex));
  }
  const match = (await searchCodebase(dir, 'f_99_99')).matchingSymbols.find(symbol => symbol.symbolName === 'f_99_99');
  expect(match).toBeDefined();
  expect(unfoldSymbol(files[99].content, files[99].relativePath, match!.symbolName)).toContain('f_99_99 body');
 } finally {
  _resetGrammarLibOptOut();
  rmSync(dir, { recursive: true, force: true });
 }
}, 120000);
