import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { useHealth } from './hooks/useHealth';
import { useClients } from './hooks/useClients';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { Observation, Summary, UserPrompt, TrackedClient } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [currentSource, setCurrentSource] = useState('all');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);
  const [remoteAccessBlocked, setRemoteAccessBlocked] = useState(false);

  // Detect remote access without proxy (API returns 401)
  useEffect(() => {
    const isRemote = !['localhost', '127.0.0.1', '[::1]'].some(h => window.location.hostname.includes(h));
    if (isRemote) {
      fetch('/api/health').then(r => {
        if (r.status === 401) setRemoteAccessBlocked(true);
      }).catch(() => setRemoteAccessBlocked(true));
    }
  }, []);

  const { observations, summaries, prompts, projects, sources, projectsBySource, isProcessing, queueDepth, isConnected, onClientEvent } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats, refreshStats } = useStats();
  const { health } = useHealth();
  const { clients, activeCount, totalCount, handleClientSSE, sseHandlerRegistered } = useClients(health.mode);
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter, currentSource);

  const availableProjects = useMemo(() => {
    if (currentSource === 'all') {
      return projects;
    }

    return projectsBySource[currentSource] || [];
  }, [currentSource, projects, projectsBySource]);

  const matchesSelection = useCallback((item: { project: string; platform_source: string }) => {
    const matchesProject = !currentFilter || item.project === currentFilter;
    const matchesSource = currentSource === 'all' || (item.platform_source || 'claude') === currentSource;
    return matchesProject && matchesSource;
  }, [currentFilter, currentSource]);

  useEffect(() => {
    if (currentFilter && !availableProjects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [availableProjects, currentFilter]);

  // Wire SSE client events to useClients handler (once)
  useEffect(() => {
    if (!sseHandlerRegistered.current) {
      onClientEvent(handleClientSSE);
      sseHandlerRegistered.current = true;
    }
  }, [onClientEvent, handleClientSSE, sseHandlerRegistered]);

  // Merge SSE live data with paginated data, filtering by project when active
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

  // Toggle context preview modal
  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  // Toggle logs modal
  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
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
  }, [pagination.observations, pagination.summaries, pagination.prompts]);

  // Reset paginated data and load first page when project/source changes
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter, currentSource]);

  if (remoteAccessBlocked) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        minHeight: '60vh', padding: '40px', textAlign: 'center', color: 'var(--color-text-primary)'
      }}>
        <h2 style={{ marginBottom: '16px' }}>Remote access requires a local proxy</h2>
        <p style={{ marginBottom: '24px', color: 'var(--color-text-secondary)', maxWidth: '500px' }}>
          This server requires authentication for API access. Use the local proxy on your machine instead of connecting directly.
        </p>
        <a
          href="http://localhost:37777"
          style={{
            padding: '10px 24px', borderRadius: '6px',
            background: 'var(--color-bg-button)', color: '#fff', textDecoration: 'none',
            fontWeight: 600
          }}
        >
          Open via local proxy (localhost:37777)
        </a>
        <p style={{ marginTop: '16px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
          If the proxy isn't running: <code>bun ~/.claude/plugins/cache/thedotmack/claude-mem/.../scripts/proxy-service.cjs</code>
        </p>
      </div>
    );
  }

  return (
    <>
      <Header
        isConnected={isConnected}
        projects={availableProjects}
        sources={sources}
        currentFilter={currentFilter}
        currentSource={currentSource}
        onFilterChange={setCurrentFilter}
        onSourceChange={setCurrentSource}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        version={stats.worker?.version}
        mode={health.mode}
        activeClients={activeCount}
        totalClients={totalCount}
        health={health}
        clients={clients}
        authToken={settings.CLAUDE_MEM_AUTH_TOKEN}
      />

      <Feed
        observations={allObservations}
        summaries={allSummaries}
        prompts={allPrompts}
        onLoadMore={handleLoadMore}
        isLoading={pagination.observations.isLoading || pagination.summaries.isLoading || pagination.prompts.isLoading}
        hasMore={pagination.observations.hasMore || pagination.summaries.hasMore || pagination.prompts.hasMore}
      />

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
