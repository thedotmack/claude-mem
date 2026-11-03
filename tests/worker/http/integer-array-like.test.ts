import { describe, expect, it } from 'bun:test';
import { integerArrayLike } from '../../../src/services/worker/http/middleware/integerArrayLike.js';

describe('worker observation ids', () => {
  for (const ids of [['56390', '56391'], '["56390", "56391"]', [56390, ' 56391 ']]) {
    it(`accepts numeric-string ids in ${JSON.stringify(ids)}`, () => {
      expect(integerArrayLike.parse(ids)).toEqual([56390, 56391]);
    });
  }

  for (const ids of [[1, 2], '[1,2]', '1,2']) {
    it(`preserves existing numeric inputs ${JSON.stringify(ids)}`, () => {
      expect(integerArrayLike.parse(ids)).toEqual([1, 2]);
    });
  }

  for (const ids of [['observation:abc'], [''], [' '], [true], [null], ['1.5'], ['1e2']]) {
    it(`rejects a non-integer id in ${JSON.stringify(ids)}`, () => {
      expect(integerArrayLike.safeParse(ids).success).toBe(false);
    });
  }

  it('keeps an empty array empty', () => {
    expect(integerArrayLike.parse([])).toEqual([]);
  });
});
