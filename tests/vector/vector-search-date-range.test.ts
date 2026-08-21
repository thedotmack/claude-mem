import { describe, it, expect, mock } from 'bun:test';
import { VectorSearchStrategy } from '../../src/services/worker/search/strategies/VectorSearchStrategy.js';

/**
 * Date-filtered semantic search.
 *
 * Callers hand this strategy ISO STRINGS: mcp-server declares dateStart /
 * dateEnd as strings and SearchOrchestrator.normalizeParams passes them through
 * uncoerced, so `epoch < dateRange.start` was comparing a number against a
 * string — Number('2026-01-01') is NaN, every comparison false, the range
 * excluding nothing.
 */

const DAY = 24 * 60 * 60 * 1000;

function epochOf(iso: string): number {
  return new Date(iso).getTime();
}

/** Ids the strategy asked SessionStore to hydrate, in order. */
async function hydratedIds(
  docs: Array<{ id: number; epoch: number }>,
  dateRange?: { start?: string | number; end?: string | number },
): Promise<number[]> {
  const queryChroma = mock(() => Promise.resolve({
    ids: docs.map((d) => d.id),
    distances: docs.map(() => 0.1),
    metadatas: docs.map((d) => ({ doc_type: 'observation', created_at_epoch: d.epoch })),
  }));

  let asked: number[] = [];
  const sessionStore = {
    getObservationsByIds: (ids: number[]) => {
      asked = ids;
      return ids.map((id) => ({ id }));
    },
    getSessionSummariesByIds: () => [],
    getUserPromptsByIds: () => [],
  };

  const strategy = new VectorSearchStrategy({ queryChroma } as any, sessionStore as any);
  await strategy.search({ query: 'anything', searchType: 'observations', dateRange } as any);
  return asked;
}

describe('VectorSearchStrategy date filtering', () => {
  it('honours an ISO-string date range instead of letting every row through', async () => {
    const inside = { id: 1, epoch: epochOf('2025-01-15T00:00:00Z') };
    const before = { id: 2, epoch: epochOf('2024-12-01T00:00:00Z') };
    const after = { id: 3, epoch: epochOf('2025-03-01T00:00:00Z') };

    const ids = await hydratedIds([inside, before, after], {
      start: '2025-01-01',
      end: '2025-01-31',
    });

    expect(ids).toEqual([inside.id]);
  });

  it('honours a numeric date range too', async () => {
    const inside = { id: 1, epoch: epochOf('2025-01-15T00:00:00Z') };
    const after = { id: 3, epoch: epochOf('2025-03-01T00:00:00Z') };

    const ids = await hydratedIds([inside, after], {
      start: epochOf('2025-01-01'),
      end: epochOf('2025-01-31'),
    });

    expect(ids).toEqual([inside.id]);
  });

  it('treats an end-only range as "everything up to that date", not "the last 90 days"', async () => {
    // Older than the 90-day recency default, so the default floor — if it were
    // applied to an end-only query — would drop it.
    const old = { id: 1, epoch: Date.now() - 400 * DAY };
    const afterTheEnd = { id: 2, epoch: Date.now() };
    const end = new Date(Date.now() - 30 * DAY).toISOString();

    const ids = await hydratedIds([old, afterTheEnd], { end });

    expect(ids).toEqual([old.id]);
  });

  it('still applies the 90-day recency default when no date range is given', async () => {
    const recent = { id: 1, epoch: Date.now() - 10 * DAY };
    const old = { id: 2, epoch: Date.now() - 400 * DAY };

    const ids = await hydratedIds([recent, old]);

    expect(ids).toEqual([recent.id]);
  });

  it('ignores an unparseable date bound rather than excluding everything', async () => {
    const recent = { id: 1, epoch: Date.now() - 10 * DAY };
    const old = { id: 2, epoch: Date.now() - 400 * DAY };

    const ids = await hydratedIds([recent, old], { start: 'not a date' });

    expect(ids).toEqual([recent.id, old.id]);
  });
});
