import { describe, expect, test } from 'bun:test';
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
    expect(parsed.symbols[0].children?.map(symbol => symbol.name)).toEqual(['reset', 'increment']);
    expect(parsed.symbols[0].children?.map(symbol => symbol.kind)).toEqual(['method', 'method']);
    expect(unfoldSymbol(SOURCE, 'counter.rb', 'reset')).toContain('def self.reset\n    :reset\n  end');
  }, 120000);

  test('captures a method defined on an explicit receiver outside a class', () => {
    const source = 'def Counter.reset\n  :reset\nend';
    expect(parseFile(source, 'receiver.rb').symbols.map(symbol => symbol.name)).toEqual(['reset']);
    expect(unfoldSymbol(source, 'receiver.rb', 'reset')).toContain(source);
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
