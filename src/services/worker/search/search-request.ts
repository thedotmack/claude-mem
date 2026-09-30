import { AppError } from '../../server/ErrorHandler.js';

interface SearchRequestInput {
  query?: unknown;
  project?: unknown;
  platformSource?: unknown;
  dateRange?: { start?: unknown; end?: unknown } | null;
  obsType?: unknown;
  concepts?: unknown;
  files?: unknown;
}

function isPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

/**
 * Request-boundary check for search: a request needs query text or at least one row filter.
 * Each SessionSearch leg returns [] when none of the filters apply to it (so an obs_type-only
 * search is not rejected by the sessions and prompts legs), which means an empty request would
 * otherwise come back as a silent zero-result success instead of a 400.
 * A document category (`type: 'observations'`) selects what to search, not which rows, so it
 * does not count as a filter.
 */
export function assertSearchHasQueryOrFilter(input: SearchRequestInput): void {
  const hasDateRange = !!input.dateRange && (isPresent(input.dateRange.start) || isPresent(input.dateRange.end));
  const hasFilter = hasDateRange
    || [input.project, input.platformSource, input.obsType, input.concepts, input.files].some(isPresent);
  if (!isPresent(input.query) && !hasFilter) {
    throw new AppError('Either query or filters required for search', 400, 'INVALID_SEARCH_REQUEST');
  }
}
