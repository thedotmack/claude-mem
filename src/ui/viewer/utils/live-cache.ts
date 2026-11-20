/** Transient stream history is separate from pages the user explicitly loaded. */
export const LIVE_ITEMS_PER_KIND = 200;

export function retainLiveRow<T extends { id: number }>(rows: T[], row: T, limit = LIVE_ITEMS_PER_KIND): T[] {
  return [row, ...rows.filter(previous => previous.id !== row.id)].slice(0, limit);
}
