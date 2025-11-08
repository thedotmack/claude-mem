/**
 * Data manipulation utility functions
 * Used for merging and deduplicating real-time and paginated data
 */

/**
 * Merge real-time SSE items with paginated items, removing duplicates by ID
 * NOTE: This should ONLY be used when no project filter is active.
 * When filtering, use ONLY paginated data (API-filtered).
 *
 * @param liveItems - Items from SSE stream (unfiltered)
 * @param paginatedItems - Items from pagination API
 * @returns Merged and deduplicated array
 */
export function mergeAndDeduplicateByProject<T extends { id: number; project?: string }>(
  liveItems: T[],
  paginatedItems: T[]
): T[] {
  // Deduplicate by ID
  const seen = new Set<number>();
  return [...liveItems, ...paginatedItems].filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
