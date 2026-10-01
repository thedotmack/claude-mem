import { useState, useCallback, useRef } from 'react';
import type { SessionCatalogEntry } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import {
  catalogEntryRef,
  emptyCatalogJournal,
  mergeCatalogPage,
  sameSession,
  sessionKey,
  type CatalogJournal,
  type SessionRef,
} from '../utils/sessions';
import type { LiveSessionItem } from './useSSE';

/** Sessions per catalog page; older pages load as the list scrolls. */
export const SESSION_CATALOG_PAGE_SIZE = 100;

/**
 * The Sessions view's catalog. Fetched a page at a time when the view opens
 * (and when the project filter changes), extended with older pages on scroll,
 * and kept current from live SSE rows and deletes, so it is never pushed to
 * every tab over the stream.
 */
export function useSessionCatalog() {
  const [sessions, setSessions] = useState<SessionCatalogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const projectRef = useRef('');
  // Server offset of the next page: sessions loaded from the server, minus
  // loaded ones deleted since (the server's list moved up by that many).
  const offsetRef = useRef(0);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Live changes made while a page request is in flight, re-applied to its
  // response so a refresh never hides a new session or restores a deleted one.
  const journalRef = useRef<CatalogJournal>(emptyCatalogJournal());

  const fetchPage = useCallback(async (project: string, mode: 'replace' | 'append') => {
    const requestSeq = ++requestSeqRef.current;
    const offset = mode === 'replace' ? 0 : offsetRef.current;
    projectRef.current = project;
    journalRef.current = emptyCatalogJournal();
    inFlightRef.current = true;
    setIsLoading(true);
    setLoadError(null);
    const params = new URLSearchParams({ offset: String(offset), limit: String(SESSION_CATALOG_PAGE_SIZE) });
    if (project) params.append('project', project);
    try {
      const response = await fetch(`${API_ENDPOINTS.SESSIONS}?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { sessions: SessionCatalogEntry[]; hasMore?: boolean };
      if (requestSeq !== requestSeqRef.current) return;
      const journal = journalRef.current;
      // A session deleted mid-request that the page still contains moved the
      // server's list up by one more. Deletes of already-loaded sessions made
      // mid-request have moved offsetRef back themselves, so append adds to it.
      const deletedFromPage = data.sessions.filter(entry => journal.removed.has(sessionKey(catalogEntryRef(entry)))).length;
      const pageAdvance = data.sessions.length - deletedFromPage;
      offsetRef.current = mode === 'replace' ? pageAdvance : offsetRef.current + pageAdvance;
      setHasMore(data.hasMore === true);
      setSessions(prev => mergeCatalogPage(prev, data.sessions, journal, mode));
    } catch (error) {
      if (requestSeq === requestSeqRef.current) {
        setLoadError(`Could not load sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }, []);

  const refresh = useCallback((project: string) => fetchPage(project, 'replace'), [fetchPage]);

  /** The next (older) page for the project the list was last loaded for. */
  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore) return;
    await fetchPage(projectRef.current, 'append');
  }, [fetchPage, hasMore]);

  /** A live row arrived: bump its session's count, or add a session seen for the first time. */
  const touch = useCallback((item: LiveSessionItem) => {
    setSessions(prev => {
      const index = prev.findIndex(entry => sameSession(catalogEntryRef(entry), item.session));
      if (index === -1) {
        const entry: SessionCatalogEntry = {
          content_session_id: item.session.contentSessionId,
          project: item.project,
          platform_source: item.session.platformSource,
          // Live rows don't carry custom_title; the next catalog fetch does.
          custom_title: null,
          started_at_epoch: item.createdAtEpoch,
          item_count: 1,
        };
        journalRef.current.added.push(entry);
        return [entry, ...prev];
      }
      const next = [...prev];
      next[index] = { ...next[index], item_count: next[index].item_count + 1 };
      return next;
    });
  }, []);

  const remove = useCallback((session: SessionRef) => {
    journalRef.current.removed.add(sessionKey(session));
    // A loaded session is gone from the server's list too: the next page starts one earlier.
    if (sessionsRef.current.some(entry => sameSession(catalogEntryRef(entry), session))) {
      offsetRef.current = Math.max(0, offsetRef.current - 1);
    }
    setSessions(prev => prev.filter(entry => !sameSession(catalogEntryRef(entry), session)));
  }, []);

  return { sessions, isLoading, hasMore, loadError, refresh, loadMore, touch, remove };
}
