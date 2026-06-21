import { describe, it, expect } from 'bun:test';
import { prepareSummariesForTimeline } from '../../src/services/context/ObservationCompiler.js';
import type { SessionSummary } from '../../src/services/context/types.js';

function createSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const epoch = overrides.created_at_epoch ?? 0;
  return {
    id: 0,
    memory_session_id: 'sess',
    request: null,
    investigated: null,
    learned: null,
    completed: null,
    next_steps: null,
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
    ...overrides,
  };
}

describe('prepareSummariesForTimeline', () => {
  // Summaries are stored newest-first and rendered as "Session started" markers,
  // so each one is back-dated to the start of its session (the next-older
  // summary's creation time) — including the newest displayed summary.
  it('back-dates the newest displayed summary to the next-older summary', () => {
    const s1 = createSummary({ id: 1, created_at_epoch: 300 }); // newest
    const s2 = createSummary({ id: 2, created_at_epoch: 200 });
    const s3 = createSummary({ id: 3, created_at_epoch: 100 }); // lookahead

    const result = prepareSummariesForTimeline([s1, s2], [s1, s2, s3]);

    // Newest summary anchors at s2 (its session start), not its own epoch (300).
    expect(result[0].displayEpoch).toBe(200);
    expect(result[0].displayTime).toBe(s2.created_at);
    // Next summary anchors at the over-fetched lookahead s3.
    expect(result[1].displayEpoch).toBe(100);
    expect(result[1].displayTime).toBe(s3.created_at);
  });

  it('marks only the most recent summary as not linkable', () => {
    const s1 = createSummary({ id: 1, created_at_epoch: 300 });
    const s2 = createSummary({ id: 2, created_at_epoch: 200 });
    const s3 = createSummary({ id: 3, created_at_epoch: 100 });

    const result = prepareSummariesForTimeline([s1, s2], [s1, s2, s3]);

    expect(result[0].shouldShowLink).toBe(false); // most recent
    expect(result[1].shouldShowLink).toBe(true);
  });

  it('falls back to a summary\'s own time when there is no older neighbor', () => {
    const only = createSummary({ id: 1, created_at_epoch: 300 });

    const result = prepareSummariesForTimeline([only], [only]);

    expect(result[0].displayEpoch).toBe(300);
    expect(result[0].displayTime).toBe(only.created_at);
  });
});
