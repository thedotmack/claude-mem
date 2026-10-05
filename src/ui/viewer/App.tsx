import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ViewTabs, type ViewTab } from './components/ViewTabs';
import { SessionList } from './components/SessionList';
import { SessionDetailPage } from './components/SessionDetailPage';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { useSSE } from './hooks/useSSE';
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
  const [route, setRoute] = useState<ViewRoute>(() => parseViewRoute(window.location.hash));
  // The Sessions list keeps the last timeline/session scope, so switching back
  // does not reload pages that are still correct.
  const [feedScope, setFeedScope] = useState<FeedScope>(
    () => scopeForRoute(route, currentFilter) ?? { project: currentFilter, session: null }
  );
  const scopeKey = feedScopeKey(feedScope);
  const activeFeedScopeRef = useRef({ key: scopeKey, version: 0 });
  if (activeFeedScopeRef.current.key !== scopeKey) {
    activeFeedScopeRef.current = { key: scopeKey, version: activeFeedScopeRef.current.version + 1 };
  }

  const feedVersion = activeFeedScopeRef.current.version;

  const catalog = useSessionCatalog();
  const { observations, summaries, prompts, projects, isProcessing, queueDepth, removeLiveItem, removeLiveSession } = useSSE({
    onItemDeleted: removeDeletedItem,
    onSessionDeleted: removeDeletedSession,
    onLiveItem: catalog.touch,
  });
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();
  const pagination = usePagination(feedScope.project, feedScope.session);

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

  const matchesScope = useCallback((item: SessionScopedRow & { project: string }) => {
    if (feedScope.session) return sameSession(sessionRefOf(item), feedScope.session);
    return !feedScope.project || item.project === feedScope.project;
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
      .filter(session => !currentFilter || session.project === currentFilter)
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
    const requestFeedVersion = feedVersion;
    const isCurrentVisit = () => activeFeedScopeRef.current.version === requestFeedVersion;
    setFeedLoadError(null);
    try {
      // Each cursor advances independently; commit its rows before a sibling
      // request can reject the group, or successful pages would be skipped.
      await Promise.all([
        pagination.observations.loadMore().then(rows => {
          if (isCurrentVisit() && rows.length) setPaginatedObservations(prev => [...prev, ...rows]);
        }),
        pagination.summaries.loadMore().then(rows => {
          if (isCurrentVisit() && rows.length) setPaginatedSummaries(prev => [...prev, ...rows]);
        }),
        pagination.prompts.loadMore().then(rows => {
          if (isCurrentVisit() && rows.length) setPaginatedPrompts(prev => [...prev, ...rows]);
        })
      ]);
    } catch (error) {
      console.error('Failed to load more data:', error);
      if (isCurrentVisit()) {
        setFeedLoadError(error instanceof Error ? error.message : 'Failed to load more data');
      }
    }
  }, [feedVersion, pagination.observations, pagination.summaries, pagination.prompts]);

  // One removal path for a deleted row, whether this tab deleted it or another
  // tab did (item_deleted SSE, which also reaches this tab): drop it from the
  // live and loaded lists once, and move a loaded page's offset back by one so
  // the next page does not skip a row.
  const handledDeletionsRef = useRef(new Set<string>());
  const loadedRowsRef = useRef({ observation: paginatedObservations, summary: paginatedSummaries, prompt: paginatedPrompts });
  loadedRowsRef.current = { observation: paginatedObservations, summary: paginatedSummaries, prompt: paginatedPrompts };

  function removeDeletedItem(itemType: FeedItemType, id: number): void {
    const key = `${itemType}:${id}`;
    if (handledDeletionsRef.current.has(key)) return;
    handledDeletionsRef.current.add(key);

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
    await deleteSession(session);
    removeDeletedSession(session);
  }

  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedScopeKey(feedScope)]);

  const isLoading = pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading;
  const hasMore = pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore;
  const activeTab: ViewTab = route.view === 'timeline' ? 'timeline' : 'sessions';
  const tabs = (
    <ViewTabs
      active={activeTab}
      onSelect={tab => navigate(tab === 'sessions' ? sessionsHash() : '')}
    />
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
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
      />

      {content}

      {!welcomeDismissed && (
        <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />
      )}

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />

      <button
        className="console-toggle-btn"
        onClick={toggleLogsModal}
        title="Toggle Console"
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
