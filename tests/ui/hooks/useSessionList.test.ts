import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Summary } from '../../../src/ui/viewer/types.js';
import {
  mapSummaryToSessionListItem,
  groupSessionsByDay,
  buildSessionGroups,
  nextDayString,
} from '../../../src/ui/viewer/hooks/useSessionList.js';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeEpochForDate(dateStr: string): number {
  return new Date(dateStr).getTime();
}

function makeSummary(overrides: Partial<Summary> & { created_at_epoch: number }): Summary {
  return {
    id: 1,
    session_id: 'session-abc',
    project: 'test-project',
    request: 'Fix the bug',
    created_at_epoch: overrides.created_at_epoch,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// mapSummaryToSessionListItem
// ─────────────────────────────────────────────────────────

describe('mapSummaryToSessionListItem', () => {
  it('maps all fields correctly', () => {
    const summary = makeSummary({
      id: 42,
      session_id: 'sess-xyz',
      project: 'my-project',
      request: 'Implement auth',
      created_at_epoch: 1700000000000,
    });

    const item = mapSummaryToSessionListItem(summary);

    expect(item.id).toBe(42);
    expect(item.session_id).toBe('sess-xyz');
    expect(item.project).toBe('my-project');
    expect(item.request).toBe('Implement auth');
    expect(item.created_at_epoch).toBe(1700000000000);
    expect(item.status).toBe('completed');
  });

  it('maps observationCount as 0 when summary has no observation_count (e.g. SSE payload)', () => {
    const summary = makeSummary({ created_at_epoch: 1700000000000 });
    const item = mapSummaryToSessionListItem(summary);
    expect(item.observationCount).toBe(0);
  });

  it('uses observation_count from summary when present (DB-fetched summaries)', () => {
    const summary = makeSummary({ created_at_epoch: 1700000000000, observation_count: 7 });
    const item = mapSummaryToSessionListItem(summary);
    expect(item.observationCount).toBe(7);
  });

  it('uses observation_count of 0 when summary has observation_count explicitly set to 0', () => {
    const summary = makeSummary({ created_at_epoch: 1700000000000, observation_count: 0 });
    const item = mapSummaryToSessionListItem(summary);
    expect(item.observationCount).toBe(0);
  });

  it('preserves optional request as undefined when missing', () => {
    const summary = makeSummary({ created_at_epoch: 1700000000000 });
    delete summary.request;
    const item = mapSummaryToSessionListItem(summary);
    expect(item.request).toBeUndefined();
  });

  it('always sets status to completed', () => {
    const summary = makeSummary({ created_at_epoch: 1700000000000 });
    const item = mapSummaryToSessionListItem(summary);
    expect(item.status).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────
// groupSessionsByDay
// ─────────────────────────────────────────────────────────

describe('groupSessionsByDay', () => {
  // Pin "now" so grouping labels are deterministic
  const TODAY = new Date('2026-02-17T10:00:00Z');
  const YESTERDAY = new Date('2026-02-16T10:00:00Z');
  const OLDER = new Date('2026-02-15T10:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  it('labels sessions from today as "Today"', () => {
    const item = mapSummaryToSessionListItem(makeSummary({ id: 1, created_at_epoch: TODAY.getTime() }));
    const groups = groupSessionsByDay([item]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].dateKey).toBe('2026-02-17');
  });

  it('labels sessions from yesterday as "Yesterday"', () => {
    const item = mapSummaryToSessionListItem(makeSummary({ id: 2, created_at_epoch: YESTERDAY.getTime() }));
    const groups = groupSessionsByDay([item]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Yesterday');
    expect(groups[0].dateKey).toBe('2026-02-16');
  });

  it('formats older sessions as short date like "Feb 15"', () => {
    const item = mapSummaryToSessionListItem(makeSummary({ id: 3, created_at_epoch: OLDER.getTime() }));
    const groups = groupSessionsByDay([item]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Feb 15');
    expect(groups[0].dateKey).toBe('2026-02-15');
  });

  it('groups multiple sessions from the same day into one group', () => {
    const session1 = mapSummaryToSessionListItem(makeSummary({ id: 1, created_at_epoch: TODAY.getTime() }));
    const session2 = mapSummaryToSessionListItem(makeSummary({ id: 2, session_id: 's2', created_at_epoch: TODAY.getTime() + 3600000 }));
    const groups = groupSessionsByDay([session1, session2]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it('creates separate groups for sessions on different days', () => {
    const todayItem = mapSummaryToSessionListItem(makeSummary({ id: 1, created_at_epoch: TODAY.getTime() }));
    const yesterdayItem = mapSummaryToSessionListItem(makeSummary({ id: 2, session_id: 's2', created_at_epoch: YESTERDAY.getTime() }));
    const groups = groupSessionsByDay([todayItem, yesterdayItem]);

    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday']);
  });

  it('preserves insertion order of sessions within a group', () => {
    const first = mapSummaryToSessionListItem(makeSummary({ id: 10, created_at_epoch: TODAY.getTime() }));
    const second = mapSummaryToSessionListItem(makeSummary({ id: 20, session_id: 's2', created_at_epoch: TODAY.getTime() + 1000 }));
    const groups = groupSessionsByDay([first, second]);

    expect(groups[0].sessions[0].id).toBe(10);
    expect(groups[0].sessions[1].id).toBe(20);
  });

  it('returns empty array for empty input', () => {
    const groups = groupSessionsByDay([]);
    expect(groups).toHaveLength(0);
  });

  it('deduplicates groups by dateKey', () => {
    const session1 = mapSummaryToSessionListItem(makeSummary({ id: 1, created_at_epoch: TODAY.getTime() }));
    const session2 = mapSummaryToSessionListItem(makeSummary({ id: 2, session_id: 's2', created_at_epoch: TODAY.getTime() + 7200000 }));
    const groups = groupSessionsByDay([session1, session2]);

    const keys = groups.map(g => g.dateKey);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});

// ─────────────────────────────────────────────────────────
// buildSessionGroups (integration of map + group)
// ─────────────────────────────────────────────────────────

describe('buildSessionGroups', () => {
  const TODAY = new Date('2026-02-17T10:00:00Z');
  const YESTERDAY = new Date('2026-02-16T10:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  it('converts summaries into grouped SessionListItems', () => {
    const summaries: Summary[] = [
      makeSummary({ id: 1, created_at_epoch: TODAY.getTime() }),
      makeSummary({ id: 2, session_id: 's2', created_at_epoch: YESTERDAY.getTime() }),
    ];

    const groups = buildSessionGroups(summaries);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].sessions[0].id).toBe(1);
    expect(groups[1].label).toBe('Yesterday');
    expect(groups[1].sessions[0].id).toBe(2);
  });

  it('returns empty array for empty summaries', () => {
    expect(buildSessionGroups([])).toHaveLength(0);
  });

  it('all items in groups have status completed', () => {
    const summaries = [makeSummary({ id: 1, created_at_epoch: TODAY.getTime() })];
    const groups = buildSessionGroups(summaries);
    const allItems = groups.flatMap(g => g.sessions);
    expect(allItems.every(s => s.status === 'completed')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// fetch integration tests (mock fetch)
// ─────────────────────────────────────────────────────────

describe('fetchSessionPage (via fetch mock)', () => {
  const TODAY = new Date('2026-02-17T10:00:00Z');

  const mockSummaries: Summary[] = [
    { id: 1, session_id: 'sess-1', project: 'proj-a', request: 'First task', created_at_epoch: TODAY.getTime() },
    { id: 2, session_id: 'sess-2', project: 'proj-a', request: 'Second task', created_at_epoch: TODAY.getTime() - 3600000 },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches from /api/summaries with correct query params', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: mockSummaries, hasMore: false, offset: 0, limit: 50 }),
    } as Response);

    const { fetchSessionPage } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await fetchSessionPage({ offset: 0, limit: 50, project: '' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/summaries');
    expect(url).toContain('offset=0');
    expect(url).toContain('limit=50');
  });

  it('includes project filter in query when provided', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [], hasMore: false, offset: 0, limit: 50 }),
    } as Response);

    const { fetchSessionPage } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await fetchSessionPage({ offset: 0, limit: 50, project: 'my-project' });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('project=my-project');
  });

  it('omits project param when project is empty string', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [], hasMore: false, offset: 0, limit: 50 }),
    } as Response);

    const { fetchSessionPage } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await fetchSessionPage({ offset: 0, limit: 50, project: '' });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('project=');
  });

  it('returns mapped items and hasMore flag', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: mockSummaries, hasMore: true, offset: 0, limit: 50 }),
    } as Response);

    const { fetchSessionPage } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    const result = await fetchSessionPage({ offset: 0, limit: 50, project: '' });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.items[0].id).toBe(1);
    expect(result.items[0].status).toBe('completed');
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error',
    } as Response);

    const { fetchSessionPage } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await expect(fetchSessionPage({ offset: 0, limit: 50, project: '' }))
      .rejects.toThrow('Failed to load sessions');
  });
});

// ─────────────────────────────────────────────────────────
// prepend logic for SSE new_summary events
// ─────────────────────────────────────────────────────────

describe('prependSession', () => {
  const TODAY = new Date('2026-02-17T10:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  it('adds new session to the start of the most recent matching group', async () => {
    const { prependSession, groupSessionsByDay, mapSummaryToSessionListItem } = await import('../../../src/ui/viewer/hooks/useSessionList.js');

    const existing = [mapSummaryToSessionListItem(makeSummary({ id: 1, created_at_epoch: TODAY.getTime() }))];
    const groups = groupSessionsByDay(existing);

    const newSummary = makeSummary({ id: 99, session_id: 'new-sess', created_at_epoch: TODAY.getTime() + 100 });
    const updated = prependSession(groups, newSummary);

    expect(updated[0].sessions[0].id).toBe(99);
    expect(updated[0].sessions).toHaveLength(2);
  });

  it('creates a new group if the new session is from a different day', async () => {
    const { prependSession, groupSessionsByDay, mapSummaryToSessionListItem } = await import('../../../src/ui/viewer/hooks/useSessionList.js');

    const yesterday = new Date('2026-02-16T10:00:00Z');
    const existing = [mapSummaryToSessionListItem(makeSummary({ id: 1, created_at_epoch: yesterday.getTime() }))];
    const groups = groupSessionsByDay(existing);

    const newSummary = makeSummary({ id: 99, session_id: 'new-sess', created_at_epoch: TODAY.getTime() });
    const updated = prependSession(groups, newSummary);

    expect(updated).toHaveLength(2);
    expect(updated[0].label).toBe('Today');
    expect(updated[0].sessions[0].id).toBe(99);
  });

  it('handles prepending to empty groups array', async () => {
    const { prependSession } = await import('../../../src/ui/viewer/hooks/useSessionList.js');

    const newSummary = makeSummary({ id: 1, created_at_epoch: TODAY.getTime() });
    const updated = prependSession([], newSummary);

    expect(updated).toHaveLength(1);
    expect(updated[0].sessions[0].id).toBe(1);
  });

  it('uses observation_count from summary when present, ignoring sseObservationCount', async () => {
    const { prependSession } = await import('../../../src/ui/viewer/hooks/useSessionList.js');

    // Summary has DB-accurate observation_count of 5
    const newSummary = makeSummary({ id: 1, session_id: 'sess-1', created_at_epoch: TODAY.getTime(), observation_count: 5 });
    const updated = prependSession([], newSummary, 99);

    // DB count (5) should take priority over SSE count (99)
    expect(updated[0].sessions[0].observationCount).toBe(5);
  });

  it('uses sseObservationCount when summary lacks observation_count (SSE-delivered summary)', async () => {
    const { prependSession } = await import('../../../src/ui/viewer/hooks/useSessionList.js');

    // SSE-delivered summary has no observation_count
    const newSummary = makeSummary({ id: 1, session_id: 'sess-1', created_at_epoch: TODAY.getTime() });
    delete newSummary.observation_count;
    const updated = prependSession([], newSummary, 3);

    expect(updated[0].sessions[0].observationCount).toBe(3);
  });

  it('falls back to 0 when summary lacks observation_count and no sseObservationCount provided', async () => {
    const { prependSession } = await import('../../../src/ui/viewer/hooks/useSessionList.js');

    const newSummary = makeSummary({ id: 1, session_id: 'sess-1', created_at_epoch: TODAY.getTime() });
    delete newSummary.observation_count;
    const updated = prependSession([], newSummary);

    expect(updated[0].sessions[0].observationCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// nextDayString
// ─────────────────────────────────────────────────────────

describe('nextDayString', () => {
  it('returns the next day for a mid-month date', () => {
    expect(nextDayString('2026-02-17')).toBe('2026-02-18');
  });

  it('handles month rollover (Jan 31 → Feb 1)', () => {
    expect(nextDayString('2026-01-31')).toBe('2026-02-01');
  });

  it('handles year rollover (Dec 31 → Jan 1)', () => {
    expect(nextDayString('2025-12-31')).toBe('2026-01-01');
  });

  it('handles Feb 28 non-leap year (→ Mar 1)', () => {
    expect(nextDayString('2025-02-28')).toBe('2025-03-01');
  });

  it('handles Feb 28 leap year (→ Feb 29)', () => {
    expect(nextDayString('2024-02-28')).toBe('2024-02-29');
  });

  it('handles Feb 29 leap year (→ Mar 1)', () => {
    expect(nextDayString('2024-02-29')).toBe('2024-03-01');
  });
});

// ─────────────────────────────────────────────────────────
// fetchSessionsByDate
// ─────────────────────────────────────────────────────────

describe('fetchSessionsByDate', () => {
  const TODAY = new Date('2026-02-17T10:00:00Z');

  const mockSearchResponse = {
    sessions: [
      { id: 1, memory_session_id: 'sess-1', project: 'proj-a', request: 'Task A', created_at_epoch: TODAY.getTime(), observation_count: 5 },
      { id: 2, memory_session_id: 'sess-2', project: 'proj-a', request: 'Task B', created_at_epoch: TODAY.getTime() - 3600000, observation_count: 3 },
    ],
    observations: [],
    prompts: [],
    totalResults: 2,
    query: '',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches from /api/search with dateStart and next-day dateEnd for full-day coverage', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockSearchResponse,
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await fetchSessionsByDate('2026-02-17', 'proj-a');

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/api/search');
    expect(url).toContain('dateStart=2026-02-17');
    expect(url).toContain('dateEnd=2026-02-18');
    expect(url).toContain('project=proj-a');
  });

  it('omits project param when project is empty', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockSearchResponse,
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await fetchSessionsByDate('2026-02-17', '');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('project=');
  });

  it('maps memory_session_id to session_id from search API response', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockSearchResponse,
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    const result = await fetchSessionsByDate('2026-02-17', 'proj-a');

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[0].session_id).toBe('sess-1');
    expect(result[0].status).toBe('completed');
    expect(result[0].observationCount).toBe(5);
    expect(result[1].session_id).toBe('sess-2');
  });

  it('prefers session_id over memory_session_id when both present', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [{ id: 1, session_id: 'content-id', memory_session_id: 'mem-id', project: 'p', request: null, created_at_epoch: TODAY.getTime() }],
        observations: [],
        prompts: [],
        totalResults: 1,
        query: '',
      }),
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    const result = await fetchSessionsByDate('2026-02-17', '');

    expect(result[0].session_id).toBe('content-id');
  });

  it('returns empty array when search returns no sessions', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessions: [], observations: [], prompts: [], totalResults: 0, query: '' }),
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    const result = await fetchSessionsByDate('2026-02-17', 'proj-a');

    expect(result).toHaveLength(0);
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Server Error',
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    await expect(fetchSessionsByDate('2026-02-17', 'proj-a'))
      .rejects.toThrow('Failed to load sessions for date');
  });

  it('defaults observationCount to 0 when search result lacks observation_count', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [{ id: 1, memory_session_id: 'sess-1', project: 'p', request: null, created_at_epoch: TODAY.getTime() }],
        observations: [],
        prompts: [],
        totalResults: 1,
        query: '',
      }),
    } as Response);

    const { fetchSessionsByDate } = await import('../../../src/ui/viewer/hooks/useSessionList.js');
    const result = await fetchSessionsByDate('2026-02-17', '');

    expect(result[0].observationCount).toBe(0);
  });
});

