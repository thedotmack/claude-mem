
import type { DateRange } from '../types.js';

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

