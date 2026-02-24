import { useState, useEffect, useCallback, useRef } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { ACTIVE_SESSIONS_POLL_INTERVAL_MS } from '../constants/sessions';
import { logger } from '../utils/logger';

export interface ActiveSession {
  id: number;
  content_session_id: string;
  project: string;
  user_prompt: string | null;
  started_at_epoch: number;
  duration_ms: number;
  is_stale: boolean;
}

interface ActiveSessionsData {
  sessions: ActiveSession[];
  staleCount: number;
  totalCount: number;
}

export interface UseActiveSessionsResult {
  sessions: ActiveSession[];
  staleCount: number;
  totalCount: number;
  isLoading: boolean;
  closeSession: (id: number) => Promise<void>;
  closeAllStale: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useActiveSessions(): UseActiveSessionsResult {
  const [data, setData] = useState<ActiveSessionsData>({
    sessions: [],
    staleCount: 0,
    totalCount: 0,
  });
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadActiveSessions = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    try {
      const response = await fetch(API_ENDPOINTS.ACTIVE_SESSIONS, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Active sessions fetch failed');
      const responseData = await response.json() as ActiveSessionsData;
      if (!controller.signal.aborted) {
        setData(responseData);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      logger.error('useActiveSessions', 'Failed to load active sessions');
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadActiveSessions();

    const interval = setInterval(() => {
      void loadActiveSessions();
    }, ACTIVE_SESSIONS_POLL_INTERVAL_MS);

    return () => {
      abortRef.current?.abort();
      clearInterval(interval);
    };
  }, [loadActiveSessions]);

  const closeSession = useCallback(async (id: number): Promise<void> => {
    try {
      const response = await fetch(`${API_ENDPOINTS.SESSIONS_BASE}/${String(id)}/close`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`Failed to close session ${String(id)}`);
      await loadActiveSessions();
    } catch (_error) {
      logger.error('useActiveSessions', `Failed to close session ${String(id)}`);
    }
  }, [loadActiveSessions]);

  const closeAllStale = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(API_ENDPOINTS.CLOSE_STALE_SESSIONS, {
        method: 'POST',
      });
      if (!response.ok) throw new Error('Failed to close stale sessions');
      await loadActiveSessions();
    } catch (_error) {
      logger.error('useActiveSessions', 'Failed to close stale sessions');
    }
  }, [loadActiveSessions]);

  return {
    sessions: data.sessions,
    staleCount: data.staleCount,
    totalCount: data.totalCount,
    isLoading,
    closeSession,
    closeAllStale,
    refresh: loadActiveSessions,
  };
}
