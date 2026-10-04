import { describe, expect, test } from 'bun:test';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

describe('smart outline import ranges', () => {
  test('preserves all names and the source of multiline imports', () => {
    const statement = 'import {\n  first,\n  second as renamed\n} from "@example/library";';
    expect(parseFile(statement + '\nfunction use() {}', 'imports.js').imports).toEqual([statement]);
  }, 120000);
  test('excludes adjacent declarations on the same line', () => {
    const statement = 'import { value } from "@example/library";';
    expect(parseFile(statement + ' const other = 1;', 'imports.js').imports).toEqual([statement]);
  }, 120000);
  test('uses UTF-8 capture columns after a Unicode prefix', () => {
    const statement = 'import { value } from "@example/library";';
    expect(parseFile('const café = 1; ' + statement + ' const after = 2;', 'imports.js').imports).toEqual([statement]);
  }, 120000);
  test('preserves a simple single-line import', () => {
    const statement = 'import value from "@example/library";';
    expect(parseFile(statement + '\nfunction use() {}', 'imports.js').imports).toEqual([statement]);
  }, 120000);
});
