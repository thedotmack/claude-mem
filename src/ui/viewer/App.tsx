import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { Observation, Summary, UserPrompt, FeedItemType } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

const DELETE_ENDPOINTS: Record<FeedItemType, string> = {
  observation: '/api/observation',
  summary: '/api/summary',
  prompt: '/api/prompt',
};

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);
  const [paginatedAdvisorCalls, setPaginatedAdvisorCalls] = useState<AdvisorCall[]>([]);

  const { observations, summaries, prompts, advisorCalls, projects, isProcessing, queueDepth } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();
  const { t, locale } = useI18n();
  const pagination = usePagination(currentFilter);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const matchesSelection = useCallback((item: { project: string }) => {
    return !currentFilter || item.project === currentFilter;
  }, [currentFilter]);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const allObservations = useMemo(() => {
    const live = observations.filter(matchesSelection);
    const paginated = paginatedObservations.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [observations, paginatedObservations, matchesSelection]);

  const allSummaries = useMemo(() => {
    const live = summaries.filter(matchesSelection);
    const paginated = paginatedSummaries.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [summaries, paginatedSummaries, matchesSelection]);

  const allPrompts = useMemo(() => {
    const live = prompts.filter(matchesSelection);
    const paginated = paginatedPrompts.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [prompts, paginatedPrompts, matchesSelection]);

  const allAdvisorCalls = useMemo(() => {
    const live = advisorCalls.filter(matchesSelection);
    const paginated = paginatedAdvisorCalls.filter(matchesSelection);
    return mergeAndDeduplicateByProject(live, paginated);
  }, [advisorCalls, paginatedAdvisorCalls, matchesSelection]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  const handleLoadMore = useCallback(async () => {
    try {
      const [newObservations, newSummaries, newPrompts, newAdvisorCalls] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore(),
        pagination.advisorCalls.loadMore()
      ]);

      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations]);
      }
      if (newSummaries.length > 0) {
        setPaginatedSummaries(prev => [...prev, ...newSummaries]);
      }
      if (newPrompts.length > 0) {
        setPaginatedPrompts(prev => [...prev, ...newPrompts]);
      }
      if (newAdvisorCalls.length > 0) {
        setPaginatedAdvisorCalls(prev => [...prev, ...newAdvisorCalls]);
      }
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [pagination.observations, pagination.summaries, pagination.prompts, pagination.advisorCalls]);

  // Delete a feed item: call the worker, then drop it from local paginated
  // state. The worker also broadcasts an `item_deleted` SSE event, which clears
  // the live copy here and in any other open viewer tab.
  const handleDelete = useCallback(async (itemType: FeedItemType, id: number) => {
    try {
      const response = await fetch(`${DELETE_ENDPOINTS[itemType]}/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`);
      }

      if (itemType === 'observation') {
        setPaginatedObservations(prev => prev.filter(o => o.id !== id));
      } else if (itemType === 'summary') {
        setPaginatedSummaries(prev => prev.filter(s => s.id !== id));
      } else {
        setPaginatedPrompts(prev => prev.filter(p => p.id !== id));
      }

      refreshStats();
    } catch (error) {
      console.error('Failed to delete item:', error);
    }
  }, [refreshStats]);

  // Reset paginated data and load first page when filter changes
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    setPaginatedAdvisorCalls([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter]);

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

      <Feed
        observations={allObservations}
        summaries={allSummaries}
        prompts={allPrompts}
        advisorCalls={allAdvisorCalls}
        onLoadMore={handleLoadMore}
        onDelete={handleDelete}
        isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
        hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
      />

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
        title={t('header.toggleConsole')}
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
