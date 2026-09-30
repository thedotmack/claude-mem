import type { SessionCatalogEntry, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';

/**
 * A session is identified by (platform_source, content_session_id): the same
 * content session id can exist under two hosts, so both travel together
 * through routes, React keys, pagination, the catalog and deletes.
 */
export interface SessionRef {
  platformSource: string;
  contentSessionId: string;
}

/** Stable key for maps and React keys. Platform sources never contain '/'. */
export function sessionKey(ref: SessionRef): string {
  return `${ref.platformSource}/${ref.contentSessionId}`;
}

export function sameSession(a: SessionRef | null | undefined, b: SessionRef | null | undefined): boolean {
  return !!a && !!b && a.platformSource === b.platformSource && a.contentSessionId === b.contentSessionId;
}

export function catalogEntryRef(entry: SessionCatalogEntry): SessionRef {
  return { platformSource: entry.platform_source, contentSessionId: entry.content_session_id };
}

/** Any feed row: observations and prompts carry content_session_id, summaries carry session_id. */
export interface SessionScopedRow {
  content_session_id?: string | null;
  session_id?: string | null;
  platform_source?: string | null;
}

/** The session a feed row belongs to, or null when the row does not say. */
export function sessionRefOf(row: SessionScopedRow): SessionRef | null {
  const contentSessionId = row.content_session_id ?? row.session_id;
  if (!contentSessionId) return null;
  return { platformSource: row.platform_source || 'claude', contentSessionId };
}

export type ViewRoute =
  | { view: 'timeline' }
  | { view: 'sessions' }
  | { view: 'session'; session: SessionRef };

const SESSIONS_HASH = '#/sessions';

export function sessionsHash(): string {
  return SESSIONS_HASH;
}

export function sessionHash(ref: SessionRef): string {
  return `${SESSIONS_HASH}/${encodeURIComponent(ref.platformSource)}/${encodeURIComponent(ref.contentSessionId)}`;
}

/** `#/sessions` is the list, `#/sessions/<platform>/<id>` one session; anything else is the timeline. */
export function parseViewRoute(hash: string): ViewRoute {
  if (hash === SESSIONS_HASH) return { view: 'sessions' };
  if (!hash.startsWith(`${SESSIONS_HASH}/`)) return { view: 'timeline' };
  const parts = hash.slice(SESSIONS_HASH.length + 1).split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { view: 'sessions' };
  try {
    return {
      view: 'session',
      session: { platformSource: decodeURIComponent(parts[0]), contentSessionId: decodeURIComponent(parts[1]) },
    };
  } catch {
    // A hand-edited hash with broken percent-encoding: fall back to the list.
    return { view: 'sessions' };
  }
}

/** User-facing reason for a refused session delete, by the worker's status code. */
export function describeSessionDeleteFailure(status: number): string {
  if (status === 409) {
    return 'Not deleted: this session is still running, or holds memories synced from another device (delete those there).';
  }
  if (status === 503) {
    return 'Not deleted: cloud sync is unavailable, so the delete could not be recorded for your other devices. Try again once sync reconnects.';
  }
  if (status === 404) {
    return 'Not deleted: this session is already gone.';
  }
  return `Not deleted: the worker answered HTTP ${status}.`;
}

/**
 * Delete a session and everything captured in it through the worker's
 * sync-safe endpoint. Rejects with a user-facing message.
 */
export async function deleteSession(ref: SessionRef, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${API_ENDPOINTS.SESSIONS}/${encodeURIComponent(ref.platformSource)}/${encodeURIComponent(ref.contentSessionId)}`;
  const response = await fetchImpl(url, { method: 'DELETE' }).catch(() => {
    throw new Error('Not deleted: the claude-mem worker could not be reached.');
  });
  if (!response.ok) {
    throw new Error(describeSessionDeleteFailure(response.status));
  }
}

/** The session a `session_deleted` SSE event names, or null when the event is malformed. */
export function sessionDeletedTarget(event: StreamEvent): SessionRef | null {
  if (event.type !== 'session_deleted') return null;
  if (typeof event.platformSource !== 'string' || !event.platformSource) return null;
  if (typeof event.contentSessionId !== 'string' || !event.contentSessionId) return null;
  return { platformSource: event.platformSource, contentSessionId: event.contentSessionId };
}

/**
 * Drop a deleted session's rows from a loaded page list. `removedCount` is how
 * far that list's next-page offset has to move back, or rows would be skipped.
 */
export function removeSessionRows<T extends SessionScopedRow>(rows: T[], ref: SessionRef): { rows: T[]; removedCount: number } {
  const remaining = rows.filter(row => !sameSession(sessionRefOf(row), ref));
  return { rows: remaining, removedCount: rows.length - remaining.length };
}
