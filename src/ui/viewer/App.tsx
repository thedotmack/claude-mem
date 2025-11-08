import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { Sidebar } from './components/Sidebar';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, isProcessing, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats } = useStats();
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter);

  // Track the last filter to detect changes in handleLoadMore
  const lastFilterRef = useRef(currentFilter);

  // When filtering by project: ONLY use paginated data (API-filtered)
  // When showing all projects: merge SSE live data with paginated data
  const allObservations = useMemo(() => {
    if (currentFilter) {
      // Project filter active: API handles filtering, ignore SSE items
      return paginatedObservations;
    }
    // No filter: merge SSE + paginated, deduplicate by ID
    return mergeAndDeduplicateByProject(observations, paginatedObservations, '');
  }, [observations, paginatedObservations, currentFilter]);

  const allSummaries = useMemo(() => {
    if (currentFilter) {
      return paginatedSummaries;
    }
    return mergeAndDeduplicateByProject(summaries, paginatedSummaries, '');
  }, [summaries, paginatedSummaries, currentFilter]);

  const allPrompts = useMemo(() => {
    if (currentFilter) {
      return paginatedPrompts;
    }
    return mergeAndDeduplicateByProject(prompts, paginatedPrompts, '');
  }, [prompts, paginatedPrompts, currentFilter]);

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  // Handle loading more data
  const handleLoadMore = useCallback(async () => {
    // If filter changed, reset paginated data synchronously before loading
    if (lastFilterRef.current !== currentFilter) {
      lastFilterRef.current = currentFilter;
      setPaginatedObservations([]);
      setPaginatedSummaries([]);
      setPaginatedPrompts([]);
    }

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
  }, [currentFilter, pagination.observations, pagination.summaries, pagination.prompts]);

  // Load first page when filter changes
  useEffect(() => {
    handleLoadMore();
  }, [currentFilter, handleLoadMore]);

  return (
    <div className="container">
      <div className="main-col">
        <Header
          isConnected={isConnected}
          projects={projects}
          currentFilter={currentFilter}
          onFilterChange={setCurrentFilter}
          onSettingsToggle={toggleSidebar}
          sidebarOpen={sidebarOpen}
          isProcessing={isProcessing}
          themePreference={preference}
          onThemeChange={setThemePreference}
        />
        <Feed
          observations={allObservations}
          summaries={allSummaries}
          prompts={allPrompts}
          onLoadMore={handleLoadMore}
          isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
          hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
        />
      </div>

      <Sidebar
        isOpen={sidebarOpen}
        settings={settings}
        stats={stats}
        isSaving={isSaving}
        saveStatus={saveStatus}
        isConnected={isConnected}
        onSave={saveSettings}
        onClose={toggleSidebar}
      />
    </div>
  );
}
