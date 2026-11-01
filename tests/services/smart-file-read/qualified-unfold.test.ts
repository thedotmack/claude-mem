import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = [
  'class First {',
  '  run() { return "first"; }',
  '}',
  'class Second {',
  '  run() { return "second"; }',
  '}',
].join('\n');

describe('smart search to unfold symbol identity', () => {
  test('unfolds the exact qualified method returned by native smart search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-qualified-unfold-'));
    try {
      writeFileSync(join(dir, 'methods.js'), SOURCE);
      const result = await searchCodebase(dir, 'run');
      const method = result.matchingSymbols.find(symbol => symbol.symbolName === 'Second.run');
      expect(method).toBeDefined();
      const unfolded = unfoldSymbol(SOURCE, 'methods.js', method!.symbolName);
      expect(unfolded).toContain('return "second"');
      expect(unfolded).not.toContain('return "first"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);

  test('retains the existing unqualified lookup and rejects a wrong owner', () => {
    expect(unfoldSymbol(SOURCE, 'methods.js', 'run')).toContain('return "first"');
    expect(unfoldSymbol(SOURCE, 'methods.js', 'Missing.run')).toBeNull();
  }, 120000);

  test('accepts the full chain returned by search for nested class methods', async () => {
    const source = 'class Outer {\n  create() {\n    class Inner {\n      run() { return "nested"; }\n    }\n  }\n}';
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-nested-unfold-'));
    try {
      writeFileSync(join(dir, 'nested.js'), source);
      const result = await searchCodebase(dir, 'run');
      const method = result.matchingSymbols.find(symbol => symbol.symbolName === 'Outer.Inner.run');
      expect(method).toBeDefined();
      expect(unfoldSymbol(source, 'nested.js', method!.symbolName)).toContain('return "nested"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});

test('round trips nested CSS rules and literal dotted selectors independently', async () => {
  const source = 'anonymous.anonymous.foo { color: red; }\n@media screen {\n  @media print {\n    foo { color: blue; }\n  }\n}';
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-css-qualified-'));
  try {
    writeFileSync(join(dir, 'owned.css'), source);
    const result = await searchCodebase(dir, 'foo');
    const literal = result.matchingSymbols.find(symbol => symbol.lineStart === 0)!;
    const nested = result.matchingSymbols.find(symbol => symbol.lineStart === 3)!;
    expect(literal.symbolName).not.toBe(nested.symbolName);
    expect(unfoldSymbol(source, 'owned.css', literal.symbolName)).toContain('color: red');
    expect(unfoldSymbol(source, 'owned.css', literal.symbolName)).not.toContain('color: blue');
    expect(unfoldSymbol(source, 'owned.css', nested.symbolName)).toContain('color: blue');
    expect(unfoldSymbol(source, 'owned.css', nested.symbolName)).not.toContain('color: red');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
