import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from './components/Header';
import { SessionCard } from './components/SessionCard';
import { SessionDetailPage } from './components/SessionDetailPage';
import { ContextSettingsModal } from './components/ContextSettingsModal';
import { LogsDrawer } from './components/LogsModal';
import { WelcomeCard, getStoredWelcomeDismissed, setStoredWelcomeDismissed } from './components/WelcomeCard';
import { useSSE } from './hooks/useSSE';
import { useSettings } from './hooks/useSettings';
import { useTheme } from './hooks/useTheme';
import { SessionCatalogEntry } from './types';
import { API_ENDPOINTS } from './constants/api';

type Route = { view: 'list' } | { view: 'session'; contentSessionId: string };

function routeFromLocation(): Route {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session');
  return sessionId ? { view: 'session', contentSessionId: sessionId } : { view: 'list' };
}

export function App() {
  const [currentFilter, setCurrentFilter] = useState('');
  const [contextPreviewOpen, setContextPreviewOpen] = useState(false);
  const [logsModalOpen, setLogsModalOpen] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(getStoredWelcomeDismissed);
  const [route, setRoute] = useState<Route>(routeFromLocation);

  const { observations, summaries, prompts, projects, sessions, removeSession, isProcessing, queueDepth } = useSSE();
  const { settings, saveSettings, isSaving, saveStatus } = useSettings();
  const { preference, setThemePreference } = useTheme();

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (currentFilter && !projects.includes(currentFilter)) {
      setCurrentFilter('');
    }
  }, [projects, currentFilter]);

  const navigateToSession = useCallback((contentSessionId: string) => {
    const url = `${window.location.pathname}?session=${encodeURIComponent(contentSessionId)}`;
    window.history.pushState({}, '', url);
    setRoute({ view: 'session', contentSessionId });
  }, []);

  const navigateToList = useCallback(() => {
    window.history.pushState({}, '', window.location.pathname);
    setRoute({ view: 'list' });
  }, []);

  const handleDeleteSession = useCallback(async (session: SessionCatalogEntry) => {
    const confirmed = window.confirm(
      `Delete all content for session ${session.content_session_id}? This removes every observation, summary, and prompt from this session and cannot be undone.`
    );
    if (!confirmed) return;

    const params = `?platformSource=${encodeURIComponent(session.platform_source)}`;
    const response = await fetch(`${API_ENDPOINTS.SESSIONS}/${encodeURIComponent(session.content_session_id)}${params}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      console.error('[Session Delete] Failed:', body);
      return;
    }
    removeSession(session.content_session_id);
  }, [removeSession]);

  const toggleContextPreview = useCallback(() => {
    setContextPreviewOpen(prev => !prev);
  }, []);

  const toggleLogsModal = useCallback(() => {
    setLogsModalOpen(prev => !prev);
  }, []);

  const visibleSessions = useMemo(() => {
    return sessions
      .filter(s => !currentFilter || s.project === currentFilter)
      .sort((a, b) => b.started_at_epoch - a.started_at_epoch);
  }, [sessions, currentFilter]);

  return (
    <>
      <Header
        projects={projects}
        currentFilter={currentFilter}
        onFilterChange={setCurrentFilter}
        isProcessing={isProcessing}
        queueDepth={queueDepth}
        themePreference={preference}
        onThemeChange={setThemePreference}
        onContextPreviewToggle={toggleContextPreview}
        onShowHelp={() => {
          setStoredWelcomeDismissed(false);
          setWelcomeDismissed(false);
        }}
      />

      {route.view === 'list' ? (
        <div className="session-list">
          <div className="session-list-content">
            {visibleSessions.map(session => (
              <SessionCard
                key={session.content_session_id}
                session={session}
                onOpen={() => navigateToSession(session.content_session_id)}
                onDelete={() => handleDeleteSession(session)}
              />
            ))}
            {visibleSessions.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px', color: '#8b949e' }}>
                No sessions to display
              </div>
            )}
          </div>
        </div>
      ) : (
        <SessionDetailPage
          contentSessionId={route.contentSessionId}
          observations={observations}
          summaries={summaries}
          prompts={prompts}
          onBack={navigateToList}
        />
      )}

      {!welcomeDismissed && (
        <WelcomeCard onDismiss={() => setWelcomeDismissed(true)} />
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
