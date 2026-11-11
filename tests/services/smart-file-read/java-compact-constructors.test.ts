import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatFoldedView, parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const source = readFileSync(join(import.meta.dir, 'fixtures/compact-constructors.java'), 'utf8');
const filename = 'OwnedRecords.java';

describe('Java compact record constructors', () => {
  test('outlines the compact constructor with its implicit record parameters', () => {
    const parsed = parseFile(source, filename);
    const range = parsed.symbols.find(symbol => symbol.name === 'Range')!;
    const constructor = range.children?.find(symbol => symbol.name === 'Range(int low, int high)');
    expect(constructor?.kind).toBe('method');
    expect(constructor?.signature).toBe('public Range');
    expect(constructor?.jsdoc).toContain('Validates ordered bounds');
    expect(constructor?.lineStart).toBe(2);
    expect(constructor?.lineEnd).toBe(4);
    expect(range.children?.map(symbol => symbol.name)).toEqual(['Range(int low, int high)', 'Range()', 'width']);
    expect(formatFoldedView(parsed)).toContain('public Range');
  }, 120000);

  test('unfolds validation separately from an explicit overload and other methods', () => {
    const compact = unfoldSymbol(source, filename, 'Range.Range(int low, int high)');
    expect(compact).toContain('if (low > high)');
    expect(compact).not.toContain('this(0, 0)');
    expect(compact).not.toContain('int width()');
    const overload = unfoldSymbol(source, filename, 'Range.Range()');
    expect(overload).toContain('this(0, 0)');
    expect(overload).not.toContain('reversed bounds');
  }, 120000);

  test('retains multiline generic and variable-arity record components', () => {
    const payload = parseFile(source, filename).symbols.find(symbol => symbol.name === 'Payload')!;
    const name = 'Payload( java.util.List<T> values, String... labels )';
    expect(payload.children?.map(symbol => symbol.name)).toEqual([name]);
    const unfolded = unfoldSymbol(source, filename, 'Payload.' + name);
    expect(unfolded).toContain('values = java.util.List.copyOf(values)');
    expect(unfolded).toContain('labels = labels.clone()');
    expect(unfolded).not.toContain('class Envelope');
  }, 120000);

  test('native batched search returns the exact nested constructor for unfolding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'owned-java-compact-'));
    try {
      writeFileSync(join(directory, filename), source);
      const results = await searchCodebase(directory, 'Name');
      const constructor = results.matchingSymbols.find(symbol => symbol.symbolName === 'Envelope.Name.Name(String value)');
      expect(constructor?.kind).toBe('method');
      const unfolded = unfoldSymbol(source, filename, constructor!.symbolName);
      expect(unfolded).toContain('value = value.strip()');
      expect(unfolded).not.toContain('toUpperCase');
      const envelope = parseFile(source, filename).symbols.find(symbol => symbol.name === 'Envelope')!;
      expect(envelope.children?.map(symbol => symbol.name)).toEqual(['Name', 'Other']);
      expect(envelope.children?.find(symbol => symbol.name === 'Other')?.children?.map(symbol => symbol.name)).toEqual(['Other(String value)']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120000);

  test('retains the parentheses for a record with no components', () => {
    const token = parseFile(source, filename).symbols.find(symbol => symbol.name === 'Token')!;
    expect(token.children?.map(symbol => symbol.name)).toEqual(['Token()']);
    expect(unfoldSymbol(source, filename, 'Token.Token()')).toContain('owned token');
  }, 120000);

  test('keeps ordinary and explicit canonical constructors unchanged', () => {
    const parsed = parseFile(source, filename);
    expect(parsed.symbols.find(symbol => symbol.name === 'Plain')?.children?.map(symbol => symbol.name)).toEqual(['Plain()', 'Plain(int value)']);
    expect(parsed.symbols.find(symbol => symbol.name === 'Explicit')?.children?.map(symbol => symbol.name)).toEqual(['Explicit(int value)']);
    expect(unfoldSymbol(source, filename, 'Explicit.Explicit(int value)')).toContain('this.value = value');
    expect(unfoldSymbol(source, filename, 'Plain.Plain(int value)')).toContain('System.out.println(value)');
  }, 120000);
});
