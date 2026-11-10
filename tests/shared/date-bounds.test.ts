import { describe, it, expect } from 'bun:test';
import { resolveDateBound } from '../../src/shared/date-bounds.js';

describe('resolveDateBound', () => {
  it('passes numeric epochs through unchanged', () => {
    expect(resolveDateBound(1735689600000, 'start')).toBe(1735689600000);
    expect(resolveDateBound(1735689600000, 'end')).toBe(1735689600000);
  });

  it('trims whitespace from digit-string epochs', () => {
    expect(resolveDateBound(' 1735689600000 ', 'end')).toBe(1735689600000);
  });

  it('rejects non-dates', () => {
    for (const value of ['nope', '', 'tomorrow-ish']) {
      expect(() => resolveDateBound(value, 'start')).toThrow(/Invalid date/);
    }
    expect(() => resolveDateBound(Number.NaN, 'end')).toThrow(/Invalid date/);
  });

  it('rejects an epoch a Date cannot hold instead of returning Infinity', () => {
    for (const value of ['9'.repeat(309), '99999999999999999', Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      expect(() => resolveDateBound(value, 'start')).toThrow('Invalid date');
      expect(() => resolveDateBound(value, 'end')).toThrow('Invalid date');
    }
    expect(resolveDateBound(String(8.64e15), 'end')).toBe(8.64e15);
  });

  it('still reads a four-digit string as a year', () => {
    expect(resolveDateBound('2025', 'start')).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
  });

  it('resolves a date-only start bound to the start of the day', () => {
    expect(resolveDateBound('2025-01-01', 'start')).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
  });

  it('resolves a date-only end bound to the last millisecond of the day', () => {
    expect(resolveDateBound('2025-01-01', 'end')).toBe(Date.parse('2025-01-01T23:59:59.999Z'));
  });

  it('rejects a date that is not on the calendar instead of rolling it over', () => {
    for (const value of ['2025-02-29', '2025-02-30', '2025-04-31', '2025-02-30T08:00:00Z']) {
      expect(() => resolveDateBound(value, 'start')).toThrow('Invalid date');
      expect(() => resolveDateBound(value, 'end')).toThrow('Invalid date');
    }
    expect(resolveDateBound('2024-02-29', 'end')).toBe(Date.parse('2024-02-29T23:59:59.999Z'));
  });

  it('leaves an end bound with an explicit time untouched', () => {
    const value = '2025-01-01T08:30:00.000Z';
    expect(resolveDateBound(value, 'end')).toBe(Date.parse(value));
  });
});

describe('whitespace-padded date bounds', () => {
  it('normalizes both boundaries in a non-UTC timezone', () => {
    const previousTZ = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const midnight = Date.parse('2025-01-01T00:00:00.000Z');
      for (const value of [' 2025-01-01 ', '\t2025-01-01\n']) {
        expect(resolveDateBound(value, 'start')).toBe(midnight);
        expect(resolveDateBound(value, 'end')).toBe(midnight + 86_400_000 - 1);
      }
    } finally {
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    }
  });
});
