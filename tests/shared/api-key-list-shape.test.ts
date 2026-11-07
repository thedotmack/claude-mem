import { expect, test } from 'bun:test';
import { parseApiKeyList } from '../../src/shared/api-key-pool.js';
test('retains only literal key strings from mixed settings arrays', () => expect(parseApiKeyList(['real-key',null,undefined,42,{},['nested-key'],true,' second-key '])).toEqual(['real-key','second-key']));
test('ignores objects without evaluating custom string conversion', () => expect(parseApiKeyList([{toString(){throw new Error('not a key')}}])).toEqual([]));
test('still splits and deduplicates string entries', () => expect(parseApiKeyList(['a,b',' a ','c'])).toEqual(['a','b','c']));
