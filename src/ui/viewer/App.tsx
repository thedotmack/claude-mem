import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ViewTabs, type ViewTab } from './components/ViewTabs';
import { SessionList } from './components/SessionList';
import { SessionDetailPage } from './components/SessionDetailPage';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { useSSE, type MemoryChange } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { usePagination } from './hooks/usePagination';
import { useSessionCatalog } from './hooks/useSessionCatalog';
import { useTheme } from './hooks/useTheme';
import { Observation, Summary, UserPrompt, FeedItemType } from './types';
import { buildFeedItems, mergeAndDeduplicateByProject } from './utils/data';
import { removeLoadedRow } from './utils/feed-deletion';
import {
  catalogEntryRef,
  deleteSession,
  parseViewRoute,
  removeSessionRows,
  rowInProject,
  sameSession,
  sessionHash,
  sessionKey,
  sessionRefOf,
  sessionsHash,
  type SessionRef,
  type SessionScopedRow,
  type ViewRoute,
} from './utils/sessions';

/** What the feed shows: the project timeline, or one session's rows. */
interface FeedScope {
  project: string;
  session: SessionRef | null;
}

function feedScopeKey(scope: FeedScope): string {
  return `${scope.project}|${scope.session ? sessionKey(scope.session) : ''}`;
}

function scopeForRoute(route: ViewRoute, project: string): FeedScope | null {
  if (route.view === 'sessions') return null;
  if (route.view === 'session') return { project: '', session: route.session };
  return { project, session: null };
}

function navigate(hash: string): void {
  window.location.hash = hash;
}

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);
  const [feedLoadError, setFeedLoadError] = useState<string | null>(null);
  const [showLatestRefresh, setShowLatestRefresh] = useState(false);
  const [feedRefreshNotice, setFeedRefreshNotice] = useState<string | null>(null);
  const handledDeletionsRef = useRef(new Set<string>());
  // A page started before a session was deleted must not restore its old rows,
  // even if a live row has since re-created that same session identity.
  const deletionVersionRef = useRef(0);
  const sessionDeletionVersionsRef = useRef(new Map<string, number>());
  const itemDeletionVersionsRef = useRef(new Map<string, number>());
  const contentGenerationRef = useRef(0);
  const initialReadStartedRef = useRef(false);
  const loadedVisitRef = useRef(-1);
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resyncBusyRef = useRef(false);
  const resyncPausedRef = useRef(false);
  const resyncInterruptionsRef = useRef(0);
  const pendingResyncRef = useRef(new Set<FeedItemType>());
  const activeResyncKindsRef = useRef<FeedItemType[]>([]);
  const failedResyncRef = useRef(new Set<FeedItemType>());
  const refreshLatestRef = useRef(false);
  const runResyncRef = useRef<() => Promise<void>>(async () => {});
  const disposedRef = useRef(false);
  const [connectionWaitExpired, setConnectionWaitExpired] = useState(false);
  const [route, setRoute] = useState<ViewRoute>(() => parseViewRoute(window.location.hash));
  // The Sessions list keeps the last timeline/session scope, so switching back
  // does not reload pages that are still correct.
  const [feedScope, setFeedScope] = useState<FeedScope>(
    () => scopeForRoute(route, currentFilter) ?? { project: currentFilter, session: null }
  );
  const scopeKey = feedScopeKey(feedScope);
  const activeFeedScopeRef = useRef({ key: scopeKey, version: 0 });
  const feedVisit = activeFeedScopeRef.current.key === scopeKey
    ? activeFeedScopeRef.current
    : { key: scopeKey, version: activeFeedScopeRef.current.version + 1 };
  // Only a committed scope retires the previous visit's rows and errors.
  useLayoutEffect(() => { activeFeedScopeRef.current = feedVisit; }, [feedVisit]);
  const feedVersion = feedVisit.version;

  const catalog = useSessionCatalog();
  const { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected, syncStatus, removeLiveItem, removeLiveSession,
    captureLiveVersion, clearLiveThrough, refreshProjects } = useSSE({
    onItemDeleted: removeDeletedItem,
    onSessionDeleted: removeDeletedSession,
    onLiveItem: item => {
      handledDeletionsRef.current.delete(`session:${sessionKey(item.session)}`);
      catalog.touch(item);
    },
    onDataChanged: queueDataRefresh,
  });
  const {
    settings, saveSettings, isSaving, saveStatus,
    isLoaded: settingsLoaded, loadError: settingsLoadError, reload: reloadSettings,
  } = useSettings();
  const { preference, setThemePreference } = useTheme();
  const pagination = usePagination(feedScope.project, feedScope.session);

  useEffect(() => {
    disposedRef.current = false;
    const timeout = setTimeout(() => setConnectionWaitExpired(true), 250);
    return () => {
      disposedRef.current = true;
      clearTimeout(timeout);
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    };
  }, []);

  function scheduleDataRefresh(): void {
    if (disposedRef.current || resyncPausedRef.current || resyncBusyRef.current || resyncTimerRef.current) return;
    resyncTimerRef.current = setTimeout(() => {
      resyncTimerRef.current = null;
      void runResyncRef.current();
    }, 250);
  }

  function queueDataRefresh(change: MemoryChange): void {
    // The initial baseline starts after stream admission. If HTTP already
    // started via the outage fallback, this first connection must catch up.
    if (!initialReadStartedRef.current) return;
    if (resyncPausedRef.current) return;
    if (change.kinds && !change.kinds.some(kind => ['observation', 'summary', 'prompt', 'mutation'].includes(kind))) return;
    // These three lists share one displayed visit/generation. Cancelling an
    // older read must also refresh its siblings, even if only one kind changed.
    const kinds = ['observation', 'summary', 'prompt'] as const;
    contentGenerationRef.current++;
    for (const kind of kinds) pendingResyncRef.current.add(kind);
    for (const kind of activeResyncKindsRef.current) pendingResyncRef.current.add(kind);
    // Scope hints are advisory: aliases and linked-session repairs can affect
    // a filtered view even when its spelling is absent from the event.
    pagination.observations.invalidate();
    pagination.summaries.invalidate();
    pagination.prompts.invalidate();
    catalog.invalidate();
    if (resyncBusyRef.current && ++resyncInterruptionsRef.current >= 3) {
      // A live database can keep invalidating every in-flight read. Stop the
      // automatic loop after a bounded number of retries, keeping shown rows.
      resyncPausedRef.current = true;
      pendingResyncRef.current.clear();
      for (const kind of kinds) failedResyncRef.current.add(kind);
      setFeedLoadError('Memories are changing faster than this view can refresh. Retry, or refresh the latest memories.');
      setShowLatestRefresh(true);
      return;
    }
    scheduleDataRefresh();
  }

  async function runDataRefresh(): Promise<void> {
    if (disposedRef.current || resyncBusyRef.current || !pendingResyncRef.current.size) return;
    resyncBusyRef.current = true;
    const kinds = [...pendingResyncRef.current];
    activeResyncKindsRef.current = kinds;
    pendingResyncRef.current.clear();
    const generation = contentGenerationRef.current;
    const visit = activeFeedScopeRef.current.version;
    const liveVersion = captureLiveVersion();
    const latest = refreshLatestRef.current;
    refreshLatestRef.current = false;
    const deletedBeforeRead = deletionVersionRef.current;
    const current = () => !disposedRef.current && contentGenerationRef.current === generation && activeFeedScopeRef.current.version === visit;
    const errors: string[] = [];
    const retain = <T extends SessionScopedRow & { id: number }>(rows: T[], kind: FeedItemType) => rows.filter(row => {
      const key = `${kind}:${row.id}`;
      if ((itemDeletionVersionsRef.current.get(key) ?? 0) > deletedBeforeRead) return false;
      const session = sessionRefOf(row);
      if (session && (sessionDeletionVersionsRef.current.get(sessionKey(session)) ?? 0) > deletedBeforeRead) return false;
      // This request began after older deletes: its returned rows can include
      // a valid recreation, so old tombstones must not hide it forever.
      handledDeletionsRef.current.delete(key);
      if (session) handledDeletionsRef.current.delete(`session:${sessionKey(session)}`);
      return true;
    });
    try {
      await Promise.all(kinds.map(async kind => {
        try {
          if (kind === 'observation') {
            const rows = await (latest ? pagination.observations.refreshLatest() : pagination.observations.refresh());
            if (!current()) return;
            const kept = retain(rows, kind); pagination.observations.noteRemoved(rows.length - kept.length);
            setPaginatedObservations(kept);
          } else if (kind === 'summary') {
            const rows = await (latest ? pagination.summaries.refreshLatest() : pagination.summaries.refresh());
            if (!current()) return;
            const kept = retain(rows, kind); pagination.summaries.noteRemoved(rows.length - kept.length);
            setPaginatedSummaries(kept);
          } else {
            const rows = await (latest ? pagination.prompts.refreshLatest() : pagination.prompts.refresh());
            if (!current()) return;
            const kept = retain(rows, kind); pagination.prompts.noteRemoved(rows.length - kept.length);
            setPaginatedPrompts(kept);
          }
          clearLiveThrough(kind, liveVersion);
          failedResyncRef.current.delete(kind);
          for (const [key, version] of itemDeletionVersionsRef.current) {
            if (key.startsWith(`${kind}:`) && version <= deletedBeforeRead) {
              itemDeletionVersionsRef.current.delete(key); handledDeletionsRef.current.delete(key);
            }
          }
        } catch (error) {
          if (!current()) return;
          failedResyncRef.current.add(kind);
          errors.push(error instanceof Error ? error.message : 'Could not refresh saved memories.');
        }
      }));
      if (current()) {
        setFeedLoadError(previous => errors.length ? `Could not refresh saved memories. ${errors.join(' ')}` : failedResyncRef.current.size ? previous : null);
        setShowLatestRefresh(failedResyncRef.current.size > 0);
        if (latest && !errors.length) setFeedRefreshNotice('Showing the newest memories. Load more to browse older history.');
        resyncInterruptionsRef.current = 0;
        void refreshProjects();
        void catalog.refreshLoaded(route.view === 'session' ? '' : currentFilter);
      }
    } finally {
      resyncBusyRef.current = false;
      activeResyncKindsRef.current = [];
      if (pendingResyncRef.current.size) scheduleDataRefresh();
    }
  }
  useLayoutEffect(() => { runResyncRef.current = runDataRefresh; });

  useEffect(() => {
    const onHashChange = () => setRoute(parseViewRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const next = scopeForRoute(route, currentFilter);
    if (next) setFeedScope(prev => (feedScopeKey(prev) === feedScopeKey(next) ? prev : next));
  }, [route, currentFilter]);

  const refreshCatalog = catalog.refresh;
  useEffect(() => {
    if (route.view === 'sessions') void refreshCatalog(currentFilter);
  }, [route.view, currentFilter, refreshCatalog]);

  const matchesScope = useCallback((item: SessionScopedRow & { project: string; merged_into_project?: string | null }) => {
    if (feedScope.session) return sameSession(sessionRefOf(item), feedScope.session);
    return !feedScope.project || rowInProject(item, feedScope.project);
  }, [feedScope]);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const allObservations = useMemo(() => {
    const live = observations.filter(matchesScope);
    const paginated = paginatedObservations.filter(matchesScope);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesScope]);

  const allSummaries = useMemo(() => {
    const live = summaries.filter(matchesScope);
    const paginated = paginatedSummaries.filter(matchesScope);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesScope]);

  const allPrompts = useMemo(() => {
    const live = prompts.filter(matchesScope);
    const paginated = paginatedPrompts.filter(matchesScope);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesScope]);

  const feedItems = useMemo(
    () => buildFeedItems(allObservations, allSummaries, allPrompts),
    [allObservations, allSummaries, allPrompts]
  );

  const visibleSessions = useMemo(() => {
    return catalog.sessions
      .filter(session => !currentFilter || rowInProject(session, currentFilter))
      .sort((a, b) => b.started_at_epoch - a.started_at_epoch);
  }, [catalog.sessions, currentFilter]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  const handleLoadMore = useCallback(async () => {
    // A second visit to the same scope has a new owner, even if its key matches.
    if (activeFeedScopeRef.current.version !== feedVersion) return;
    if (!isConnected && !connectionWaitExpired) return;
    if (failedResyncRef.current.size) {
      resyncPausedRef.current = false;
      resyncInterruptionsRef.current = 0;
      queueDataRefresh({ kinds: [...failedResyncRef.current] });
      return;
    }
    initialReadStartedRef.current = true;
    const requestFeedVersion = feedVersion;
    const contentGeneration = contentGenerationRef.current;
    const deletionVersion = deletionVersionRef.current;
    const isCurrentVisit = () => activeFeedScopeRef.current.version === requestFeedVersion && contentGenerationRef.current === contentGeneration;
    setFeedLoadError(null);
    const retainPageRows = <T extends SessionScopedRow & { id: number }>(rows: T[], itemType: FeedItemType): T[] => {
      return rows.filter(row => {
        if (handledDeletionsRef.current.has(`${itemType}:${row.id}`)) return false;
        const session = sessionRefOf(row);
        if (!session) return true;
        const key = sessionKey(session);
        if ((sessionDeletionVersionsRef.current.get(key) ?? 0) > deletionVersion) return false;
        // A server page started after deletion is authoritative, including a
        // recreation whose live SSE event this tab missed. Keep history for
        // older pending pages while rearming the identity for future deletes.
        handledDeletionsRef.current.delete(`session:${key}`);
        return true;
      });
    };
    try {
      // Each cursor advances independently; commit its rows before a sibling
      // request can reject the group, or successful pages would be skipped.
      await Promise.all([
        pagination.observations.loadMore().then(rows => {
          if (!isCurrentVisit() || !rows.length) return;
          const retained = retainPageRows(rows, 'observation');
          pagination.observations.noteRemoved(rows.length - retained.length);
          setPaginatedObservations(prev => [...prev, ...retained]);
        }),
        pagination.summaries.loadMore().then(rows => {
          if (!isCurrentVisit() || !rows.length) return;
          const retained = retainPageRows(rows, 'summary');
          pagination.summaries.noteRemoved(rows.length - retained.length);
          setPaginatedSummaries(prev => [...prev, ...retained]);
        }),
        pagination.prompts.loadMore().then(rows => {
          if (!isCurrentVisit() || !rows.length) return;
          const retained = retainPageRows(rows, 'prompt');
          pagination.prompts.noteRemoved(rows.length - retained.length);
          setPaginatedPrompts(prev => [...prev, ...retained]);
        })
      ]);
    } catch (error) {
      console.error('Failed to load more data:', error);
      if (isCurrentVisit()) {
        setFeedLoadError(error instanceof Error ? error.message : 'Failed to load more data');
      }
    }
  }, [feedVersion, isConnected, connectionWaitExpired, pagination.observations, pagination.summaries, pagination.prompts]);

  // One removal path for a deleted row, whether this tab deleted it or another
  // tab did (item_deleted SSE, which also reaches this tab): drop it from the
  // live and loaded lists once, and move a loaded page's offset back by one so
  // the next page does not skip a row.
  const loadedRowsRef = useRef({ observation: paginatedObservations, summary: paginatedSummaries, prompt: paginatedPrompts });
  loadedRowsRef.current = { observation: paginatedObservations, summary: paginatedSummaries, prompt: paginatedPrompts };

  function removeDeletedItem(itemType: FeedItemType, id: number): void {
    const key = `${itemType}:${id}`;
    if (handledDeletionsRef.current.has(key)) return;
    handledDeletionsRef.current.add(key);
    itemDeletionVersionsRef.current.set(key, ++deletionVersionRef.current);

    const liveRows = { observation: observations, summary: summaries, prompt: prompts };
    const deletedRow = liveRows[itemType].find(row => row.id === id)
      ?? loadedRowsRef.current[itemType].find(row => row.id === id);
    const deletedSession = deletedRow ? sessionRefOf(deletedRow) : null;
    if (deletedSession) catalog.noteItemRemoved(deletedSession);

    removeLiveItem(itemType, id);
    if (itemType === 'observation') {
      if (removeLoadedRow(loadedRowsRef.current.observation, id).wasLoaded) pagination.observations.noteRemoved();
      setPaginatedObservations(prev => removeLoadedRow(prev, id).rows);
    } else if (itemType === 'summary') {
      if (removeLoadedRow(loadedRowsRef.current.summary, id).wasLoaded) pagination.summaries.noteRemoved();
      setPaginatedSummaries(prev => removeLoadedRow(prev, id).rows);
    } else {
      if (removeLoadedRow(loadedRowsRef.current.prompt, id).wasLoaded) pagination.prompts.noteRemoved();
      setPaginatedPrompts(prev => removeLoadedRow(prev, id).rows);
    }
  }

  // Same single path for a whole deleted session (this tab or session_deleted
  // SSE): drop it from the catalog and every list, rebase each loaded page's
  // offset by the rows it lost, and leave its detail view if it is open.
  function removeDeletedSession(session: SessionRef): void {
    const key = `session:${sessionKey(session)}`;
    if (handledDeletionsRef.current.has(key)) return;
    handledDeletionsRef.current.add(key);
    sessionDeletionVersionsRef.current.set(sessionKey(session), ++deletionVersionRef.current);

    catalog.remove(session);
    removeLiveSession(session);
    const loaded = loadedRowsRef.current;
    const lostObservations = removeSessionRows(loaded.observation, session).removedCount;
    const lostSummaries = removeSessionRows(loaded.summary, session).removedCount;
    const lostPrompts = removeSessionRows(loaded.prompt, session).removedCount;
    if (lostObservations > 0) pagination.observations.noteRemoved(lostObservations);
    if (lostSummaries > 0) pagination.summaries.noteRemoved(lostSummaries);
    if (lostPrompts > 0) pagination.prompts.noteRemoved(lostPrompts);
    setPaginatedObservations(prev => removeSessionRows(prev, session).rows);
    setPaginatedSummaries(prev => removeSessionRows(prev, session).rows);
    setPaginatedPrompts(prev => removeSessionRows(prev, session).rows);

    if (route.view === 'session' && sameSession(route.session, session)) {
      navigate(sessionsHash());
    }
  }

  /** Rejects with a user-facing reason; the card shows it. */
  async function handleDeleteSession(session: SessionRef): Promise<void> {
    const key = sessionKey(session);
    const deletionVersion = sessionDeletionVersionsRef.current.get(key) ?? 0;
    await deleteSession(session);
    // The stream may have already delivered this delete, followed by a new
    // live row recreating the session. Its HTTP acknowledgment must not delete
    // that newer incarnation a second time.
    if ((sessionDeletionVersionsRef.current.get(key) ?? 0) === deletionVersion) {
      removeDeletedSession(session);
    }
  }

  useEffect(() => {
    if (!isConnected && !connectionWaitExpired) return;
    // Run once per committed visit, not again when an outage reconnects.
    if (initialReadStartedRef.current && loadedVisitRef.current === feedVersion) return;
    loadedVisitRef.current = feedVersion;
    contentGenerationRef.current++;
    pendingResyncRef.current.clear(); failedResyncRef.current.clear();
    refreshLatestRef.current = false;
    resyncPausedRef.current = false; resyncInterruptionsRef.current = 0;
    setShowLatestRefresh(false); setFeedRefreshNotice(null);
    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = null;
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedScopeKey(feedScope), isConnected, connectionWaitExpired]);

  const isLoading = (!initialReadStartedRef.current && !isConnected && !connectionWaitExpired)
    || pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading;
  const hasMore = pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore;
  const activeTab: ViewTab = route.view === 'timeline' ? 'timeline' : 'sessions';
  const tabs = (
    <>
      <div className="memory-page-heading">
        <div>
          <p className="memory-eyebrow">Your saved context</p>
          <h2>{route.view === 'timeline' ? 'Memory timeline' : route.view === 'sessions' ? 'Sessions' : 'Session memory'}</h2>
          <p>{route.view === 'timeline'
            ? 'Browse observations, summaries, and prompts from your work.'
            : route.view === 'sessions'
              ? 'Open a session to revisit what happened and what was learned.'
              : 'Review the context captured during this session.'}</p>
          {showLatestRefresh && <button type="button" onClick={() => {
            resyncPausedRef.current = false;
            resyncInterruptionsRef.current = 0;
            refreshLatestRef.current = true;
            queueDataRefresh({});
          }}>Refresh latest memories</button>}
          {feedRefreshNotice && <p role="status">{feedRefreshNotice}</p>}
        </div>
        <ViewTabs
          active={activeTab}
          onSelect={tab => navigate(tab === 'sessions' ? sessionsHash() : '')}
        />
      </div>
    </>
  );

  let content: React.ReactNode;
  if (route.view === 'sessions') {
    content = (
      <SessionList
        header={tabs}
        sessions={visibleSessions}
        isLoading={catalog.isLoading}
        hasMore={catalog.hasMore}
        loadError={catalog.loadError}
        onOpen={session => navigate(sessionHash(session))}
        onDelete={handleDeleteSession}
        onLoadMore={catalog.loadMore}
        onRefreshLatest={catalog.refreshFailed ? () => { void catalog.refresh(currentFilter); } : undefined}
      />
    );
  } else if (route.view === 'session') {
    const catalogEntry = catalog.sessions.find(entry => sameSession(catalogEntryRef(entry), route.session));
    content = (
      <SessionDetailPage
        tabs={tabs}
        session={route.session}
        title={catalogEntry?.custom_title ?? catalogEntry?.project ?? null}
        items={feedItems}
        isLoading={isLoading}
        hasMore={hasMore}
        loadError={feedLoadError}
        onLoadMore={handleLoadMore}
        onDeleted={removeDeletedItem}
        onBack={() => navigate(sessionsHash())}
      />
    );
  } else {
    content = (
      <Feed
        header={tabs}
        items={feedItems}
        onLoadMore={handleLoadMore}
        onDeleted={removeDeletedItem}
        isLoading={isLoading}
        hasMore={hasMore}
        loadError={feedLoadError}
      />
    );
  }

  return (
    <>
      <Header
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        isConnected={isConnected}
        syncStatus={syncStatus}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
        showTeamBrainLink={settingsLoaded && !settings.CLAUDE_MEM_TEAMBRAIN_URL?.trim()}
      />

      {content}

      {!welcomeDismissed && (
        <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />
      )}

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        isLoaded={settingsLoaded}
        loadError={settingsLoadError}
        onRetryLoad={reloadSettings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />

      <button
        className="console-toggle-btn"
        onClick={toggleLogsModal}
        title="Open memory logs"
        aria-label={logsModalOpen ? 'Close memory logs' : 'Open memory logs'}
        aria-expanded={logsModalOpen}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </button>

      <LogsDrawer
        isOpen={logsModalOpen}
        onClose={toggleLogsModal}
      />
    </>
  );
}
