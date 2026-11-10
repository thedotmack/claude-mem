import { beforeEach, describe, expect, it } from 'bun:test';
import { CONTEXT_OUTPUT_LIMIT, fitContextToBudget } from '../../src/services/context/ContextBudget.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { renderContextFromRows } from '../../src/services/context/ContextBuilder.js';
import type { ContextConfig, Observation, SessionSummary } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 50, fullObservationCount: 0, sessionCount: 0,
  showReadTokens: false, showWorkTokens: false, observationTypes: new Set(),
  observationConcepts: new Set(), fullObservationField: 'narrative',
  showLastSummary: false, showLastMessage: false, mainAgentOnly: false,
};

function observation(id: number): Observation {
  const epoch = Date.UTC(2026, 0, 20) - id * 60_000;
  return {
    id, memory_session_id: `memory-${id}`, type: 'discovery',
    title: `Observation ${id}: ${'x'.repeat(360 + (id % 3) * 80)}`,
    subtitle: null, narrative: null, facts: null, concepts: null,
    files_read: null, files_modified: null, discovery_tokens: 0,
    created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
  };
}

function summary(id: number): SessionSummary {
  const epoch = Date.UTC(2026, 0, 19) - id * 60_000;
  return {
    id, memory_session_id: `summary-memory-${id}`,
    request: `Summary ${id}: ${'s'.repeat(950 + (id % 3) * 60)}`,
    investigated: null, learned: null, completed: null, next_steps: null,
    created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
  };
}

const scope = (cfg: ContextConfig) => ({ config: cfg, cwd: process.cwd() });
function unlimited(observations: Observation[], summaries: SessionSummary[], cfg: ContextConfig): string {
  return renderContextFromRows({ observations, summaries }, {
    full: true, includeHealthWarning: false,
  }, false, scope(cfg)).text;
}

describe('context budget retains the largest fitting timeline prefix', () => {
  beforeEach(() => ModeManager.getInstance().loadMode('code'));
  for (const reserveChars of [0, 700]) {
    it(`keeps every observation that fits the actual agent render (${reserveChars} reserved characters)`, () => {
      const observations = Array.from({ length: 30 }, (_, i) => observation(i + 1));
      const limit = CONTEXT_OUTPUT_LIMIT - reserveChars;
      const expected = observations.reduce((count, _, i) =>
        unlimited(observations.slice(0, i + 1), [], config).length <= limit ? i + 1 : count, 0);
      expect(expected).toBeGreaterThan(15);
      expect(expected).toBeLessThan(30);

      const result = renderContextFromRows({ observations, summaries: [] }, {
        includeHealthWarning: false, reserveChars,
      }, false, scope(config));

      expect(result.stats?.observation_count).toBe(expected);
      expect(result.text).toBe(unlimited(observations.slice(0, expected), [], config));
      expect(result.text.length).toBeLessThanOrEqual(limit);
      expect(unlimited(observations.slice(0, expected + 1), [], config).length).toBeGreaterThan(limit);
    });
  }

  it('keeps the largest fitting session prefix before reducing observations', () => {
    const observations = [observation(1), observation(2)];
    const summaries = Array.from({ length: 12 }, (_, i) => summary(i + 1));
    const cfg = { ...config, sessionCount: summaries.length };
    const expected = summaries.reduce((count, _, i) =>
      unlimited(observations, summaries, { ...cfg, sessionCount: i + 1 }).length <= CONTEXT_OUTPUT_LIMIT
        ? i + 1 : count, 0);
    expect(expected).toBeGreaterThan(6);
    expect(expected).toBeLessThan(12);

    const result = renderContextFromRows({ observations, summaries }, {
      includeHealthWarning: false,
    }, false, scope(cfg));

    expect(result.text).toBe(unlimited(observations, summaries, { ...cfg, sessionCount: expected }));
    expect(result.stats?.observation_count).toBe(observations.length);
    expect(result.text.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
  });

  it('refines a coarse reduction with logarithmically many render probes', () => {
    const items = Array.from({ length: 4096 }, (_, i) => i);
    let renders = 0;
    const result = fitContextToBudget(items, config, rows => {
      renders++;
      return 'x'.repeat(rows.length);
    }, 3001);
    expect(result.observationCount).toBe(3001);
    expect(renders).toBeLessThanOrEqual(14);
    expect(result.overBudget).toBe(false);
    expect(config.sessionCount).toBe(0);
  });
});
