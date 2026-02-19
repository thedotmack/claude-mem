/**
 * Tests for formatTokenCount utility
 *
 * Tests the compact token count formatting used in AnalyticsBar.
 * Pure function tests — no DOM or React needed.
 */

import { describe, it, expect } from 'vitest';
import { formatTokenCount } from '../../../src/ui/viewer/utils/format';

describe('formatTokenCount', () => {
  describe('zero', () => {
    it('returns "0" for 0', () => {
      expect(formatTokenCount(0)).toBe('0');
    });
  });

  describe('small numbers (1-999)', () => {
    it('returns "1" for 1', () => {
      expect(formatTokenCount(1)).toBe('1');
    });

    it('returns "123" for 123', () => {
      expect(formatTokenCount(123)).toBe('123');
    });

    it('returns "999" for 999 (boundary below K)', () => {
      expect(formatTokenCount(999)).toBe('999');
    });
  });

  describe('thousands range (1000-999999)', () => {
    it('returns "1.0K" for 1000 (boundary at K)', () => {
      expect(formatTokenCount(1000)).toBe('1.0K');
    });

    it('returns "1.2K" for 1234', () => {
      expect(formatTokenCount(1234)).toBe('1.2K');
    });

    it('returns "1.5K" for 1500', () => {
      expect(formatTokenCount(1500)).toBe('1.5K');
    });

    it('returns "45.7K" for 45678', () => {
      expect(formatTokenCount(45678)).toBe('45.7K');
    });

    it('returns "999.9K" for 999900', () => {
      expect(formatTokenCount(999900)).toBe('999.9K');
    });

    it('rolls over to "1.0M" for 999999 (avoids "1000.0K")', () => {
      expect(formatTokenCount(999999)).toBe('1.0M');
    });
  });

  describe('millions range (1000000+)', () => {
    it('returns "1.0M" for 1000000 (boundary at M)', () => {
      expect(formatTokenCount(1000000)).toBe('1.0M');
    });

    it('returns "1.2M" for 1200000', () => {
      expect(formatTokenCount(1200000)).toBe('1.2M');
    });

    it('returns "45.6M" for 45600000', () => {
      expect(formatTokenCount(45600000)).toBe('45.6M');
    });

    it('returns "100.0M" for 100000000', () => {
      expect(formatTokenCount(100000000)).toBe('100.0M');
    });
  });

  describe('K-to-M boundary precision', () => {
    it('returns "999.9K" for 999949 (just below rollover)', () => {
      expect(formatTokenCount(999949)).toBe('999.9K');
    });

    it('returns "1.0M" for 999950 (rollover threshold)', () => {
      expect(formatTokenCount(999950)).toBe('1.0M');
    });
  });

  describe('edge cases', () => {
    it('handles 10000 correctly', () => {
      expect(formatTokenCount(10000)).toBe('10.0K');
    });

    it('handles 500000 correctly', () => {
      expect(formatTokenCount(500000)).toBe('500.0K');
    });

    it('handles 775900 (typical work tokens value)', () => {
      expect(formatTokenCount(775900)).toBe('775.9K');
    });

    it('handles 50700 (typical read tokens value)', () => {
      expect(formatTokenCount(50700)).toBe('50.7K');
    });

    it('handles 8200 (typical savings tokens value)', () => {
      expect(formatTokenCount(8200)).toBe('8.2K');
    });
  });

  describe('defensive guards (negative, NaN, Infinity)', () => {
    it('returns "0" for negative numbers', () => {
      expect(formatTokenCount(-1)).toBe('0');
      expect(formatTokenCount(-1500)).toBe('0');
    });

    it('returns "0" for NaN', () => {
      expect(formatTokenCount(NaN)).toBe('0');
    });

    it('returns "0" for Infinity', () => {
      expect(formatTokenCount(Infinity)).toBe('0');
      expect(formatTokenCount(-Infinity)).toBe('0');
    });

    it('returns "0" for negative zero', () => {
      expect(formatTokenCount(-0)).toBe('0');
    });
  });
});
