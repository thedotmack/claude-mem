import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

interface UIState {
  currentFilter: string;
  contextPreviewOpen: boolean;
  logsModalOpen: boolean;
}

interface PaginatedData {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
}

export function App() {
  const [uiState, setUIState] = useState<UIState>({
    currentFilter: '',
    contextPreviewOpen: false,
    logsModalOpen: false,
  });

  const [paginatedData, setPaginatedData] = useState<PaginatedData>({
    observations: [],
    summaries: [],
    prompts: [],
  });

  const { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats, refreshStats } = useStats();
  const { preference, setThemePreference } = useTheme();
  const pagination = usePagination(uiState.currentFilter);

  // Merge live SSE data with paginated data based on filter state
  const mergedData = useMemo(() => {
    const hasFilter = Boolean(uiState.currentFilter);
    const mergeFn = (live: any[], paginated: any[]) => 
      hasFilter ? paginated : mergeAndDeduplicateByProject(live, paginated);
    
    return {
      observations: mergeFn(observations, paginatedData.observations),
      summaries: mergeFn(summaries, paginatedData.summaries),
      prompts: mergeFn(prompts, paginatedData.prompts),
    };
  }, [observations, summaries, prompts, paginatedData, uiState.currentFilter]);

  // Unified modal toggle handler
  const toggleModal = useCallback((modalKey: keyof Pick<UIState, 'contextPreviewOpen' | 'logsModalOpen'>) => {
    setUIState(prev => ({ ...prev, [modalKey]: !prev[modalKey] }));
  }, []);

  // Handle filter changes
  const handleFilterChange = useCallback((filter: string) => {
    setUIState(prev => ({ ...prev, currentFilter: filter }));
  }, []);

  // Load more data with intelligent batching
  const handleLoadMore = useCallback(async () => {
    try {
      const loadPromises = [
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore(),
      ] as const;

      const [newObservations, newSummaries, newPrompts] = await Promise.all(loadPromises);
      
      // Batch update to reduce re-renders
      const updates: Partial<PaginatedData> = {};
      if (newObservations.length > 0) updates.observations = [...paginatedData.observations, ...newObservations];
      if (newSummaries.length > 0) updates.summaries = [...paginatedData.summaries, ...newSummaries];
      if (newPrompts.length > 0) updates.prompts = [...paginatedData.prompts, ...newPrompts];

      if (Object.keys(updates).length > 0) {
        setPaginatedData(prev => ({ ...prev, ...updates }));
      }
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [pagination, paginatedData]);

  // Reset and reload data when filter changes
  useEffect(() => {
    const resetData = { observations: [], summaries: [], prompts: [] };
    setPaginatedData(resetData);
    handleLoadMore();
  }, [uiState.currentFilter, handleLoadMore]);

  // Computed loading and availability states
  const loadingState = {
    isLoading: pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading,
    hasMore: pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore,
  };

  return (
    <>
      <Header
        isConnected={isConnected}
        projects={projects}
        currentFilter={uiState.currentFilter}
        onFilterChange={handleFilterChange}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={() => toggleModal('contextPreviewOpen')}
      />

      <Feed
        observations={mergedData.observations}
        summaries={mergedData.summaries}
        prompts={mergedData.prompts}
        onLoadMore={handleLoadMore}
        isLoading={loadingState.isLoading}
        hasMore={loadingState.hasMore}
      />

      <ContextSettingsModal
        isOpen={uiState.contextPreviewOpen}
        onClose={() => toggleModal('contextPreviewOpen')}
        settings={settings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />

      <button
        className="console-toggle-btn"
        onClick={() => toggleModal('logsModalOpen')}
        title="Toggle Console"
        aria-label="Toggle Console"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
      </button>

      <LogsDrawer
        isOpen={uiState.logsModalOpen}
        onClose={() => toggleModal('logsModalOpen')}
      />
    </>
  );
}
