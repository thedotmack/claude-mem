import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { Sidebar } from './components/Sidebar';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, processingSessions, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats } = useStats();
  const pagination = usePagination(currentFilter);

  // Reset paginated data when filter changes
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
  }, [currentFilter]);

  // Merge real-time data with paginated data, removing duplicates and filtering by project
  const allObservations = useMemo(
    () => mergeAndDeduplicateByProject(observations, paginatedObservations, currentFilter),
    [observations, paginatedObservations, currentFilter]
  );

  const allSummaries = useMemo(
    () => mergeAndDeduplicateByProject(summaries, paginatedSummaries, currentFilter),
    [summaries, paginatedSummaries, currentFilter]
  );

  const allPrompts = useMemo(
    () => mergeAndDeduplicateByProject(prompts, paginatedPrompts, currentFilter),
    [prompts, paginatedPrompts, currentFilter]
  );

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
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
  }, [pagination]);

  // Load first page when filter changes or pagination handlers update
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
          isProcessing={processingSessions.size > 0}
        />
        <Feed
          observations={allObservations}
          summaries={allSummaries}
          prompts={allPrompts}
          processingSessions={processingSessions}
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
