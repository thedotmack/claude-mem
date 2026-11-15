import { describe, expect, it } from 'bun:test';
import { parseJsonc, stripJsonComments } from '../../src/shared/atomic-json.js';

// parseJsonc/stripJsonComments exist because Zed's settings.json is JSONC:
// the editor accepts // and /* */ comments and trailing commas, strict
// JSON.parse does not. The dangerous cases are comment/trailing-comma
// lookalikes inside string values — those must survive untouched.
describe('parseJsonc', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJsonc('{"a": 1, "b": [1, 2]}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('strips line and block comments', () => {
    expect(parseJsonc('{\n// hello\n"a": 1, /* inline */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it('strips trailing commas before } and ]', () => {
    expect(parseJsonc('{"a": [1, 2,], "b": 2,}')).toEqual({ a: [1, 2], b: 2 });
  });

  it('keeps // and /* inside string values', () => {
    expect(parseJsonc('{"url": "https://example.com/a//b", "note": "/* not a comment */"}')).toEqual({
      url: 'https://example.com/a//b',
      note: '/* not a comment */',
    });
  });

  it('keeps a comma before } inside a string value', () => {
    expect(parseJsonc('{"text": "a,}"}')).toEqual({ text: 'a,}' });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{"text": "say \\"hi\\" // ok"}')).toEqual({ text: 'say "hi" // ok' });
  });

  it('throws on an unterminated block comment', () => {
    expect(() => parseJsonc('{"a": 1, /* oops')).toThrow('Unterminated block comment');
  });

  it('throws on an unterminated string', () => {
    expect(() => parseJsonc('{"a": "oops')).toThrow('Unterminated string');
  });

  it('still throws on malformed JSON that is not JSONC', () => {
    expect(() => parseJsonc('{ not json')).toThrow();
  });

  it('stripJsonComments leaves a BOM-stripped plain file alone', () => {
    expect(stripJsonComments('{"a": 1}')).toBe('{"a": 1}');
  });
});
