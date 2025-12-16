import React from 'react';

interface QueueButtonProps {
  queueDepth: number;
  stuckCount: number;
  onClick: () => void;
}

export function QueueButton({ queueDepth, stuckCount, onClick }: QueueButtonProps) {
  const hasStuck = stuckCount > 0;
  const hasWork = queueDepth > 0;

  return (
    <button
      className={`queue-button ${hasStuck ? 'has-stuck' : ''} ${hasWork ? 'has-work' : ''}`}
      onClick={onClick}
      title={hasStuck ? `${stuckCount} stuck message(s)` : `${queueDepth} message(s) in queue`}
    >
      <svg
        className="queue-icon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
      {(hasWork || hasStuck) && (
        <span className={`queue-badge ${hasStuck ? 'stuck' : ''}`}>
          {hasStuck ? stuckCount : queueDepth}
        </span>
      )}
    </button>
  );
}
