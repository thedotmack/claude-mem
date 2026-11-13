import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as promises from 'node:fs/promises';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTest } from './native-prerequisite.js';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const limit = 512 * 1024;
const directories: string[] = [];
afterEach(() => {
  mock.restore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-search-read-budget-'));
  directories.push(directory);
  const path = join(directory, 'target.ts');
  writeFileSync(path, content);
  return { directory, path };
}

/** Change a real file after its metadata is read, through either supported I/O path. */
function observeReads(path: string, afterMetadata: () => void = () => {}, failRead = false) {
  const state = { bytes: 0, metadataReads: 0, opened: 0, closed: 0 };
  const stat = promises.stat.bind(promises);
  const open = promises.open.bind(promises);
  const readFile = promises.readFile.bind(promises);
  spyOn(promises, 'stat').mockImplementation((async (...args: Parameters<typeof promises.stat>) => {
    const result = await stat(...args);
    if (String(args[0]) === path) { state.metadataReads++; afterMetadata(); }
    return result;
  }) as typeof promises.stat);
  spyOn(promises, 'readFile').mockImplementation((async (...args: Parameters<typeof promises.readFile>) => {
    if (String(args[0]) === path && failRead) throw new Error('controlled read failure');
    const result = await readFile(...args);
    if (String(args[0]) === path) state.bytes += Buffer.byteLength(result);
    return result;
  }) as typeof promises.readFile);
  spyOn(promises, 'open').mockImplementation(async (...args: Parameters<typeof promises.open>) => {
    const handle = await open(...args);
    if (String(args[0]) !== path) return handle;
    state.opened++;
    const handleStat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
      const result = await handleStat(...statArgs);
      state.metadataReads++;
      afterMetadata();
      return result;
    }) as typeof handle.stat;
    handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
      if (failRead) throw new Error('controlled read failure');
      const result = await read(...readArgs);
      state.bytes += result.bytesRead;
      return result;
    }) as typeof handle.read;
    handle.close = async () => { state.closed++; await close(); };
    return handle;
  });
  return state;
}

for (const megabytes of [4, 16]) {
  test(`path search bounds a source growing to ${megabytes} MiB after metadata`, async () => {
    const { directory, path } = fixture('export const target = 1;');
    const reads = observeReads(path, () => writeFileSync(path, 'x'.repeat(megabytes * 1024 * 1024)));
    const result = await searchCodebase(directory, 'target', { skipSymbolExtraction: true });
    expect(reads.metadataReads).toBe(1);
    expect(result.totalFilesScanned).toBe(0);
    expect(result.matchingFiles).toEqual([]);
    expect(reads.bytes).toBeLessThanOrEqual(limit + 1);
    expect(reads.closed).toBe(reads.opened);
  });
}

nativeTest('native search never parses a source that grows beyond the byte limit', async () => {
  const { directory, path } = fixture('export function target() { return 1; }');
  const reads = observeReads(path, () => writeFileSync(path, 'export function target() {}\n//' + 'x'.repeat(2 * limit)));
  const result = await searchCodebase(directory, 'target');
  expect(reads.metadataReads).toBe(1);
  expect(result.totalFilesScanned).toBe(0);
  expect(result.matchingSymbols).toEqual([]);
  expect(reads.bytes).toBeLessThanOrEqual(limit + 1);
  expect(reads.closed).toBe(reads.opened);
}, 120_000);

nativeTest('a source exactly at the byte limit preserves UTF-8 across read boundaries', async () => {
  let source = '//' + 'x'.repeat(65_533) + '数\nexport function 名称() { return "完整"; }\n//';
  source += 'x'.repeat(limit - Buffer.byteLength(source));
  const { directory, path } = fixture(source);
  const reads = observeReads(path);
  const result = await searchCodebase(directory, '名称');
  expect(result.totalFilesScanned).toBe(1);
  expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['名称']);
  expect(result.foldedFiles[0]).toEqual(parseFile(source, 'target.ts'));
  expect(reads.bytes).toBe(limit);
  expect(reads.closed).toBe(reads.opened);
}, 120_000);

test('an already oversized source is skipped without reading content', async () => {
  const { directory, path } = fixture('x'.repeat(limit + 1));
  const reads = observeReads(path);
  const result = await searchCodebase(directory, 'target', { skipSymbolExtraction: true });
  expect(result.totalFilesScanned).toBe(0);
  expect(reads.bytes).toBe(0);
  expect(reads.closed).toBe(reads.opened);
});

test('a read error skips the file and closes the opened handle', async () => {
  const { directory, path } = fixture('export const target = 1;');
  const reads = observeReads(path, undefined, true);
  const result = await searchCodebase(directory, 'target', { skipSymbolExtraction: true });
  expect(result.totalFilesScanned).toBe(0);
  expect(reads.closed).toBe(reads.opened);
});

(process.platform === 'win32' ? nativeTest.skip : nativeTest)('a path replacement keeps reads on the file whose metadata was checked', async () => {
  const source = 'export function target() { return "original"; }';
  const { directory, path } = fixture(source);
  const reads = observeReads(path, () => {
    renameSync(path, join(directory, 'old-source.txt'));
    writeFileSync(path, 'export function replacement() {}\n//' + 'x'.repeat(2 * limit));
  });
  const result = await searchCodebase(directory, 'target');
  expect(reads.metadataReads).toBe(1);
  expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['target']);
  expect(result.foldedFiles[0]).toEqual(parseFile(source, 'target.ts'));
  expect(reads.bytes).toBe(Buffer.byteLength(source));
  expect(reads.closed).toBe(reads.opened);
}, 120_000);
