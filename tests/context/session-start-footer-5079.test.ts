import { describe, expect, it } from 'bun:test';
import { composeSessionStartSystemMessage, sessionStartBannerFooter } from '../../src/cli/handlers/context.js';
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

  // The worker-outage notice is joined in front, and a server-runtime viewer
  // URL has no length bound; neither fits in the fixed reserve, so the whole
  // message is measured and the preview cut at a line boundary.
  const fullPreview = () => {
    const observations = Array.from({ length: 200 }, (_, i) => ({ id: i }) as unknown as Observation);
    const config = { fullObservationCount: 0, showLastSummary: false, showLastMessage: false, sessionCount: 0 } as ContextConfig;
    const render = (items: Observation[]) => items.map(() => 'x'.repeat(80)).join('\n');
    return fitContextForDelivery(
      observations, [], config, '', render, CONTEXT_OUTPUT_LIMIT, false,
      (items) => items.map(() => 'y'.repeat(120)).join('\n'),
    ).text;
  };
  const longOutageNotice = `claude-mem worker unreachable for 12 consecutive hooks — memory features are degraded, but your prompts are not blocked. ${'Port 37777 is held by an unreachable process that no PID file claims. '.repeat(6)}`;

  it('keeps a full preview, the longest footer and a long outage notice within the limit', () => {
    const preview = fullPreview();
    expect(longOutageNotice.length + 2 + preview.length + footer.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT);
    const systemMessage = composeSessionStartSystemMessage(preview, footer, longOutageNotice)!;
    expect(systemMessage.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(systemMessage.startsWith(`${longOutageNotice}\n\n`)).toBe(true);
    expect(systemMessage.endsWith(footer)).toBe(true);
    // Cut at a line boundary: the kept preview is a prefix of whole lines.
    const keptPreview = systemMessage.slice(longOutageNotice.length + 2, systemMessage.length - footer.length);
    expect(preview.startsWith(`${keptPreview}\n`)).toBe(true);
  });

  it('keeps a full preview within the limit with a 300-character server viewer URL and an outage notice', () => {
    const serverViewerUrl = `https://memory.example.com/${'a'.repeat(300 - 'https://memory.example.com/'.length)}`;
    expect(serverViewerUrl.length).toBe(300);
    const serverFooter = sessionStartBannerFooter(serverViewerUrl, 'claude-mem free trial: 30 days left', TEAMBRAIN_DISCOVERY_LINE);
    const preview = fullPreview();
    const withoutNotice = composeSessionStartSystemMessage(preview, serverFooter, null)!;
    expect(withoutNotice.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(withoutNotice).toContain(serverViewerUrl);
    const withNotice = composeSessionStartSystemMessage(preview, serverFooter, longOutageNotice)!;
    expect(withNotice.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(withNotice).toContain(serverViewerUrl);
  });

  it('leaves a message that already fits unchanged, and sends the notice alone without a banner', () => {
    expect(composeSessionStartSystemMessage('short preview', footer, 'notice')).toBe(`notice\n\nshort preview${footer}`);
    expect(composeSessionStartSystemMessage('short preview', footer, null)).toBe(`short preview${footer}`);
    expect(composeSessionStartSystemMessage(null, footer, 'notice')).toBe('notice');
    expect(composeSessionStartSystemMessage(null, footer, null)).toBeUndefined();
  });
});
