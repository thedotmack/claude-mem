// Floating toasts for background "agent" work: running (spinner) → done (clickable).
//
// Ported from /tmp/cmem-redesign/cmem-viewer/search-agent.jsx:291-314.

import React from 'react';
import { Icon } from '../ui/icons.js';
import type { AgentSession } from '../hooks/useAgentSessions.js';

export interface AgentToastsProps {
  sessions: AgentSession[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function AgentToasts({ sessions, onOpen, onDismiss }: AgentToastsProps) {
  const visible = sessions.filter(
    (s) => !(s.status === 'done' && s.viewed && s.dismissedAfterView)
  );
  if (visible.length === 0) return null;
  return (
    <div className="agent-toasts">
      {visible.map((s) => (
        <div key={s.id} className={'agent-toast' + (s.status === 'done' ? ' done' : '')}>
          <img
            src="claude-mem-logomark.webp"
            alt=""
            className={'toast-mark' + (s.status === 'running' ? ' spin' : '')}
          />
          <button
            className="toast-main"
            onClick={() => s.status === 'done' && onOpen(s.id)}
            disabled={s.status !== 'done'}
          >
            <span className="toast-query">“{s.query}”</span>
            <span className={'toast-stage' + (s.status === 'done' && !s.viewed ? ' ready' : '')}>
              {s.status === 'done'
                ? s.viewed
                  ? 'Answer · tap to reopen'
                  : 'Answer ready — tap to read'
                : s.stage}
            </span>
          </button>
          <button className="toast-x" onClick={() => onDismiss(s.id)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
