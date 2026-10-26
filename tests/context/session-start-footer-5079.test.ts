import { describe, expect, it } from 'bun:test';
import { sessionStartBannerFooter } from '../../src/cli/handlers/context.js';
import { CONTEXT_OUTPUT_LIMIT, TERMINAL_BANNER_RESERVE_CHARS } from '../../src/services/context/ContextBudget.js';
import { fitContextForDelivery } from '../../src/services/context/ContextBuilder.js';
import { TEAMBRAIN_DISCOVERY_LINE } from '../../src/shared/teambrain.js';
import type { ContextConfig, Observation } from '../../src/services/context/types.js';

// The SessionStart hook appends this footer to the terminal preview inside one
// `systemMessage`, which Claude Code caps at 10,000 characters (#5079).
describe('SessionStart systemMessage stays within the field cap (#5079)', () => {
  const footer = sessionStartBannerFooter(
    'http://localhost:37777',
    'claude-mem free trial: 30 days left',
    TEAMBRAIN_DISCOVERY_LINE,
  );

  it('fits the longest footer the hook composes in the reserved room', () => {
    expect(footer.length).toBeLessThanOrEqual(TERMINAL_BANNER_RESERVE_CHARS);
  });

  it('keeps preview plus footer within the limit when the preview is full', () => {
    const observations = Array.from({ length: 200 }, (_, i) => ({ id: i }) as unknown as Observation);
    const config = { fullObservationCount: 0, showLastSummary: false, showLastMessage: false, sessionCount: 0 } as ContextConfig;
    const render = (items: Observation[]) => items.map(() => 'x'.repeat(80)).join('\n');
    const { text } = fitContextForDelivery(
      observations, [], config, '', render, CONTEXT_OUTPUT_LIMIT, false,
      (items) => items.map(() => 'y'.repeat(120)).join('\n'),
    );
    expect(text.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT - TERMINAL_BANNER_RESERVE_CHARS - 200);
    expect(text.length + footer.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
  });
});
