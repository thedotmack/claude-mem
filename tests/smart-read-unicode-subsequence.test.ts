import { expect, it } from 'bun:test';
import { formatAvailableSymbols, matchScore } from '../src/services/smart-file-read/parser.js';

it('scores supplementary Unicode identifier characters in subsequence queries', () => {
  // Deseret letters are valid ECMAScript identifier characters.
  expect(matchScore('𐐀cacheloader', ['𐐀loader'])).toBe(1);
  expect(matchScore('𐐀cacheloader', ['𐐀cacheloader'])).toBe(10);
  expect(matchScore('𐐀cacheloader', ['𐐀cache'])).toBe(5);
});
it('does not score out-of-order Unicode characters', () => {
  expect(matchScore('𐐀cacheloader', ['loader𐐀'])).toBe(0);
  expect(matchScore('cacheloader', ['𐐀loader'])).toBe(0);
});
it('ranks Unicode subsequence matches first in unfold suggestions', () => {
  const symbols = ['unrelated', '𐐀cacheloader'].map(name => ({ name, kind: 'function' as const,
    signature: `function ${name}()`, lineStart: 0, lineEnd: 0, exported: false }));
  const hints = formatAvailableSymbols({ filePath: 'example.ts', language: 'typescript', symbols,
    imports: [], totalLines: 2, foldedTokenEstimate: 10 }, '𐐀loader');
  expect(hints.split('\n')[0]).toBe('  - 𐐀cacheloader (function)');
});
