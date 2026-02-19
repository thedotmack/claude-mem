import { describe, it, expect } from 'vitest';
import { calculateBackoffDelay } from '../../../src/ui/viewer/utils/backoff';

describe('calculateBackoffDelay', () => {
  const BASE = 3000;
  const MAX = 60000;
  const FACTOR = 2;

  it('returns base delay on first attempt (attempt 0)', () => {
    expect(calculateBackoffDelay(0, BASE, MAX, FACTOR)).toBe(3000);
  });

  it('doubles delay on second attempt', () => {
    expect(calculateBackoffDelay(1, BASE, MAX, FACTOR)).toBe(6000);
  });

  it('quadruples delay on third attempt', () => {
    expect(calculateBackoffDelay(2, BASE, MAX, FACTOR)).toBe(12000);
  });

  it('caps delay at max', () => {
    // attempt 5: 3000 * 2^5 = 96000 → capped at 60000
    expect(calculateBackoffDelay(5, BASE, MAX, FACTOR)).toBe(60000);
  });

  it('returns max for very large attempt numbers', () => {
    expect(calculateBackoffDelay(100, BASE, MAX, FACTOR)).toBe(60000);
  });

  it('works with custom factor of 3', () => {
    // attempt 2: 1000 * 3^2 = 9000
    expect(calculateBackoffDelay(2, 1000, 50000, 3)).toBe(9000);
  });

  it('returns base * 2^-1 = 1500 for negative attempt -1', () => {
    // attempt -1: 3000 * 2^-1 = 1500
    // Documents behavior for out-of-range negative attempts
    expect(calculateBackoffDelay(-1, BASE, MAX, FACTOR, 0)).toBe(1500);
  });
});
