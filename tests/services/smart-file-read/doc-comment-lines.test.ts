import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';
import { searchCodebase } from '../../../src/services/smart-file-read/search.js';

function symbol(content: string, filename: string, path: string[]) {
  let symbols = parseFile(content, filename).symbols;
  let found;
  for (const name of path) {
    found = symbols.find(s => s.name === name);
    expect(found).toBeDefined();
    symbols = found!.children ?? [];
  }
  return found!;
}

describe('smart outline doc comments take only comment lines', () => {
  test('a `#` line is code outside the languages whose comments start with it', () => {
    expect(symbol('class Counter {\n  #count = 0;\n  increment() { return ++this.#count; }\n}', 'counter.js', ['Counter', 'increment']).jsdoc).toBeUndefined();
    expect(symbol('#!/usr/bin/env node\n\nfunction main(): void {}', 'cli.ts', ['main']).jsdoc).toBeUndefined();
    expect(symbol('#include <stdio.h>\n\nint main(void) { return 0; }', 'main.c', ['main']).jsdoc).toBeUndefined();
    expect(symbol('#pragma once\n#include <string>\n\nclass Widget {};', 'widget.hpp', ['Widget']).jsdoc).toBeUndefined();
    expect(symbol('#[derive(Debug, Clone)]\npub struct Point {\n    x: i32,\n}', 'lib.rs', ['Point']).jsdoc).toBeUndefined();
  }, 120000);

  test('a `#` comment still documents what follows it, a shebang does not', () => {
    expect(symbol('# Builds the site.\nbuild() {\n  echo build\n}', 'tools.sh', ['build']).jsdoc).toBe('# Builds the site.');
    expect(symbol('#!/usr/bin/env bash\n\nbuild() {\n  echo build\n}', 'tools.sh', ['build']).jsdoc).toBeUndefined();
    expect(symbol('# Loads a user.\ndef load\n  1\nend', 'user.rb', ['load']).jsdoc).toBe('# Loads a user.');
  }, 120000);

  test('a preprocessor line above a comment ending in `*/` stays out of it', () => {
    expect(symbol('#ifdef FAST\n// Matches /a*/\nint f(void) { return 0; }\n#endif', 'f.c', ['f']).jsdoc).toBe('// Matches /a*/');
  }, 120000);

  test('a Rust outer attribute is passed over, not taken as the comment', () => {
    expect(symbol('/// A documented struct.\n#[derive(Debug)]\npub struct Doc {}', 'lib.rs', ['Doc']).jsdoc).toBe('/// A documented struct.');
  }, 120000);

  test('an `@` line is code in languages without decorators', () => {
    expect(symbol('class Counter\n  @@count = 0\n  def self.increment\n    @@count += 1\n  end\nend', 'counter.rb', ['Counter', 'self.increment']).jsdoc).toBeUndefined();
    expect(symbol('@use "sass:math";\n\n.button {\n  color: red;\n}', 'style.scss', ['.button']).jsdoc).toBeUndefined();
  }, 120000);

  test('search no longer reports a preprocessor line as a doc comment match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-doc-comment-lines-'));
    try {
      writeFileSync(join(dir, 'main.c'), '#include <stdio.h>\n\nint main(void) { return 0; }\n');
      const result = await searchCodebase(dir, 'stdio', { maxResults: 5 });
      expect(result.matchingSymbols.map(s => s.symbolName)).not.toContain('main');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
