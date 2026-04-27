import React from 'react';

interface WelcomeCardProps {
  onDismiss: () => void;
}

const STORAGE_KEY = 'claude-mem-welcome-dismissed-v1';

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

export function WelcomeCard({ onDismiss }: WelcomeCardProps) {
  const handleDismiss = () => {
    setStoredWelcomeDismissed(true);
    onDismiss();
  };

  return (
    <article className="card welcome-card">
      <header className="welcome-card-header">
        <img src="claude-mem-logomark.webp" alt="" width="32" height="32" />
        <div className="welcome-card-lede">
          <h2>Welcome to claude-mem</h2>
          <p>Persistent memory across Claude Code sessions. Try one of these prompts to get started:</p>
        </div>
        <button
          type="button"
          className="welcome-card-dismiss"
          onClick={handleDismiss}
          aria-label="Dismiss welcome card"
          title="Dismiss"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </header>
      <ul className="welcome-card-prompts">
        <li><code>ask:</code> what did we change in this codebase last week?</li>
        <li><code>ask:</code> did we already solve X?</li>
        <li><code>/mem-search</code> to dig into past work</li>
        <li><code>/learn-codebase</code> — have Claude read every file in this repo</li>
      </ul>
      <footer className="welcome-card-footer">
        <a href="https://docs.claude-mem.ai" target="_blank" rel="noopener noreferrer">
          Read the docs
        </a>
      </footer>
    </article>
  );
}
