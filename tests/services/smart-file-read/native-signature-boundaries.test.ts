import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol, formatFoldedView, type CodeSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const fixture = (file: string) => readFileSync(join(import.meta.dir, 'fixtures', file), 'utf8');
function symbols(source: string, file: string): Map<string, CodeSymbol> {
  const result = new Map<string, CodeSymbol>();
  const visit = (items: CodeSymbol[]) => {
    for (const item of items) { result.set(item.name, item); visit(item.children ?? []); }
  };
  visit(parseFile(source, file).symbols);
  return result;
}

const jsExpected: Record<string, string> = {
  "unpack": "export default function unpack( { value = \"{\" }, suffixNeedle = \"}\" )",
  "convert": "export const convert = ( { value }, options = { enabled: true } ) =>",
  "shallow": "export const shallow = () =>",
  "callback": "export let callback = function ({ value }, ending = \"}\")",
  "legacy": "var legacy = ({ value }, { mode } = { mode: \"{\" }) =>",
  "read": "read({ value }, ending = \"{\")",
  "field": "field = ({ value }, options = { enabled: true }) =>",
  "items": "*items({ value }, ending = \"{\")",
  "values": "export function* values({ value }, ending = \"{\")"
};

describe('native function signature boundaries', () => {
  for (const extension of ['js', 'ts', 'tsx']) {
    test(`retains destructured defaults and each function variable in .${extension}`, () => {
      const source = fixture('signature-boundaries.mjs');
      const found = symbols(source, `owned.${extension}`);
      for (const [name, signature] of Object.entries(jsExpected)) {
        expect(found.get(name)?.signature).toBe(signature);
      }
    }, 120000);
  }

  for (const extension of ['ts', 'tsx']) {
    test(`retains object parameters and object return types in .${extension}`, () => {
      const source = fixture('signature-boundaries.ts');
      const found = symbols(source, `owned.${extension}`);
      expect(found.get('build')?.signature).toBe('export function build( options: { key: string } = { key: "{" } ): { result: string }');
      expect(found.get('typed')?.signature).toBe('export const typed = ({ key }: { key: string }): { result: string } =>');
      expect(found.get('read')?.signature).toContain('read(options: { key: string }): { result: string }');
    }, 120000);
  }

  test('searches a later header parameter and still unfolds the complete implementation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-signature-search-'));
    const source = fixture('signature-boundaries.mjs');
    try {
      writeFileSync(join(directory, 'public.mjs'), source);
      const result = await searchCodebase(directory, 'suffixNeedle');
      expect(result.matchingSymbols.map(row => row.symbolName)).toEqual(['unpack']);
      expect(result.matchingSymbols[0].matchReason).toContain('signature');
      expect(formatFoldedView(parseFile(source, 'public.mjs'))).toContain(jsExpected.unpack);
      expect(unfoldSymbol(source, 'public.mjs', 'unpack')).toContain('return value + suffixNeedle;');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120000);

  test('retains the existing signature length bound after native range extraction', () => {
    const source = 'export function long(value = "' + '{'.repeat(250) + '") { return "BODY_ONLY"; }';
    const signature = parseFile(source, 'long.js').symbols[0].signature;
    expect(signature.startsWith('export function long(value = "')).toBe(true);
    expect(signature.length).toBe(200);
    expect(signature.endsWith('...')).toBe(true);
    expect(signature).not.toContain('BODY_ONLY');
  }, 120000);

  const cases: Array<{ file: string; expected: Record<string, string> }> = [
  {
    "file": "signature-boundaries.go",
    "expected": {
      "read": "func read(value struct { N int }) int"
    }
  },
  {
    "file": "signature-boundaries.rs",
    "expected": {
      "read": "pub fn read(Item { value }: Item) -> i32"
    }
  },
  {
    "file": "signature-boundaries.cpp",
    "expected": {
      "choose": "int choose(int value = [] { return 7; }())",
      "Api": "Api(int value = [] { return 7; }()) : value{value}"
    }
  },
  {
    "file": "SignatureBoundaries.java",
    "expected": {
      "read": "@Tags({\"{\", \"header\"}) int read(int value)",
      "SignatureBoundaries(int value)": "@Tags({\"{\", \"constructor\"}) SignatureBoundaries(int value)"
    }
  },
  {
    "file": "signature-boundaries.php",
    "expected": {
      "read_value": "function read_value($opening = \"{\", $closing = \"}\")"
    }
  },
  {
    "file": "signature-boundaries.kt",
    "expected": {
      "choose": "fun choose(make: () -> Int = { 7 }): Int",
      "constructor(make: () -> Int = { 7 })": "constructor(make: () -> Int = { 7 })"
    }
  },
  {
    "file": "signature-boundaries.swift",
    "expected": {
      "choose": "func choose(make: () -> Int = { 7 }) -> Int"
    }
  },
  {
    "file": "signature-boundaries.scala",
    "expected": {
      "choose": "def choose(make: () => Int = () => { 7 }): Int ="
    }
  },
  {
    "file": "signature-boundaries.sh",
    "expected": {
      "work": "work()",
      "ordinary": "ordinary()"
    }
  },
  {
    "file": "signature-boundaries.zig",
    "expected": {
      "read": "fn read(value: struct { number: i32 }) i32",
      "\"brace {\"": "test \"brace {\""
    }
  }
];
  for (const example of cases) {
    test(`uses the parsed body boundary in ${example.file}`, () => {
      const found = symbols(fixture(example.file), example.file);
      for (const [name, signature] of Object.entries(example.expected)) expect(found.get(name)?.signature).toBe(signature);
    }, 120000);
  }

  test('keeps bodyless declarations as complete native headers', () => {
    const examples = [
  [
    "signature-boundaries.go",
    "external",
    "func external(value int) int"
  ],
  [
    "signature-boundaries.rs",
    "external",
    "fn external(value: i32) -> i32;"
  ],
  [
    "signature-boundaries.cpp",
    "gone",
    "void gone() = delete;"
  ],
  [
    "SignatureBoundaries.java",
    "external",
    "abstract int external(int value);"
  ],
  [
    "signature-boundaries.php",
    "external",
    "abstract public function external(int $value): int;"
  ],
  [
    "signature-boundaries.kt",
    "external",
    "fun external(value: Int): Int"
  ],
  [
    "signature-boundaries.zig",
    "external",
    "extern fn external(value: i32) i32;"
  ]
] as const;
    for (const [file, name, expected] of examples) {
      expect(symbols(fixture(file), file).get(name)?.signature).toBe(expected);
    }
    const swift = parseFile(fixture('signature-boundaries.swift'), 'owned.swift');
    expect(swift.symbols.find(row => row.name === 'Api')?.children?.[0].signature)
      .toBe('init(make: () -> Int = { 7 })');
    expect(swift.symbols.find(row => row.name === 'Contract')?.children?.[0].signature).toBe('init(value: Int)');
  }, 120000);

  test('preserves the existing unbraced-language and ordinary C paths', () => {
    const controls = [
      ['owned.py', 'def read(value):\n    return {"value": value}\n', 'read', 'def read(value)'],
      ['owned.rb', 'def read(value)\n  { value: value }\nend\n', 'read', 'def read(value)'],
      ['owned.lua', 'function read(value)\n  return { value = value }\nend\n', 'read', 'function read(value)'],
      ['owned.c', 'int read(int value) { return value; }\n', 'read', 'int read(int value)'],
    ];
    for (const [file, source, name, expected] of controls) expect(symbols(source, file).get(name)?.signature).toBe(expected);
  }, 120000);
});
