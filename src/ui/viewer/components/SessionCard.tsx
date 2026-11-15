import React, { useRef, useState } from 'react';
import { useI18n, interpolate } from '../../i18n';
import { translateViewerError } from '../../i18n/errors';
import { SessionCatalogEntry } from '../types';
import { formatDate } from '../utils/formatters';
import { SessionCardMenu } from './SessionCardMenu';

interface SessionCardProps {
  session: SessionCatalogEntry;
  onOpen: () => void;
  /** Deletes the session; rejects with a user-facing reason when the worker refuses. */
  onDelete: () => Promise<void>;
}

export function SessionCard({ session, onOpen, onDelete }: SessionCardProps) {
  const { t, locale } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = session.custom_title || session.project;
  const date = formatDate(session.started_at_epoch);
  const memoriesLabel = interpolate(t(session.item_count === 1 ? '{count} memory' : '{count} memories'), { count: session.item_count });

  const handleDelete = async () => {
    const confirmMessage = interpolate(
      t('Delete this session and everything captured in it ({count})? This cannot be undone.'),
      { count: memoriesLabel }
    );
    if (!window.confirm(confirmMessage)) return;
    setIsDeleting(true);
    setFailure(null);
    try {
      await onDelete();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setIsDeleting(false);
    }
  };

  return (
    <div
      className={`session-card${isDeleting ? ' session-card--deleting' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
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
            ref={menuTriggerRef}
            className="session-card-menu-trigger"
            disabled={isDeleting}
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(prev => !prev);
            }}
            aria-label={t('Session actions')}
            aria-expanded={menuOpen}
            title={t('Session actions')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5"></circle>
              <circle cx="12" cy="12" r="1.5"></circle>
              <circle cx="12" cy="19" r="1.5"></circle>
            </svg>
          </button>
          {menuOpen && (
            <SessionCardMenu
              triggerRef={menuTriggerRef}
              onClose={() => setMenuOpen(false)}
              onOpen={onOpen}
              onDelete={handleDelete}
            />
          )}
        </div>
      </div>
      <div className="session-card-meta">
        <span className="session-card-project">{session.project}</span>
        <span className="session-card-platform">{session.platform_source}</span>
        <span className="session-card-date">{date}</span>
      </div>
      {failure && (
        <div className="card-delete-error" role="alert" onClick={e => e.stopPropagation()}>{translateViewerError(failure, t)}</div>
      )}
    </div>
  );
}
