import type { ChromaFallbackRowIds } from '../../sync/ChromaSync.js';
import type { SessionStore } from '../../sqlite/SessionStore.js';

/**
 * The rows one search can keep, listed from SQLite the first time a candidate
 * window falls back to a filtered chroma query and reused by its wider windows,
 * so a search pays for at most one listing (#5091).
 */
export function scopeRowIdsFor(
  store: SessionStore,
  categories: { observations: boolean; sessions: boolean; prompts: boolean },
  scope: { project?: string; projects?: string[]; platformSource?: string }
): ChromaFallbackRowIds {
  let listed: { maxIds: number; ids: number[] | null } | undefined;
  return maxIds => {
    if (listed?.maxIds !== maxIds) {
      try {
        listed = { maxIds, ids: store.getSearchScopeRowIds(categories, scope, maxIds) };
      } catch (error) {
        // It would fail again: later windows send the plain filter without retrying.
        listed = { maxIds, ids: null };
        throw error;
      }
    }
    return listed.ids;
  };
}
