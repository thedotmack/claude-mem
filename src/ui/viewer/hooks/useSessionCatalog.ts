import { useState, useCallback, useRef, useEffect } from 'react';
import type { SessionCatalogEntry } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import {
  catalogEntryRef,
  emptyCatalogJournal,
  mergeCatalogPage,
  rowInProject,
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
  // Retrying a failed refresh must replace from offset zero, including after a
  // project switch; only a failed older-page fetch should append.
  const failedModeRef = useRef<'replace' | 'append' | 'refresh'>('replace');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Live changes made while a page request is in flight, re-applied to its
  // response so a refresh never hides a new session or restores a deleted one.
  const journalRef = useRef<CatalogJournal>(emptyCatalogJournal());
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => { requestSeqRef.current++; controllerRef.current?.abort(); }, []);

  const fetchPage = useCallback(async (project: string, mode: 'replace' | 'append' | 'refresh') => {
    const sameProject = projectRef.current === project;
    const boundary = mode === 'refresh' && sameProject
      ? sessionsRef.current.reduce<SessionCatalogEntry | null>((oldest, row) => !oldest || row.started_at_epoch <= oldest.started_at_epoch ? row : oldest, null)
      : null;
    const desiredCount = mode === 'refresh' && sameProject ? Math.max(SESSION_CATALOG_PAGE_SIZE, offsetRef.current) : SESSION_CATALOG_PAGE_SIZE;
    const pageBudget = Math.min(512, Math.ceil(desiredCount / SESSION_CATALOG_PAGE_SIZE) + 20);
    let pagesRead = 0;
    const requestSeq = ++requestSeqRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const offset = mode === 'append' ? offsetRef.current : 0;
    // A superseded request may already have live events in its journal.
    // Keep those until the newest request for this same scope settles.
    if (!inFlightRef.current || projectRef.current !== project) {
      journalRef.current = emptyCatalogJournal();
    }
    projectRef.current = project;
    inFlightRef.current = true;
    setIsLoading(true);
    setLoadError(null);
    setRefreshFailed(false);
    const params = new URLSearchParams({ offset: String(offset), limit: String(SESSION_CATALOG_PAGE_SIZE) });
    if (project) params.append('project', project);
    try {
      for (;;) {
        let sessions: SessionCatalogEntry[] = [];
        let hasMore = false;
        let pageOffset = offset;
        for (;;) {
          if (++pagesRead > pageBudget) throw new Error('Session history changed too much to refresh. Retry or refresh the latest sessions.');
          params.set('offset', String(pageOffset));
          const response = await fetch(`${API_ENDPOINTS.SESSIONS}?${params}`, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const page = await response.json() as { sessions: SessionCatalogEntry[]; hasMore?: boolean };
          if (requestSeq !== requestSeqRef.current) return;
          if (!Array.isArray(page.sessions)) throw new Error('Invalid session page');
          const pageStart = sessions.length;
          sessions.push(...page.sessions);
          hasMore = page.hasMore === true;
          if (mode !== 'refresh') break;
          if (boundary) {
            const index = sessions.findIndex(row => sameSession(catalogEntryRef(row), catalogEntryRef(boundary)));
            const olderIndex = sessions.findIndex(row => row.started_at_epoch < boundary.started_at_epoch);
            const stop = index >= 0 ? index + 1 : olderIndex >= 0 ? olderIndex : -1;
            if (stop >= 0) {
              hasMore ||= stop < sessions.length;
              sessions = sessions.slice(0, stop);
              break;
            }
          } else if (sessions.length >= desiredCount) break;
          if (!hasMore || !page.sessions.length) break;
          pageOffset += sessions.length - pageStart;
        }
        const data = { sessions, hasMore };
        if (requestSeq !== requestSeqRef.current) return;
        const journal = journalRef.current;
        // A session deleted mid-request that the page still contains moved the
        // server's list up by one more. Deletes of already-loaded sessions made
        // mid-request have moved offsetRef back themselves, so append adds to it.
        const deletedFromPage = data.sessions.filter(entry => journal.removed.has(sessionKey(catalogEntryRef(entry)))).length;
        const pageAdvance = data.sessions.length - deletedFromPage;
        offsetRef.current = mode === 'append' ? offsetRef.current + pageAdvance : pageAdvance;
        setHasMore(data.hasMore === true);
        setSessions(prev => mergeCatalogPage(prev, data.sessions, journal, mode === 'append' ? 'append' : 'replace'));
        if (mode === 'append' || (journal.decreased.size === 0 && journal.recreated.size === 0)) break;
        // Counts cannot identify deletion or recreation freshness. Confirm
        // once after all overlapping deletions, keeping this request loading.
        // Another deletion or recreation during confirmation needs a new fetch.
        journalRef.current = {
          ...emptyCatalogJournal(),
          // Keep introduced sessions visible if the confirming page is full.
          // Their current entries supply counts; old count mutations reset.
          added: journal.added.filter(entry => !journal.removed.has(sessionKey(catalogEntryRef(entry)))),
          removed: new Set(journal.removed),
        };
      }
    } catch (error) {
      if (requestSeq === requestSeqRef.current) {
        failedModeRef.current = mode;
        setRefreshFailed(mode === 'refresh');
        setLoadError(`Could not load sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      clearTimeout(timeout);
      if (controllerRef.current === controller) controllerRef.current = null;
      if (requestSeq === requestSeqRef.current) {
        journalRef.current = emptyCatalogJournal();
        inFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }, []);

  const refresh = useCallback((project: string) => fetchPage(project, 'replace'), [fetchPage]);
  const refreshLoaded = useCallback((project: string) => fetchPage(project, 'refresh'), [fetchPage]);
  /** A committed remote change invalidates any older catalog read in flight. */
  const invalidate = useCallback(() => {
    requestSeqRef.current++;
    controllerRef.current?.abort();
    controllerRef.current = null;
    inFlightRef.current = false;
    setIsLoading(false);
  }, []);

  /** The next (older) page for the project the list was last loaded for. */
  const loadMore = useCallback(async () => {
    if (inFlightRef.current || (!hasMore && !loadError)) return;
    await fetchPage(projectRef.current, loadError ? failedModeRef.current : 'append');
  }, [fetchPage, hasMore, loadError]);

  /** A live row arrived: bump its session's count, or add a session seen for the first time. */
  const touch = useCallback((item: LiveSessionItem) => {
    const key = sessionKey(item.session);
    // A live row after a whole-session deletion recreates this identity.
    // Earlier tombstones must not hide its new catalog entry.
    if (journalRef.current.removed.delete(key)) {
      journalRef.current.recreated.add(key);
    }
    journalRef.current.touched.add(key);
    setSessions(prev => {
      const index = prev.findIndex(entry => sameSession(catalogEntryRef(entry), item.session));
      if (index === -1) {
        if (projectRef.current && !rowInProject(item, projectRef.current)) return prev;
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

  const noteItemRemoved = useCallback((session: SessionRef) => {
    const key = sessionKey(session);
    journalRef.current.touched.add(key);
    journalRef.current.decreased.add(key);
    setSessions(prev => prev.map(entry => sameSession(catalogEntryRef(entry), session)
      ? { ...entry, item_count: Math.max(0, entry.item_count - 1) }
      : entry));
  }, []);

  const remove = useCallback((session: SessionRef) => {
    const key = sessionKey(session);
    journalRef.current.removed.add(key);
    journalRef.current.recreated.delete(key);
    // A loaded session is gone from the server's list too: the next page starts one earlier.
    if (sessionsRef.current.some(entry => sameSession(catalogEntryRef(entry), session))) {
      offsetRef.current = Math.max(0, offsetRef.current - 1);
    }
    setSessions(prev => prev.filter(entry => !sameSession(catalogEntryRef(entry), session)));
  }, []);

  return { sessions, isLoading, hasMore, loadError, refreshFailed, refresh, refreshLoaded, invalidate, loadMore, touch, noteItemRemoved, remove };
}
