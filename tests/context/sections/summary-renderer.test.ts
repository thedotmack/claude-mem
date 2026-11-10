import { describe, it, expect } from 'bun:test';
import { shouldShowSummary } from '../../../src/services/context/sections/SummaryRenderer.js';
import type { ContextConfig, Observation, SessionSummary } from '../../../src/services/context/types.js';

describe('shouldShowSummary', () => {
  it.each([
    ['same-batch timestamp', true, 5000, 5000, true, true],
    ['strictly newer observation', true, 5000, 6000, true, false],
    ['newer summary', true, 6000, 5000, true, true],
    ['no observation', true, 1735732800000, undefined, true, true],
    ['disabled', false, 1735732800000, undefined, true, false],
    ['empty summary', true, 1735732800000, undefined, false, false],
  ] as [string, boolean, number, number | undefined, boolean, boolean][])('%s', (_, showLastSummary, summaryEpoch, observationEpoch, content, expected) => {
    const summary = {
      created_at_epoch: summaryEpoch,
      request: 'Test request',
      investigated: content ? 'Investigated things' : null,
      learned: content ? 'Learned things' : null,
      completed: content ? 'Completed things' : null,
      next_steps: content ? 'Next steps' : null,
    } as SessionSummary;
    const observation = observationEpoch === undefined ? undefined : { created_at_epoch: observationEpoch } as Observation;
    expect(shouldShowSummary({ showLastSummary } as ContextConfig, summary, observation)).toBe(expected);
  });
});
