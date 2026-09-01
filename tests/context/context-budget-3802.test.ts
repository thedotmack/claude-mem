import { describe, it, expect } from 'bun:test';
import {
  fitContextToBudget,
  CONTEXT_OUTPUT_LIMIT,
} from '../../src/services/context/ContextBudget.js';
import { fitContextForDelivery } from '../../src/services/context/ContextBuilder.js';
import type { Observation, SessionSummary } from '../../src/services/context/types.js';
import type { ContextConfig } from '../../src/services/context/types.js';

// #3802 — the SessionStart block was sized by item counts, so on an active
// project it went past Claude Code's 10,000-character per-hook-output limit and
// the model silently received a ~2KB stub instead of any context at all.

function makeConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 3,
    sessionCount: 10,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: false,
    observationTypes: new Set<string>(),
    observationConcepts: new Set<string>(),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
    ...overrides,
  } as ContextConfig;
}

/**
 * Stands in for buildContextOutput with the cost profile the issue measured:
 * a fixed header and footer, ~200 characters per observation title, ~1,200 more
 * for each full narrative, ~400 per session line, and a 3,000-character
 * last-session summary block.
 */
function render(items: number[], config: ContextConfig): string {
  const header = 'H'.repeat(300);
  const titles = items.length * 200;
  const fulls = Math.min(config.fullObservationCount, items.length) * 1200;
  const sessions = config.sessionCount * 400;
  const summary = config.showLastSummary ? 3000 : 0;
  const footer = 'F'.repeat(200);
  return header + 'x'.repeat(titles + fulls + sessions + summary) + footer;
}

const items = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('context output budget (#3802)', () => {
  it('leaves a block that already fits completely alone', () => {
    const config = makeConfig({ fullObservationCount: 1, sessionCount: 2, showLastSummary: false });
    const result = fitContextToBudget(items(5), config, render);

    expect(result.reductions).toBe(0);
    expect(result.observationCount).toBe(5);
    expect(result.config).toBe(config);
    expect(result.text.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
  });

  it('fits a busy project that overflows on the plugin defaults', () => {
    // 50 observations at the shipped defaults: ~10,000 of titles alone, plus
    // full narratives, ten session lines and the summary block.
    const before = render(items(50), makeConfig());
    expect(before.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT);

    const result = fitContextToBudget(items(50), makeConfig(), render);
    expect(result.text.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(result.overBudget).toBe(false);
  });

  it('gives up full narratives before it gives up timeline entries', () => {
    const result = fitContextToBudget(items(20), makeConfig(), render);

    expect(result.config.fullObservationCount).toBe(0);
    expect(result.observationCount).toBeGreaterThan(1);
  });

  it('gives up the last-session summary before it gives up observations', () => {
    // 40 titles (8,000) + the 3,000-character summary block is over the limit;
    // dropping the block alone brings it back to 8,500.
    const config = makeConfig({ fullObservationCount: 0, sessionCount: 0 });
    expect(render(items(40), config).length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT);

    const result = fitContextToBudget(items(40), config, render);
    expect(result.config.showLastSummary).toBe(false);
    expect(result.observationCount).toBe(40);
  });

  it('keeps at least one observation and says so when nothing more can go', () => {
    const huge = (items: number[]) => 'x'.repeat(20_000 + items.length);
    const result = fitContextToBudget(items(10), makeConfig(), huge);

    expect(result.observationCount).toBe(1);
    expect(result.overBudget).toBe(true);
    expect(result.text.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT);
  });

  it('honours an explicit unlimited budget', () => {
    const result = fitContextToBudget(items(50), makeConfig(), render, Number.POSITIVE_INFINITY);

    expect(result.reductions).toBe(0);
    expect(result.observationCount).toBe(50);
  });

  it('never returns a text longer than the one it started from', () => {
    const config = makeConfig();
    const first = render(items(50), config);
    const result = fitContextToBudget(items(50), config, render);

    expect(result.text.length).toBeLessThanOrEqual(first.length);
  });
});

// ── what happens around the fitter ────────────────────────────────
//
// Both of these are about the block that is actually DELIVERED. The fitter
// itself was already correct; the delivered block was not, because a warning
// was appended after fitting and the stats were computed before it.

function obs(i: number): Observation {
  return {
    id: i,
    memory_session_id: `session-${i}`,
    type: 'discovery',
    title: 'T'.repeat(200),
    narrative: 'N'.repeat(1200),
    created_at_epoch: 1_700_000_000 + i,
  } as unknown as Observation;
}

function summary(i: number): SessionSummary {
  return { id: i, memory_session_id: `session-${i}` } as unknown as SessionSummary;
}

/** Cost profile of the real renderer, ignoring the summaries it is handed. */
function renderBlock(items: Observation[], config: ContextConfig): string {
  const titles = items.length * 200;
  const fulls = Math.min(config.fullObservationCount, items.length) * 1200;
  const sessions = config.sessionCount * 400;
  const lastSummary = config.showLastSummary ? 3000 : 0;
  return 'x'.repeat(300 + titles + fulls + sessions + lastSummary + 200);
}

describe('what the fitted block delivers (#3811 review)', () => {
  const WARNING = 'W'.repeat(600);

  // 47 observations render to 9,900 characters under this config, so the block
  // fits on its own and needs no reduction -- and 9,900 + a 600-character
  // warning does not. That is the whole discriminator: with the warning inside
  // the measured block the fitter gives something up, and without it the block
  // is delivered 500 characters over the limit and replaced by the stub.
  const NEAR_LIMIT = makeConfig({
    fullObservationCount: 0,
    sessionCount: 0,
    showLastSummary: false,
  });

  it('counts the observer-health warning against the budget', () => {
    // Without the warning this input fits at just under the limit, so a warning
    // appended afterwards is the whole difference between delivered and stubbed.
    const delivered = fitContextForDelivery(
      Array.from({ length: 47 }, (_, i) => obs(i)),
      [],
      NEAR_LIMIT,
      WARNING,
      renderBlock,
      CONTEXT_OUTPUT_LIMIT,
      false,
    );

    expect(delivered.text).toContain(WARNING);
    expect(delivered.text.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
  });

  it('leaves the block alone when the observer is healthy', () => {
    const withWarning = fitContextForDelivery(
      Array.from({ length: 47 }, (_, i) => obs(i)),
      [],
      NEAR_LIMIT,
      WARNING,
      renderBlock,
      CONTEXT_OUTPUT_LIMIT,
      false,
    );
    const healthy = fitContextForDelivery(
      Array.from({ length: 47 }, (_, i) => obs(i)),
      [],
      NEAR_LIMIT,
      '',
      renderBlock,
      CONTEXT_OUTPUT_LIMIT,
      false,
    );

    expect(healthy.text).not.toContain('W');
    // The warning costs budget, so the healthy block is allowed to carry more.
    expect(healthy.stats.observation_count).toBeGreaterThanOrEqual(
      withWarning.stats.observation_count,
    );
  });

  it('reports the observations it delivered, not the ones it queried', () => {
    const queried = Array.from({ length: 50 }, (_, i) => obs(i));
    const delivered = fitContextForDelivery(
      queried,
      [],
      makeConfig(),
      '',
      renderBlock,
      CONTEXT_OUTPUT_LIMIT,
      false,
    );

    expect(delivered.stats.observation_count).toBeLessThan(queried.length);
    expect(delivered.stats.session_count).toBe(delivered.stats.observation_count);
    expect(
      delivered.stats.obs_type_bugfix +
        delivered.stats.obs_type_discovery +
        delivered.stats.obs_type_decision +
        delivered.stats.obs_type_refactor +
        delivered.stats.obs_type_other,
    ).toBe(delivered.stats.observation_count);
  });

  it('reports a session summary only when one survived the reduction', () => {
    // The fitter drops `sessionCount` to 0 long before it starts dropping
    // observations, so a run trimmed this hard delivers no summary at all.
    const delivered = fitContextForDelivery(
      Array.from({ length: 50 }, (_, i) => obs(i)),
      Array.from({ length: 10 }, (_, i) => summary(i)),
      makeConfig(),
      '',
      renderBlock,
      CONTEXT_OUTPUT_LIMIT,
      false,
    );

    expect(delivered.stats.has_session_summary).toBe(false);
  });

  it('reports everything when nothing had to be given up', () => {
    const queried = Array.from({ length: 3 }, (_, i) => obs(i));
    const delivered = fitContextForDelivery(
      queried,
      [summary(0)],
      makeConfig({ fullObservationCount: 0, sessionCount: 1, showLastSummary: false }),
      '',
      renderBlock,
      CONTEXT_OUTPUT_LIMIT,
      false,
    );

    expect(delivered.stats.observation_count).toBe(3);
    expect(delivered.stats.has_session_summary).toBe(true);
  });
});
