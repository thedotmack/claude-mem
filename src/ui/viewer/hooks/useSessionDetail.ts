import { useState, useEffect, useRef } from 'react';
import type { Observation, Summary, UserPrompt, SessionDetail } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Simple LRU-style cache that keeps the last N session details.
 * Exported for direct testing without React.
 */
export class SessionDetailCache {
  private readonly capacity: number;
  /** Ordered list of cache keys (oldest first). Mutated internally for LRU reordering. */
  private order: string[] = [];
  private readonly store = new Map<string, SessionDetail>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  private buildKey(sessionId: string, project: string, summaryId?: number | null): string {
    return summaryId != null ? `${project}::${sessionId}::${summaryId}` : `${project}::${sessionId}`;
  }

  get(sessionId: string, project: string, summaryId?: number | null): SessionDetail | undefined {
    const key = this.buildKey(sessionId, project, summaryId);
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

  set(sessionId: string, project: string, detail: SessionDetail, summaryId?: number | null): void {
    const key = this.buildKey(sessionId, project, summaryId);

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
  summaryId?: number | null,
  signal?: AbortSignal,
): Promise<SessionDetail | null> {
  if (!sessionId) {
    return null;
  }

  // Base params for summaries (filter by session_id)
  const summaryParams = new URLSearchParams({
    offset: '0',
    limit: '200',
    session_id: sessionId,
  });
  if (project) {
    summaryParams.set('project', project);
  }

  // Params for observations and prompts — scope to summary's time window when summaryId is available
  const detailParams = new URLSearchParams({
    offset: '0',
    limit: '200',
    session_id: sessionId,
  });
  if (project) {
    detailParams.set('project', project);
  }
  if (summaryId) {
    detailParams.set('summary_id', String(summaryId));
  } else {
    // No summaryId → active/unsummarized session; scope to observations after the latest summary
    detailParams.set('unsummarized', 'true');
  }

  const fetchOpts = signal ? { signal } : undefined;

  const [summariesResp, observationsResp, promptsResp] = await Promise.all([
    fetch(`${API_ENDPOINTS.SUMMARIES}?${summaryParams}`, fetchOpts),
    fetch(`${API_ENDPOINTS.OBSERVATIONS}?${detailParams}`, fetchOpts),
    fetch(`${API_ENDPOINTS.PROMPTS}?${detailParams}`, fetchOpts),
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

  // When summaryId is provided, find the specific summary.
  // When null (active/unsummarized session), don't show old summaries —
  // observations and prompts are already scoped to unsummarized content.
  const summary = summaryId
    ? summariesData.items.find(s => s.id === summaryId) ?? summariesData.items[0]
    : null;

  // Return observations/prompts even without a summary (active/unsummarized sessions)
  if (!summary && observationsData.items.length === 0 && promptsData.items.length === 0) {
    return null;
  }

  return {
    summary: summary ?? null,
    observations: observationsData.items,
    prompts: promptsData.items,
  };
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
/** Polling interval for active (unsummarized) sessions in ms. */
const ACTIVE_SESSION_POLL_INTERVAL = 5_000;

export function useSessionDetail(
  sessionId: string | null,
  project: string,
  summaryId?: number | null,
): UseSessionDetailResult {
  const [detail, setDetail] = useState<SessionDetail | null>(() =>
    sessionId ? (sessionDetailCache.get(sessionId, project, summaryId) ?? null) : null,
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
    // Skip cache for active/unsummarized sessions (summaryId is null) — their data changes live.
    if (summaryId) {
      const cached = sessionDetailCache.get(sessionId, project, summaryId);
      if (cached) {
        setDetail(cached);
        setIsLoading(false);
        return;
      }
    }

    // No cache hit: show loading state and fetch
    setIsLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    void fetchSessionDetail(sessionId, project, summaryId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result) {
          sessionDetailCache.set(sessionId, project, result, summaryId);
        }
        setDetail(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        logger.error('sessionDetail', 'Failed to load session detail');
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
  }, [sessionId, project, summaryId]);

  // Poll active (unsummarized) sessions so new observations appear without refresh.
  // Summarized sessions (summaryId truthy) are static — no polling needed.
  useEffect(() => {
    if (!sessionId || summaryId) return;

    const poll = () => {
      void fetchSessionDetail(sessionId, project, summaryId)
        .then((result) => {
          if (result) {
            setDetail(result);
          }
        })
        .catch(() => {
          // Swallow errors during polling — don't clear existing detail
        });
    };

    const intervalId = setInterval(poll, ACTIVE_SESSION_POLL_INTERVAL);
    return () => { clearInterval(intervalId); };
  }, [sessionId, project, summaryId]);

  return { detail, isLoading };
}
