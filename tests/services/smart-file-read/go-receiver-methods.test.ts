import { describe, expect } from 'bun:test';
import { nativeTest as test } from './native-prerequisite.js';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';
const source = `package owned
type Local struct {}
type Remote struct {}
func (l Local) Reset() { local_body() }
func (r *Remote) Reset() { remote_body() }`;
describe('Go method receiver identity', () => {
  test('distinguishes matching method names on value and pointer receivers', () => {
    expect(parseFile(source, 'store.go').symbols.filter(s => s.kind === 'method').map(s => s.name))
      .toEqual(['Local.Reset', 'Remote.Reset']);
  }, 120000);
  test('unfolds the chosen receiver method without selecting the other receiver', () => {
    const local = unfoldSymbol(source, 'store.go', 'Local.Reset');
    const remote = unfoldSymbol(source, 'store.go', 'Remote.Reset');
    expect(local).toContain('local_body');
    expect(local).not.toContain('remote_body');
    expect(remote).toContain('remote_body');
    expect(remote).not.toContain('local_body');
  }, 120000);
  test('still unfolds a bare method name and rejects a wrong receiver', () => {
    expect(unfoldSymbol(source, 'store.go', 'Reset')).toContain('local_body');
    expect(unfoldSymbol(source, 'store.go', 'Remote.Reset')).toContain('remote_body');
    expect(unfoldSymbol(source, 'store.go', 'Missing.Reset')).toBeNull();
  }, 120000);
});

 test('keeps generic and unnamed receivers supported', () => {
  const source = `package owned
    type Store[T any] struct {}
    func (s Store[T]) Fetch() { generic_value() }
    func (s *Store[T]) Save() { generic_pointer() }
    func (Store[T]) Clear() { unnamed_receiver() }`;
  const methods = parseFile(source, 'generic.go').symbols.filter(s => s.kind === 'method');
  expect(methods.map(s => s.name)).toEqual(['Store[T].Fetch', 'Store[T].Save', 'Store[T].Clear']);
  expect(unfoldSymbol(source, 'generic.go', 'Store[T].Save')).toContain('generic_pointer');
 }, 120000);

test('derives Go method visibility from the method identifier, not its receiver', () => {
  const symbols=parseFile(`package owned
type local struct {}
type Local struct {}
func (l local) Reset() {}
func (l Local) reset() {}`, 'visibility.go').symbols;
  expect(symbols.find(s=>s.name==='local.Reset')?.exported).toBe(true);
  expect(symbols.find(s=>s.name==='Local.reset')?.exported).toBe(false);
},120000);
