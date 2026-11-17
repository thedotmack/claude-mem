import { expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = `class Converter {
  int convert(int value) { return value + 1; }
  String convert(String value) { return value.trim(); }
  void reset() {}
}`;

test('assigns distinct identities to sibling Java method overloads', () => {
  const methods = parseFile(SOURCE, 'Converter.java').symbols[0].children;
  expect(methods?.map(method => method.name)).toEqual(['convert(int value)', 'convert(String value)', 'reset']);
  expect(methods?.map(method => method.lineStart)).toEqual([1, 2, 3]);
}, 120000);

test('unfolds each overload by its returned identity and preserves the old bare lookup', () => {
  expect(unfoldSymbol(SOURCE, 'Converter.java', 'Converter.convert(int value)')).toContain('return value + 1');
  const stringBody = unfoldSymbol(SOURCE, 'Converter.java', 'Converter.convert(String value)');
  expect(stringBody).toContain('return value.trim()');
  expect(stringBody).not.toContain('value + 1');
  expect(unfoldSymbol(SOURCE, 'Converter.java', 'convert(String value)')).toBe(stringBody);
  expect(unfoldSymbol(SOURCE, 'Converter.java', 'Converter.convert')).toContain('return value + 1');
  expect(unfoldSymbol(SOURCE, 'Converter.java', 'convert')).toContain('return value + 1');
}, 120000);

test('round trips both real search results to the corresponding method bodies', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'java-method-overloads-'));
  try {
    writeFileSync(join(directory, 'Converter.java'), SOURCE);
    const result = await searchCodebase(directory, 'convert');
    const methods = result.matchingSymbols.filter(symbol => symbol.kind === 'method');
    expect(methods.map(method => method.symbolName)).toEqual(['Converter.convert(int value)', 'Converter.convert(String value)']);
    for (const method of methods) {
      const body = unfoldSymbol(SOURCE, 'Converter.java', method.symbolName);
      expect(body).toContain(method.symbolName.includes('String') ? 'value.trim()' : 'value + 1');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120000);

test('retains native multiline parameter lists on bodyless overloads', () => {
  const source = `interface Reader {
  String read(int index);
  String read(
    java.util.List<String> names,
    String... defaults
  );
}`;
  const methods = parseFile(source, 'Reader.java').symbols[0].children;
  expect(methods?.map(method => method.name)).toEqual(['read(int index)', 'read( java.util.List<String> names, String... defaults )']);
  expect(unfoldSymbol(source, 'Reader.java', `Reader.${methods?.[1].name}`)).toContain('String... defaults');
}, 120000);

test('leaves same-named methods in separate owners and existing constructors unchanged', () => {
  const source = `class Outer {
  Outer() {}
  Outer(int seed) {}
  void reset() {}
  class Inner { void reset() {} }
}`;
  const outer = parseFile(source, 'Outer.java').symbols[0];
  expect(outer.children?.map(method => method.name)).toEqual(['Outer()', 'Outer(int seed)', 'reset', 'Inner']);
  expect(outer.children?.[3].children?.map(method => method.name)).toEqual(['reset']);
  expect(unfoldSymbol(source, 'Outer.java', 'Outer')).toContain('class Outer');
  expect(unfoldSymbol(source, 'Outer.java', 'Outer.Outer(int seed)')).toContain('Outer(int seed)');
  expect(unfoldSymbol(source, 'Outer.java', 'Outer.Inner.reset')).toContain('void reset()');
}, 120000);

test('distinguishes a same-named method overload from the constructor', async () => {
  const source = `class Foo {
  Foo(int x) { System.out.println("constructor"); }
  void Foo(int x) { System.out.println("integer method"); }
  void Foo(String x) { System.out.println("string method"); }
}`;
  const methods = parseFile(source, 'Foo.java').symbols[0].children!;
  expect(methods.map(method => method.name)).toEqual(['Foo(int x)', 'method Foo(int x)', 'Foo(String x)']);
  const directory = mkdtempSync(join(tmpdir(), 'java-constructor-method-'));
  try {
    writeFileSync(join(directory, 'Foo.java'), source);
    const result = await searchCodebase(directory, 'Foo');
    const hits = result.matchingSymbols.filter(symbol => symbol.kind === 'method').sort((a, b) => a.lineStart - b.lineStart);
    expect(hits.map(hit => hit.symbolName)).toEqual(['Foo.Foo(int x)', 'Foo.method Foo(int x)', 'Foo.Foo(String x)']);
    for (const [index, hit] of hits.entries()) {
      const body = unfoldSymbol(source, 'Foo.java', hit.symbolName);
      expect(body).toContain(['"constructor"', '"integer method"', '"string method"'][index]);
    }
    expect(unfoldSymbol(source, 'Foo.java', 'Foo.Foo')).toContain('"integer method"');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120000);
