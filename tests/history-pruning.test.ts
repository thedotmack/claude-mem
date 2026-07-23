import { describe, expect, it } from 'bun:test';

import {
  pruneProcessedObservationPayloads,
  KEEP_RECENT_MESSAGES,
  MIN_PRUNABLE_CHARS,
} from '../src/services/worker/history-pruning.js';
import { buildObservationPrompt, SUMMARY_MODE_MARKER } from '../src/sdk/prompts.js';
import type { ConversationMessage } from '../src/services/worker-types.js';

const INIT_PROMPT = 'You are an observer.\n<observed_from_primary_session>\n  <user_request>build the thing</user_request>\n</observed_from_primary_session>\n' + 'x'.repeat(2000);

function observationMessage(tool: string, filler: string): ConversationMessage {
  return {
    role: 'user',
    content: buildObservationPrompt({
      id: 0,
      tool_name: tool,
      tool_input: JSON.stringify({ file_path: `/repo/${tool}.ts` }),
      tool_output: JSON.stringify({ content: filler }),
      created_at_epoch: 1700000000000,
      cwd: '/repo',
    }),
  };
}

function assistantMessage(): ConversationMessage {
  return { role: 'assistant', content: '<observation><type>discovery</type><title>Found it</title></observation>' };
}

function buildHistory(exchanges: number): ConversationMessage[] {
  const history: ConversationMessage[] = [{ role: 'user', content: INIT_PROMPT }];
  for (let i = 0; i < exchanges; i++) {
    history.push(observationMessage('Read', `payload ${i} ` + 'y'.repeat(5000)));
    history.push(assistantMessage());
  }
  return history;
}

describe('pruneProcessedObservationPayloads', () => {
  it('stubs old observation payloads and keeps role, tool name, and timestamp', () => {
    const history = buildHistory(10); // 21 messages, indices 1..12 outside keep window
    const pruned = pruneProcessedObservationPayloads(history);

    expect(pruned).toBeGreaterThan(0);
    const stub = history[1];
    expect(stub.role).toBe('user');
    expect(stub.content).toContain('pruned="true"');
    expect(stub.content).toContain('<what_happened>Read</what_happened>');
    expect(stub.content).toContain('2023-11-14'); // from created_at_epoch
    expect(stub.content).not.toContain('yyyy');
    expect(stub.content.length).toBeLessThan(MIN_PRUNABLE_CHARS);
  });

  it('never touches the init prompt, assistant messages, or the recent window', () => {
    const history = buildHistory(10);
    const before = history.map(m => m.content);
    pruneProcessedObservationPayloads(history);

    // init prompt intact
    expect(history[0].content).toBe(before[0]);
    // assistant messages intact everywhere
    for (let i = 0; i < history.length; i++) {
      if (history[i].role === 'assistant') {
        expect(history[i].content).toBe(before[i]);
      }
    }
    // trailing window intact
    for (let i = history.length - KEEP_RECENT_MESSAGES; i < history.length; i++) {
      expect(history[i].content).toBe(before[i]);
    }
  });

  it('skips summary prompts and small messages', () => {
    const history = buildHistory(8);
    const summary: ConversationMessage = {
      role: 'user',
      content: `--- ${SUMMARY_MODE_MARKER} ---\n<observed_from_primary_session>\n` + 'z'.repeat(2000),
    };
    const small: ConversationMessage = { role: 'user', content: '<observed_from_primary_session>tiny</observed_from_primary_session>' };
    history.splice(3, 0, summary, small);

    pruneProcessedObservationPayloads(history);

    expect(history[3].content).toContain(SUMMARY_MODE_MARKER);
    expect(history[3].content).toContain('zzz');
    expect(history[4].content).toBe(small.content);
  });

  it('is idempotent: a second pass prunes nothing', () => {
    const history = buildHistory(10);
    const first = pruneProcessedObservationPayloads(history);
    const second = pruneProcessedObservationPayloads(history);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('bounds total history size as exchanges grow', () => {
    const history = buildHistory(40); // 81 messages, ~5k chars per payload
    const beforeChars = history.reduce((sum, m) => sum + m.content.length, 0);
    pruneProcessedObservationPayloads(history);
    const afterChars = history.reduce((sum, m) => sum + m.content.length, 0);

    // Everything outside init + recent window collapses to stubs.
    expect(afterChars).toBeLessThan(beforeChars / 5);
    // Chronology and count preserved: nothing is removed, only shrunk.
    expect(history.length).toBe(81);
  });

  it('does nothing on short histories that fit the recent window', () => {
    const history = buildHistory(3); // 7 messages <= 1 + KEEP_RECENT_MESSAGES
    const pruned = pruneProcessedObservationPayloads(history);
    expect(pruned).toBe(0);
  });
});
