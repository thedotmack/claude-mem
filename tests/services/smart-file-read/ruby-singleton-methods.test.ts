import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

const SOURCE = 'class Counter\n  def self.reset\n    :reset\n  end\n  def increment\n    1\n  end\nend';

describe('Ruby singleton method outlines', () => {
  test('captures class methods beside ordinary instance methods', () => {
    const parsed = parseFile(SOURCE, 'counter.rb');
    expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['Counter']);
    expect(parsed.symbols[0].children?.map(symbol => symbol.name)).toEqual(['self.reset', 'increment']);
    expect(parsed.symbols[0].children?.map(symbol => symbol.kind)).toEqual(['method', 'method']);
    expect(unfoldSymbol(SOURCE, 'counter.rb', 'self.reset')).toContain('def self.reset\n    :reset\n  end');
  }, 120000);

  test('captures a method defined on an explicit receiver outside a class', () => {
    const source = 'def Counter.reset\n  :reset\nend';
    expect(parseFile(source, 'receiver.rb').symbols.map(symbol => symbol.name)).toEqual(['Counter.reset']);
    expect(unfoldSymbol(source, 'receiver.rb', 'Counter.reset')).toContain(source);
  }, 120000);

  test('native batched search discovers the class method', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-ruby-singleton-'));
    try {
      writeFileSync(join(dir, 'counter.rb'), SOURCE);
      const result = await searchCodebase(dir, 'reset');
      expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toContain('Counter.reset');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});

test('distinguishes the same-named instance and singleton method', async () => {
  const source = 'class Counter\n  def reset\n    :instance\n  end\n  def self.reset\n    :singleton\n  end\nend';
  const parsed = parseFile(source, 'owned.rb');
  expect(parsed.symbols[0].children?.map(symbol => symbol.name)).toEqual(['reset', 'self.reset']);
  expect(unfoldSymbol(source, 'owned.rb', 'reset')).toContain(':instance');
  expect(unfoldSymbol(source, 'owned.rb', 'self.reset')).toContain(':singleton');
  expect(unfoldSymbol(source, 'owned.rb', 'self.reset')).not.toContain(':instance');
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-ruby-identities-'));
  try {
    writeFileSync(join(dir, 'owned.rb'), source);
    const result = await searchCodebase(dir, 'reset');
    expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['Counter#reset', 'Counter.reset']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('explicit receivers inside a class retain their actual receiver identity', async () => {
  const source = 'class Counter\n  def Counter.reset\n    :explicit\n  end\n  def Other.reset\n    :other\n  end\nend';
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-ruby-explicit-owner-'));
  try {
    writeFileSync(join(dir, 'owned.rb'), source);
    const result = await searchCodebase(dir, 'reset');
    expect(result.matchingSymbols.map(symbol => symbol.symbolName).sort()).toEqual(['Counter.reset', 'Other.reset']);
    expect(unfoldSymbol(source, 'owned.rb', 'Counter.reset')).toContain(':explicit');
    expect(unfoldSymbol(source, 'owned.rb', 'Other.reset')).toContain(':other');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);

test('search identities round trip same-named instance and explicit singleton methods', async () => {
  const source = 'class Counter\n  def reset\n    :instance\n  end\n  def Counter.reset\n    :explicit_singleton\n  end\nend';
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-ruby-instance-singleton-'));
  try {
    writeFileSync(join(dir, 'owned.rb'), source);
    const result = await searchCodebase(dir, 'reset');
    expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['Counter#reset', 'Counter.reset']);
    for (const match of result.matchingSymbols) {
      const unfolded = unfoldSymbol(source, 'owned.rb', match.symbolName);
      const instance = match.lineStart === 1;
      expect(unfolded).toContain(instance ? ':instance' : ':explicit_singleton');
      expect(unfolded).not.toContain(instance ? ':explicit_singleton' : ':instance');
    }
    expect(unfoldSymbol(source, 'owned.rb', 'reset')).toContain(':instance');
    expect((await searchCodebase(dir, 'Counter#reset')).matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['Counter#reset']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120000);
