import { describe, it, expect } from 'bun:test';
import { parseRetentionDays } from '../../src/shared/retention-days.js';

describe('parseRetentionDays', () => {
  it('reads a positive whole number of days', () => {
    expect(parseRetentionDays('30')).toBe(30);
    expect(parseRetentionDays(' 7 ')).toBe(7);
  });

  it('treats 0, empty and unparseable values as keep-forever', () => {
    for (const raw of ['0', '', '   ', 'abc', '-5', '1.5', '1e3', 'NaN', 'Infinity']) {
      expect(parseRetentionDays(raw)).toBe(0);
    }
  });

  it('treats a missing setting as keep-forever', () => {
    expect(parseRetentionDays(undefined)).toBe(0);
  });

  it('accepts an unquoted JSON number, which hand-edited settings.json can hold', () => {
    expect(parseRetentionDays(30)).toBe(30);
    expect(parseRetentionDays(0)).toBe(0);
  });

  it('never throws on a value that is not a string or number, and keeps everything', () => {
    for (const raw of [null, true, false, {}, [], [30], { days: 30 }, 1.5, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parseRetentionDays(raw)).toBe(0);
    }
  });
});
