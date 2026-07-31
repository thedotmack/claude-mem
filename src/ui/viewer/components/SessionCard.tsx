import React, { useState } from 'react';
import { SessionCatalogEntry } from '../types';
import { formatDate } from '../utils/formatters';
import { SessionCardMenu } from './SessionCardMenu';

interface SessionCardProps {
  session: SessionCatalogEntry;
  onOpen: () => void;
  onDelete: () => void;
}

export function SessionCard({ session, onOpen, onDelete }: SessionCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = session.custom_title || session.project;
  const date = formatDate(session.started_at_epoch);
  const memoriesLabel = session.item_count === 1 ? '1 memory' : `${session.item_count} memories`;

  return (
    <div
      className="session-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="session-card-header">
        <div className="session-card-title-group">
          <span className="session-card-name">{name}</span>
          <span className="session-card-id" title={session.content_session_id}>
            {session.content_session_id}
          </span>
        </div>
        <div className="session-card-actions">
          <span className="session-card-count">{memoriesLabel}</span>
          <button
            className="session-card-menu-trigger"
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(prev => !prev);
            }}
            aria-label="Session actions"
            title="Session actions"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5"></circle>
              <circle cx="12" cy="12" r="1.5"></circle>
              <circle cx="12" cy="19" r="1.5"></circle>
            </svg>
          </button>
          {menuOpen && (
            <SessionCardMenu
              onClose={() => setMenuOpen(false)}
              onOpen={onOpen}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
      <div className="session-card-meta">
        <span className="session-card-project">{session.project}</span>
        <span className="session-card-date">{date}</span>
      </div>
    </div>
  );
}
