import React from 'react';

interface WelcomeCardProps {
  onDismiss: () => void;
  observationCount: number;
  projectCount: number;
  isConnected: boolean;
  firstObservationAt: string | null;
}

const STORAGE_KEY = 'claude-mem-welcome-dismissed-v3';
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

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  );
}

const CARD_TYPES = [
  {
    kind: 'observation',
    label: 'Observation',
    description: 'Captured in real time as Claude reads files, edits code, or runs commands.',
  },
  {
    kind: 'summary',
    label: 'Summary',
    description: 'A condensed roll-up of what happened, written when each session ends.',
  },
  {
    kind: 'prompt',
    label: 'Prompt',
    description: 'Your messages, kept alongside the work they triggered for searchable context.',
  },
] as const;

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

  return (
    <article className={`card welcome-card ${isEmpty ? 'welcome-card-empty' : ''}`}>
      <header className="welcome-card-header">
        <img src="claude-mem-logomark.webp" alt="" width="32" height="32" />
        <div className="welcome-card-lede">
          <h2>{isEmpty ? 'Welcome to claude-mem' : 'claude-mem'}</h2>
          <p>Persistent memory for Claude Code &mdash; observations stream in here as Claude reads, edits, and runs commands, then carry forward into the next session.</p>
          {!isEmpty && (
            <div className="welcome-card-stats">
              <span>{observationCount.toLocaleString()} {observationCount === 1 ? 'observation' : 'observations'}</span>
              <span className="welcome-card-stats-sep">{'·'}</span>
              <span>{projectCount} {projectCount === 1 ? 'project' : 'projects'}</span>
              <span className="welcome-card-stats-sep">{'·'}</span>
              <span>since {formatDate(firstObservationAt)}</span>
            </div>
          )}
        </div>
        <DismissButton onClick={handleDismiss} />
      </header>

      {isEmpty && (
        <div className="welcome-card-status-row">
          <span className="welcome-card-status-dot" data-connected={isConnected ? 'true' : 'false'} />
          <span className="welcome-card-status-label">
            {isConnected ? 'Connected to worker · waiting for activity' : 'Reconnecting to worker…'}
          </span>
        </div>
      )}

      <section className="welcome-card-section">
        <h3 className="welcome-card-section-title">What you'll see in this feed</h3>
        <ul className="welcome-card-types">
          {CARD_TYPES.map(t => (
            <li key={t.kind} className={`welcome-card-type welcome-card-type-${t.kind}`}>
              <span className="welcome-card-type-tag">{t.label}</span>
              <span className="welcome-card-type-desc">{t.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="welcome-card-section">
        <h3 className="welcome-card-section-title">Make it yours</h3>
        <ul className="welcome-card-tips">
          <li>
            <span className="welcome-card-tip-icon" aria-hidden="true"><GearIcon /></span>
            <div>
              <strong>Settings</strong> — click the gear in the top-right to tune how many observations get injected on session start, expand specific fields, and toggle token economics.
            </div>
          </li>
          <li>
            <span className="welcome-card-tip-icon" aria-hidden="true"><FilterIcon /></span>
            <div>
              <strong>Filter by project</strong> — use the project dropdown in the header to scope the feed to a single repo.
            </div>
          </li>
          <li>
            <span className="welcome-card-tip-icon" aria-hidden="true"><SearchIcon /></span>
            <div>
              <strong>Recall past work</strong> — ask Claude <code>did we already solve X?</code> or run <code>/mem-search</code> to dig through every observation across sessions.
            </div>
          </li>
        </ul>
      </section>

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
