/**
 * Tests for useSessionDetail hook
 *
 * Tests the core session-detail fetching and caching logic used by the hook.
 * The hook wraps these pure functions with React state management.
 *
 * We test the pure functions directly (no DOM/React needed) since vitest
 * runs without a browser environment and @testing-library/react is not installed.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  fetchSessionDetail,
  SessionDetailCache,
} from '../../../src/ui/viewer/hooks/useSessionDetail';
import type { Observation, Summary, UserPrompt } from '../../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = 'test-project';
const SESSION_ID = 'session-abc-123';
const OTHER_SESSION_ID = 'session-xyz-999';

const mockSummary: Summary = {
  id: 1,
  session_id: SESSION_ID,
  project: PROJECT,
  request: 'Fix the login bug',
  investigated: 'Traced the auth flow',
  learned: 'Token expiry was wrong',
  completed: 'Fixed token refresh',
  next_steps: 'Add tests',
  created_at_epoch: 1700000001000,
};

const mockObservations: Observation[] = [
  {
    id: 10,
    memory_session_id: SESSION_ID,
    project: PROJECT,
    type: 'code_change',
    title: 'Fixed auth',
    subtitle: null,
    narrative: null,
    text: 'Changed token expiry',
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: 'auth.ts',
    prompt_number: 1,
    created_at: '2024-01-01T00:00:00.000Z',
    created_at_epoch: 1700000002000,
  },
  {
    id: 11,
    memory_session_id: OTHER_SESSION_ID,
    project: PROJECT,
    type: 'tool_use',
    title: 'Read file',
    subtitle: null,
    narrative: null,
    text: null,
    facts: null,
    concepts: null,
    files_read: 'config.ts',
    files_modified: null,
    prompt_number: 2,
    created_at: '2024-01-01T00:01:00.000Z',
    created_at_epoch: 1700000003000,
  },
];

const mockPrompts: UserPrompt[] = [
  {
    id: 20,
    content_session_id: SESSION_ID,
    project: PROJECT,
    prompt_number: 1,
    prompt_text: 'Fix the login bug',
    created_at_epoch: 1700000000000,
  },
  {
    id: 21,
    content_session_id: OTHER_SESSION_ID,
    project: PROJECT,
    prompt_number: 2,
    prompt_text: 'Unrelated prompt',
    created_at_epoch: 1700000004000,
  },
];

// API response shape for all three endpoints
function makeApiResponse<T>(items: T[]) {
  return { items, hasMore: false, offset: 0, limit: 200 };
}

// ---------------------------------------------------------------------------
// fetchSessionDetail tests
// ---------------------------------------------------------------------------

describe('fetchSessionDetail', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns null when sessionId is null', async () => {
    const result = await fetchSessionDetail(null, PROJECT);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when sessionId is empty string', async () => {
    const result = await fetchSessionDetail('', PROJECT);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches observations, prompts, and summaries then filters by session_id', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([mockSummary])),
        });
      }
      if (u.pathname === '/api/observations') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse(mockObservations)),
        });
      }
      if (u.pathname === '/api/prompts') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse(mockPrompts)),
        });
      }
      return Promise.resolve({ ok: false, statusText: 'Not Found' });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT);

    expect(result).not.toBeNull();
    // Summary matches the session
    expect(result!.summary.session_id).toBe(SESSION_ID);
    // Only observations for this session
    expect(result!.observations).toHaveLength(1);
    expect(result!.observations[0].memory_session_id).toBe(SESSION_ID);
    // Only prompts for this session
    expect(result!.prompts).toHaveLength(1);
    expect(result!.prompts[0].content_session_id).toBe(SESSION_ID);
  });

  it('passes project filter to all three API calls', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeApiResponse([])),
    });

    await fetchSessionDetail(SESSION_ID, PROJECT);

    const urls = fetchMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toContain(`project=${PROJECT}`);
    }
  });

  it('returns null when summary is not found for the session_id', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        // Return summaries for a different session
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([
            { ...mockSummary, session_id: OTHER_SESSION_ID },
          ])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT);

    expect(result).toBeNull();
  });

  it('throws when observations API returns non-ok response', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/observations') {
        return Promise.resolve({ ok: false, statusText: 'Internal Server Error' });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    await expect(fetchSessionDetail(SESSION_ID, PROJECT)).rejects.toThrow();
  });

  it('throws when summaries API returns non-ok response', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        return Promise.resolve({ ok: false, statusText: 'Service Unavailable' });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    await expect(fetchSessionDetail(SESSION_ID, PROJECT)).rejects.toThrow();
  });

  it('throws when prompts API returns non-ok response', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/prompts') {
        return Promise.resolve({ ok: false, statusText: 'Bad Gateway' });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    await expect(fetchSessionDetail(SESSION_ID, PROJECT)).rejects.toThrow();
  });

  it('returns empty observations and prompts arrays when none match session_id', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([mockSummary])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT);

    expect(result).not.toBeNull();
    expect(result!.observations).toEqual([]);
    expect(result!.prompts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SessionDetailCache tests
// ---------------------------------------------------------------------------

describe('SessionDetailCache', () => {
  it('stores and retrieves a session detail by key', () => {
    const cache = new SessionDetailCache(5);
    const detail = {
      summary: mockSummary,
      observations: [],
      prompts: [],
    };

    cache.set(SESSION_ID, PROJECT, detail);
    const retrieved = cache.get(SESSION_ID, PROJECT);

    expect(retrieved).toEqual(detail);
  });

  it('returns undefined for a cache miss', () => {
    const cache = new SessionDetailCache(5);

    const result = cache.get('nonexistent-session', PROJECT);

    expect(result).toBeUndefined();
  });

  it('returns undefined when key exists for different project', () => {
    const cache = new SessionDetailCache(5);
    const detail = {
      summary: mockSummary,
      observations: [],
      prompts: [],
    };

    cache.set(SESSION_ID, PROJECT, detail);
    const result = cache.get(SESSION_ID, 'different-project');

    expect(result).toBeUndefined();
  });

  it('evicts the oldest entry when capacity is exceeded', () => {
    const cache = new SessionDetailCache(2);
    const makeDetail = (sessionId: string): { summary: Summary; observations: Observation[]; prompts: UserPrompt[] } => ({
      summary: { ...mockSummary, session_id: sessionId },
      observations: [],
      prompts: [],
    });

    cache.set('session-1', PROJECT, makeDetail('session-1'));
    cache.set('session-2', PROJECT, makeDetail('session-2'));
    // Adding a third entry should evict the first
    cache.set('session-3', PROJECT, makeDetail('session-3'));

    expect(cache.get('session-1', PROJECT)).toBeUndefined();
    expect(cache.get('session-2', PROJECT)).toBeDefined();
    expect(cache.get('session-3', PROJECT)).toBeDefined();
  });

  it('can hold up to capacity entries without eviction', () => {
    const cache = new SessionDetailCache(3);

    cache.set('session-1', PROJECT, { summary: { ...mockSummary, session_id: 'session-1' }, observations: [], prompts: [] });
    cache.set('session-2', PROJECT, { summary: { ...mockSummary, session_id: 'session-2' }, observations: [], prompts: [] });
    cache.set('session-3', PROJECT, { summary: { ...mockSummary, session_id: 'session-3' }, observations: [], prompts: [] });

    expect(cache.get('session-1', PROJECT)).toBeDefined();
    expect(cache.get('session-2', PROJECT)).toBeDefined();
    expect(cache.get('session-3', PROJECT)).toBeDefined();
  });

  it('overwrites existing entry on set with same key', () => {
    const cache = new SessionDetailCache(5);
    const detailV1 = { summary: { ...mockSummary, request: 'v1' }, observations: [], prompts: [] };
    const detailV2 = { summary: { ...mockSummary, request: 'v2' }, observations: [], prompts: [] };

    cache.set(SESSION_ID, PROJECT, detailV1);
    cache.set(SESSION_ID, PROJECT, detailV2);

    expect(cache.get(SESSION_ID, PROJECT)?.summary.request).toBe('v2');
  });

  it('respects a cache capacity of 5', () => {
    const cache = new SessionDetailCache(5);
    for (let i = 1; i <= 5; i++) {
      cache.set(`session-${i}`, PROJECT, {
        summary: { ...mockSummary, session_id: `session-${i}` },
        observations: [],
        prompts: [],
      });
    }

    // All 5 should be present
    for (let i = 1; i <= 5; i++) {
      expect(cache.get(`session-${i}`, PROJECT)).toBeDefined();
    }

    // Adding a 6th evicts session-1
    cache.set('session-6', PROJECT, { summary: { ...mockSummary, session_id: 'session-6' }, observations: [], prompts: [] });
    expect(cache.get('session-1', PROJECT)).toBeUndefined();
    expect(cache.get('session-6', PROJECT)).toBeDefined();
  });
});
