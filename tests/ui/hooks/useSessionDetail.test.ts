/**
 * Tests for useSessionDetail hook
 *
 * Tests the core session-detail fetching and caching logic used by the hook.
 * The hook wraps these pure functions with React state management.
 *
 * We test the pure functions directly (no DOM/React needed) since vitest
 * runs without a browser environment and @testing-library/react is not installed.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('fetches observations, prompts, and summaries with server-side session_id filter', async () => {
    // Server-side filtering: API returns only items for the requested session_id
    const sessionObservations = mockObservations.filter(o => o.memory_session_id === SESSION_ID);
    const sessionPrompts = mockPrompts.filter(p => p.content_session_id === SESSION_ID);

    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      // Verify session_id is passed to API
      expect(u.searchParams.get('session_id')).toBe(SESSION_ID);

      if (u.pathname === '/api/summaries') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([mockSummary])),
        });
      }
      if (u.pathname === '/api/observations') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse(sessionObservations)),
        });
      }
      if (u.pathname === '/api/prompts') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse(sessionPrompts)),
        });
      }
      return Promise.resolve({ ok: false, statusText: 'Not Found' });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT, mockSummary.id);

    expect(result).not.toBeNull();
    expect(result!.summary!.session_id).toBe(SESSION_ID);
    expect(result!.observations).toHaveLength(1);
    expect(result!.observations[0].memory_session_id).toBe(SESSION_ID);
    expect(result!.prompts).toHaveLength(1);
    expect(result!.prompts[0].content_session_id).toBe(SESSION_ID);
  });

  it('passes session_id and project to all three API calls', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeApiResponse([])),
    });

    await fetchSessionDetail(SESSION_ID, PROJECT);

    const urls = fetchMock.mock.calls.map((call: unknown[]) => call[0] as string);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toContain(`session_id=${SESSION_ID}`);
      expect(url).toContain(`project=${PROJECT}`);
    }
  });

  it('passes summary_id to observations and prompts APIs when summaryId is provided', async () => {
    const SUMMARY_ID = 42;
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([{ ...mockSummary, id: SUMMARY_ID }])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    await fetchSessionDetail(SESSION_ID, PROJECT, SUMMARY_ID);

    const urls = fetchMock.mock.calls.map((call: unknown[]) => call[0] as string);
    const summariesUrl = urls.find((u: string) => u.includes('/api/summaries'));
    const observationsUrl = urls.find((u: string) => u.includes('/api/observations'));
    const promptsUrl = urls.find((u: string) => u.includes('/api/prompts'));

    // summary_id should NOT be on summaries endpoint (it fetches all summaries for the session)
    expect(summariesUrl).not.toContain('summary_id=');
    // summary_id SHOULD be on observations and prompts endpoints
    expect(observationsUrl).toContain(`summary_id=${SUMMARY_ID}`);
    expect(promptsUrl).toContain(`summary_id=${SUMMARY_ID}`);
  });

  it('finds the specific summary by id when summaryId is provided', async () => {
    const SUMMARY_ID = 99;
    const targetSummary = { ...mockSummary, id: SUMMARY_ID, request: 'target summary' };
    const otherSummary = { ...mockSummary, id: 1, request: 'other summary' };

    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([otherSummary, targetSummary])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT, SUMMARY_ID);

    expect(result).not.toBeNull();
    expect(result!.summary.id).toBe(SUMMARY_ID);
    expect(result!.summary.request).toBe('target summary');
  });

  it('returns null when server returns no summary AND no observations/prompts', async () => {
    fetchMock.mockImplementation(() => {
      // Server-side filtering returns empty results when session not found
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT);

    expect(result).toBeNull();
  });

  it('returns observations and prompts with null summary for active/unsummarized sessions', async () => {
    const sessionObservations = mockObservations.filter(o => o.memory_session_id === SESSION_ID);
    const sessionPrompts = mockPrompts.filter(p => p.content_session_id === SESSION_ID);

    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        // No summary exists for active session
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([])),
        });
      }
      if (u.pathname === '/api/observations') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse(sessionObservations)),
        });
      }
      if (u.pathname === '/api/prompts') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse(sessionPrompts)),
        });
      }
      return Promise.resolve({ ok: false, statusText: 'Not Found' });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT);

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.observations).toHaveLength(1);
    expect(result!.observations[0].memory_session_id).toBe(SESSION_ID);
    expect(result!.prompts).toHaveLength(1);
    expect(result!.prompts[0].content_session_id).toBe(SESSION_ID);
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

    const result = await fetchSessionDetail(SESSION_ID, PROJECT, mockSummary.id);

    expect(result).not.toBeNull();
    expect(result!.observations).toEqual([]);
    expect(result!.prompts).toEqual([]);
  });

  it('does NOT include summary_id param when no summaryId is provided (fetches all session observations)', async () => {
    // When no summaryId is given, the detail view should include ALL observations for the session,
    // including any observations that were created before the first summary existed (pre-summary obs).
    // The server handles this: without summary_id, it returns all observations for the session_id.
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeApiResponse([])),
    });

    await fetchSessionDetail(SESSION_ID, PROJECT);

    const urls = fetchMock.mock.calls.map((call: unknown[]) => call[0] as string);
    for (const url of urls) {
      expect(url).not.toContain('summary_id=');
    }
  });

  it('includes pre-summary observations when no summaryId is provided', async () => {
    // Pre-summary observations have created_at_epoch BEFORE the summary's epoch.
    // The server returns them because without summary_id, it fetches all observations for the session.
    const preSummaryObservation: Observation = {
      ...mockObservations[0],
      id: 99,
      memory_session_id: SESSION_ID,
      // Observation created before the summary
      created_at_epoch: mockSummary.created_at_epoch - 5000,
    };

    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/summaries') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([mockSummary])),
        });
      }
      if (u.pathname === '/api/observations') {
        // Server returns pre-summary observations when queried by session_id
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(makeApiResponse([preSummaryObservation])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    const result = await fetchSessionDetail(SESSION_ID, PROJECT);

    expect(result).not.toBeNull();
    expect(result!.observations).toHaveLength(1);
    expect(result!.observations[0].id).toBe(99);
    expect(result!.observations[0].created_at_epoch).toBeLessThan(mockSummary.created_at_epoch);
  });

  it('forwards AbortSignal to all three fetch calls when signal is provided', async () => {
    const controller = new AbortController();

    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeApiResponse([mockSummary])),
    });

    await fetchSessionDetail(SESSION_ID, PROJECT, mockSummary.id, controller.signal);

    // All 3 fetch calls (summaries, observations, prompts) should receive the signal
    for (const call of fetchMock.mock.calls) {
      const fetchInit = call[1] as RequestInit | undefined;
      expect(fetchInit?.signal).toBe(controller.signal);
    }
  });

  it('rejects when signal is aborted before fetch completes', async () => {
    const controller = new AbortController();
    controller.abort();

    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([])),
      });
    });

    await expect(fetchSessionDetail(SESSION_ID, PROJECT, mockSummary.id, controller.signal))
      .rejects.toThrow('aborted');
  });

  it('first summary fetches observations from epoch 0 (no lower bound) when no summaryId given', async () => {
    // When summaryId is absent from the request, the server queries all observations for the session.
    // This is the correct behavior for the first summary's detail view:
    // all pre-summary observations (epoch > 0) should be visible.
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(url, 'http://localhost');
      if (u.pathname === '/api/observations') {
        // Confirm no epoch filtering is applied on the client — the server handles it
        const hasSummaryId = u.searchParams.has('summary_id');
        expect(hasSummaryId).toBe(false);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(makeApiResponse([mockSummary])),
      });
    });

    await fetchSessionDetail(SESSION_ID, PROJECT);
    // If we reach here without assertion failures, the epoch logic is correct
    expect(fetchMock).toHaveBeenCalled();
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

  it('caches different summaryIds separately for the same session', () => {
    const cache = new SessionDetailCache(5);
    const detail1 = {
      summary: { ...mockSummary, id: 10, request: 'summary 10' },
      observations: [],
      prompts: [],
    };
    const detail2 = {
      summary: { ...mockSummary, id: 20, request: 'summary 20' },
      observations: [],
      prompts: [],
    };

    cache.set(SESSION_ID, PROJECT, detail1, 10);
    cache.set(SESSION_ID, PROJECT, detail2, 20);

    const retrieved1 = cache.get(SESSION_ID, PROJECT, 10);
    const retrieved2 = cache.get(SESSION_ID, PROJECT, 20);

    expect(retrieved1?.summary.request).toBe('summary 10');
    expect(retrieved2?.summary.request).toBe('summary 20');
  });

  it('returns undefined when summaryId does not match cached entry', () => {
    const cache = new SessionDetailCache(5);
    const detail = {
      summary: { ...mockSummary, id: 10 },
      observations: [],
      prompts: [],
    };

    cache.set(SESSION_ID, PROJECT, detail, 10);

    expect(cache.get(SESSION_ID, PROJECT, 10)).toBeDefined();
    expect(cache.get(SESSION_ID, PROJECT, 99)).toBeUndefined();
    expect(cache.get(SESSION_ID, PROJECT)).toBeUndefined();
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
