import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
const source = `class Store {
  fetch = () => { field_body(); };
  reset = function () { reset_body(); };
  value = 2;
}`;
describe('class field function outlines', () => {
  for (const extension of ['js', 'ts', 'tsx']) {
    test(`captures callable .${extension} fields under their class`, () => {
      const fields = parseFile(source, `store.${extension}`).symbols[0]?.children;
      expect(fields?.map(field => [field.name, field.kind])).toEqual([['fetch', 'method'], ['reset', 'method']]);
      expect(unfoldSymbol(source, `store.${extension}`, 'Store.fetch')).toContain('field_body');
    }, 120000);
  }
});

for (const extension of ['js', 'ts', 'tsx']) test(`retains private, quoted, computed and grouped .${extension} callables`, () => {
  const source = `class Store {
    #private = () => { private_body(); };
    "quoted" = function () { quoted_body(); };
    [Symbol.iterator] = () => { iterator_body(); };
    grouped = (((() => { grouped_body(); })));
    wrapped = wrap(() => { not_a_method(); });
    data = { callback: () => {} };
  }`;
  const methods = parseFile(source, `store.${extension}`).symbols[0].children;
  expect(methods?.map(method => method.name)).toEqual(['#private', '"quoted"', '[Symbol.iterator]', 'grouped']);
  expect(unfoldSymbol(source, `store.${extension}`, 'Store.grouped')).toContain('grouped_body');
  expect(unfoldSymbol(source, `store.${extension}`, 'Store.#private')).toContain('private_body');
}, 120000);
