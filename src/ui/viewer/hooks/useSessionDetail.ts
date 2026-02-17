import { useState, useEffect, useRef } from 'react';
import type { Observation, Summary, UserPrompt, SessionDetail } from '../types';
import { API_ENDPOINTS } from '../constants/api';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Simple LRU-style cache that keeps the last N session details.
 * Exported for direct testing without React.
 */
export class SessionDetailCache {
  private readonly capacity: number;
  /** Ordered list of cache keys (oldest first) */
  private readonly order: string[] = [];
  private readonly store = new Map<string, SessionDetail>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  private buildKey(sessionId: string, project: string): string {
    return `${project}::${sessionId}`;
  }

  get(sessionId: string, project: string): SessionDetail | undefined {
    const key = this.buildKey(sessionId, project);
    const value = this.store.get(key);
    if (value !== undefined) {
      // Promote to most-recently-used to maintain LRU ordering
      const idx = this.order.indexOf(key);
      if (idx !== -1) {
        this.order.splice(idx, 1);
        this.order.push(key);
      }
    }
    return value;
  }

  set(sessionId: string, project: string, detail: SessionDetail): void {
    const key = this.buildKey(sessionId, project);

    if (this.store.has(key)) {
      // Overwrite in-place; move to back so it is considered newest
      const idx = this.order.indexOf(key);
      if (idx !== -1) {
        this.order.splice(idx, 1);
      }
    } else if (this.order.length >= this.capacity) {
      // Evict the oldest entry
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }

    this.store.set(key, detail);
    this.order.push(key);
  }
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

interface ApiListResponse<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

/**
 * Fetch a fully-assembled SessionDetail for the given sessionId.
 *
 * Returns null when:
 * - sessionId is null or empty
 * - no summary exists for the given sessionId/project combination
 *
 * Throws on HTTP errors so callers can handle loading state properly.
 *
 * Exported for direct testing without React.
 */
export async function fetchSessionDetail(
  sessionId: string | null,
  project: string,
  signal?: AbortSignal,
): Promise<SessionDetail | null> {
  if (!sessionId) {
    return null;
  }

  // TODO: Add session_id query param once the API supports server-side filtering.
  // Currently fetches all items for the project and filters client-side.
  const params = new URLSearchParams({
    offset: '0',
    limit: '200',
    project,
  });

  const fetchOpts = signal ? { signal } : undefined;

  const [summariesResp, observationsResp, promptsResp] = await Promise.all([
    fetch(`${API_ENDPOINTS.SUMMARIES}?${params}`, fetchOpts),
    fetch(`${API_ENDPOINTS.OBSERVATIONS}?${params}`, fetchOpts),
    fetch(`${API_ENDPOINTS.PROMPTS}?${params}`, fetchOpts),
  ]);

  if (!summariesResp.ok) {
    throw new Error(`Failed to load summaries: ${summariesResp.statusText}`);
  }
  if (!observationsResp.ok) {
    throw new Error(`Failed to load observations: ${observationsResp.statusText}`);
  }
  if (!promptsResp.ok) {
    throw new Error(`Failed to load prompts: ${promptsResp.statusText}`);
  }

  const [summariesData, observationsData, promptsData] = await Promise.all([
    summariesResp.json() as Promise<ApiListResponse<Summary>>,
    observationsResp.json() as Promise<ApiListResponse<Observation>>,
    promptsResp.json() as Promise<ApiListResponse<UserPrompt>>,
  ]);

  const summary = summariesData.items.find((s) => s.session_id === sessionId);
  if (!summary) {
    return null;
  }

  const observations = observationsData.items.filter(
    (o) => o.memory_session_id === sessionId,
  );
  const prompts = promptsData.items.filter(
    (p) => p.content_session_id === sessionId,
  );

  return { summary, observations, prompts };
}

// ---------------------------------------------------------------------------
// Module-level cache shared across hook instances (LRU, last 5 sessions)
// ---------------------------------------------------------------------------

const sessionDetailCache = new SessionDetailCache(5);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseSessionDetailResult {
  detail: SessionDetail | null;
  isLoading: boolean;
}

/**
 * Fetch and cache detailed data for the selected session.
 *
 * - Returns `{ detail: null, isLoading: false }` when sessionId is null.
 * - Returns cached data immediately while re-fetching in the background.
 * - Caches the last 5 session details to avoid redundant API calls.
 */
export function useSessionDetail(
  sessionId: string | null,
  project: string,
): UseSessionDetailResult {
  const [detail, setDetail] = useState<SessionDetail | null>(() =>
    sessionId ? (sessionDetailCache.get(sessionId, project) ?? null) : null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      setIsLoading(false);
      return;
    }

    // Serve from cache immediately so the UI doesn't flash.
    // No background revalidation — cached data is used as-is until evicted.
    const cached = sessionDetailCache.get(sessionId, project);
    if (cached) {
      setDetail(cached);
      setIsLoading(false);
      return;
    }

    // No cache hit: show loading state and fetch
    setIsLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    void fetchSessionDetail(sessionId, project, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result) {
          sessionDetailCache.set(sessionId, project, result);
        }
        setDetail(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Log error but don't crash — detail stays null
        console.error('useSessionDetail: fetch failed', err);
        setDetail(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [sessionId, project]);

  return { detail, isLoading };
}
