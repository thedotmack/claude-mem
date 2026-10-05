import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
const source = `impl<T> Store<T> {
  pub fn fetch(&self) { generic_body(); }
}
impl api::Remote {
  pub fn sync(&self) { remote_body(); }
}`;
describe('Rust implementation ownership', () => {
  test('retains generic and qualified implementation containers', () => {
    const parsed = parseFile(source, 'store.rs');
    expect(parsed.symbols.map(symbol => symbol.name)).toEqual(['Store<T>', 'api::Remote']);
    expect(parsed.symbols.map(symbol => symbol.children?.map(child => child.name))).toEqual([['fetch'], ['sync']]);
  }, 120000);
  test('unfolds a method by its generic or qualified owner', () => {
    expect(unfoldSymbol(source, 'store.rs', 'Store<T>.fetch')).toContain('generic_body');
    expect(unfoldSymbol(source, 'store.rs', 'api::Remote.sync')).toContain('remote_body');
  }, 120000);
});
