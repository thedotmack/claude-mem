import { nativeTest as test } from './native-prerequisite.js';
import assert from 'node:assert/strict';
import { parseFile, unfoldSymbol } from '../../../src/services/smart-file-read/parser.js';

const source = [
  'pub trait Decode {', '  type Output;', '  const WIDTH: usize;',
  '  fn read(&self) -> Self::Output;', '}',
  'pub struct Buffer;', 'impl Decode for Buffer {', '  type Output = u8;',
  '  const WIDTH: usize = 1;', '  fn read(&self) -> u8 { 11 }', '}',
  'impl Other for Buffer {', '  fn read(&self) -> u8 { 22 }', '}',
  'macro_rules! wire {', '  ($x:expr) => { $x + 3 };', '}',
  'pub enum Event {', '  Open { port: u16 },', '  Close(u8),', '}',
  'pub mod api {', '  pub type Packet = Result<Vec<u8>, Error>;', '}',
].join('\n');

test('Rust traits expose required methods, associated types and constants', () => {
  const trait = parseFile(source, 'lib.rs').symbols.find(s => s.kind === 'trait');
  assert.deepEqual(trait?.children?.map(s => s.name), ['Output', 'WIDTH', 'read']);
  assert.match(unfoldSymbol(source, 'lib.rs', 'Decode.read') ?? '', /fn read\(&self\)/);
}, 120000);

test('distinct trait implementations on one Rust type have distinct method identities', () => {
  assert.match(unfoldSymbol(source, 'lib.rs', '<Buffer as Decode>.read') ?? '', /11/);
  assert.match(unfoldSymbol(source, 'lib.rs', '<Buffer as Other>.read') ?? '', /22/);
}, 120000);

test('Rust declarative macro definitions can be unfolded without counting invocations', () => {
  const text = source + '\nfn entry() { let _ = wire!(12); }';
  const defs = parseFile(text, 'lib.rs').symbols.filter(s => s.name === 'wire');
  assert.equal(defs.length, 1);
  assert.match(unfoldSymbol(text, 'lib.rs', 'wire') ?? '', /\$x \+ 3/);
}, 120000);

test('Rust enum payload variants can be located through the enum', () => {
  const enm = parseFile(source, 'lib.rs').symbols.find(s => s.kind === 'enum');
  assert.deepEqual(enm?.children?.map(s => s.name), ['Open', 'Close']);
  assert.match(unfoldSymbol(source, 'lib.rs', 'Event.Open') ?? '', /port: u16/);
}, 120000);

test('Rust module type aliases retain a qualified unfoldable identity', () => {
  assert.match(unfoldSymbol(source, 'lib.rs', 'api.Packet') ?? '', /Result<Vec<u8>, Error>/);
}, 120000);

test('required trait signatures show multiline parameters, return types and where clauses', () => {
  const text = ['trait Read {', ' fn read<T>(', '  &self, input: T,', ' ) -> Self::Output',
    ' where T: AsRef<[u8]>;', '}', 'type Alias =', ' CrossLineOnlyMarker;'].join('\n');
  const parsed = parseFile(text, 'lib.rs');
  const method = parsed.symbols[0].children?.[0];
  assert.match(parsed.symbols[1].signature, /type Alias = CrossLineOnlyMarker;/);
  assert.match(method?.signature ?? '', /input: T,.*-> Self::Output.*T: AsRef<\[u8\]>/);
}, 120000);
