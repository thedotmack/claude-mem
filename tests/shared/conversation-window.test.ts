import { describe, it, expect } from 'bun:test';
import {
  compactConversationHistory,
  DEFAULT_HISTORY_MAX_CHARS,
  DEFAULT_HISTORY_MAX_MESSAGES,
} from '../../src/shared/conversation-window.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

function message(role: 'user' | 'assistant', content: string): ConversationMessage {
  return { role, content };
}

function windowOf(count: number, charsEach: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) =>
    message(i % 2 === 0 ? 'user' : 'assistant', `${i}:`.padEnd(charsEach, 'x'))
  );
}

function totalChars(history: ConversationMessage[]): number {
  return history.reduce((sum, m) => sum + m.content.length, 0);
}

describe('compactConversationHistory (#3800)', () => {
  it('leaves a window that already fits untouched, without reallocating', () => {
    const history = windowOf(6, 100);
    const result = compactConversationHistory(history);

    expect(result.dropped).toBe(0);
    expect(result.droppedChars).toBe(0);
    expect(result.history).toBe(history);
  });

  it('bounds a window that exceeds the character budget', () => {
    // 40 messages x 20k chars = 800k chars, far past the 260k budget.
    const history = windowOf(40, 20_000);
    const result = compactConversationHistory(history);

    expect(result.dropped).toBeGreaterThan(0);
    expect(totalChars(result.history)).toBeLessThanOrEqual(DEFAULT_HISTORY_MAX_CHARS);
  });

  it('bounds a window that exceeds the message budget even when every message is small', () => {
    const history = windowOf(DEFAULT_HISTORY_MAX_MESSAGES + 40, 10);
    const result = compactConversationHistory(history);

    expect(result.dropped).toBe(40);
    expect(result.history.length).toBeLessThanOrEqual(DEFAULT_HISTORY_MAX_MESSAGES + 1); // +1 elision marker
  });

  it('pins the framing message at the head so the observer keeps its instructions', () => {
    const history = windowOf(200, 5_000);
    history[0] = message('user', 'FRAMING: project=acme session=abc mode=default');

    const result = compactConversationHistory(history);

    expect(result.history[0].content).toBe('FRAMING: project=acme session=abc mode=default');
  });

  it('keeps the newest messages and drops from the middle, oldest-first', () => {
    const history = windowOf(200, 5_000);
    const newest = history[history.length - 1].content;

    const result = compactConversationHistory(history);

    expect(result.history[result.history.length - 1].content).toBe(newest);
    // The message right after the pinned head is the elision marker, not an
    // old turn that survived out of order.
    expect(result.history[1].content).toContain('<elided');
  });

  it('announces the elision so the model does not treat the gap as fact', () => {
    const history = windowOf(200, 5_000);
    const result = compactConversationHistory(history);

    const marker = result.history[1];
    expect(marker.role).toBe('user');
    expect(marker.content).toContain(`messages="${result.dropped}"`);
    expect(marker.content).toContain('do not infer');
  });

  it('never drops the live observation, even when it alone exceeds the budget', () => {
    const oversized = 'y'.repeat(DEFAULT_HISTORY_MAX_CHARS * 2);
    const history = [...windowOf(10, 40_000), message('user', oversized)];

    const result = compactConversationHistory(history);

    expect(result.history[result.history.length - 1].content).toBe(oversized);
  });

  it('holds per-request size flat as a session grows — the O(N^2) regression guard', () => {
    // Without compaction, request size grows linearly with session length and
    // total spend grows quadratically. Compaction must break that link.
    const shortSession = compactConversationHistory(windowOf(30, 20_000));
    const longSession = compactConversationHistory(windowOf(600, 20_000));

    expect(totalChars(longSession.history)).toBeLessThanOrEqual(DEFAULT_HISTORY_MAX_CHARS);
    // A 20x longer session must not produce a meaningfully larger request.
    expect(totalChars(longSession.history)).toBeLessThanOrEqual(totalChars(shortSession.history) * 1.1);
  });

  it('honours explicit budgets', () => {
    const history = windowOf(50, 1_000);
    const result = compactConversationHistory(history, { maxChars: 5_000, maxMessages: 10 });

    expect(totalChars(result.history)).toBeLessThanOrEqual(5_000 + result.history[1].content.length);
    expect(result.history.length).toBeLessThanOrEqual(11);
  });
});
