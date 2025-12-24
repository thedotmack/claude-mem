import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { GraphPanel } from './components/GraphPanel';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useSearch } from './hooks/useSearch';
import { useTheme } from './hooks/useTheme';
import { Observation, Summary, UserPrompt, OBSERVATION_TYPES } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

type ViewMode = 'feed' | 'graph';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('feed');
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  // Type filter state - default to all types selected
  const [selectedTypes, setSelectedTypes] = useState<string[]>([...OBSERVATION_TYPES]);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');

  const { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected } = useSSE();
  const { results: searchResults, isLoading: isSearching, isSearchActive } = useSearch(
    searchQuery,
    currentFilter || undefined,
    selectedTypes
  );
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats, refreshStats } = useStats();
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter, selectedTypes);

  // Toggle a single type in the filter
  const handleTypeToggle = useCallback((type: string) => {
    setSelectedTypes(prev => {
      if (prev.includes(type)) {
        // Remove type (but don't allow empty selection)
        const newTypes = prev.filter(t => t !== type);
        return newTypes.length > 0 ? newTypes : prev;
      } else {
        // Add type
        return [...prev, type];
      }
    });
  }, []);

  // Select all types
  const handleSelectAllTypes = useCallback(() => {
    setSelectedTypes([...OBSERVATION_TYPES]);
  }, []);

  // Deselect all types (select only one to prevent empty)
  const handleDeselectAllTypes = useCallback(() => {
    setSelectedTypes([OBSERVATION_TYPES[0]]);
  }, []);

  // When searching: use search results
  // When filtering by project or type: ONLY use paginated data (API-filtered)
  // When showing all projects/types: merge SSE live data with paginated data
  const allObservations = useMemo(() => {
    // Search mode: return search results
    if (isSearchActive && searchResults) {
      return searchResults.observations;
    }

    const hasTypeFilter = selectedTypes.length < OBSERVATION_TYPES.length;

    if (currentFilter || hasTypeFilter) {
      // Filter active: API handles filtering, ignore SSE items
      // But also filter SSE observations by type for live updates
      if (hasTypeFilter) {
        const filteredSSE = observations.filter(obs => selectedTypes.includes(obs.type));
        return mergeAndDeduplicateByProject(filteredSSE, paginatedObservations);
      }
      return paginatedObservations;
    }
    // No filter: merge SSE + paginated, deduplicate by ID
    return mergeAndDeduplicateByProject(observations, paginatedObservations);
  }, [observations, paginatedObservations, currentFilter, selectedTypes, isSearchActive, searchResults]);

  const allSummaries = useMemo(() => {
    // Search mode: return search results (currently empty since we focus on observations)
    if (isSearchActive && searchResults) {
      return searchResults.sessions;
    }
    if (currentFilter) {
      return paginatedSummaries;
    }
    return mergeAndDeduplicateByProject(summaries, paginatedSummaries);
  }, [summaries, paginatedSummaries, currentFilter, isSearchActive, searchResults]);

  const allPrompts = useMemo(() => {
    // Search mode: return search results (currently empty since we focus on observations)
    if (isSearchActive && searchResults) {
      return searchResults.prompts;
    }
    if (currentFilter) {
      return paginatedPrompts;
    }
    return mergeAndDeduplicateByProject(prompts, paginatedPrompts);
  }, [prompts, paginatedPrompts, currentFilter, isSearchActive, searchResults]);

  // Toggle context preview modal
  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  // Toggle view mode between feed and graph
  const toggleViewMode = useCallback(() => {
    setViewMode(prev => prev === 'feed' ? 'graph' : 'feed');
  }, []);

  // Handle loading more data
  const handleLoadMore = useCallback(async () => {
    try {
      const [newObservations, newSummaries, newPrompts] = await Promise.all([
        pagination.observations.loadMore(),
        pagination.summaries.loadMore(),
        pagination.prompts.loadMore()
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
    } catch (error) {
      console.error('Failed to load more data:', error);
    }
  }, [currentFilter, selectedTypes, pagination.observations, pagination.summaries, pagination.prompts]);

  // Reset paginated data and load first page when filter changes
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter, selectedTypes]);

  return (
    <div className="app-container">
      <div className="main-content">
        <Header
          isConnected={isConnected}
          projects={projects}
          currentFilter={currentFilter}
          onFilterChange={setCurrentFilter}
          selectedTypes={selectedTypes}
          onTypeToggle={handleTypeToggle}
          onSelectAllTypes={handleSelectAllTypes}
          onDeselectAllTypes={handleDeselectAllTypes}
          isProcessing={isProcessing}
          queueDepth={queueDepth}
          themePreference={preference}
          onThemeChange={setThemePreference}
          onContextPreviewToggle={toggleContextPreview}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          isSearching={isSearching}
          viewMode={viewMode}
          onViewModeToggle={toggleViewMode}
        />

        {viewMode === 'feed' ? (
          <Feed
            observations={allObservations}
            summaries={allSummaries}
            prompts={allPrompts}
            onLoadMore={handleLoadMore}
            isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
            hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
            isSearchMode={isSearchActive}
            searchQuery={searchQuery}
            searchTotal={searchResults?.total}
          />
        ) : (
          <GraphPanel
            project={currentFilter || undefined}
          />
        )}
      </div>

      <ContextSettingsModal
        isOpen={contextPreviewOpen}
        onClose={toggleContextPreview}
        settings={settings}
        onSave={saveSettings}
        isSaving={isSaving}
        saveStatus={saveStatus}
      />
    </div>
  );
}
