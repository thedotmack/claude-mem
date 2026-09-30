import { useState, useCallback, useRef } from 'react';
import type { SessionCatalogEntry } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { catalogEntryRef, sameSession, type SessionRef } from '../utils/sessions';
import type { LiveSessionItem } from './useSSE';

/**
 * The Sessions view's catalog. Fetched when the view opens (and when the
 * project filter changes), then kept current from live SSE rows and deletes,
 * so it is never pushed to every tab over the stream.
 */
export function useSessionCatalog() {
  const [sessions, setSessions] = useState<SessionCatalogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const refresh = useCallback(async (project: string) => {
    const requestSeq = ++requestSeqRef.current;
    setIsLoading(true);
    setLoadError(null);
    const params = new URLSearchParams();
    if (project) params.append('project', project);
    try {
      const response = await fetch(`${API_ENDPOINTS.SESSIONS}?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { sessions: SessionCatalogEntry[] };
      if (requestSeq === requestSeqRef.current) setSessions(data.sessions);
    } catch (error) {
      if (requestSeq === requestSeqRef.current) {
        setLoadError(`Could not load sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (requestSeq === requestSeqRef.current) setIsLoading(false);
    }
  }, []);

  /** A live row arrived: bump its session's count, or add a session seen for the first time. */
  const touch = useCallback((item: LiveSessionItem) => {
    setSessions(prev => {
      const index = prev.findIndex(entry => sameSession(catalogEntryRef(entry), item.session));
      if (index === -1) {
        return [
          {
            content_session_id: item.session.contentSessionId,
            project: item.project,
            platform_source: item.session.platformSource,
            // Live rows don't carry custom_title; the next catalog fetch does.
            custom_title: null,
            started_at_epoch: item.createdAtEpoch,
            item_count: 1,
          },
          ...prev,
        ];
      }
      const next = [...prev];
      next[index] = { ...next[index], item_count: next[index].item_count + 1 };
      return next;
    });
  }, []);

  const remove = useCallback((session: SessionRef) => {
    setSessions(prev => prev.filter(entry => !sameSession(catalogEntryRef(entry), session)));
  }, []);

  return { sessions, isLoading, loadError, refresh, touch, remove };
}
