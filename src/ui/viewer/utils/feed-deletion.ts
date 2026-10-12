import type { FeedItemType, StreamEvent } from '../types';

/**
 * Rows the viewer offers to delete. Prompts are left out: deleting one shifts
 * the prompt numbers of later prompts in the session (prompt_number is derived
 * from a COUNT), so they stay read-only here until numbering is stable.
 */
export type DeletableItemType = Exclude<FeedItemType, 'prompt'>;

const DELETE_ENDPOINTS: Record<DeletableItemType, string> = {
  observation: '/api/observation',
  summary: '/api/summary',
};

const FEED_ITEM_TYPES: readonly FeedItemType[] = ['observation', 'summary', 'prompt'];

/** User-facing reason for a refused delete, by the worker's status code. */
export function describeDeleteFailure(status: number): string {
  if (status === 404) {
    return 'Not deleted: this memory was synced from another device (delete it there), or it is already gone.';
  }
  if (status === 503) {
    return 'Not deleted: cloud sync is unavailable, so the delete could not be recorded for your other devices. Try again once sync reconnects.';
  }
  return `Not deleted: the worker answered HTTP ${status}.`;
}

/**
 * Delete one memory through the worker's sync-safe endpoint (tombstone and row
 * delete in one transaction). Rejects with a user-facing message.
 */
export async function deleteFeedItem(
  itemType: DeletableItemType,
  id: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${DELETE_ENDPOINTS[itemType]}/${id}`, { method: 'DELETE' }).catch(() => {
    throw new Error('Not deleted: the claude-mem worker could not be reached.');
  });
  if (!response.ok) {
    throw new Error(describeDeleteFailure(response.status));
  }
}

/** The row an `item_deleted` SSE event names, or null when the event is malformed. */
export function itemDeletedTarget(event: StreamEvent): { itemType: FeedItemType; id: number } | null {
  if (event.type !== 'item_deleted') return null;
  const itemType = event.itemType;
  if (!itemType || !FEED_ITEM_TYPES.includes(itemType)) return null;
  if (typeof event.id !== 'number' || !Number.isSafeInteger(event.id)) return null;
  return { itemType, id: event.id };
}

/**
 * Drop a deleted row from a loaded page list. `wasLoaded` means the server's
 * list shifted up by one under the loaded pages, so the next page offset has to
 * move back by one or a row would be skipped.
 */
export function removeLoadedRow<T extends { id: number }>(rows: T[], id: number): { rows: T[]; wasLoaded: boolean } {
  const remaining = rows.filter(row => row.id !== id);
  return { rows: remaining, wasLoaded: remaining.length !== rows.length };
}
