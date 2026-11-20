import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

// TypeScript's declaration output commonly uses `export declare function`.
// The grammar wraps its function_signature in an ambient_declaration.
const source = [
  '/** Decode an owned packet. */',
  'export declare function decodePacket(input: Uint8Array): string;',
  'declare function internalTrace(message: string): void;',
  'export interface Options { verbose: boolean }',
].join('\n');

describe('declared TypeScript functions', () => {
  for (const file of ['api.d.ts', 'api.ts', 'api.tsx']) {
    test('includes exported and local declarations in ' + file, () => {
      const parsed = parseFile(source, file);
      expect(parsed.symbols.map(symbol => [symbol.name, symbol.kind, symbol.exported])).toEqual([
        ['decodePacket', 'function', true],
        ['internalTrace', 'function', false],
        ['Options', 'interface', true],
      ]);
      expect(parsed.symbols[0].signature).toBe('export declare function decodePacket(input: Uint8Array): string;');
      expect(parsed.symbols[0].jsdoc).toContain('Decode an owned packet');
      const folded = formatFoldedView(parsed);
      expect(folded).toContain('decodePacket [exported]');
      expect(folded).toContain('declare function internalTrace(message: string): void;');
      const unfolded = unfoldSymbol(source, file, 'decodePacket');
      expect(unfolded).toContain('/** Decode an owned packet. */');
      expect(unfolded).toContain('export declare function decodePacket');
      expect(unfolded).not.toContain('internalTrace');
    }, 120000);
  }

  test('keeps multiline object types and the terminating semicolon in the signature', () => {
    const declaration = [
      'export declare function parseOptions<T extends { name: string }>(',
      '  value: T,',
      '  options: { mode: "a  b" },',
      '): { value: T; ok: boolean };',
    ].join('\n');
    const parsed = parseFile(declaration, 'options.d.ts');
    expect(parsed.symbols[0]?.signature).toBe(
      'export declare function parseOptions<T extends { name: string }>( value: T, options: { mode: "a  b" }, ): { value: T; ok: boolean };');
    expect(unfoldSymbol(declaration, 'options.d.ts', 'parseOptions')).toContain(declaration);
  }, 120000);

  test('searches a declaration through its namespace using the native batch parser', async () => {
    const declaration = [
      'export namespace Native {',
      '  export declare function readPacket(input: Uint8Array): string;',
      '}',
      'namespace Private {',
      '  declare function readPacket(input: Uint8Array): number;',
      '}',
    ].join('\n');
    const directory = mkdtempSync(join(tmpdir(), 'owned-ts-declarations-'));
    try {
      writeFileSync(join(directory, 'packets.ts'), declaration);
      const result = await searchCodebase(directory, 'readPacket');
      expect(result.matchingSymbols.map(symbol => symbol.symbolName).sort()).toEqual([
        'Native.readPacket', 'Private.readPacket',
      ]);
      const unfolded = unfoldSymbol(declaration, 'packets.ts', 'Private.readPacket');
      expect(unfolded).toContain('declare function readPacket(input: Uint8Array): number;');
      expect(unfolded).not.toContain(': string;');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120000);

  test('keeps implemented overloads and plain JavaScript functions unfoldable', () => {
    const implemented = [
      'export function convert(input: string): string;',
      'export function convert(input: number): number;',
      'export function convert(input: string | number) { return input; }',
    ].join('\n');
    expect(unfoldSymbol(implemented, 'implementation.ts', 'convert')).toContain('return input;');
    expect(parseFile(implemented, 'implementation.ts').symbols.map(symbol => symbol.name)).toEqual(['convert']);
    const javascript = 'export function readPacket() { return "owned body"; }';
    expect(parseFile(javascript, 'packets.js').symbols.map(symbol => symbol.name)).toEqual(['readPacket']);
    expect(unfoldSymbol(javascript, 'packets.js', 'readPacket')).toContain('return "owned body"');
  }, 120000);
});
