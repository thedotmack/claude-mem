import { describe, it, expect } from 'bun:test';
import {
  fitContextToBudget,
  CONTEXT_OUTPUT_LIMIT,
} from '../../src/services/context/ContextBudget.js';
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
