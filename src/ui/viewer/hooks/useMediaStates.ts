import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MEDIA_PENDING_MAX_POLLS,
  MEDIA_PENDING_POLL_MS,
  mediaDisplayStateFrom,
  mediaMetadataUrl,
  shouldPollMediaState,
  type MediaDisplayState,
} from '../utils/media';

/**
 * Resolve readiness for each attachment through the controlled metadata route.
 * Pending and downloading attachments are re-checked a bounded number of
 * times; an unresolved replica's metadata read also drives its download.
 * `retry(id)` re-reads one attachment after an error.
 */
export function useMediaStates(ids: readonly string[]) {
  const [states, setStates] = useState<Record<string, MediaDisplayState>>({});
  const pollCounts = useRef<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const mounted = useRef(true);
  const idsKey = ids.join(',');

  const load = useCallback(async (id: string) => {
    let next: MediaDisplayState;
    try {
      const response = await fetch(mediaMetadataUrl(id), { credentials: 'same-origin' });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A non-JSON body is mapped by status alone below.
      }
      next = mediaDisplayStateFrom(response.status, body);
    } catch {
      next = mediaDisplayStateFrom(0, null);
    }
    if (!mounted.current) return;
    if (shouldPollMediaState(next)) {
      const polls = (pollCounts.current[id] ?? 0) + 1;
      pollCounts.current[id] = polls;
      if (polls <= MEDIA_PENDING_MAX_POLLS) {
        timers.current[id] = setTimeout(() => { void load(id); }, MEDIA_PENDING_POLL_MS);
      } else if (next.kind === 'pending' || next.kind === 'downloading') {
        // Bounded polling ended: show a Retry control that restarts it.
        next = { ...next, stalled: true };
      }
    }
    setStates(previous => ({ ...previous, [id]: next }));
  }, []);

  useEffect(() => {
    mounted.current = true;
    for (const id of ids) void load(id);
    return () => {
      mounted.current = false;
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
      timers.current = {};
    };
    // idsKey stands for ids: refs are value-identical across feed refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, load]);

  const retry = useCallback((id: string) => {
    clearTimeout(timers.current[id]);
    pollCounts.current[id] = 0;
    setStates(previous => ({ ...previous, [id]: { kind: 'loading' } }));
    void load(id);
  }, [load]);

  /** An <img> that failed after metadata said ready: show it as a read error. */
  const markImageError = useCallback((id: string) => {
    setStates(previous => ({ ...previous, [id]: { kind: 'error', code: 'image_load_failed' } }));
  }, []);

  return { states, retry, markImageError };
}
