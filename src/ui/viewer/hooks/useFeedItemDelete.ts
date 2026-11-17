import { useCallback, useMemo, useRef, useState } from 'react';
import { deleteFeedItem, type DeletableItemType } from '../utils/feed-deletion';

/**
 * Where a delete stands, for a card (a memory) and for a Sessions row (a whole session). One writer: useDeletes below,
 * which the cards reach through useFeedDeletes and the Sessions list uses directly.
 *
 *   idle --ask--> asking --confirm--> deleting --refused / no answer / stopped--> failed --retry--> deleting
 *     ^             |                    |                                          |
 *     +---cancel----+    (row removed once the worker says it is gone)              +--dismiss--> idle
 *
 * Cancel during `deleting` stops waiting for the request ("stopped"); its outcome is unknown,
 * so the card says so instead of going quiet.
 */
export type DeleteStage = 'idle' | 'asking' | 'deleting' | 'failed';

/** Words a screen reader hears for each stage. A failed delete's own alert says what happened, so it adds none. */
export const DELETE_STAGE_STATUS: Record<DeleteStage, string> = {
  idle: '',
  asking: 'Confirm the delete',
  deleting: 'Deleting…',
  failed: '',
};

/** One card's delete, as its card shows it. */
export interface FeedItemDeletion {
  stage: DeleteStage;
  /** Why the delete did not finish (English; the card translates it). */
  failure: string | null;
  ask(): void;
  /** Leaves the question, or stops waiting for a delete already sent. */
  cancel(): void;
  confirm(): void;
  retry(): void;
  dismiss(): void;
}

interface DeleteEntry { stage: Exclude<DeleteStage, 'idle'>; failure: string | null }

/**
 * Every delete of one list in one place, keyed by row (a card's feedItemKey, a session's sessionKey). Held above the
 * rows, so a question, a delete on its way and its refusal outlive a row that scrolls out of the list's window or a
 * view that is left and opened again; `active` names the rows that must stay drawn. `forKey` takes what the delete
 * sends: it rejects with the user-facing reason the row shows, and `signal` stops waiting for the worker.
 */
export function useDeletes() {
  const [entries, setEntries] = useState<Record<string, DeleteEntry>>({});
  const requests = useRef(new Map<string, AbortController>());

  const put = useCallback((key: string, entry: DeleteEntry | null) => setEntries(previous => {
    if (entry) return { ...previous, [key]: entry };
    if (!(key in previous)) return previous;
    const next = { ...previous };
    delete next[key];
    return next;
  }), []);

  const send = useCallback(async (key: string, perform: (signal: AbortSignal) => Promise<void>) => {
    // One request per row at a time: a second press while it runs does nothing.
    if (requests.current.has(key)) return;
    const request = new AbortController();
    requests.current.set(key, request);
    put(key, { stage: 'deleting', failure: null });
    try {
      await perform(request.signal);
      put(key, null);
    } catch (error) {
      put(key, { stage: 'failed', failure: error instanceof Error ? error.message : String(error) });
    } finally {
      requests.current.delete(key);
    }
  }, [put]);

  const forKey = useCallback((key: string, perform: (signal: AbortSignal) => Promise<void>): FeedItemDeletion => {
    const entry = entries[key];
    return {
      stage: entry?.stage ?? 'idle',
      failure: entry?.failure ?? null,
      ask: () => put(key, { stage: 'asking', failure: null }),
      cancel: () => {
        const request = requests.current.get(key);
        if (request) request.abort();
        else put(key, null);
      },
      confirm: () => { void send(key, perform); },
      retry: () => { void send(key, perform); },
      dismiss: () => put(key, null),
    };
  }, [entries, put, send]);

  const active = useMemo(() => new Set(Object.keys(entries)), [entries]);
  return { forKey, active };
}

/** The cards' deletes (useDeletes keyed by feedItemKey): each removes one memory, then tells the page it is gone. */
export function useFeedDeletes(onDeleted: (itemType: DeletableItemType, id: number) => void) {
  const { forKey, active } = useDeletes();
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;
  const forRow = useCallback((key: string, itemType: DeletableItemType, id: number): FeedItemDeletion =>
    forKey(key, async signal => {
      await deleteFeedItem(itemType, id, fetch, { signal });
      onDeletedRef.current(itemType, id);
    }), [forKey]);
  return { forRow, active };
}

/** One card's delete on its own, for a card drawn outside a list (DeleteButton, a single card). */
export function useFeedItemDelete(itemType: DeletableItemType, id: number, onDeleted: (itemType: DeletableItemType, id: number) => void): FeedItemDeletion {
  const deletes = useFeedDeletes(onDeleted);
  return deletes.forRow(`${itemType}-${id}`, itemType, id);
}
