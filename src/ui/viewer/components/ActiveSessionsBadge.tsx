import React, { useState, useRef, useEffect } from 'react';
import { formatRelativeTime } from '../utils/formatters';
import type { ActiveSession } from '../hooks/useActiveSessions';

export interface ActiveSessionsBadgeProps {
  sessions: ActiveSession[];
  staleCount: number;
  totalCount: number;
  onCloseSession: (id: number) => Promise<{ summaryQueued: boolean } | null>;
  onCloseAllStale: () => Promise<{ summariesQueued: number } | null>;
}

const MAX_PROJECT_NAME_LENGTH = 20;

function getProjectShortName(project: string): string {
  const lastSegment = project.split('/').pop() ?? project;
  if (lastSegment.length > MAX_PROJECT_NAME_LENGTH) {
    return lastSegment.slice(0, MAX_PROJECT_NAME_LENGTH) + '…';
  }
  return lastSegment;
}

export function ActiveSessionsBadge({
  sessions,
  staleCount,
  totalCount,
  onCloseSession,
  onCloseAllStale,
}: ActiveSessionsBadgeProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Auto-clear status message after 3s with proper cleanup
  useEffect(() => {
    if (!statusMessage) return;
    const timer = setTimeout(() => { setStatusMessage(null); }, 3000);
    return () => { clearTimeout(timer); };
  }, [statusMessage]);

  useEffect(() => {
    if (!isOpen) return;

    function handleOutsideClick(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen]);

  return (
    <div className="active-sessions-wrapper" ref={wrapperRef}>
      <button
        className={`active-sessions-badge${staleCount > 0 ? ' active-sessions-badge--warning' : ''}`}
        onClick={() => { setIsOpen(prev => !prev); }}
        aria-label="Active sessions"
        title="Active sessions"
      >
        Sessions: {totalCount}
      </button>

      {isOpen && (
        <div className="active-sessions-dropdown">
          {sessions.map(session => (
            <div key={session.id} className="active-sessions-item">
              <span
                className={`active-sessions-item__dot ${session.is_stale ? 'active-sessions-item__dot--stale' : 'active-sessions-item__dot--fresh'}`}
                aria-hidden="true"
              />
              <div className="active-sessions-item__info">
                <div className="active-sessions-item__project" title={session.project}>
                  {getProjectShortName(session.project)}
                </div>
                <div className="active-sessions-item__duration">
                  {formatRelativeTime(session.started_at_epoch)}
                </div>
              </div>
              {session.is_stale && (
                <button
                  className="active-sessions-item__close"
                  onClick={async () => {
                    const result = await onCloseSession(session.id);
                    if (result?.summaryQueued) {
                      setStatusMessage('Summary generating...');
                    }
                  }}
                  title="Close session"
                  aria-label={`Close session for ${getProjectShortName(session.project)}`}
                >
                  [Close]
                </button>
              )}
            </div>
          ))}

          {staleCount > 0 && (
            <div className="active-sessions-footer">
              <button
                className="active-sessions-close-all-btn"
                onClick={async () => {
                  const result = await onCloseAllStale();
                  if (result && result.summariesQueued > 0) {
                    setStatusMessage(`${result.summariesQueued} summaries generating...`);
                  }
                }}
              >
                Close All Stale
              </button>
            </div>
          )}

          {statusMessage && (
            <div className="active-sessions-status" aria-live="polite">
              {statusMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
