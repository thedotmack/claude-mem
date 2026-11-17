import { describe, it, expect } from 'bun:test';
import {
  deleteSession,
  describeSessionDeleteFailure,
  emptyCatalogJournal,
  mergeCatalogPage,
  parseViewRoute,
  removeSessionRows,
  sameSession,
  sessionDeletedTarget,
  sessionHash,
  sessionKey,
  sessionRefOf,
  sessionsHash,
  sessionTitle,
  shortSessionId,
  matchesSessionSearch,
  SESSION_DELETE_STOPPED,
} from '../../src/ui/viewer/utils/sessions';
import { translateViewerError } from '../../src/ui/i18n/errors';
import type { SessionCatalogEntry } from '../../src/ui/viewer/types';

const claudeRef = { platformSource: 'claude', contentSessionId: 'abc-123' };
const codexRef = { platformSource: 'codex', contentSessionId: 'abc-123' };

describe('session identity is (platform, content session id)', () => {
  it('keys and compares on both halves', () => {
    expect(sessionKey(claudeRef)).not.toBe(sessionKey(codexRef));
    expect(sameSession(claudeRef, { ...claudeRef })).toBe(true);
    expect(sameSession(claudeRef, codexRef)).toBe(false);
    expect(sameSession(claudeRef, null)).toBe(false);
  });

  it('reads the session off observations, prompts (content_session_id) and summaries (session_id)', () => {
    expect(sessionRefOf({ content_session_id: 'abc-123', platform_source: 'codex' })).toEqual(codexRef);
    expect(sessionRefOf({ session_id: 'abc-123', platform_source: 'claude' })).toEqual(claudeRef);
    expect(sessionRefOf({ content_session_id: 'abc-123' })).toEqual(claudeRef);
    expect(sessionRefOf({ platform_source: 'claude' })).toBeNull();
  });
});

describe('view routes', () => {
  it('round-trips a session through the hash, including characters that need encoding', () => {
    const odd = { platformSource: 'codex', contentSessionId: 'thread/42 #a' };
    expect(parseViewRoute(sessionHash(odd))).toEqual({ view: 'session', session: odd });
  });

  it('maps the list hash, the empty hash and anything else', () => {
    expect(parseViewRoute(sessionsHash())).toEqual({ view: 'sessions' });
    expect(parseViewRoute('')).toEqual({ view: 'timeline' });
    expect(parseViewRoute('#')).toEqual({ view: 'timeline' });
    expect(parseViewRoute('#/something-else')).toEqual({ view: 'timeline' });
  });

  it('falls back to the list for a malformed session hash', () => {
    expect(parseViewRoute('#/sessions/claude')).toEqual({ view: 'sessions' });
    expect(parseViewRoute('#/sessions/claude/%E0%A4%A')).toEqual({ view: 'sessions' });
  });
});

describe('session_deleted SSE events', () => {
  it('names the deleted session', () => {
    expect(sessionDeletedTarget({ type: 'session_deleted', platformSource: 'codex', contentSessionId: 'abc-123' })).toEqual(codexRef);
  });

  it('ignores other events and malformed payloads', () => {
    expect(sessionDeletedTarget({ type: 'item_deleted', itemType: 'observation', id: 1 })).toBeNull();
    expect(sessionDeletedTarget({ type: 'session_deleted', contentSessionId: 'abc-123' })).toBeNull();
    expect(sessionDeletedTarget({ type: 'session_deleted', platformSource: 'claude' })).toBeNull();
  });
});

describe('deleting a session from the viewer', () => {
  it('DELETEs the composite route with both halves encoded', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response('{"success":true}', { status: 200 });
    }) as typeof fetch;

    await deleteSession({ platformSource: 'codex', contentSessionId: 'thread/42' }, fetchImpl);

    expect(calls).toEqual([{ url: '/api/sessions/codex/thread%2F42', method: 'DELETE' }]);
  });

  it('explains each refusal', async () => {
    const refuse = (status: number) => (async () => new Response('{}', { status })) as typeof fetch;
    await expect(deleteSession(claudeRef, refuse(409))).rejects.toThrow('synced from another device');
    await expect(deleteSession(claudeRef, refuse(503))).rejects.toThrow('cloud sync is unavailable');
    await expect(deleteSession(claudeRef, refuse(404))).rejects.toThrow('already gone');
    await expect(deleteSession(claudeRef, (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch))
      .rejects.toThrow('worker could not be reached');
    expect(describeSessionDeleteFailure(500)).toBe('Not deleted: the worker answered HTTP 500.');
  });
});

describe('loaded page bookkeeping after a session delete', () => {
  it('drops only that session\'s rows and reports how far the page offset moves back', () => {
    const rows = [
      { id: 1, content_session_id: 'abc-123', platform_source: 'claude' },
      { id: 2, content_session_id: 'abc-123', platform_source: 'codex' },
      { id: 3, content_session_id: 'abc-123', platform_source: 'claude' },
      { id: 4, content_session_id: 'other', platform_source: 'claude' },
    ];
    const result = removeSessionRows(rows, claudeRef);
    expect(result.rows.map(row => row.id)).toEqual([2, 4]);
    expect(result.removedCount).toBe(2);
  });
});

describe('catalog pages merge with live changes made while they loaded', () => {
  const entry = (contentSessionId: string, overrides: Partial<SessionCatalogEntry> = {}): SessionCatalogEntry => ({
    content_session_id: contentSessionId,
    project: 'proj',
    platform_source: 'claude',
    custom_title: null,
    started_at_epoch: 1000,
    item_count: 1,
    ...overrides,
  });
  const ids = (entries: SessionCatalogEntry[]) => entries.map(e => e.content_session_id);

  it('a refresh keeps a session first seen live mid-request, preferring the page row when it has one', () => {
    const journal = emptyCatalogJournal();
    journal.added.push(entry('fresh'), entry('both', { custom_title: null, item_count: 1 }));
    const page = [entry('both', { custom_title: 'Titled', item_count: 7 }), entry('older')];

    const merged = mergeCatalogPage([entry('stale-list-row')], page, journal, 'replace');

    expect(ids(merged)).toEqual(['fresh', 'both', 'older']);
    expect(merged[1]).toMatchObject({ custom_title: 'Titled', item_count: 7 });
  });

  // A summary that arrives live while a page is in flight is newer than a page whose query may have run before the
  // summary was stored: its title wins over the page's (the row would otherwise read "No summary yet" until the next fetch).
  it('a refresh keeps a title a live summary gave a loaded session while the page loaded', () => {
    const key = sessionKey({ platformSource: 'claude', contentSessionId: 'live' });
    const journal = emptyCatalogJournal();
    journal.touched.add(key);
    journal.retitled.set(key, 'The live summary');
    const current = [entry('live', { summary_title: 'The live summary', item_count: 5 })];
    const page = [entry('live', { summary_title: null, item_count: 4 }), entry('other', { summary_title: 'Other title' })];

    const merged = mergeCatalogPage(current, page, journal, 'replace');
    expect(merged.map(row => [row.content_session_id, row.summary_title, row.item_count]))
      .toEqual([['live', 'The live summary', 5], ['other', 'Other title', 1]]);
    // The page's own metadata still wins where nothing live changed it.
    const quiet = mergeCatalogPage(current, [entry('live', { summary_title: 'Older page title', custom_title: 'Set on purpose' })], emptyCatalogJournal(), 'replace');
    expect(quiet[0]).toMatchObject({ summary_title: 'Older page title', custom_title: 'Set on purpose' });
  });

  it('a refresh never restores a session deleted mid-request', () => {
    const journal = emptyCatalogJournal();
    journal.removed.add(sessionKey({ platformSource: 'claude', contentSessionId: 'doomed' }));

    expect(ids(mergeCatalogPage([], [entry('doomed'), entry('kept')], journal, 'replace'))).toEqual(['kept']);
  });

  it('an older page extends the list once per session and skips sessions deleted mid-request', () => {
    const journal = emptyCatalogJournal();
    journal.removed.add(sessionKey({ platformSource: 'claude', contentSessionId: 'gone' }));
    const current = [entry('a'), entry('b')];
    // The server list shifted while the page loaded, so it repeats 'b'.
    const page = [entry('b'), entry('gone'), entry('c'), entry('b', { platform_source: 'codex' })];

    expect(mergeCatalogPage(current, page, journal, 'append').map(e => `${e.platform_source}/${e.content_session_id}`))
      .toEqual(['claude/a', 'claude/b', 'claude/c', 'codex/b']);
  });
});

describe('what a session is called (one rule for the list and the session page)', () => {
  const entry = (fields: Partial<SessionCatalogEntry>): SessionCatalogEntry => ({
    content_session_id: 'abc-123', project: 'repo', platform_source: 'claude', custom_title: null,
    started_at_epoch: 1, item_count: 1, ...fields,
  });

  // A title an integration set on purpose (dsh-plugin's customTitle, a synced set_title) wins; the newest summary's
  // request fills in only where there is none.
  it('uses the custom title, then the newest summary\'s request; null reads "No summary yet"', () => {
    expect(sessionTitle(entry({ summary_title: '  Ship the titles ', custom_title: 'Custom' }))).toBe('Custom');
    expect(sessionTitle(entry({ summary_title: '  Ship the titles ', custom_title: null }))).toBe('Ship the titles');
    expect(sessionTitle(entry({ summary_title: '  Ship the titles ', custom_title: '   ' }))).toBe('Ship the titles');
    expect(sessionTitle(entry({ summary_title: null, custom_title: 'Custom' }))).toBe('Custom');
    expect(sessionTitle(entry({ summary_title: null }))).toBeNull();
    expect(sessionTitle(entry({ summary_title: '   ', custom_title: '  ' }))).toBeNull();
  });

  it('keeps a 15.x worker\'s title (custom title, else the project) when the field is missing, empty titles included (G19)', () => {
    expect(sessionTitle(entry({}))).toBe('repo');
    // The list used `||` and the page `??`: an empty custom title read as the project on one and blank on the other.
    expect(sessionTitle(entry({ custom_title: '' }))).toBe('repo');
    expect(sessionTitle(entry({ custom_title: 'Custom' }))).toBe('Custom');
  });

  it('lets the session page use its newest loaded summary where there is no custom title, with or without a catalog row', () => {
    expect(sessionTitle(entry({ custom_title: 'Custom' }), 'Loaded summary')).toBe('Custom');
    expect(sessionTitle(entry({}), 'Loaded summary')).toBe('Loaded summary');
    expect(sessionTitle(entry({ summary_title: 'Catalog title' }), 'Loaded summary')).toBe('Catalog title');
    expect(sessionTitle(null, ' Loaded summary ')).toBe('Loaded summary');
    expect(sessionTitle(undefined, null)).toBeNull();
  });

  it('chips the first eight characters of an id and keeps short ids whole', () => {
    expect(shortSessionId('66055a58-9ed9-4251-9443-136ea61e2089')).toBe('66055a58');
    expect(shortSessionId('saved-0')).toBe('saved-0');
  });

  it('finds a session by every word of the query across title, project, tool and id', () => {
    const row = entry({ summary_title: 'Ship the session titles', project: 'acme/repo', content_session_id: '66055a58-9ed9' });
    expect(matchesSessionSearch(row, 'SHIP titles')).toBe(true);
    expect(matchesSessionSearch(row, 'acme 66055a58')).toBe(true);
    expect(matchesSessionSearch(row, 'claude')).toBe(true);
    expect(matchesSessionSearch(row, 'ship missing')).toBe(false);
    expect(matchesSessionSearch(row, '   ')).toBe(true);
  });
});

describe('stopping a session delete', () => {
  it('says the outcome is unknown when the reader stops waiting or the worker does not answer in time', async () => {
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const stop = new AbortController();
    const stopped = deleteSession(claudeRef, hang, { signal: stop.signal });
    stop.abort();
    await expect(stopped).rejects.toThrow(SESSION_DELETE_STOPPED);
    await expect(deleteSession(claudeRef, hang, { timeoutMs: 20 })).rejects.toThrow(
      'No answer from the worker in 0.02 seconds, so the viewer stopped waiting. If the delete finishes anyway, this session leaves the list.');
    const t = (english: string) => `<${english}>`;
    expect(translateViewerError(SESSION_DELETE_STOPPED, t)).toBe(`<${SESSION_DELETE_STOPPED}>`);
    expect(translateViewerError('No answer from the worker in 10 seconds, so the viewer stopped waiting. If the delete finishes anyway, this session leaves the list.', t))
      .toBe('<No answer from the worker in {seconds} seconds, so the viewer stopped waiting. If the delete finishes anyway, this session leaves the list.>'.replace('{seconds}', '10'));
  });
});
