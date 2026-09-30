import React from 'react';
import { SessionCatalogEntry } from '../types';
import { SessionCard } from './SessionCard';
import { catalogEntryRef, sessionKey, type SessionRef } from '../utils/sessions';

interface SessionListProps {
  header: React.ReactNode;
  sessions: SessionCatalogEntry[];
  isLoading: boolean;
  loadError: string | null;
  onOpen: (session: SessionRef) => void;
  onDelete: (session: SessionRef) => Promise<void>;
}

export function SessionList({ header, sessions, isLoading, loadError, onOpen, onDelete }: SessionListProps) {
  return (
    <div className="session-list">
      <div className="session-list-content">
        {header}
        {loadError && <div className="card-delete-error" role="alert">{loadError}</div>}
        {sessions.map(session => {
          const ref = catalogEntryRef(session);
          return (
            <SessionCard
              key={sessionKey(ref)}
              session={session}
              onOpen={() => onOpen(ref)}
              onDelete={() => onDelete(ref)}
            />
          );
        })}
        {sessions.length === 0 && !loadError && (
          <div className="session-list-empty">
            {isLoading ? 'Loading sessions…' : 'No sessions to display'}
          </div>
        )}
      </div>
    </div>
  );
}
