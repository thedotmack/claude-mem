import { describe, expect, it } from 'bun:test';
import {
  boundObserverHistory,
  OBSERVER_CONTEXT_MAX_ARRAY_ITEMS,
  OBSERVER_CONTEXT_MAX_HISTORY_MESSAGES,
  OBSERVER_CONTEXT_MAX_SERIALIZED_CHARS,
  OBSERVER_CONTEXT_MAX_STRING_CHARS,
  sanitizeObserverText,
  stringifyObserverPayload,
} from '../../src/services/worker/observer-context.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

describe('observer context bounds', () => {
  it('strips data URLs and base64-shaped binary fields before provider prompts', () => {
    const payload = {
      tool: 'Screenshot',
      screenshot: `data:image/png;base64,${'A'.repeat(800)}`,
      nested: {
        text: 'keep this durable detail',
        image_base64: `${'B'.repeat(1024)}==`,
      },
      list: [
        {
          audioBytes: `${'C'.repeat(768)}==`,
        },
      ],
    };

    const serialized = stringifyObserverPayload(payload, 'tool_response');

    expect(serialized).toContain('keep this durable detail');
    expect(serialized).toContain('[stripped data URL:');
    expect(serialized).toContain('[stripped image_base64 payload:');
    expect(serialized).toContain('[stripped audioBytes payload:');
    expect(serialized).not.toContain('data:image/png;base64');
    expect(serialized).not.toContain('A'.repeat(128));
    expect(serialized).not.toContain('B'.repeat(128));
    expect(serialized).not.toContain('C'.repeat(128));
  });

  it('bounds long strings, arrays, and serialized payload size', () => {
    const longText = sanitizeObserverText('x'.repeat(OBSERVER_CONTEXT_MAX_STRING_CHARS + 50));
    expect(longText).toContain('[truncated 50 chars]');

    const arrayPayload = stringifyObserverPayload(
      Array.from({ length: OBSERVER_CONTEXT_MAX_ARRAY_ITEMS + 5 }, (_, index) => `item-${index}`),
      'tool_input',
    );
    expect(arrayPayload).toContain(`item-${OBSERVER_CONTEXT_MAX_ARRAY_ITEMS - 1}`);
    expect(arrayPayload).toContain('[truncated array: 5 additional items]');
    expect(arrayPayload).not.toContain(`item-${OBSERVER_CONTEXT_MAX_ARRAY_ITEMS}`);

    const widePayload = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, 'detail '.repeat(1000)]),
    );
    const serialized = stringifyObserverPayload(widePayload, 'tool_output');
    expect(serialized.length).toBeLessThan(OBSERVER_CONTEXT_MAX_SERIALIZED_CHARS + 80);
    expect(serialized).toContain('[truncated ');
  });

  it('preserves init context and newest messages when bounding conversation history', () => {
    const history: ConversationMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`,
    }));

    const bounded = boundObserverHistory(history);

    expect(bounded).toHaveLength(OBSERVER_CONTEXT_MAX_HISTORY_MESSAGES);
    expect(bounded[0]).toBe(history[0]);
    expect(bounded[1]).toBe(history[history.length - OBSERVER_CONTEXT_MAX_HISTORY_MESSAGES + 1]);
    expect(bounded[bounded.length - 1]).toBe(history[history.length - 1]);
  });
});
