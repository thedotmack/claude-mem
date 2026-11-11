import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const cSource = readFileSync(join(import.meta.dir, 'fixtures/function-declarations.h'), 'utf8');
const cppSource = readFileSync(join(import.meta.dir, 'fixtures/function-declarations.hpp'), 'utf8');

describe('native C and C++ function declarations', () => {
  test('retains header APIs through pointer wrappers and multiple declarators', () => {
    const file = parseFile(cSource, 'owned.h');
    expect(file.symbols.map(symbol => symbol.name)).toEqual([
      'Hook', 'add', 'message', 'apply', 'factory', 'first', 'second', 'repeated(int value)', 'repeated',
    ]);
    expect(file.symbols.find(symbol => symbol.name === 'factory')?.kind).toBe('function');
    expect(unfoldSymbol(cSource, 'owned.h', 'factory')).toContain('int (*factory(void))(int);');
    expect(unfoldSymbol(cSource, 'owned.h', 'second')).toContain('int first(void), second(int value);');
  }, 120000);

  test('keeps the entire multiline declaration, documentation and exact source bounds', () => {
    const file = parseFile(cSource, 'owned.h');
    const add = file.symbols.find(symbol => symbol.name === 'add');
    expect(add?.signature).toBe('int add( int lhs, int rhs );');
    expect(add?.jsdoc).toContain('Adds the two public values');
    expect(add?.lineStart).toBe(9);
    expect(add?.lineEnd).toBe(12);
    expect(formatFoldedView(file)).toContain('int add( int lhs, int rhs );');
    const unfolded = unfoldSymbol(cSource, 'owned.h', 'add');
    expect(unfolded).toContain('int rhs');
    expect(unfolded).not.toContain('message(void)');
  }, 120000);

  test('retains C++ member declarations and disambiguates only colliding names', () => {
    const api = parseFile(cppSource, 'owned.hpp').symbols.find(symbol => symbol.name === 'api')!;
    const widget = api.children?.find(symbol => symbol.name === 'Widget');
    expect(widget?.children?.map(symbol => symbol.name)).toEqual([
      'Widget', '~Widget', 'size()', 'size() const', 'name', 'shared', 'operator==',
    ]);
    expect(widget?.children?.every(symbol => symbol.kind === 'method')).toBe(true);
    expect(api.children?.map(symbol => symbol.name)).toEqual([
      'Widget', 'remoteFetch', 'tally(int count)', 'tally(double count)', 'identity',
    ]);
    expect(unfoldSymbol(cppSource, 'owned.hpp', 'api.Widget.shared')).toContain('static Widget& shared() noexcept;');
  }, 120000);

  test('native batch search returns a qualified header API that unfolds precisely', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owned-c-api-'));
    try {
      writeFileSync(join(directory, 'public.h'), cSource);
      writeFileSync(join(directory, 'public.hpp'), cppSource);
      const results = await searchCodebase(directory, 'remoteFetch');
      const hit = results.matchingSymbols.find(symbol => symbol.symbolName === 'api.remoteFetch');
      expect(hit?.filePath).toBe('public.hpp');
      expect(hit?.kind).toBe('function');
      const unfolded = unfoldSymbol(cppSource, 'public.hpp', hit!.symbolName);
      expect(unfolded).toContain('Widget& remoteFetch();');
      expect(unfolded).not.toContain('int tally');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120000);

  test('unfolds declaration overloads and const member variants independently', () => {
    const overloaded = unfoldSymbol(cppSource, 'owned.hpp', 'api.tally(double count)');
    expect(overloaded).toContain('int tally(double count);');
    expect(overloaded).not.toContain('int tally(int count);');
    const constant = unfoldSymbol(cppSource, 'owned.hpp', 'api.Widget.size() const');
    expect(constant).toContain('int size() const;');
    expect(constant).not.toContain('int size();');
  }, 120000);

  test('keeps existing bare-name body lookup when a prototype precedes it', () => {
    expect(unfoldSymbol(cSource, 'owned.h', 'repeated')).toContain('return value + 1;');
    const body = 'int apply(int handler(int)) { return handler(1); }\nint (*factory(void))(int) { return 0; }';
    expect(parseFile(body, 'owned.c').symbols.map(symbol => symbol.name)).toEqual(['apply', 'factory']);
    expect(unfoldSymbol(body, 'owned.c', 'factory')).toContain('return 0;');
  }, 120000);

  test('does not turn function pointers, their callback parameters or typedefs into APIs', () => {
    const source = 'int (*slot)(int nested(int));\ntypedef int Callback(int input);\ntypedef int (*Pointer)(int input);\nstruct Storage { int (*callback)(int nested(int)); int value; };';
    for (const extension of ['c', 'cpp']) {
      const file = parseFile(source, 'owned.' + extension);
      expect(file.symbols.map(symbol => symbol.name)).toEqual(['Storage']);
      expect(file.symbols[0].children).toEqual([]);
    }
  }, 120000);

  test('keeps a multiline template return type and C language linkage declaration', () => {
    const file = parseFile(cppSource, 'owned.hpp');
    const api = file.symbols.find(symbol => symbol.name === 'api')!;
    expect(api.children?.find(symbol => symbol.name === 'identity')?.signature).toBe('template<typename T> auto identity( T value ) -> T;');
    const unfolded = unfoldSymbol(cppSource, 'owned.hpp', 'api.identity');
    expect(unfolded).toContain('template<typename T>');
    expect(unfolded).toContain(') -> T;');
    expect(unfolded).not.toContain('c_linkage');
    expect(file.symbols.find(symbol => symbol.name === 'c_linkage')?.kind).toBe('function');
  }, 120000);
});
