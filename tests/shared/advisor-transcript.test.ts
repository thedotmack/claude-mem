import { describe, it, expect } from 'bun:test';
import { extractAdvisorCallsFromJsonl, extractAdvisorCalls } from '../../src/shared/advisor-transcript.js';

// Line shapes mirror real Claude Code transcripts: advisor is a server-side
// tool — a server_tool_use block in one assistant entry, and the paired
// advisor_tool_result block in a following assistant entry.

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: '2026-07-06T05:00:00.000Z',
  });
}

function advisorCallLine(id: string, model = 'claude-fable-5', timestamp = '2026-07-06T05:00:01.000Z'): string {
  return JSON.stringify({
    type: 'assistant',
    advisorModel: model,
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'server_tool_use', id, name: 'advisor', input: {} }] },
    timestamp,
  });
}

function advisorResultLine(id: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    advisorModel: 'claude-fable-5',
    isSidechain: false,
    message: {
      role: 'assistant',
      content: [{ type: 'advisor_tool_result', tool_use_id: id, content: { type: 'advisor_result', text } }],
    },
    timestamp: '2026-07-06T05:00:02.000Z',
  });
}

function advisorErrorLine(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'advisor_tool_result', tool_use_id: id, content: { type: 'advisor_tool_result_error', error_code: 'unavailable' } }],
    },
    timestamp: '2026-07-06T05:00:02.000Z',
  });
}

describe('extractAdvisorCallsFromJsonl', () => {
  it('pairs a server_tool_use with its advisor_tool_result and extracts the advice verbatim', () => {
    const jsonl = [
      userLine('why is this failing?'),
      advisorCallLine('srvtoolu_001'),
      advisorResultLine('srvtoolu_001', 'The actual advice text.'),
    ].join('\n');

    const calls = extractAdvisorCallsFromJsonl(jsonl);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolUseId).toBe('srvtoolu_001');
    expect(calls[0].advice).toBe('The actual advice text.');
    expect(calls[0].advisorModel).toBe('claude-fable-5');
    expect(calls[0].lastUserMessage).toBe('why is this failing?');
    expect(calls[0].transcriptLineNumber).toBe(2);
    expect(calls[0].occurredAtEpoch).toBe(Date.parse('2026-07-06T05:00:01.000Z'));
  });

  it('skips error results and calls with no result', () => {
    const jsonl = [
      userLine('help'),
      advisorCallLine('srvtoolu_err'),
      advisorErrorLine('srvtoolu_err'),
      advisorCallLine('srvtoolu_orphan'),
    ].join('\n');

    expect(extractAdvisorCallsFromJsonl(jsonl)).toHaveLength(0);
  });

  it('skips sidechain entries', () => {
    const call = JSON.parse(advisorCallLine('srvtoolu_side'));
    call.isSidechain = true;
    const result = JSON.parse(advisorResultLine('srvtoolu_side', 'sidechain advice'));
    result.isSidechain = true;

    const jsonl = [userLine('main turn'), JSON.stringify(call), JSON.stringify(result)].join('\n');
    expect(extractAdvisorCallsFromJsonl(jsonl)).toHaveLength(0);
  });

  it('tolerates malformed lines and blank lines', () => {
    const jsonl = [
      'not json{{{',
      '',
      userLine('q'),
      advisorCallLine('srvtoolu_ok'),
      '{"truncated": ',
      advisorResultLine('srvtoolu_ok', 'still extracted'),
    ].join('\n');

    const calls = extractAdvisorCallsFromJsonl(jsonl);
    expect(calls).toHaveLength(1);
    expect(calls[0].advice).toBe('still extracted');
  });

  it('attributes each call to the user message of its own turn', () => {
    const jsonl = [
      userLine('first turn'),
      advisorCallLine('srvtoolu_t1'),
      advisorResultLine('srvtoolu_t1', 'advice one'),
      userLine('second turn'),
      advisorCallLine('srvtoolu_t2'),
      advisorResultLine('srvtoolu_t2', 'advice two'),
    ].join('\n');

    const calls = extractAdvisorCallsFromJsonl(jsonl);
    expect(calls).toHaveLength(2);
    expect(calls[0].lastUserMessage).toBe('first turn');
    expect(calls[1].lastUserMessage).toBe('second turn');
  });

  it('currentTurnOnly returns only calls after the last user text message', () => {
    const jsonl = [
      userLine('old turn'),
      advisorCallLine('srvtoolu_old'),
      advisorResultLine('srvtoolu_old', 'old advice'),
      userLine('current turn'),
      advisorCallLine('srvtoolu_new'),
      advisorResultLine('srvtoolu_new', 'new advice'),
    ].join('\n');

    const calls = extractAdvisorCallsFromJsonl(jsonl, { currentTurnOnly: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].toolUseId).toBe('srvtoolu_new');
  });

  it('currentTurnOnly ignores tool-result-only user entries as turn boundaries', () => {
    const toolResultUserEntry = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] },
      timestamp: '2026-07-06T05:00:03.000Z',
    });
    const jsonl = [
      userLine('the turn'),
      advisorCallLine('srvtoolu_a'),
      advisorResultLine('srvtoolu_a', 'advice'),
      toolResultUserEntry,
    ].join('\n');

    const calls = extractAdvisorCallsFromJsonl(jsonl, { currentTurnOnly: true });
    expect(calls).toHaveLength(1);
  });

  it('strips system reminders from the turn user message', () => {
    const jsonl = [
      userLine('<system-reminder>injected</system-reminder>real question'),
      advisorCallLine('srvtoolu_s'),
      advisorResultLine('srvtoolu_s', 'advice'),
    ].join('\n');

    const calls = extractAdvisorCallsFromJsonl(jsonl);
    expect(calls[0].lastUserMessage).toBe('real question');
  });
});

describe('extractAdvisorCalls', () => {
  it('returns [] for a missing file', () => {
    expect(extractAdvisorCalls('/nonexistent/transcript.jsonl')).toEqual([]);
  });

  it('returns [] for an empty path', () => {
    expect(extractAdvisorCalls('')).toEqual([]);
  });
});
