import { describe, it, expect } from 'bun:test';
import {
  conversationChars,
  shouldRecycleConversation,
  resolveConversationMaxChars,
  OBSERVER_CONVERSATION_MAX_CHARS,
} from '../../src/shared/observer-recycle.js';
import { wrapPriorContext } from '../../src/sdk/prompts.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

function windowOf(count: number, charsEach: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: 'x'.repeat(charsEach),
  }));
}

describe('observer generation budget (#3800)', () => {
  it('does not recycle a conversation that is within budget', () => {
    expect(shouldRecycleConversation(windowOf(10, 1_000))).toBe(false);
  });

  it('recycles once the generation has spent its budget', () => {
    const history = windowOf(50, 10_000); // 500k chars > 400k default
    expect(conversationChars(history)).toBeGreaterThan(OBSERVER_CONVERSATION_MAX_CHARS);
    expect(shouldRecycleConversation(history)).toBe(true);
  });

  it('checks the budget before a send, so the over-ceiling request is never paid for', () => {
    // Exactly at the budget must already trigger: the next observation would
    // push it past, and that request is the one that fails.
    const atBudget = [{ role: 'user' as const, content: 'x'.repeat(OBSERVER_CONVERSATION_MAX_CHARS) }];
    expect(shouldRecycleConversation(atBudget)).toBe(true);
  });

  it('honours an operator override and falls back on a malformed one', () => {
    expect(resolveConversationMaxChars('120000')).toBe(120_000);
    expect(resolveConversationMaxChars(undefined)).toBe(OBSERVER_CONVERSATION_MAX_CHARS);
    expect(resolveConversationMaxChars('')).toBe(OBSERVER_CONVERSATION_MAX_CHARS);
    expect(resolveConversationMaxChars('nonsense')).toBe(OBSERVER_CONVERSATION_MAX_CHARS);
    expect(resolveConversationMaxChars('0')).toBe(OBSERVER_CONVERSATION_MAX_CHARS);
    expect(resolveConversationMaxChars('-5')).toBe(OBSERVER_CONVERSATION_MAX_CHARS);
  });

  it('bounds per-session cost regardless of session length', () => {
    // The point of generations: a session 20x longer must not make any single
    // request 20x bigger. Each generation is capped, so cost is linear in
    // observations rather than quadratic.
    const long = windowOf(2_000, 10_000);
    let generationSize = 0;
    const generation: ConversationMessage[] = [];
    for (const message of long) {
      if (shouldRecycleConversation(generation)) {
        generation.length = 0; // retire and start fresh
      }
      generation.push(message);
      generationSize = Math.max(generationSize, conversationChars(generation));
    }
    // No request ever exceeds one budget plus the message that tripped it.
    expect(generationSize).toBeLessThanOrEqual(OBSERVER_CONVERSATION_MAX_CHARS + 10_000);
  });
});

describe('wrapPriorContext — continuity across generations (#3800)', () => {
  it('is empty for a first generation, leaving the prompt unchanged', () => {
    expect(wrapPriorContext('')).toBe('');
    expect(wrapPriorContext('   \n  ')).toBe('');
  });

  it('carries the session-start context so a fresh generation is not blind', () => {
    const block = wrapPriorContext('111 2:18p bugfix Fixed the auth redirect');

    expect(block).toContain('Fixed the auth redirect');
    expect(block).toContain('<session_start_context>');
    expect(block).toContain('</session_start_context>');
  });

  it('tells the observer not to re-record what it already captured', () => {
    expect(wrapPriorContext('something')).toContain('do not re-record');
  });

  it('does not let the observer read the gap as "the work did not happen"', () => {
    expect(wrapPriorContext('something')).toContain('do not treat its absence');
  });

  it('passes the context builder output through verbatim rather than re-rendering it', () => {
    // The whole point of the change: one renderer, the one the SessionStart
    // hook already uses. This block must not reformat what it is given.
    const generated = '### Aug 19\n111056 2:18p discovery Tool search returns same results';
    expect(wrapPriorContext(generated)).toContain(generated);
  });
});
