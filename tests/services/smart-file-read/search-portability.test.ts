import { test } from 'bun:test';
import { nativeTest } from './native-prerequisite.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

test('a path-only search over more source bytes than the heap completes', () => {
  const root = mkdtempSync(join(tmpdir(), 'smart-search-heap-'));
  try {
    const padding = 'x'.repeat(355_000);
    for (let i = 0; i < 256; i++) writeFileSync(join(root, `lookup-${i}.ts`), `// ${i}\n//${padding}`);
    const source = buildSync({
      stdin: { resolveDir: process.cwd(), contents: `
        import { searchCodebase } from './src/services/smart-file-read/search.ts';
        const result = await searchCodebase(process.argv[2], 'lookup', { skipSymbolExtraction: true });
        console.log(JSON.stringify([result.totalFilesScanned, result.matchingFiles.length]));
      ` },
      bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false,
    }).outputFiles[0].text;
    const child = spawnSync('node', ['--max-old-space-size=48', '--input-type=module', '-', root],
      { input: source, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), [256, 20]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

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
