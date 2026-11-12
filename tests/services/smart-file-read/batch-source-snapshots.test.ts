import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, parseFilesBatch } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

describe('native batches parse the source that was read', () => {
  for (const [relativePath, content, replacement] of [
    ['module.ts', 'export function capturedSnapshot() { return 1; }', 'export function x() { return 2; }'],
    ['module.py', 'def captured_snapshot():\n    return 1\n', 'def x():\n    return 2\n'],
    ['module.rs', 'pub fn captured_snapshot() -> i32 { 1 }', 'pub fn x() -> i32 { 2 }'],
  ]) {
    test(`an edited ${relativePath} keeps capture offsets consistent with its supplied content`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'cm-batch-snapshot-'));
      try {
        const absolutePath = join(directory, relativePath);
        writeFileSync(absolutePath, replacement);
        const parsed = parseFilesBatch([{ absolutePath, relativePath, content }]);
        expect(parsed.get(relativePath)).toEqual(parseFile(content, relativePath));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 120000);
  }

  test('a file removed after the read does not discard its language batch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-batch-removed-'));
    try {
      const files = ['removed.ts', 'remaining.ts'].map((relativePath, index) => {
        const content = `export function retained${index}() { return ${index}; }`;
        const absolutePath = join(directory, relativePath);
        writeFileSync(absolutePath, content);
        return { absolutePath, relativePath, content };
      });
      rmSync(files[0].absolutePath);
      const parsed = parseFilesBatch(files);
      for (const file of files) expect(parsed.get(file.relativePath)).toEqual(parseFile(file.content, file.relativePath));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120000);

  test('unchanged files retain their original paths, imports, and symbols across languages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-batch-control-'));
    try {
      const files = [
        ['space [literal].ts', 'import { readFile } from "node:fs/promises";\nexport function readData() { return readFile("data"); }'],
        ['unicode-示例.py', 'import json\nclass Reader:\n    def read(self):\n        return json.loads("null")\n'],
      ].map(([relativePath, content]) => {
        const absolutePath = join(directory, relativePath);
        writeFileSync(absolutePath, content);
        return { absolutePath, relativePath, content };
      });
      const parsed = parseFilesBatch(files);
      for (const file of files) expect(parsed.get(file.relativePath)).toEqual(parseFile(file.content, file.relativePath));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120000);

  (process.platform === 'win32' ? test.skip : test)('a POSIX newline filename survives native batch identity and smart search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cm-batch-newline-'));
    try {
      const relativePath = 'two\nlines.ts';
      const absolutePath = join(directory, relativePath);
      const content = 'export function retainedMarker() { return 1; }';
      writeFileSync(absolutePath, content);
      expect(parseFilesBatch([{ absolutePath, relativePath, content }]).get(relativePath)).toEqual(parseFile(content, relativePath));
      const result = await searchCodebase(directory, 'retainedMarker');
      expect(result.matchingSymbols.map(symbol => [symbol.filePath, symbol.symbolName])).toEqual([[relativePath, 'retainedMarker']]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120000);
});
