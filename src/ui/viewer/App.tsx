import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { Sidebar } from './components/Sidebar';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { Observation, Summary } from './types';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { observations, summaries, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats } = useStats();

  // Get unique projects from observations
  const projects = Array.from(new Set(observations.map(o => o.project)));

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

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
        />
        <Feed
          observations={observations}
          summaries={summaries}
          currentFilter={currentFilter}
        />
      </div>

      <Sidebar
        isOpen={sidebarOpen}
        settings={settings}
        stats={stats}
        isSaving={isSaving}
        saveStatus={saveStatus}
        onSave={saveSettings}
      />
    </div>
  );
}
