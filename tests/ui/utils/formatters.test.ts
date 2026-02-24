/**
 * Tests for formatRelativeTime utility
 *
 * Pure function tests — no DOM or React needed.
 * Tests relative time formatting from epoch ms to compact string like "2m", "3h", "1d".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatRelativeTime } from '../../../src/ui/viewer/utils/formatters';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    // Freeze time at a known point: 2026-02-24T00:00:00.000Z
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('just now', () => {
    it('returns "just now" for timestamps less than 1 minute ago', () => {
      const now = Date.now();
      expect(formatRelativeTime(now)).toBe('just now');
    });

    it('returns "just now" for 30 seconds ago', () => {
      const thirtySecondsAgo = Date.now() - 30_000;
      expect(formatRelativeTime(thirtySecondsAgo)).toBe('just now');
    });

    it('returns "just now" for 59 seconds ago', () => {
      const fiftyNineSecondsAgo = Date.now() - 59_000;
      expect(formatRelativeTime(fiftyNineSecondsAgo)).toBe('just now');
    });
  });

  describe('minutes', () => {
    it('returns "1m" for exactly 1 minute ago', () => {
      const oneMinuteAgo = Date.now() - 60_000;
      expect(formatRelativeTime(oneMinuteAgo)).toBe('1m');
    });

    it('returns "5m" for 5 minutes ago', () => {
      const fiveMinutesAgo = Date.now() - 5 * 60_000;
      expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m');
    });

    it('returns "59m" for 59 minutes ago (boundary before hours)', () => {
      const fiftyNineMinutesAgo = Date.now() - 59 * 60_000;
      expect(formatRelativeTime(fiftyNineMinutesAgo)).toBe('59m');
    });

    it('returns minutes, not hours, for 59 minutes 59 seconds ago', () => {
      const justUnderOneHour = Date.now() - (60 * 60_000 - 1000);
      expect(formatRelativeTime(justUnderOneHour)).toBe('59m');
    });
  });

  describe('hours', () => {
    it('returns "1h" for exactly 1 hour ago', () => {
      const oneHourAgo = Date.now() - 60 * 60_000;
      expect(formatRelativeTime(oneHourAgo)).toBe('1h');
    });

    it('returns "3h" for 3 hours ago', () => {
      const threeHoursAgo = Date.now() - 3 * 60 * 60_000;
      expect(formatRelativeTime(threeHoursAgo)).toBe('3h');
    });

    it('returns "23h" for 23 hours ago (boundary before days)', () => {
      const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60_000;
      expect(formatRelativeTime(twentyThreeHoursAgo)).toBe('23h');
    });

    it('returns hours, not days, for 23 hours 59 minutes ago', () => {
      const justUnderOneDay = Date.now() - (24 * 60 * 60_000 - 60_000);
      expect(formatRelativeTime(justUnderOneDay)).toBe('23h');
    });
  });

  describe('days', () => {
    it('returns "1d" for exactly 24 hours ago', () => {
      const oneDayAgo = Date.now() - 24 * 60 * 60_000;
      expect(formatRelativeTime(oneDayAgo)).toBe('1d');
    });

    it('returns "2d" for 2 days ago', () => {
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60_000;
      expect(formatRelativeTime(twoDaysAgo)).toBe('2d');
    });

    it('returns "7d" for 7 days ago', () => {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60_000;
      expect(formatRelativeTime(sevenDaysAgo)).toBe('7d');
    });

    it('returns "30d" for 30 days ago', () => {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60_000;
      expect(formatRelativeTime(thirtyDaysAgo)).toBe('30d');
    });
  });

  describe('boundary conditions', () => {
    it('59m boundary: 59 minutes is NOT shown as "0h"', () => {
      const fiftyNineMinutesAgo = Date.now() - 59 * 60_000;
      const result = formatRelativeTime(fiftyNineMinutesAgo);
      expect(result).toBe('59m');
      expect(result).not.toBe('0h');
    });

    it('23h boundary: 23 hours is NOT shown as "0d"', () => {
      const twentyThreeHoursAgo = Date.now() - 23 * 60 * 60_000;
      const result = formatRelativeTime(twentyThreeHoursAgo);
      expect(result).toBe('23h');
      expect(result).not.toBe('0d');
    });
  });
});
