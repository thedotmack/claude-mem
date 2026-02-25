import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { TwoPanel } from './components/TwoPanel';
import type { TwoPanelHandle } from './components/TwoPanel';
import { SearchResultsBadge } from './components/SearchResultsBadge';
import { CommandPalette } from './components/CommandPalette';
import { KeyboardShortcutHelp } from './components/KeyboardShortcutHelp';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { useKeyboardNavigation } from './hooks/useKeyboardNavigation';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { useFilters } from './hooks/useFilters';
import { useSearch } from './hooks/useSearch';
import { useActivityDensity } from './hooks/useActivityDensity';
import type { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';
import { logger } from './utils/logger';
import { API_ENDPOINTS } from './constants/api';

// ---------------------------------------------------------------------------
// Pure utility (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Detects the active (unsummarized) session from SSE observations.
 *
 * Scans ALL observations — not just the first — so SSE reconnects and
 * observation reorders don't break detection.  Uses a Set for O(1) summary
 * lookups.
 *
 * Compares against `memory_session_id` (the plugin's session ID) since
 * observations use `memory_session_id` while summaries may return
 * `session_id` as the Claude Code `content_session_id`.
 *
 * @returns The memory_session_id of the first unsummarized observation, or null.
 */
export function detectActiveSessionId(
  observations: Observation[],
  summaries: Summary[],
): string | null {
  if (observations.length === 0) return null;
  // Build a set of memory_session_ids that have summaries.
  // Use memory_session_id when available (matches observations), fall back to session_id.
  const summarizedIds = new Set(summaries.map(s => s.memory_session_id ?? s.session_id));
  for (const obs of observations) {
    if (!summarizedIds.has(obs.memory_session_id)) return obs.memory_session_id;
  }
  return null;
}

export function App() {
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [filterPaletteOpen, setFilterPaletteOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const {
    filters, setQuery, setProject, toggleObsType, toggleConcept,
    toggleItemKind, setDateRange, clearAll,
    hasActiveFilters, isFilterMode, activeFilterCount
  } = useFilters();

  const search = useSearch(filters, isFilterMode);
  const activityDensity = useActivityDensity(filters.project);

  const { observations, summaries, prompts, projects, setProjects, isProcessing, queueDepth, initialActiveSession } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats } = useStats();
  const { preference, setThemePreference } = useTheme();
  const [paginationResetKey, setPaginationResetKey] = useState(0);
  const pagination = usePagination(filters.project, paginationResetKey);

  // When in filter/search mode: use search results
  // When project only: use paginated data (API-filtered)
  // When no filter: merge SSE + paginated
  const allObservations = useMemo(() => {
    if (isFilterMode) {
      return search.results?.observations ?? [];
    }
    if (filters.project) {
      return paginatedObservations;
    }
    return mergeAndDeduplicateByProject(observations, paginatedObservations);
  }, [isFilterMode, search.results, filters.project, observations, paginatedObservations]);

  const allSummaries = useMemo(() => {
    if (isFilterMode) {
      return search.results?.sessions ?? [];
    }
    if (filters.project) {
      return paginatedSummaries;
    }
    return mergeAndDeduplicateByProject(summaries, paginatedSummaries);
  }, [isFilterMode, search.results, filters.project, summaries, paginatedSummaries]);

  const allPrompts = useMemo(() => {
    if (isFilterMode) {
      return search.results?.prompts ?? [];
    }
    if (filters.project) {
      return paginatedPrompts;
    }
    return mergeAndDeduplicateByProject(prompts, paginatedPrompts);
  }, [isFilterMode, search.results, filters.project, prompts, paginatedPrompts]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleFilterPalette = useCallback(() => {
    setFilterPaletteOpen(prev => !prev);
  }, []);

  const closePalette = useCallback(() => {
    setFilterPaletteOpen(false);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  const handleProjectsChanged = useCallback(async () => {
    try {
      const res = await fetch(API_ENDPOINTS.PROJECTS_BASE);
      if (res.ok) {
        const data = await res.json() as { projects?: string[] };
        setProjects(data.projects ?? []);
      }
    } catch {
      logger.error('app', 'Failed to refresh projects list');
    }
  }, [setProjects]);

  const twoPanelRef = useRef<TwoPanelHandle>(null);

  const focusSearch = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('.search-bar-input');
    input?.focus();
  }, []);

  const handleNextSession = useCallback(() => {
    twoPanelRef.current?.navigateNext();
  }, []);

  const handlePrevSession = useCallback(() => {
    twoPanelRef.current?.navigatePrev();
  }, []);

  const handleDayNavigate = useCallback((direction: 'prev' | 'next') => {
    twoPanelRef.current?.navigateDay(direction);
  }, []);

  const { showHelp, setShowHelp } = useKeyboardNavigation({
    onNextSession: handleNextSession,
    onPrevSession: handlePrevSession,
    onFocusSearch: focusSearch,
    onTogglePalette: toggleFilterPalette,
    isPaletteOpen: filterPaletteOpen,
    onClosePalette: closePalette,
    onClearSearch: clearAll,
    hasSearchContent: filters.query.length > 0,
    onDayNavigate: handleDayNavigate,
  });

  const handleLoadMore = useCallback(async () => {
    if (isFilterMode) {
      await search.loadMore();
      return;
    }

    try {
      const [newObservations, newSummaries, newPrompts] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore()
      ]);

      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations as Observation[]]);
      }
      if (newSummaries.length > 0) {
        setPaginatedSummaries(prev => [...prev, ...newSummaries as Summary[]]);
      }
      if (newPrompts.length > 0) {
        setPaginatedPrompts(prev => [...prev, ...newPrompts as UserPrompt[]]);
      }
    } catch (_error) {
      logger.error('app', 'Failed to load more data');
    }
  }, [isFilterMode, search, pagination.observations, pagination.summaries, pagination.prompts]);

  // Clear stale paginated data immediately on any mode/project transition.
  // useLayoutEffect runs synchronously before paint, preventing a flash of stale items.
  useLayoutEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    if (!isFilterMode) {
      // Force pagination offset reset by changing the key
      setPaginationResetKey(k => k + 1);
    }
  }, [isFilterMode, filters.project]);

  // Load fresh data after pagination has been reset (driven by resetKey changes)
  useEffect(() => {
    if (isFilterMode) return;
    void handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleLoadMore excluded: loads are driven by paginationResetKey changes only
  }, [paginationResetKey, isFilterMode]);

  // Track new SSE summaries for live updates in TwoPanel.
  // Skip the initial_load batch; only react to subsequent new_summary events.
  const sseInitialLoadRef = useRef(true);
  const [latestSSESummary, setLatestSSESummary] = useState<Summary | null>(null);

  useEffect(() => {
    if (summaries.length === 0) return;
    if (sseInitialLoadRef.current) {
      sseInitialLoadRef.current = false;
      return;
    }
    setLatestSSESummary(summaries[0]);
  }, [summaries]);

  // Detect active session: SSE observations without a matching summary,
  // falling back to the initial_load activeSession info for page refresh persistence
  const activeSessionId = useMemo(() => {
    const fromSSE = detectActiveSessionId(observations, summaries);
    if (fromSSE) return fromSSE;
    // Fallback: use active session from initial_load (persists across refresh)
    return initialActiveSession?.memorySessionId ?? null;
  }, [observations, summaries, initialActiveSession]);

  const activeSessionObsCount = useMemo(() => {
    if (!activeSessionId) return 0;
    // Count from SSE observations first
    const sseCount = observations.filter(o => o.memory_session_id === activeSessionId).length;
    if (sseCount > 0) return sseCount;
    // Fallback: use count from initial_load
    if (initialActiveSession?.memorySessionId === activeSessionId) {
      return initialActiveSession.observationCount;
    }
    return 0;
  }, [activeSessionId, observations, initialActiveSession]);

  const isLoading = isFilterMode
    ? search.isSearching
    : (pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading);

  const hasMore = isFilterMode
    ? search.hasMore
    : (pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore);

  return (
    <>
      <Header
        projects={projects}
        currentFilter={filters.project}
        onFilterChange={setProject}
        onProjectsChanged={() => { void handleProjectsChanged(); }}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        onContextPreviewToggle={toggleContextPreview}
        query={filters.query}
        onQueryChange={setQuery}
        isSearching={search.isSearching}
        resultCount={isFilterMode ? `${String(search.totalResults)}${search.hasMore ? '+' : ''}` : null}
        filterCount={activeFilterCount}
        onFilterToggle={toggleFilterPalette}
        version={stats.worker?.version}
        project={filters.project}
      />

      <SearchResultsBadge
        totalResults={search.totalResults}
        query={filters.query}
        hasActiveFilters={isFilterMode}
        hasMore={search.hasMore}
        onClear={clearAll}
      />

      {isFilterMode ? (
        <Feed
          observations={allObservations}
          summaries={allSummaries}
          prompts={allPrompts}
          onLoadMore={() => { void handleLoadMore(); }}
          isLoading={isLoading}
          hasMore={hasMore}
        />
      ) : (
        <TwoPanel
          ref={twoPanelRef}
          project={filters.project}
          newSummary={latestSSESummary}
          activityDays={activityDensity.days}
          activityLoading={activityDensity.isLoading}
          dateStart={filters.dateStart}
          dateEnd={filters.dateEnd}
          onDateRangeSelect={setDateRange}
          activeSessionId={activeSessionId}
          activeSessionObsCount={activeSessionObsCount}
        />
      )}

      <CommandPalette
        isOpen={filterPaletteOpen}
        onClose={closePalette}
        filters={filters}
        onQueryChange={setQuery}
        onToggleObsType={toggleObsType}
        onToggleConcept={toggleConcept}
        onToggleItemKind={toggleItemKind}
        onDateRangeChange={setDateRange}
        onClearAll={clearAll}
        hasActiveFilters={hasActiveFilters}
        isSearching={search.isSearching}
      />

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        onSave={(s) => { void saveSettings(s); }}
        isSaving={isSaving}
        saveStatus={saveStatus}
        themePreference={preference}
        onThemeChange={setThemePreference}
      />

      <button
        className="console-toggle-btn"
        onClick={toggleLogsModal}
        title="Toggle Console"
        aria-label="Toggle Console"
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

      <KeyboardShortcutHelp
        isOpen={showHelp}
        onClose={() => { setShowHelp(false); }}
      />
    </>
  );
}
