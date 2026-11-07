import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
    // Points at the call entry's line: just past the first line and its newline.
    expect(calls[0].transcriptByteOffset).toBe(Buffer.byteLength(userLine('why is this failing?')) + 1);
    expect(calls[0].occurredAtEpoch).toBe(Date.parse('2026-07-06T05:00:01.000Z'));
  });

  it('starts a new image-only turn without replaying earlier advice or its prompt text', () => {
    const jsonl = [
      userLine('old question'), advisorCallLine('old'), advisorResultLine('old', 'old advice'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ] } }), advisorCallLine('new'), advisorResultLine('new', 'image advice'),
    ].join('\n');
    expect(extractAdvisorCallsFromJsonl(jsonl, { currentTurnOnly: true }).map(call =>
      [call.toolUseId, call.lastUserMessage])).toEqual([['new', null]]);
    expect(extractAdvisorCallsFromJsonl(jsonl)).toHaveLength(2);
  });

  it('starts a document-only turn but does not treat tool results as a new prompt', () => {
    const jsonl = [userLine('old question'), advisorCallLine('old'), advisorResultLine('old', 'old advice'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'document', source: { type: 'text', data: 'doc' } }] } }),
      advisorCallLine('new'), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'result' }] } }),
      advisorResultLine('new', 'document advice')].join('\n');
    const calls = extractAdvisorCallsFromJsonl(jsonl, { currentTurnOnly: true });
    expect(calls.map(call => call.toolUseId)).toEqual(['new']);
    expect(calls[0].lastUserMessage).toBeNull();
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
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'advisor-transcript-'));
    dirs.push(dir);
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  it('returns [] for a missing file', () => {
    expect(extractAdvisorCalls('/nonexistent/transcript.jsonl')).toEqual([]);
  });

  it('returns [] for an empty path', () => {
    expect(extractAdvisorCalls('')).toEqual([]);
  });

  it('reads only the tail of a long transcript, and its offsets still point into the file', () => {
    // An old turn with its own call, padded well past the tail window.
    const filler = Array.from({ length: 200 }, (_, i) => userLine(`old question ${i} ${'x'.repeat(200)}`));
    const path = writeTranscript([
      userLine('old turn'),
      advisorCallLine('srvtoolu_old'),
      advisorResultLine('srvtoolu_old', 'old advice'),
      ...filler,
      userLine('current question'),
      advisorCallLine('srvtoolu_new'),
      advisorResultLine('srvtoolu_new', 'new advice'),
    ]);

    const calls = extractAdvisorCalls(path, { currentTurnOnly: true, maxTailBytes: 4096 });
    expect(calls.map(c => c.toolUseId)).toEqual(['srvtoolu_new']);
    expect(calls[0].lastUserMessage).toBe('current question');

    const lineAtOffset = readFileSync(path).subarray(calls[0].transcriptByteOffset).toString('utf-8').split('\n', 1)[0];
    expect(JSON.parse(lineAtOffset).message.content[0].id).toBe('srvtoolu_new');
  });

  it('keeps the calls of a turn that started before the tail window', () => {
    const path = writeTranscript([
      userLine(`long turn ${'y'.repeat(6000)}`),
      advisorCallLine('srvtoolu_late'),
      advisorResultLine('srvtoolu_late', 'late advice'),
    ]);

    const calls = extractAdvisorCalls(path, { currentTurnOnly: true, maxTailBytes: 1024 });
    expect(calls.map(c => c.toolUseId)).toEqual(['srvtoolu_late']);
  });
});
