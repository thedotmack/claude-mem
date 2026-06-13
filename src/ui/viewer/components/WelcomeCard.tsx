import React, { useEffect } from 'react';

interface WelcomeCardProps {
  onDismiss: () => void;
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

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="welcome-modal-dismiss"
      onClick={onClick}
      aria-label="Close welcome"
      title="Close (Esc)"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  );
}

function StreamIllustration() {
  return (
    <svg
      className="welcome-modal-feature-art"
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="14" y="56" width="68" height="22" rx="4" />
      <line x1="20" y1="56" x2="20" y2="78" stroke="var(--info)" strokeWidth="3" />
      <line x1="30" y1="64" x2="56" y2="64" opacity="0.6" />
      <line x1="30" y1="71" x2="48" y2="71" opacity="0.6" />

      <rect x="10" y="30" width="68" height="22" rx="4" />
      <line x1="16" y1="30" x2="16" y2="52" stroke="var(--honey-500)" strokeWidth="3" />
      <line x1="26" y1="38" x2="60" y2="38" opacity="0.6" />
      <line x1="26" y1="45" x2="52" y2="45" opacity="0.6" />

      <rect x="18" y="6" width="68" height="22" rx="4" />
      <line x1="24" y1="6" x2="24" y2="28" stroke="var(--coral-500)" strokeWidth="3" />
      <line x1="34" y1="14" x2="68" y2="14" opacity="0.6" />
      <line x1="34" y1="21" x2="60" y2="21" opacity="0.6" />
    </svg>
  );
}

function TuneIllustration() {
  return (
    <svg
      className="welcome-modal-feature-art"
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="14" y1="26" x2="82" y2="26" />
      <line x1="14" y1="48" x2="82" y2="48" />
      <line x1="14" y1="70" x2="82" y2="70" />

      <circle cx="32" cy="26" r="6" fill="var(--surface)" />
      <circle cx="62" cy="48" r="6" fill="var(--surface)" />
      <circle cx="44" cy="70" r="6" fill="var(--surface)" />

      <circle cx="32" cy="26" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="62" cy="48" r="2.5" fill="currentColor" stroke="none" />
      <circle cx="44" cy="70" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RecallIllustration() {
  return (
    <svg
      className="welcome-modal-feature-art"
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="10" y="14" width="58" height="40" rx="4" opacity="0.45" />
      <line x1="20" y1="24" x2="56" y2="24" opacity="0.45" />
      <line x1="20" y1="32" x2="48" y2="32" opacity="0.45" />
      <line x1="20" y1="40" x2="52" y2="40" opacity="0.45" />

      <rect x="18" y="26" width="58" height="40" rx="4" fill="var(--surface)" />
      <line x1="28" y1="36" x2="64" y2="36" opacity="0.6" />
      <line x1="28" y1="44" x2="56" y2="44" opacity="0.6" />
      <line x1="28" y1="52" x2="60" y2="52" opacity="0.6" />

      <circle cx="62" cy="62" r="14" fill="var(--surface)" stroke="currentColor" strokeWidth="2.25" />
      <line x1="73" y1="73" x2="84" y2="84" strokeWidth="2.5" />
    </svg>
  );
}

interface Feature {
  kind: string;
  illustration: React.ReactNode;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    kind: 'stream',
    illustration: <StreamIllustration />,
    title: 'Live feed',
    description: 'Observations, summaries, and prompts stream in live.',
  },
  {
    kind: 'tune',
    illustration: <TuneIllustration />,
    title: 'Tune it',
    description: 'The gear in the top-right tunes memory injection.',
  },
  {
    kind: 'recall',
    illustration: <RecallIllustration />,
    title: 'Recall it',
    description: 'Ask Claude or run /mem-search to find past work.',
  },
];

const WELCOME_STYLES = `
.welcome-modal-backdrop {
  position: fixed; inset: 0; z-index: 200;
  display: flex; align-items: center; justify-content: center;
  padding: var(--space-5);
  background: rgba(42,28,21,0.32);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  animation: welcomeFade var(--dur, 240ms) var(--ease-out, ease);
}
@keyframes welcomeFade { from { opacity: 0; } to { opacity: 1; } }
.welcome-modal {
  position: relative;
  width: min(680px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2xl);
  box-shadow: var(--shadow-lg);
  padding: var(--space-10) var(--space-8) var(--space-8);
  font-family: var(--font-sans);
  color: var(--fg);
  animation: welcomePop var(--dur, 240ms) var(--ease-bounce, ease);
}
@keyframes welcomePop { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: none; } }
.welcome-modal-dismiss {
  position: absolute; top: var(--space-4); right: var(--space-4);
  display: grid; place-items: center; width: 34px; height: 34px;
  border-radius: var(--r-pill); color: var(--fg-3);
  background: var(--surface-sunken); border: 1px solid var(--border-soft);
  transition: color var(--dur-fast, 140ms) var(--ease-out, ease), background var(--dur-fast, 140ms) var(--ease-out, ease);
}
.welcome-modal-dismiss:hover { color: var(--fg); background: var(--surface-tint); }
.welcome-modal-header { text-align: center; display: flex; flex-direction: column; align-items: center; gap: var(--space-2); margin-bottom: var(--space-8); }
.welcome-modal-logo { width: 96px; height: 96px; object-fit: contain; }
.welcome-modal-header h2 {
  font-family: var(--font-display); font-weight: 600; font-size: 1.75rem;
  letter-spacing: -0.015em; color: var(--fg);
}
.welcome-modal-header p { font-size: 1rem; font-weight: 500; color: var(--fg-2); }
.welcome-modal-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4);
  margin-bottom: var(--space-8);
}
.welcome-modal-feature {
  background: var(--surface-sunken); border: 1px solid var(--border-soft);
  border-radius: var(--r-lg); padding: var(--space-5) var(--space-4);
}
.welcome-modal-feature-inner { display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--space-2); }
.welcome-modal-feature-art { width: 64px; height: 64px; color: var(--coral-500); }
.welcome-modal-feature-summary .welcome-modal-feature-art { color: var(--honey-500); }
.welcome-modal-feature-prompt .welcome-modal-feature-art { color: var(--info); }
.welcome-modal-feature-title { font-family: var(--font-display); font-weight: 600; font-size: 1.0625rem; color: var(--fg); }
.welcome-modal-feature-desc { font-size: 0.875rem; font-weight: 500; color: var(--fg-3); line-height: 1.5; }
.welcome-modal-footer {
  display: flex; align-items: center; justify-content: center; gap: var(--space-3);
  font-size: 0.9375rem; font-weight: 600;
}
.welcome-modal-footer a { color: var(--coral-600); text-decoration: none; }
.welcome-modal-footer a:hover { text-decoration: underline; }
.welcome-modal-footer-sep { color: var(--fg-3); }
@media (max-width: 560px) {
  .welcome-modal-grid { grid-template-columns: 1fr; }
}
`;

export function WelcomeCard({ onDismiss }: WelcomeCardProps) {
  const handleDismiss = () => {
    setStoredWelcomeDismissed(true);
    onDismiss();
  };

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="welcome-modal-backdrop" onClick={handleDismiss}>
      <style>{WELCOME_STYLES}</style>
      <article
        className="welcome-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
      >
        <DismissButton onClick={handleDismiss} />

        <header className="welcome-modal-header">
          <img className="welcome-modal-logo" src="claude-mem-logo-stylized.png" alt="" width="96" height="96" />
          <h2 id="welcome-modal-title">Welcome to claude-mem</h2>
          <p>Persistent memory for Claude Code.</p>
        </header>

        <div className="welcome-modal-grid">
          {FEATURES.map(feature => (
            <div key={feature.kind} className={`welcome-modal-feature welcome-modal-feature-${feature.kind}`}>
              <div className="welcome-modal-feature-inner">
                {feature.illustration}
                <h3 className="welcome-modal-feature-title">{feature.title}</h3>
                <p className="welcome-modal-feature-desc">{feature.description}</p>
              </div>
            </div>
          ))}
        </div>

        <footer className="welcome-modal-footer">
          <a href={EXPLAINER_URL} target="_blank" rel="noopener noreferrer">
            How it works
          </a>
          <span className="welcome-modal-footer-sep">{'·'}</span>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            Read the docs
          </a>
        </footer>
      </article>
    </div>
  );
}
