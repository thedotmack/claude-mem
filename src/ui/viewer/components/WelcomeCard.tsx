import React from 'react';

interface WelcomeCardProps {
  onDismiss: () => void;
  observationCount: number;
  projectCount: number;
  isConnected: boolean;
  firstObservationAt: string | null;
}

const STORAGE_KEY = 'claude-mem-welcome-dismissed-v2';
const EXPLAINER_URL = '/api/onboarding/explainer';
const DOCS_URL = 'https://docs.claude-mem.ai';

export function getStoredWelcomeDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch (e: unknown) {
    console.warn('Failed to read welcome-dismissed from localStorage:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

export function setStoredWelcomeDismissed(dismissed: boolean): void {
  try {
    if (dismissed) {
      localStorage.setItem(STORAGE_KEY, 'true');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (e: unknown) {
    console.warn('Failed to save welcome-dismissed to localStorage:', e instanceof Error ? e.message : String(e));
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="welcome-card-dismiss"
      onClick={onClick}
      aria-label="Dismiss welcome card"
      title="Dismiss"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  );
}

export function WelcomeCard({
  onDismiss,
  observationCount,
  projectCount,
  isConnected,
  firstObservationAt,
}: WelcomeCardProps) {
  const handleDismiss = () => {
    setStoredWelcomeDismissed(true);
    onDismiss();
  };

  const isEmpty = observationCount === 0;

  if (isEmpty) {
    return (
      <article className="card welcome-card welcome-card-empty">
        <header className="welcome-card-header">
          <img src="claude-mem-logomark.webp" alt="" width="32" height="32" />
          <div className="welcome-card-lede">
            <h2>No observations yet.</h2>
            <p>Open Claude Code in any project &mdash; entries stream in here as Claude reads, edits, and runs commands.</p>
          </div>
          <DismissButton onClick={handleDismiss} />
        </header>
        <div className="welcome-card-status-row">
          <span className="welcome-card-status-dot" data-connected={isConnected ? 'true' : 'false'} />
          <span className="welcome-card-status-label">
            {isConnected ? 'Connected to worker · waiting for activity' : 'Reconnecting…'}
          </span>
        </div>
        <footer className="welcome-card-footer">
          <a href={EXPLAINER_URL} target="_blank" rel="noopener noreferrer">
            How it works
          </a>
        </footer>
      </article>
    );
  }

  return (
    <article className="card welcome-card">
      <header className="welcome-card-header">
        <img src="claude-mem-logomark.webp" alt="" width="32" height="32" />
        <div className="welcome-card-lede">
          <h2>claude-mem</h2>
          <p>Persistent memory across Claude Code sessions.</p>
        </div>
        <DismissButton onClick={handleDismiss} />
      </header>
      <div className="welcome-card-stats">
        <span>{observationCount} observations</span>
        <span className="welcome-card-stats-sep">{'·'}</span>
        <span>{projectCount} projects</span>
        <span className="welcome-card-stats-sep">{'·'}</span>
        <span>since {formatDate(firstObservationAt)}</span>
      </div>
      <ul className="welcome-card-prompts">
        <li><code>ask:</code> did we already solve X?</li>
        <li><code>/mem-search</code> dig into past work</li>
      </ul>
      <footer className="welcome-card-footer">
        <a href={EXPLAINER_URL} target="_blank" rel="noopener noreferrer">
          How it works
        </a>
        {' · '}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          Read the docs
        </a>
      </footer>
    </article>
  );
}
