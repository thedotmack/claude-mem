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

/** Live catalog changes seen while a catalog page request was in flight. */
export interface CatalogJournal {
  /** Sessions first seen live (SSE) during the request. */
  added: SessionCatalogEntry[];
  /** Sessions whose item count changed live during the request. */
  touched: Set<string>;
  /** sessionKey of every session deleted during the request. */
  removed: Set<string>;
}

export function emptyCatalogJournal(): CatalogJournal {
  return { added: [], touched: new Set(), removed: new Set() };
}

/**
 * Fold a fetched catalog page into the list. `replace` (a refresh) starts from
 * the page and keeps sessions first seen live during the request; `append` (an
 * older page) extends the current list. Either way a session deleted during
 * the request stays gone and no session is listed twice.
 */
export function mergeCatalogPage(
  current: SessionCatalogEntry[],
  page: SessionCatalogEntry[],
  journal: CatalogJournal,
  mode: 'replace' | 'append',
): SessionCatalogEntry[] {
  const keyOf = (entry: SessionCatalogEntry) => sessionKey(catalogEntryRef(entry));
  const currentByKey = new Map(current.map(entry => [keyOf(entry), entry]));
  const preserveLiveCount = (entry: SessionCatalogEntry): SessionCatalogEntry => {
    const key = keyOf(entry);
    const live = journal.touched.has(key) ? currentByKey.get(key) : undefined;
    // A page may already include the live rows: use the larger count rather
    // than adding a delta twice. Keep authoritative page metadata (titles).
    return live && live.item_count > entry.item_count
      ? { ...entry, item_count: live.item_count }
      : entry;
  };
  let combined: SessionCatalogEntry[];
  if (mode === 'replace') {
    // The page's row carries the real title and count; a live placeholder only
    // survives for a session the page does not have yet.
    const pageKeys = new Set(page.map(keyOf));
    combined = [
      ...journal.added.filter(entry => !pageKeys.has(keyOf(entry))).map(preserveLiveCount),
      ...page.map(preserveLiveCount),
    ];
  } else {
    combined = [...current, ...page];
  }
  const seen = new Set<string>();
  return combined.filter(entry => {
    const key = keyOf(entry);
    if (seen.has(key) || journal.removed.has(key)) return false;
    seen.add(key);
    return true;
  });
}
