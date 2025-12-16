import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Header } from './components/Header';
import { Feed } from './components/Feed';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { QueueDrawer } from './components/QueueDrawer';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useStats } from './hooks/useStats';
import { usePagination } from './hooks/usePagination';
import { useTheme } from './hooks/useTheme';
import { useQueue } from './hooks/useQueue';
import { useNotifications } from './hooks/useNotifications';
import { Observation, Summary, UserPrompt } from './types';
import { mergeAndDeduplicateByProject } from './utils/data';

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [paginatedObservations, setPaginatedObservations] = useState<Observation[]>([]);
  const [paginatedSummaries, setPaginatedSummaries] = useState<Summary[]>([]);
  const [paginatedPrompts, setPaginatedPrompts] = useState<UserPrompt[]>([]);

  const { observations, summaries, prompts, projects, isProcessing, queueDepth, queueMessages, recentlyProcessed, stuckCount, isConnected } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { stats, refreshStats } = useStats();
  const { preference, resolvedTheme, setThemePreference } = useTheme();
  const pagination = usePagination(currentFilter);
  const { retryMessage, abortMessage, retryAllStuck, forceRestartSession, recoverSession } = useQueue();
  const { notifyStuck, enabled: notificationsEnabled, setEnabled: setNotificationsEnabled, permission: notificationPermission } = useNotifications();

  // Notify about stuck messages
  const prevStuckCountRef = useRef(0);
  useEffect(() => {
    if (stuckCount > prevStuckCountRef.current && notificationsEnabled) {
      // Find first stuck message for notification
      const stuckMessage = queueMessages.find(m => m.isStuck);
      if (stuckMessage) {
        const duration = stuckMessage.started_processing_at_epoch
          ? `${Math.floor((Date.now() - stuckMessage.started_processing_at_epoch) / 60000)} minutes`
          : 'unknown';
        notifyStuck(stuckMessage.tool_name || 'summarize', duration);
      }
    }
    prevStuckCountRef.current = stuckCount;
  }, [stuckCount, queueMessages, notificationsEnabled, notifyStuck]);

  // Listen for open-queue-drawer event (from notification click)
  useEffect(() => {
    const handleOpenDrawer = () => setQueueDrawerOpen(true);
    window.addEventListener('open-queue-drawer', handleOpenDrawer);
    return () => window.removeEventListener('open-queue-drawer', handleOpenDrawer);
  }, []);

  // When filtering by project: ONLY use paginated data (API-filtered)
  // When showing all projects: merge SSE live data with paginated data
  const allObservations = useMemo(() => {
    if (currentFilter) {
      // Project filter active: API handles filtering, ignore SSE items
      return paginatedObservations;
    }
    // No filter: merge SSE + paginated, deduplicate by ID
    return mergeAndDeduplicateByProject(observations, paginatedObservations);
  }, [observations, paginatedObservations, currentFilter]);

  const allSummaries = useMemo(() => {
    if (currentFilter) {
      return paginatedSummaries;
    }
    return mergeAndDeduplicateByProject(summaries, paginatedSummaries);
  }, [summaries, paginatedSummaries, currentFilter]);

  const allPrompts = useMemo(() => {
    if (currentFilter) {
      return paginatedPrompts;
    }
    return mergeAndDeduplicateByProject(prompts, paginatedPrompts);
  }, [prompts, paginatedPrompts, currentFilter]);

  // Toggle context preview modal
  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  // Toggle queue drawer
  const toggleQueueDrawer = useCallback(() => {
    setQueueDrawerOpen(prev => !prev);
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
  }, [currentFilter, pagination.observations, pagination.summaries, pagination.prompts]);

  // Reset paginated data and load first page when filter changes
  useEffect(() => {
    setPaginatedObservations([]);
    setPaginatedSummaries([]);
    setPaginatedPrompts([]);
    handleLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFilter]);

  return (
    <>
      <Header
        isConnected={isConnected}
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        stuckCount={stuckCount}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        onQueueToggle={toggleQueueDrawer}
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
        notificationsEnabled={notificationsEnabled}
        onNotificationsChange={setNotificationsEnabled}
        notificationPermission={notificationPermission}
      />

      <QueueDrawer
        isOpen={queueDrawerOpen}
        onClose={toggleQueueDrawer}
        messages={queueMessages}
        recentlyProcessed={recentlyProcessed}
        stuckCount={stuckCount}
        onRetry={retryMessage}
        onAbort={abortMessage}
        onRetryAllStuck={retryAllStuck}
        onForceRestartSession={forceRestartSession}
        onRecoverSession={recoverSession}
      />
    </>
  );
}
