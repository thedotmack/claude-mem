import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import { Observation, Summary, UserPrompt } from '../types';
import { UI } from '../constants/ui';
import { API_ENDPOINTS } from '../constants/api';
import { sessionKey, type SessionRef } from '../utils/sessions';

// offsetCapReachedAt: the server's deepest allowed offset, set when it stopped
// this list there (src/shared/listing-offset-cap.ts) rather than running out of rows.
interface PaginationState { isLoading: boolean; hasMore: boolean; offsetCapReachedAt: number | null }
type DataType = 'observations' | 'summaries' | 'prompts';
type DataItem = Observation | Summary | UserPrompt;
type Boundary = { at: number; id: number };
export const PAGINATION_REQUEST_TIMEOUT_MS = 10_000;

/** A page request the server refused (a 4xx other than timeout/rate limit): repeating it gets the same answer. */
export class PageRejectedError extends Error {}

/** The server's own message for a refused page request, or null when the failure may pass on retry. */
export async function rejectedPageMessage(response: Response): Promise<string | null> {
  if (response.status < 400 || response.status >= 500 || response.status === 408 || response.status === 429) return null;
  const body = await response.json().catch(() => null) as { message?: unknown } | null;
  return typeof body?.message === 'string' && body.message.trim() ? body.message : `HTTP ${response.status}`;
}

/** The deepest offset the server allows, when this page is the last one it will serve. */
export function offsetCapOf(page: { offsetCapReached?: unknown; maxOffset?: unknown }): number | null {
  return page.offsetCapReached === true && typeof page.maxOffset === 'number' && Number.isFinite(page.maxOffset) ? page.maxOffset : null;
}

function boundaryOf(row: DataItem | undefined): Boundary | null {
  return row && Number.isFinite(row.created_at_epoch) ? { at: row.created_at_epoch, id: row.id } : null;
}

function usePaginationFor<TItem extends DataItem>(endpoint: string, dataType: DataType, currentFilter: string, currentSession: SessionRef | null) {
  const [state, setState] = useState<PaginationState>({ isLoading: false, hasMore: true, offsetCapReachedAt: null });
  const selectionKey = `${currentFilter}|${currentSession ? sessionKey(currentSession) : ''}`;
  const offsetRef = useRef(0);
  const boundaryRef = useRef<Boundary | null>(null);
  const selectionRef = useRef({ key: selectionKey, version: 0 });
  // An abandoned render must not retire the committed visit's requests.
  const selection = selectionRef.current.key === selectionKey ? selectionRef.current
    : { key: selectionKey, version: selectionRef.current.version + 1 };
  const selectionVersion = selection.version;
  const lastLoadedVersionRef = useRef(selectionVersion);
  const stateRef = useRef(state);
  const requestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const nextRequestRef = useRef(0);
  const disposedRef = useRef(false);

  useLayoutEffect(() => {
    if (selectionRef.current.version !== selectionVersion) requestRef.current?.controller.abort();
    selectionRef.current = selection;
  }, [selection, selectionVersion]);
  useLayoutEffect(() => {
    disposedRef.current = false;
    return () => { disposedRef.current = true; requestRef.current?.controller.abort(); };
  }, []);

  const setCurrentState = (next: PaginationState) => { stateRef.current = next; setState(next); };

  const invalidate = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    nextRequestRef.current++;
    setCurrentState({ ...stateRef.current, isLoading: false });
  }, []);

  const read = useCallback(async (refresh: boolean, latest = false): Promise<TItem[]> => {
    if (disposedRef.current || selectionRef.current.version !== selectionVersion) return [];
    const changed = lastLoadedVersionRef.current !== selectionVersion;
    if (changed) {
      requestRef.current?.controller.abort();
      offsetRef.current = 0; boundaryRef.current = null;
      lastLoadedVersionRef.current = selectionVersion;
      setCurrentState({ isLoading: false, hasMore: true, offsetCapReachedAt: null });
    }
    if (!refresh && (stateRef.current.isLoading || !stateRef.current.hasMore)) return [];
    if (refresh) requestRef.current?.controller.abort();
    const controller = new AbortController();
    const id = ++nextRequestRef.current;
    requestRef.current = { id, controller };
    setCurrentState({ ...stateRef.current, isLoading: true });
    const stale = () => disposedRef.current || selectionRef.current.version !== selectionVersion || requestRef.current?.id !== id;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, PAGINATION_REQUEST_TIMEOUT_MS);
    const previousBoundary = refresh && !latest ? boundaryRef.current : null;
    const target = latest ? UI.PAGINATION_PAGE_SIZE : Math.max(UI.PAGINATION_PAGE_SIZE, offsetRef.current);
    const rows: TItem[] = [];
    const seen = new Set<number>();
    const maxPages = Math.min(512, Math.ceil(target / UI.PAGINATION_PAGE_SIZE) + 20);
    let pageCount = 0;
    let offset = refresh ? 0 : offsetRef.current;
    let hasMore = stateRef.current.hasMore;
    let offsetCapReachedAt = stateRef.current.offsetCapReachedAt;
    try {
      for (;;) {
        if (++pageCount > maxPages) throw new Error('Memory changed too much while refreshing. Retry to refresh this view.');
        const params = new URLSearchParams({ offset: String(offset), limit: String(UI.PAGINATION_PAGE_SIZE) });
        if (currentFilter) params.append('project', currentFilter);
        if (currentSession) {
          params.append('contentSessionId', currentSession.contentSessionId);
          params.append('platformSource', currentSession.platformSource);
        }
        const response = await fetch(`${endpoint}?${params}`, { cache: 'no-store', signal: controller.signal });
        if (stale()) return [];
        if (!response.ok) {
          const rejected = await rejectedPageMessage(response);
          if (stale()) return [];
          if (rejected !== null) {
            setCurrentState({ ...stateRef.current, hasMore: false });
            throw new PageRejectedError(`Failed to load ${dataType}: ${rejected}`);
          }
          throw new Error(`Failed to load ${dataType}: ${response.statusText}`);
        }
        const data = await response.json() as { items: TItem[]; hasMore: boolean; offsetCapReached?: unknown; maxOffset?: unknown };
        if (stale()) return [];
        if (!Array.isArray(data.items)) throw new Error(`Failed to load ${dataType}: invalid page`);
        let reachedBoundary = false;
        let retained = 0;
        for (const row of data.items) {
          if (refresh && previousBoundary && (row.created_at_epoch < previousBoundary.at
            || (row.created_at_epoch === previousBoundary.at && row.id < previousBoundary.id))) {
            reachedBoundary = true; break;
          }
          if (!seen.has(row.id)) { rows.push(row); seen.add(row.id); }
          retained++;
          if (refresh && previousBoundary && row.created_at_epoch === previousBoundary.at && row.id === previousBoundary.id) {
            reachedBoundary = true; break;
          }
        }
        offset += data.items.length;
        hasMore = retained < data.items.length || data.hasMore === true;
        offsetCapReachedAt = offsetCapOf(data);
        if (!refresh || reachedBoundary || !data.hasMore || !data.items.length || (!previousBoundary && rows.length >= target)) break;
      }
      if (stale()) return [];
      // Only retained prefix rows advance a refreshed cursor; discarded page
      // suffixes must remain available when the user asks for older history.
      offsetRef.current = refresh ? rows.length : offsetRef.current + rows.length;
      boundaryRef.current = boundaryOf(rows.at(-1)) ?? (refresh ? null : boundaryRef.current);
      setCurrentState({ isLoading: false, hasMore, offsetCapReachedAt });
      return rows;
    } catch (error) {
      if (stale() || (controller.signal.aborted && !timedOut)) return [];
      if (timedOut) throw new Error(`Loading ${dataType} timed out. Try again.`);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (requestRef.current?.id === id) {
        requestRef.current = null;
        if (!disposedRef.current && selectionRef.current.version === selectionVersion) setCurrentState({ ...stateRef.current, isLoading: false });
      }
    }
    // selectionKey covers both filter fields without retiring abandoned renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, selectionVersion, endpoint, dataType]);

  const loadMore = useCallback(() => read(false), [read]);
  const refresh = useCallback(() => read(true), [read]);
  const refreshLatest = useCallback(() => read(true, true), [read]);
  const noteRemoved = useCallback((count: number = 1) => { offsetRef.current = Math.max(0, offsetRef.current - count); }, []);
  return { ...state, loadMore, refresh, refreshLatest, invalidate, noteRemoved };
}

export function usePagination(currentFilter: string, currentSession: SessionRef | null = null) {
  return {
    observations: usePaginationFor<Observation>(API_ENDPOINTS.OBSERVATIONS, 'observations', currentFilter, currentSession),
    summaries: usePaginationFor<Summary>(API_ENDPOINTS.SUMMARIES, 'summaries', currentFilter, currentSession),
    prompts: usePaginationFor<UserPrompt>(API_ENDPOINTS.PROMPTS, 'prompts', currentFilter, currentSession),
  };
}
