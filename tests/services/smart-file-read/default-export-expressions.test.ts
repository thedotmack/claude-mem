import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';

const FUNCTIONS = [
  ['function', 'export default function (value) {', '  return value;', '}'],
  ['generator', 'export default async function* (value) {', '  yield value;', '}'],
  ['arrow', 'export default (value) => {', '  return value;', '};'],
  ['expression arrow', 'export default value =>', '  value.trim();'],
  ['parenthesized function', 'export default (function (value) {', '  return value;', '});'],
  ['parenthesized arrow', 'export default ((value) => {', '  return value;', '});'],
] as const;

for (const extension of ['js', 'ts', 'tsx']) {
  describe(`default export expressions in ${extension}`, () => {
    for (const [label, ...declaration] of FUNCTIONS) {
      test(`outlines and unfolds an anonymous ${label}`, () => {
        const content = [...declaration, '', 'function local() { return "local"; }'].join('\n');
        const file = `handler.${extension}`;
        const parsed = parseFile(content, file);
        expect(parsed.symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([
          ['default', 'function', true],
          ['local', 'function', false],
        ]);
        const exported = parsed.symbols[0];
        expect(exported.lineStart).toBe(0);
        expect(exported.lineEnd).toBe(declaration.length - 1);
        expect(exported.signature).toBe(declaration[0].replace(/\s*\{$/, ''));
        expect(formatFoldedView(parsed)).toContain(exported.signature);
        const unfolded = unfoldSymbol(content, file, 'default');
        expect(unfolded).toContain(declaration.join('\n'));
        expect(unfolded).not.toContain('function local');
      }, 120000);
    }

    for (const parenthesized of [false, true]) {
      test(`keeps anonymous ${parenthesized ? 'parenthesized ' : ''}class methods under the default export`, () => {
        const declaration = [
          parenthesized ? 'export default (class {' : 'export default class {',
          '  run() {',
          '    return "result";',
          '  }',
          parenthesized ? '});' : '}',
        ];
        const content = [...declaration, 'function local() {}'].join('\n');
        const file = `handler.${extension}`;
        const parsed = parseFile(content, file);
        expect(parsed.symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([
          ['default', 'class', true],
          ['local', 'function', false],
        ]);
        expect(parsed.symbols[0].signature).toBe(declaration[0].replace(/\s*\{$/, ''));
        expect(parsed.symbols[0].children?.map(symbol => [symbol.name, symbol.kind])).toEqual([['run', 'method']]);
        expect(unfoldSymbol(content, file, 'default')).toContain(declaration.join('\n'));
        const method = unfoldSymbol(content, file, 'default.run');
        expect(method).toContain('return "result";');
        expect(method).not.toContain('export default');
        expect(method).not.toContain('function local');
      }, 120000);
    }

    test('retains the existing identities of named default declarations', () => {
      for (const [content, name, kind] of [
        ['export default function handler() { return 1; }', 'handler', 'function'],
        ['export default function* values() { yield 1; }', 'values', 'function'],
        ['export default class Handler {}', 'Handler', 'class'],
      ]) {
        const parsed = parseFile(content, `named.${extension}`);
        expect(parsed.symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([[name, kind, true]]);
      }
    }, 120000);
  });
}
