import { describe, it, expect } from 'bun:test';
import {
  deleteSession,
  describeSessionDeleteFailure,
  parseViewRoute,
  removeSessionRows,
  sameSession,
  sessionDeletedTarget,
  sessionHash,
  sessionKey,
  sessionRefOf,
  sessionsHash,
} from '../../src/ui/viewer/utils/sessions';

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
