import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { StatusDashboard } from './components/StatusDashboard';
import { Timeline } from './components/Timeline';
import { PlanningBoard } from './components/PlanningBoard';
import { ConflictResolution } from './components/ConflictResolution';
import { PerformanceMetrics } from './components/PerformanceMetrics';
import { ToastContainer, useToasts } from './components/Toast';
import { LiveTerminal } from './components/LiveTerminal';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { useCollaboration } from './hooks/useCollaboration';
import { PromptBar } from './components/PromptBar';
import { ChatView } from './components/ChatView';
import { Observation, Summary, UserPrompt, ViewerTab } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

const TABS: { id: ViewerTab; label: string }[] = [
  { id: 'feed', label: 'Feed' },
  { id: 'chat', label: 'Chat' },
  { id: 'live', label: 'Live' },
  { id: 'status', label: 'Status' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'plans', label: 'Plans' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'metrics', label: 'Metrics' },
];

export function App() {
  const [activeTab, setActiveTab] = useState<ViewerTab>('feed');
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const sseData = useSSE();
  const { observations, summaries, prompts, isProcessing, queueDepth, isConnected,
    tokenEvents, agentErrors, agentActivity, clearErrors } = sseData;
  const [extraProjects, setExtraProjects] = useState<string[]>([]);
  const projects = useMemo(() => {
    const all = [...sseData.projects, ...extraProjects];
    return [...new Set(all)].sort();
  }, [sseData.projects, extraProjects]);

  const handleProjectCreated = useCallback((name: string) => {
    setExtraProjects(prev => prev.includes(name) ? prev : [...prev, name]);
  }, []);

  const handleProjectRenamed = useCallback((oldName: string, newName: string) => {
    setExtraProjects(prev => prev.filter(p => p !== oldName).concat(newName));
  }, []);

  const handleProjectDeleted = useCallback((name: string) => {
    setExtraProjects(prev => prev.filter(p => p !== name));
  }, []);
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats, refreshStats } = useStats();
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter);
  const collab = useCollaboration();
  const { toasts, addToast, dismissToast } = useToasts();

  // Watch for task completion observations from agents (especially codex)
  const prevObsCountRef = useRef(observations.length);
  useEffect(() => {
    if (observations.length > prevObsCountRef.current) {
      const newObs = observations.slice(0, observations.length - prevObsCountRef.current);
      for (const obs of newObs) {
        const title = obs.title || '';
        const isTaskCompletion = obs.type === 'task' && (
          title.toLowerCase().includes('completed') ||
          title.toLowerCase().includes('finished') ||
          title.toLowerCase().includes('done')
        );
        if (isTaskCompletion) {
          addToast(
            `Agent completed task`,
            title,
            'success'
          );
        }
      }
    }
    prevObsCountRef.current = observations.length;
  }, [observations, addToast]);

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
        onProjectCreated={handleProjectCreated}
        onProjectRenamed={handleProjectRenamed}
        onProjectDeleted={handleProjectDeleted}
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
            {tab.id === 'live' && agentErrors.length > 0 && (
              <span className="collab-tab-badge" style={{ background: '#f87171' }}>{agentErrors.length}</span>
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

      {activeTab === 'chat' && (
        <ChatView controls={collab.status?.controls || null} />
      )}

      {activeTab === 'live' && (
        <LiveTerminal
          agentLogs={{}}
          tokenEvents={tokenEvents}
          agentErrors={agentErrors}
          agentActivity={agentActivity}
          onClearErrors={clearErrors}
        />
      )}

      {activeTab === 'status' && (
        <StatusDashboard
          status={collab.status}
          messages={collab.messages}
          isLoading={collab.isLoading}
          error={collab.error}
          onRefresh={collab.refresh}
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

      {activeTab === 'metrics' && (
        <PerformanceMetrics
          stats={stats}
          observations={allObservations}
          status={collab.status}
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

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <PromptBar
        projects={projects}
        agents={collab.status?.controls?.agents ? Object.keys(collab.status.controls.agents) : []}
        onPromptSent={(taskId, agent) => {
          addToast('Prompt dispatched', `Task #${taskId} sent to ${agent}`, 'success');
          collab.refresh();
        }}
      />

      {/* Spacer so content doesn't hide behind fixed prompt bar */}
      <div style={{ height: '130px' }} />
    </>
  );
}
