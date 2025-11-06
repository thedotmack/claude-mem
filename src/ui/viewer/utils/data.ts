/**
 * Data manipulation utility functions
 * Used for merging and deduplicating real-time and paginated data
 */

/**
 * Merge real-time SSE items with paginated items, removing duplicates and filtering by project
 * @param liveItems - Items from SSE stream
 * @param paginatedItems - Items from pagination API (already filtered by project)
 * @param projectFilter - Current project filter (empty string = all projects)
 * @returns Merged and deduplicated array
 */
export function mergeAndDeduplicateByProject<T extends { id: number; project?: string }>(
  liveItems: T[],
  paginatedItems: T[],
  projectFilter: string
): T[] {
  // Filter SSE items by current project (pagination is already filtered)
  const filteredLive = projectFilter
    ? liveItems.filter(item => item.project === projectFilter)
    : liveItems;

  // Deduplicate using Set
  const seen = new Set<number>();
  return [...filteredLive, ...paginatedItems].filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
