import React, { useRef } from 'react';
import { useI18n, interpolate } from '../../i18n';
import { SessionCatalogEntry } from '../types';
import { formatCount, formatDate, formatShortTime } from '../utils/formatters';
import { catalogEntryRef, sessionHash, sessionKey, sessionTitle, shortSessionId } from '../utils/sessions';
import { isPlainClick } from '../utils/links';
import { useDeletes, type FeedItemDeletion } from '../hooks/useFeedItemDelete';
import { SessionCardMenu } from './SessionCardMenu';
import { DeleteConfirmation } from './DeleteButton';

interface SessionCardProps {
  session: SessionCatalogEntry;
  onOpen: () => void;
  /** Deletes the session; rejects with a user-facing reason when the worker refuses. `signal` stops waiting. */
  onDelete: (signal?: AbortSignal) => Promise<void>;
  /** The row's delete, when the list keeps it (so it outlives a recycled row); otherwise the card keeps its own. */
  deletion?: FeedItemDeletion;
}

/**
 * One row of the Sessions list: what the session was about (its newest summary's request), then the
 * project, the tool and a short id chip; the memory count and the start time at the right. The row's own
 * control is a link to the session's address; the "…" menu sits beside it, not inside it (F19), and a
 * delete asks in the row how many memories will go (F20).
 */
export function SessionCard({ session, onOpen, onDelete, deletion: listDeletion }: SessionCardProps) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const ref = catalogEntryRef(session);
  const own = useDeletes();
  const deletion = listDeletion ?? own.forKey(sessionKey(ref), signal => onDelete(signal));
  const title = sessionTitle(session);
  const memories = interpolate(t(session.item_count === 1 ? '{count} memory' : '{count} memories'), { count: formatCount(session.item_count) });
  const started = new Date(session.started_at_epoch);
  const startedKnown = Number.isFinite(started.getTime());
  // The day is in the day label above the row; the full stamp is in the time's title.
  const time = startedKnown ? formatShortTime(session.started_at_epoch) : t('Unknown time');

  return (
    <div ref={rowRef} className={`session-row${deletion.stage === 'deleting' ? ' session-row--deleting' : ''}`}>
      <div className="session-row-main">
        <a
          className="session-card"
          href={sessionHash(ref)}
          onClick={event => { if (isPlainClick(event)) { event.preventDefault(); onOpen(); } }}
        >
          <span className="session-card-text">
            <span className={`session-card-name${title ? '' : ' session-card-name--none'}`} title={title ?? undefined}>
              {title ?? t('No summary yet')}
            </span>
            <span className="session-card-meta">
              <span className="session-card-project" title={session.project}>{session.project}</span>
              <span className="session-card-dot" aria-hidden="true">·</span>
              <span className={`session-card-tool source-${session.platform_source}`}>{session.platform_source}</span>
              <span className="session-card-dot" aria-hidden="true">·</span>
              <span className="session-card-id" title={session.content_session_id} data-session-id={session.content_session_id}
                aria-label={interpolate(t('Session id {id}'), { id: session.content_session_id })}>
                {shortSessionId(session.content_session_id)}
              </span>
            </span>
          </span>
          <span className="session-card-side">
            <span className="session-card-count">{memories}</span>
            {startedKnown
              ? <time className="session-card-time" dateTime={started.toISOString()} title={formatDate(session.started_at_epoch)}>{time}</time>
              : <span className="session-card-time">{time}</span>}
          </span>
        </a>
        <SessionCardMenu onOpen={onOpen} onDelete={deletion.ask} />
      </div>
      {deletion.stage !== 'idle' && (
        <DeleteConfirmation
          question={interpolate(t('Delete this session and everything captured in it ({count})? This cannot be undone.'), { count: memories })}
          confirmLabel={interpolate(t('Delete {item}'), { item: t('session') })}
          deletion={deletion}
          returnFocus={() => rowRef.current?.querySelector<HTMLElement>('.session-card-menu-trigger')?.focus()}
        />
      )}
    </div>
  );
}
