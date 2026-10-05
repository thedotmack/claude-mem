import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const C = '#include <stddef.h>\nstruct Point { int x; int y; };\nint add(int a, int b) { return a + b; }\nchar *message(void) { return "hello"; }';
const CPP = '#include <string>\nclass Counter {\npublic:\n int increment() { return 1; }\n};\nint add(int a, int b) { return a + b; }';

describe('built-in C and C++ native outlines', () => {
  test('C captures functions, pointer return functions, structs and includes', () => {
    const parsed = parseFile(C, 'owned.c');
    expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['Point', 'add', 'message']);
    expect(parsed.symbols.map(symbol => symbol.kind)).toEqual(['struct', 'function', 'function']);
    expect(parsed.imports).toEqual(['#include <stddef.h>']);
    expect(unfoldSymbol(C, 'owned.c', 'message')).toContain('return "hello"');
  }, 120000);

  test('C++ captures classes with their methods, free functions and includes', () => {
    const parsed = parseFile(CPP, 'owned.cpp');
    expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['Counter', 'add']);
    expect(parsed.symbols[0].children?.map(symbol => symbol.name)).toEqual(['increment']);
    expect(parsed.imports).toEqual(['#include <string>']);
    expect(unfoldSymbol(CPP, 'owned.cpp', 'increment')).toContain('return 1');
  }, 120000);

  test('native batched search discovers functions in each built-in language', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-c-cpp-search-'));
    try {
      writeFileSync(join(dir, 'owned.c'), C);
      writeFileSync(join(dir, 'owned.cpp'), CPP);
      const result = await searchCodebase(dir, 'add');
      expect(result.matchingSymbols.filter(symbol => symbol.symbolName === 'add').map(symbol => symbol.filePath).sort()).toEqual(['owned.c', 'owned.cpp']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});

test('native C and C++ outlines retain deeply nested pointer declarators', () => {
  for (const extension of ['c', 'cpp']) {
    const source = 'char ****message(void) { return 0; }\nint ordinary(void) { return 1; }';
    expect(parseFile(source, `owned.${extension}`).symbols.map(symbol => symbol.name)).toEqual(['message', 'ordinary']);
    expect(unfoldSymbol(source, `owned.${extension}`, 'message')).toContain('return 0');
  }
}, 120000);

test('native C++ outlines, unfold and batch search retain reference returns and special members', async () => {
  const source = 'struct Widget {};\nWidget& getWidget() { static Widget result; return result; }\nclass Counter {\n ~Counter() { cleanup(); }\n bool operator==(const Counter& other) { return true; }\n int increment() { return 1; }\n};';
  const parsed = parseFile(source, 'owned.cpp');
  expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['Widget', 'getWidget', 'Counter']);
  expect(parsed.symbols[2].children?.map(symbol => symbol.name)).toEqual(['~Counter', 'operator==', 'increment']);
  expect(unfoldSymbol(source, 'owned.cpp', 'getWidget')).toContain('return result');
  expect(unfoldSymbol(source, 'owned.cpp', '~Counter')).toContain('cleanup()');
  expect(unfoldSymbol(source, 'owned.cpp', 'operator==')).toContain('return true');
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-cpp-declarators-'));
  try {
    writeFileSync(join(dir, 'owned.cpp'), source);
    expect((await searchCodebase(dir, 'getWidget')).matchingSymbols.map(symbol => symbol.symbolName)).toContain('getWidget');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('native anonymous typedef struct is accessible by its declared type name', () => {
  const source = 'typedef struct { int x; } Point;\n';
  expect(parseFile(source, 'owned.c').symbols.map(symbol => symbol.name)).toEqual(['Point']);
  expect(unfoldSymbol(source, 'owned.c', 'Point')).toContain(source.trim());
}, 120000);

test('uses the enclosing function name before callback parameters', () => {
  const source = 'int apply(int (*callback)(int)) { return callback(1); }\nint (*factory(void))(int) { return 0; }';
  expect(parseFile(source, 'owned.c').symbols.map(symbol => symbol.name)).toEqual(['apply', 'factory']);
}, 120000);
