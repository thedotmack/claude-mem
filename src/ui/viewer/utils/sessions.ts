import type { SessionCatalogEntry, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { hasEveryWord } from './search';
import { DELETE_REQUEST_TIMEOUT_MS, describeDeleteStopped, sendDelete } from './feed-deletion';

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

/**
 * What a session is called, the one rule for the list and the session page (the list used `||` and the page
 * `??`, so an empty custom title read differently on the two). In order: the session's custom title, which an
 * integration sets on purpose (dsh-plugin's customTitle, a synced set_title), then the newest summary's request
 * (from the catalog, or `loadedSummary` from the rows the page has loaded) where there is none. `null` means
 * "No summary yet". An older worker sends no `summary_title` at all; then a row with no custom title keeps its
 * 15.x title, the project name, instead of reading as unsummarized (G19).
 */
export function sessionTitle(
  entry: Pick<SessionCatalogEntry, 'summary_title' | 'custom_title' | 'project'> | null | undefined,
  loadedSummary?: string | null,
): string | null {
  const custom = entry?.custom_title?.trim();
  if (custom) return custom;
  const summary = entry?.summary_title?.trim() || loadedSummary?.trim();
  if (summary) return summary;
  return entry && entry.summary_title === undefined ? entry.project : null;
}

/**
 * The short id chip on a session row. Eight characters tell sessions apart (the first block of a UUID, as
 * git's short ids do); the full id stays in the chip's title, its accessible name and on the session page.
 */
export const SHORT_SESSION_ID_LENGTH = 8;

export function shortSessionId(contentSessionId: string): string {
  return contentSessionId.length > SHORT_SESSION_ID_LENGTH ? contentSessionId.slice(0, SHORT_SESSION_ID_LENGTH) : contentSessionId;
}

/** True when every word of the query is in the session's title, project, tool or id, in any case (hasEveryWord). */
export function matchesSessionSearch(entry: SessionCatalogEntry, query: string): boolean {
  const text = [entry.summary_title, entry.custom_title, entry.project, entry.platform_source, entry.content_session_id]
    .filter(Boolean).join('\n');
  return hasEveryWord(text, query);
}

/** Any feed row: observations and prompts carry content_session_id, summaries carry session_id. */
export interface SessionScopedRow {
  content_session_id?: string | null;
  session_id?: string | null;
  platform_source?: string | null;
}

/**
 * A feed row belongs to a project filter when it was captured there or was
 * merged into it (worktree adoption, `project merge`). The worker's
 * `?project=` pagination returns both, so the client filter must keep both.
 */
export function rowInProject(row: { project: string; merged_into_project?: string | null }, project: string): boolean {
  // Same rule as the worker's `COLLATE NOCASE` project match, which folds ASCII letters only.
  const foldAscii = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
  const wanted = foldAscii(project);
  return foldAscii(row.project) === wanted
    || (row.merged_into_project != null && foldAscii(row.merged_into_project) === wanted);
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

/** The reader pressed Cancel or Escape while a session delete was on its way. Its outcome is unknown. */
export const SESSION_DELETE_STOPPED = describeDeleteStopped('session');

/**
 * Delete a session and everything captured in it through the worker's sync-safe endpoint, by the same request path
 * as a card's delete (sendDelete), so it rejects with the same kinds of user-facing message. The wait is the card
 * delete's (DELETE_REQUEST_TIMEOUT_MS): the worker removes a session's rows and records their tombstones in one SQLite
 * transaction and only queues the cloud delete (DataRoutes.handleDeleteSession), so it answers at once.
 */
export async function deleteSession(
  ref: SessionRef,
  fetchImpl: typeof fetch = fetch,
  { signal, timeoutMs = DELETE_REQUEST_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const url = `${API_ENDPOINTS.SESSIONS}/${encodeURIComponent(ref.platformSource)}/${encodeURIComponent(ref.contentSessionId)}`;
  await sendDelete(url, { fetchImpl, signal, timeoutMs, subject: 'session', describeRefusal: describeSessionDeleteFailure });
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
  /** The newest summary title each session got live during the request (a page read before it has the older one). */
  retitled: Map<string, string>;
  /** Sessions with a live item deletion during the request. */
  decreased: Set<string>;
  /** Sessions deleted and then recreated while this page was in flight. */
  recreated: Set<string>;
  /** sessionKey of every session deleted during the request. */
  removed: Set<string>;
}

export function emptyCatalogJournal(): CatalogJournal {
  return { added: [], touched: new Set(), retitled: new Map(), decreased: new Set(), recreated: new Set(), removed: new Set() };
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
    // This page may describe the deleted incarnation, including its title.
    // Keep the recreated row provisional until the hook confirms it.
    if (live && journal.recreated.has(key)) return live;
    // A page may already include the live rows: use the larger count rather
    // than adding a delta twice. Keep the page's other metadata (the custom
    // title), but a summary that arrived live during the request is newer than
    // a page whose query may have run before it was stored: its title wins.
    // Counts have no revision: keep a deletion provisional until the hook
    // confirms it with a request started after that deletion.
    const counted = live && (journal.decreased.has(key) || live.item_count > entry.item_count)
      ? { ...entry, item_count: live.item_count }
      : entry;
    const liveTitle = journal.retitled.get(key);
    return liveTitle !== undefined && liveTitle !== counted.summary_title ? { ...counted, summary_title: liveTitle } : counted;
  };
  let combined: SessionCatalogEntry[];
  if (mode === 'replace') {
    // The page's row carries the real title and count; a live placeholder only
    // survives for a session the page does not have yet.
    const pageKeys = new Set(page.map(keyOf));
    combined = [
      // An introduced session outside a full page keeps its latest live
      // entry. If the page includes it, its fresh server row wins below.
      ...journal.added.filter(entry => !pageKeys.has(keyOf(entry)))
        .map(entry => currentByKey.get(keyOf(entry)) ?? entry).map(preserveLiveCount),
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
