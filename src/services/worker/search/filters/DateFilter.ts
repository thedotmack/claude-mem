/**
 * DateFilter - Date range filtering for search results
 *
 * Provides utilities for filtering search results by date range.
 */

import type { DateRange, SearchResult, CombinedResult } from '../types.js';
import { logger } from '../../../../utils/logger.js';
import { SEARCH_CONSTANTS } from '../types.js';

/**
 * Parse date range values to epoch milliseconds
 */
export function parseDateRange(dateRange?: DateRange): {
  startEpoch?: number;
  endEpoch?: number;
} {
  if (!dateRange) {
    return {};
  }

  const result: { startEpoch?: number; endEpoch?: number } = {};

  if (dateRange.start) {
    result.startEpoch = typeof dateRange.start === 'number'
      ? dateRange.start
      : new Date(dateRange.start).getTime();
  }

  if (dateRange.end) {
    result.endEpoch = typeof dateRange.end === 'number'
      ? dateRange.end
      : new Date(dateRange.end).getTime();
  }

  return result;
}

/**
 * Check if an epoch timestamp is within a date range
 */
export function isWithinDateRange(
  epoch: number,
  dateRange?: DateRange
): boolean {
  if (!dateRange) {
    return true;
  }

  const { startEpoch, endEpoch } = parseDateRange(dateRange);

  if (startEpoch && epoch < startEpoch) {
    return false;
  }

  if (endEpoch && epoch > endEpoch) {
    return false;
  }

  return true;
}

/**
 * Check if an epoch timestamp is within the recency window
 */
export function isRecent(epoch: number): boolean {
  const cutoff = Date.now() - SEARCH_CONSTANTS.RECENCY_WINDOW_MS;
  return epoch > cutoff;
}

/**
 * Filter combined results by date range
 */
export function filterResultsByDate<T extends { epoch: number }>(
  results: T[],
  dateRange?: DateRange
): T[] {
  if (!dateRange) {
    return results;
  }

  return results.filter(result => isWithinDateRange(result.epoch, dateRange));
}

/**
 * Get date boundaries for common ranges
 */
export function getDateBoundaries(range: 'today' | 'week' | 'month' | '90days'): DateRange {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  switch (range) {
    case 'today':
      return { start: startOfToday.getTime() };
    case 'week':
      return { start: now - 7 * 24 * 60 * 60 * 1000 };
    case 'month':
      return { start: now - 30 * 24 * 60 * 60 * 1000 };
    case '90days':
      return { start: now - SEARCH_CONSTANTS.RECENCY_WINDOW_MS };
  }
}
