import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { Sidebar } from './components/Sidebar';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { Observation, Summary } from './types';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);

  const { observations, summaries, prompts, projects, processingSessions, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats } = useStats();
  const { isLoading, hasMore, loadMore } = usePagination();

  // Merge real-time observations with paginated ones, removing duplicates
  const allObservations = useMemo(() => {
    const seen = new Set<number>();
    return [...observations, ...paginatedObservations].filter(obs => {
      if (seen.has(obs.id)) return false;
      seen.add(obs.id);
      return true;
    });
  }, [observations, paginatedObservations]);

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  // Handle loading more observations
  const handleLoadMore = useCallback(async () => {
    try {
      const newObservations = await loadMore();
      if (newObservations.length > 0) {
        setPaginatedObservations(prev => [...prev, ...newObservations]);
      }
    } catch (error) {
      console.error('Failed to load more observations:', error);
    }
  }, [loadMore]);

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
          summaries={summaries}
          prompts={prompts}
          processingSessions={processingSessions}
          currentFilter={currentFilter}
          onLoadMore={handleLoadMore}
          isLoading={isLoading}
          hasMore={hasMore}
        />
      </div>

      <Sidebar
        isOpen={sidebarOpen}
        settings={settings}
        stats={stats}
        isSaving={isSaving}
        saveStatus={saveStatus}
        onSave={saveSettings}
        onClose={toggleSidebar}
      />
    </div>
  );
}
