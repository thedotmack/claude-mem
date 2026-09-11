import { describe, it, expect } from 'bun:test';
import { buildBoundedMessages } from '../../src/services/worker/context-window.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

function turn(role: 'user' | 'assistant', content: string): ConversationMessage {
  return { role, content };
}

describe('buildBoundedMessages', () => {
  it('returns [] for empty history', () => {
    expect(buildBoundedMessages([], { maxMessages: 0, maxChars: 0 })).toEqual([]);
  });

  it('returns just the system anchor for a single-message history', () => {
    const history = [turn('user', 'init prompt with the observation schema')];
    const result = buildBoundedMessages(history, { maxMessages: 40, maxChars: 200000 });
    expect(result).toEqual([{ role: 'system', content: 'init prompt with the observation schema' }]);
  });

  it('pins history[0] as system regardless of its original role', () => {
    const history = [turn('user', 'init'), turn('assistant', 'ack')];
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 0 });
    expect(result[0]).toEqual({ role: 'system', content: 'init' });
  });

  it('maxMessages=0 means unbounded — keeps every turn after the anchor', () => {
    const history = [turn('user', 'init'), ...Array.from({ length: 50 }, (_, i) => turn('user', `turn ${i}`))];
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 0 });
    expect(result).toHaveLength(51);
  });

  it('count cap keeps only the last N turns after the system anchor', () => {
    // All 'user' so the count cap is the only thing under test — the
    // leading-assistant-drop rule is covered separately below.
    const history = [
      turn('user', 'init'),
      ...Array.from({ length: 10 }, (_, i) => turn('user', `turn ${i}`)),
    ];
    const result = buildBoundedMessages(history, { maxMessages: 4, maxChars: 0 });
    // system + last 4 of the 10 trailing turns
    expect(result).toHaveLength(5);
    expect(result.slice(1).map(m => m.content)).toEqual(['turn 6', 'turn 7', 'turn 8', 'turn 9']);
  });

  it('maxChars=0 means unbounded — no char-based trimming', () => {
    const history = [turn('user', 'init'), turn('user', 'x'.repeat(500000))];
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 0 });
    expect(result).toHaveLength(2);
  });

  it('char cap drops from the front, keeping the most recent turns and the final message', () => {
    // All 'user' so the char cap is the only thing under test — the
    // leading-assistant-drop rule is covered separately below.
    const history = [
      turn('user', 'init'),
      turn('user', 'a'.repeat(100)),
      turn('user', 'b'.repeat(100)),
      turn('user', 'c'.repeat(100)),
    ];
    // budget only fits the last two trailing turns (200 chars)
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 200 });
    expect(result.map(m => m.content)).toEqual(['init', 'b'.repeat(100), 'c'.repeat(100)]);
  });

  it('keeps the final message even when it alone exceeds the char budget', () => {
    const history = [
      turn('user', 'init'),
      turn('user', 'a'.repeat(50)),
      turn('user', 'z'.repeat(500)),
    ];
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 10 });
    expect(result).toEqual([
      { role: 'system', content: 'init' },
      { role: 'user', content: 'z'.repeat(500) },
    ]);
  });

  it('drops leading assistant turns left over after count/char trimming', () => {
    const history = [
      turn('user', 'init'),
      turn('user', 'earlier user turn'),
      turn('assistant', 'orphaned init ack'),
      turn('user', 'latest user turn'),
    ];
    // count cap of 2 lands exactly on [assistant ack, latest user turn]
    const result = buildBoundedMessages(history, { maxMessages: 2, maxChars: 0 });
    expect(result).toEqual([
      { role: 'system', content: 'init' },
      { role: 'user', content: 'latest user turn' },
    ]);
  });

  it('drops ALL leading assistant turns, not just one', () => {
    const history = [
      turn('user', 'init'),
      turn('assistant', 'ack 1'),
      turn('assistant', 'ack 2'),
      turn('user', 'real turn'),
    ];
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 0 });
    expect(result).toEqual([
      { role: 'system', content: 'init' },
      { role: 'user', content: 'real turn' },
    ]);
  });

  it('an all-assistant trailing window (after trimming) collapses to just the system anchor', () => {
    const history = [turn('user', 'init'), turn('assistant', 'only ack')];
    const result = buildBoundedMessages(history, { maxMessages: 1, maxChars: 0 });
    expect(result).toEqual([{ role: 'system', content: 'init' }]);
  });

  it('maps ConversationMessage roles onto BoundedMessage roles (assistant stays assistant, anything else becomes user)', () => {
    // The assistant turn is not leading (there's a user turn ahead of it),
    // so it survives the leading-assistant-drop rule and its role mapping
    // can be observed directly.
    const history = [turn('user', 'init'), turn('user', 'u1'), turn('assistant', 'a1'), turn('user', 'u2')];
    const result = buildBoundedMessages(history, { maxMessages: 0, maxChars: 0 });
    expect(result.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});
