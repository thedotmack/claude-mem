import { describe, expect, it } from 'bun:test';
import {
  composeSessionStartSystemMessage,
  countTerminalTimelineRows,
  sessionStartBannerFooter,
  sessionStartBannerHeader,
} from '../../src/cli/handlers/context.js';
import { CONTEXT_OUTPUT_LIMIT, TERMINAL_BANNER_RESERVE_CHARS } from '../../src/services/context/ContextBudget.js';
import { fitContextForDelivery } from '../../src/services/context/ContextBuilder.js';
import { TEAMBRAIN_DISCOVERY_LINE } from '../../src/shared/teambrain.js';
import type { ContextConfig, Observation } from '../../src/services/context/types.js';

// The SessionStart hook puts the trial and TeamBrain lines above the terminal
// preview and closes it with a blank line and the viewer line, all inside one
// `systemMessage`, which Claude Code caps at 10,000 characters (#5079).
describe('SessionStart systemMessage stays within the field cap (#5079)', () => {
  const viewerUrl = 'http://localhost:37777';
  const header = sessionStartBannerHeader('claude-mem free trial: 30 days left', TEAMBRAIN_DISCOVERY_LINE);

  it('keeps the countdown without offering a second trial', () => {
    const countdown = 'claude-mem free trial: 5 days left';
    expect(sessionStartBannerHeader(countdown, null, 'trial')).toBe(countdown);
    expect(sessionStartBannerHeader(null, null, 'pro')).toBe('');
  });

  it('closes on the viewer link and the count of timeline rows shown', () => {
    expect(sessionStartBannerFooter(viewerUrl, 50)).toBe('View Observations Live @ http://localhost:37777 · 50 lines');
    expect(sessionStartBannerFooter(viewerUrl, 1)).toBe('View Observations Live @ http://localhost:37777 · 1 line');
    expect(sessionStartBannerFooter(viewerUrl, 0)).toBe('View Observations Live @ http://localhost:37777');
  });

  it('counts observation and summary rows, not day headings or other lines', () => {
    const preview = [
      '\x1b[2mAccess Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md\x1b[0m',
      '',
      '\x1b[1m\x1b[36mNov 9, 2026\x1b[0m',
      '',
      '\x1b[2msrc/cli/handlers/context.ts\x1b[0m',
      '  \x1b[2m#241301\x1b[0m  \x1b[2m11:55a\x1b[0m  🔵  Test suite survey',
      '  \x1b[2m#241307\x1b[0m           🔵  Test lanes runner',
      '\x1b[33m#S9876\x1b[0m Session summary (Nov 9, 12:01 PM)',
    ].join('\n');
    expect(countTerminalTimelineRows(preview)).toBe(3);
  });

  it('counts the plain block\'s rows, which antigravity-cli shows, and not its day headings', () => {
    const block = [
      'Access Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md',
      '',
      'Work state, still open:',
      '- release: status=active, updated 1 minute ago',
      '',
      '### Oct 26, 2025',
      'S15448 Monitor CI checks (Oct 26 at 1:31 PM)',
      '2586 12:58a ○ Context hook file empty',
      '2587 " ✓ Context hook reads the summary table',
      '**2588** 1:02a ◆ **A full observation**',
      '3f2a9c1e 3:07p ● A server row',
      '### Oct 27, 2025',
      'A: the prior reply',
      '**Investigated**: summary field',
    ].join('\n');
    expect(countTerminalTimelineRows(block)).toBe(5);
  });

  it('fits the longest header and closing lines the hook composes, and their separators, in the reserved room', () => {
    const footer = sessionStartBannerFooter(viewerUrl, 9_999);
    expect(header.length + 2 + 2 + footer.length).toBeLessThanOrEqual(TERMINAL_BANNER_RESERVE_CHARS);
  });

  it('keeps preview plus banner lines within the limit when the preview is full', () => {
    const text = fullPreview();
    expect(text.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT - TERMINAL_BANNER_RESERVE_CHARS - 200);
    const systemMessage = composeSessionStartSystemMessage(text, header, viewerUrl, null)!;
    expect(systemMessage).toBe(`${header}\n\n${text}\n\n${sessionStartBannerFooter(viewerUrl, countTerminalTimelineRows(text))}`);
    expect(systemMessage.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
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
      (items) => items.map((_, i) => `  #${String(i).padStart(3, '0')}  ${'y'.repeat(112)}`).join('\n'),
    ).text;
  };
  const longOutageNotice = `claude-mem worker unreachable for 12 consecutive hooks — memory features are degraded, but your prompts are not blocked. ${'Port 37777 is held by an unreachable process that no PID file claims. '.repeat(6)}`;

  it('keeps a full preview, the banner lines and a long outage notice within the limit, newest row then the closing line', () => {
    const preview = fullPreview();
    expect(longOutageNotice.length + 2 + header.length + 2 + preview.length).toBeGreaterThan(CONTEXT_OUTPUT_LIMIT);
    const systemMessage = composeSessionStartSystemMessage(preview, header, viewerUrl, longOutageNotice)!;
    expect(systemMessage.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(systemMessage.startsWith(`${longOutageNotice}\n\n${header}\n\n`)).toBe(true);
    // Cut at a line boundary from the oldest end: the kept preview is a suffix
    // of whole lines, so the newest row stays just above the closing line.
    const [keptPreview, footer] = systemMessage.slice(longOutageNotice.length + 2 + header.length + 2).split('\n\n');
    expect(preview.endsWith(`\n${keptPreview}`)).toBe(true);
    expect(keptPreview!.split('\n').at(-1)).toBe(preview.split('\n').at(-1));
    expect(footer).toBe(sessionStartBannerFooter(viewerUrl, keptPreview!.split('\n').length));
  });

  it('keeps a full preview within the limit with a 300-character server viewer URL and an outage notice', () => {
    const serverViewerUrl = `https://memory.example.com/${'a'.repeat(300 - 'https://memory.example.com/'.length)}`;
    expect(serverViewerUrl.length).toBe(300);
    const preview = fullPreview();
    const withoutNotice = composeSessionStartSystemMessage(preview, header, serverViewerUrl, null)!;
    expect(withoutNotice.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(withoutNotice).toContain(`\n\nView Observations Live @ ${serverViewerUrl} · `);
    const withNotice = composeSessionStartSystemMessage(preview, header, serverViewerUrl, longOutageNotice)!;
    expect(withNotice.length).toBeLessThanOrEqual(CONTEXT_OUTPUT_LIMIT);
    expect(withNotice).toContain(`${preview.split('\n').at(-1)!}\n\nView Observations Live @ ${serverViewerUrl}`);
  });

  it('leaves a message that already fits whole, and sends the notice alone without a banner', () => {
    const footer = sessionStartBannerFooter(viewerUrl, 0);
    expect(composeSessionStartSystemMessage('short preview', header, viewerUrl, 'notice'))
      .toBe(`notice\n\n${header}\n\nshort preview\n\n${footer}`);
    expect(composeSessionStartSystemMessage('\nshort preview\n', '', viewerUrl, null)).toBe(`short preview\n\n${footer}`);
    expect(composeSessionStartSystemMessage(null, header, viewerUrl, 'notice')).toBe('notice');
    expect(composeSessionStartSystemMessage(null, header, viewerUrl, null)).toBeUndefined();
  });

  it('keeps every whole line that fits when the room starts exactly on a line boundary', () => {
    const preview = '  #1  oldest row\n  #2  middle row\n  #3  newest row';
    const top = `${header}\n\n`;
    const bottom = `\n\n${sessionStartBannerFooter(viewerUrl, 3)}`;
    const roomForLastTwoLines = '  #2  middle row\n  #3  newest row'.length;
    const systemMessage = composeSessionStartSystemMessage(preview, header, viewerUrl, null, top.length + roomForLastTwoLines + bottom.length)!;
    expect(systemMessage).toBe(`${top}  #2  middle row\n  #3  newest row\n\n${sessionStartBannerFooter(viewerUrl, 2)}`);
    // One char less: the middle row no longer fits whole, so only the newest row is kept.
    const tighter = composeSessionStartSystemMessage(preview, header, viewerUrl, null, top.length + roomForLastTwoLines + bottom.length - 1)!;
    expect(tighter).toBe(`${top}  #3  newest row\n\n${sessionStartBannerFooter(viewerUrl, 1)}`);
  });
});
