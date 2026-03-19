import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { StatusDashboard } from './components/StatusDashboard';
import { Timeline } from './components/Timeline';
import { PlanningBoard } from './components/PlanningBoard';
import { ConflictResolution } from './components/ConflictResolution';
import { LiveTerminal } from './components/LiveTerminal';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { useCollaboration } from './hooks/useCollaboration';
import { Observation, Summary, UserPrompt, ViewerTab } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

const TABS: { id: ViewerTab; label: string }[] = [
  { id: 'feed', label: 'Feed' },
  { id: 'live', label: 'Live' },
  { id: 'status', label: 'Status' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'plans', label: 'Plans' },
  { id: 'conflicts', label: 'Conflicts' },
];

export function App() {
  const [activeTab, setActiveTab] = useState<ViewerTab>('feed');
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats, refreshStats } = useStats();
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter);
  const collab = useCollaboration();

  // Merge SSE live data with paginated data, filtering by project when active
  const allObservations = useMemo(() => {
    const live = currentFilter
      ? observations.filter(o => o.project === currentFilter)
      : observations;
    return mergeAndDeduplicateByProject(live, paginatedObservations);
  }, [observations, paginatedObservations, currentFilter]);

  const allSummaries = useMemo(() => {
    const live = currentFilter
      ? summaries.filter(s => s.project === currentFilter)
      : summaries;
    return mergeAndDeduplicateByProject(live, paginatedSummaries);
  }, [summaries, paginatedSummaries, currentFilter]);

  const allPrompts = useMemo(() => {
    const live = currentFilter
      ? prompts.filter(p => p.project === currentFilter)
      : prompts;
    return mergeAndDeduplicateByProject(live, paginatedPrompts);
  }, [prompts, paginatedPrompts, currentFilter]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

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
  }, [currentFilter, pagination.observations, pagination.summaries, pagination.prompts]);

  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter]);

  // Count unread messages for badge
  const unreadCount = collab.status?.unread_messages?.length || 0;
  const conflictCount = collab.status ? collab.status.locks.filter(l => (Date.now() - l.locked_at_epoch) > 8 * 60 * 1000).length : 0;

  return (
    <>
      <Header
        isConnected={isConnected}
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
      />

      {/* Tab Navigation */}
      <div className="collab-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`collab-tab ${activeTab === tab.id ? 'collab-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'status' && unreadCount > 0 && (
              <span className="collab-tab-badge">{unreadCount}</span>
            )}
            {tab.id === 'conflicts' && conflictCount > 0 && (
              <span className="collab-tab-badge collab-tab-badge-warn">{conflictCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'feed' && (
        <Feed
          observations={allObservations}
          summaries={allSummaries}
          prompts={allPrompts}
          onLoadMore={handleLoadMore}
          isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
          hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
        />
      )}

      {activeTab === 'live' && (
        <LiveTerminal agentLogs={{}} />
      )}

      {activeTab === 'status' && (
        <StatusDashboard
          status={collab.status}
          messages={collab.messages}
          isLoading={collab.isLoading}
          error={collab.error}
        />
      )}

      {activeTab === 'timeline' && (
        <Timeline
          observations={allObservations}
          messages={collab.messages}
          plans={collab.plans}
        />
      )}

      {activeTab === 'plans' && (
        <PlanningBoard plans={collab.plans} onPlanCreated={collab.refresh} />
      )}

      {activeTab === 'conflicts' && (
        <ConflictResolution
          observations={allObservations}
          locks={collab.status?.locks || []}
          controls={collab.status?.controls || null}
        />
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
