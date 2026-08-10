export function dedupeById<T extends { id: number }>(
  liveItems: T[],
  paginatedItems: T[]
): T[] {
  return [...new Map([...liveItems, ...paginatedItems].map(item => [item.id, item])).values()];
}
