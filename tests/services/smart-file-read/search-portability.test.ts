import { test } from 'bun:test';
import { nativeTest } from './native-prerequisite.js';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

test('file filters copied across platforms select the same relative paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smart-search-path-'));
  try {
    for (const dir of ['library', 'other']) {
      mkdirSync(join(root, 'src', dir), { recursive: true });
      writeFileSync(join(root, 'src', dir, 'needle.ts'), 'export const value = 1;');
    }
    for (const filePattern of ['src/library', 'src\\library']) {
      const result = await searchCodebase(root, 'needle', { filePattern, skipSymbolExtraction: true });
      assert.equal(result.totalFilesScanned, 1);
      assert.equal(result.matchingFiles.length, 1);
      assert.match(result.matchingFiles[0].filePath, /library/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('path-only results retain counts and line totals over multiple source batches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smart-search-batches-'));
  try {
    const source = `// ${'x'.repeat(460_000)}\nconst a = 1;\n`;
    for (let i = 0; i < 24; i++) writeFileSync(join(root, `needle-${i}.ts`), source);
    const result = await searchCodebase(root, 'needle', { maxResults: 24, skipSymbolExtraction: true });
    assert.equal(result.totalFilesScanned, 24);
    assert.equal(result.matchingFiles.length, 24);
    assert.ok(result.matchingFiles.every(file => file.totalLines === 3));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

nativeTest('keeps native symbols from both sides of a source batch boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smart-search-native-batches-'));
  try {
    const padding = '// ' + 'x'.repeat(460_000);
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(root, `part-${i}.ts`), `${padding}\nexport function marker${i}() {}\n`);
    }
    const result = await searchCodebase(root, 'marker', { maxResults: 20 });
    assert.equal(result.totalFilesScanned, 20);
    assert.equal(new Set(result.matchingSymbols.map(hit => hit.symbolName)).size, 20);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
