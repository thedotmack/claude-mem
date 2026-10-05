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
