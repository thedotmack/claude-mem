import React, { useEffect, useMemo } from 'react';
import type { QueueMessage } from '../types';
import { QueueMessageCard } from './QueueMessageCard';

interface QueueDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: QueueMessage[];
  recentlyProcessed: QueueMessage[];
  stuckCount: number;
  onRetry: (id: number) => void;
  onAbort: (id: number) => void;
  onRetryAllStuck: () => void;
  onForceRestartSession: (sessionId: number) => void;
  onRecoverSession: (sessionId: number) => void;
}

/**
 * Format duration since a timestamp
 */
function formatTimeSince(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function QueueDrawer({
  isOpen,
  onClose,
  messages,
  recentlyProcessed,
  stuckCount,
  onRetry,
  onAbort,
  onRetryAllStuck,
  onForceRestartSession,
  onRecoverSession
}: QueueDrawerProps) {
  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  // Listen for custom event to open drawer
  useEffect(() => {
    const handleOpenDrawer = () => {
      // This would need to be handled by parent, but we can't open from here
      // The event is for notification click handling
    };
    window.addEventListener('open-queue-drawer', handleOpenDrawer);
    return () => window.removeEventListener('open-queue-drawer', handleOpenDrawer);
  }, []);

  if (!isOpen) return null;

  return (
    <>
      <div className="queue-drawer-backdrop" onClick={onClose} />
      <div className={`queue-drawer ${isOpen ? 'open' : ''}`}>
        <div className="queue-drawer-header">
          <h2>Message Queue</h2>
          <button className="queue-drawer-close" onClick={onClose} title="Close (Esc)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {stuckCount > 0 && (
          <div className="queue-drawer-actions">
            <button className="queue-btn-retry-all" onClick={onRetryAllStuck}>
              Retry All Stuck ({stuckCount})
            </button>
          </div>
        )}

        <div className="queue-drawer-content">
          {messages.length === 0 ? (
            <div className="queue-empty">
              <span className="queue-empty-icon">{'\u2713'}</span>
              <span className="queue-empty-text">All caught up!</span>
            </div>
          ) : (
            messages.map((message, index) => (
              <QueueMessageCard
                key={message.id}
                message={message}
                position={index + 1}
                totalCount={messages.length}
                onRetry={onRetry}
                onAbort={onAbort}
                onForceRestartSession={onForceRestartSession}
                onRecoverSession={onRecoverSession}
              />
            ))
          )}

          {/* Recently Processed Section */}
          {recentlyProcessed.length > 0 && (
            <div className="queue-recently-processed">
              <div className="queue-section-header">
                <span className="queue-section-icon">{'\u2713'}</span>
                <span>Recently Processed ({recentlyProcessed.length})</span>
              </div>
              {recentlyProcessed.map((message) => (
                <div key={message.id} className="queue-processed-item">
                  <span className="queue-processed-status">{'\u2713'}</span>
                  <span className="queue-processed-tool">{message.tool_name || 'summarize'}</span>
                  <span className="queue-processed-time">
                    {message.completed_at_epoch ? formatTimeSince(message.completed_at_epoch) : ''}
                  </span>
                  {message.project && (
                    <span className="queue-processed-project">{message.project}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
