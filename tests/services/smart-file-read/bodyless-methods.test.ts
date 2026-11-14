import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const fixtures = [
  {
    filename: 'Contract.swift',
    source: [
      'public protocol Repository {',
      '    /// Fetch and decode a stored value.',
      '    func fetch(',
      '        id: String,',
      '        decode: (String) -> String',
      '    ) async throws -> String',
      '    static func make<T>(value: T) -> Self where T: Codable',
      '    mutating func reset()',
      '    init(path: String)',
      '}',
      'extension Repository {',
      '    func available() -> Bool { true }',
      '}',
    ].join('\n'),
    owner: 'Repository',
    methods: ['fetch', 'make', 'reset', 'init(path: String)'],
    signature: 'func fetch( id: String, decode: (String) -> String ) async throws -> String',
    lastLine: ') async throws -> String',
  },
  {
    filename: 'Contract.scala',
    source: [
      'trait Repository {',
      '    /** Fetch and decode a stored value. */',
      '    def fetch[A](',
      '        id: String',
      '    )(decode: String => A): Option[A]',
      '    def size: Int',
      '    def available(): Boolean = true',
      '}',
      'abstract class Base {',
      '    protected def save(value: String): Unit',
      '}',
    ].join('\n'),
    owner: 'Repository',
    methods: ['fetch', 'size', 'available'],
    signature: 'def fetch[A]( id: String )(decode: String => A): Option[A]',
    lastLine: ')(decode: String => A): Option[A]',
  },
  {
    filename: 'Indented.scala',
    source: [
      'trait Repository:',
      '    /** Fetch and decode a stored value. */',
      '    def fetch[A](',
      '        id: String',
      '    )(decode: String => A): Option[A]',
      '    def size: Int',
      '    def available(): Boolean = true',
      'abstract class Base:',
      '    protected def save(value: String): Unit',
    ].join('\n'),
    owner: 'Repository',
    methods: ['fetch', 'size', 'available'],
    signature: 'def fetch[A]( id: String )(decode: String => A): Option[A]',
    lastLine: ')(decode: String => A): Option[A]',
  },
];

describe('native bodyless method declarations', () => {
  for (const fixture of fixtures) {
    test(`retains complete contract signatures and owners in ${fixture.filename}`, () => {
      const parsed = parseFile(fixture.source, fixture.filename);
      const owner = parsed.symbols.find(symbol => symbol.name === fixture.owner)!;
      expect(owner.children?.map(symbol => symbol.name)).toEqual(fixture.methods);
      const method = owner.children!.find(symbol => symbol.name === 'fetch')!;
      expect(method.kind).toBe('method');
      expect(method.signature).toBe(fixture.signature);
      expect(method.jsdoc).toContain('Fetch and decode a stored value.');
      expect(formatFoldedView(parsed)).toContain(fixture.signature);
      if (fixture.filename.endsWith('.scala')) {
        const base = parsed.symbols.find(symbol => symbol.name === 'Base')!;
        expect(base.children?.map(symbol => [symbol.name, symbol.kind, symbol.signature])).toEqual([
          ['save', 'method', 'protected def save(value: String): Unit'],
        ]);
      }
    }, 120_000);

    test(`search returns an unfoldable method identity in ${fixture.filename}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-bodyless-methods-'));
      try {
        writeFileSync(join(dir, fixture.filename), fixture.source);
        const result = await searchCodebase(dir, 'fetch');
        expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['Repository.fetch']);
        const unfolded = unfoldSymbol(fixture.source, fixture.filename, result.matchingSymbols[0].symbolName)!;
        expect(unfolded).toContain('id: String');
        expect(unfolded).toContain(fixture.lastLine);
        expect(unfolded).not.toContain('func make');
        expect(unfolded).not.toContain('def size');
        expect(unfolded).not.toContain('available');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);

    test(`keeps the implemented method body in ${fixture.filename}`, () => {
      const unfolded = unfoldSymbol(fixture.source, fixture.filename, 'Repository.available')!;
      expect(unfolded).toContain('true');
      expect(unfolded).not.toContain('decode:');
    }, 120_000);
  }
});
