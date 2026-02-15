/**
 * UI-related constants
 * Pagination, intersection observer settings, and other UI configuration
 */
export const UI = {
  /** Number of observations to load per page */
  PAGINATION_PAGE_SIZE: 50,

  /** Intersection observer threshold (0-1, percentage of visibility needed to trigger) */
  LOAD_MORE_THRESHOLD: 0.1,

  /** Debounce delay for search input (ms) */
  SEARCH_DEBOUNCE_MS: 300,

  /** Page size for search results */
  SEARCH_PAGE_SIZE: 50,

  /** Number of days to show in activity bar */
  ACTIVITY_BAR_DAYS: 90,

  /** Max items to fetch for activity density aggregation */
  ACTIVITY_DENSITY_LIMIT: 1000,
} as const;
