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
