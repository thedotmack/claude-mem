import { describe, expect, it } from 'bun:test';
import { composeSessionStartSystemMessage, sessionStartBannerHeader } from '../../src/cli/handlers/context.js';
import { CONTEXT_OUTPUT_LIMIT, TERMINAL_BANNER_RESERVE_CHARS } from '../../src/services/context/ContextBudget.js';
import { fitContextForDelivery } from '../../src/services/context/ContextBuilder.js';
import { TEAMBRAIN_DISCOVERY_LINE } from '../../src/shared/teambrain.js';
import type { ContextConfig, Observation } from '../../src/services/context/types.js';

// The SessionStart hook puts the viewer lines above the terminal preview inside
// one `systemMessage`, which Claude Code caps at 10,000 characters (#5079). The
// preview ends on its newest timeline entry, with no closing lines after it.
describe('SessionStart systemMessage stays within the field cap (#5079)', () => {
  const header = sessionStartBannerHeader(
    'http://localhost:37777',
    'claude-mem free trial: 30 days left',
    TEAMBRAIN_DISCOVERY_LINE,
  );

  it('fits the longest viewer lines the hook composes, and their separator, in the reserved room', () => {
    expect(header).toStartWith('View Observations Live @ http://localhost:37777\n');
    expect(header.length + 2).toBeLessThanOrEqual(TERMINAL_BANNER_RESERVE_CHARS);
  });

  it('keeps preview plus viewer lines within the limit when the preview is full', () => {
    const observations = Array.from({ length: 200 }, (_, i) => ({ id: i }) as unknown as Observation);
    const config = { fullObservationCount: 0, showLastSummary: false, showLastMessage: false, sessionCount: 0 } as ContextConfig;
    const render = (items: Observation[]) => items.map(() => 'x'.repeat(80)).join('\n');
    const { text } = fitContextForDelivery(
      observations, [], config, '', render, CONTEXT_OUTPUT_LIMIT, false,
      (items) => items.map(() => 'y'.repeat(120)).join('\n'),
    );
    expect(text.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT - TERMINAL_BANNER_RESERVE_CHARS - 200);
    expect(text.length + header.length + 2).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
  });

  // The worker-outage notice is joined in front, and a server-runtime viewer
  // URL has no length bound; neither fits in the fixed reserve, so the whole
  // message is measured and the preview cut at a line boundary, oldest first.
  const fullPreview = () => {
    const observations = Array.from({ length: 200 }, (_, i) => ({ id: i }) as unknown as Observation);
    const config = { fullObservationCount: 0, showLastSummary: false, showLastMessage: false, sessionCount: 0 } as ContextConfig;
    const render = (items: Observation[]) => items.map(() => 'x'.repeat(80)).join('\n');
    return fitContextForDelivery(
      observations, [], config, '', render, CONTEXT_OUTPUT_LIMIT, false,
      (items) => items.map((_, i) => `row ${String(i).padStart(3, '0')} ${'y'.repeat(112)}`).join('\n'),
    ).text;
  };
  const longOutageNotice = `claude-mem worker unreachable for 12 consecutive hooks — memory features are degraded, but your prompts are not blocked. ${'Port 37777 is held by an unreachable process that no PID file claims. '.repeat(6)}`;

  it('keeps a full preview, the longest viewer lines and a long outage notice within the limit, newest end intact', () => {
    const preview = fullPreview();
    expect(longOutageNotice.length + 2 + header.length + 2 + preview.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT);
    const systemMessage = composeSessionStartSystemMessage(preview, header, longOutageNotice)!;
    expect(systemMessage.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(systemMessage.startsWith(`${longOutageNotice}\n\n${header}\n\n`)).toBe(true);
    // Cut at a line boundary from the oldest end: the kept preview is a suffix
    // of whole lines, so the banner still ends on the newest row.
    const keptPreview = systemMessage.slice(longOutageNotice.length + 2 + header.length + 2);
    expect(preview.endsWith(`\n${keptPreview}`)).toBe(true);
    expect(systemMessage.endsWith(preview.split('\n').at(-1)!)).toBe(true);
  });

  it('keeps a full preview within the limit with a 300-character server viewer URL and an outage notice', () => {
    const serverViewerUrl = `https://memory.example.com/${'a'.repeat(300 - 'https://memory.example.com/'.length)}`;
    expect(serverViewerUrl.length).toBe(300);
    const serverHeader = sessionStartBannerHeader(serverViewerUrl, 'claude-mem free trial: 30 days left', TEAMBRAIN_DISCOVERY_LINE);
    const preview = fullPreview();
    const withoutNotice = composeSessionStartSystemMessage(preview, serverHeader, null)!;
    expect(withoutNotice.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(withoutNotice).toStartWith(`View Observations Live @ ${serverViewerUrl}`);
    const withNotice = composeSessionStartSystemMessage(preview, serverHeader, longOutageNotice)!;
    expect(withNotice.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(withNotice).toContain(serverViewerUrl);
    expect(withNotice.endsWith(preview.split('\n').at(-1)!)).toBe(true);
  });

  it('leaves a message that already fits unchanged, and sends the notice alone without a banner', () => {
    expect(composeSessionStartSystemMessage('short preview', header, 'notice')).toBe(`notice\n\n${header}\n\nshort preview`);
    expect(composeSessionStartSystemMessage('\nshort preview', header, null)).toBe(`${header}\n\nshort preview`);
    expect(composeSessionStartSystemMessage(null, header, 'notice')).toBe('notice');
    expect(composeSessionStartSystemMessage(null, header, null)).toBeUndefined();
  });
});
