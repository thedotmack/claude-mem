import { describe, expect, it } from 'bun:test';
import type { HookSpoolKind, HookSpoolPayloadByKind } from '../../src/shared/hook-spool.js';
import { WireCaptureAssembler } from '../../src/services/wire-gateway/capture/capture-assembler.js';
import type { WireCaptureEventSink } from '../../src/services/wire-gateway/capture/capture-event-sink.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { emptyWireUsage, type WireReply } from '../../src/services/wire-gateway/ir/types.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';
import type { WireIdentity } from '../../src/services/wire-gateway/identity/resolve-identity.js';
import { userTurnPositionOfRequest } from '../../src/services/wire-gateway/identity/turn-start.js';
import { latestUserWordsOfConversation } from '../../src/services/wire-gateway/identity/user-words.js';
import { MEDIA_PROMPT_PLACEHOLDER } from '../../src/services/sqlite/prompt-storage.js';

interface EmittedEvent { kind: HookSpoolKind; payload: Record<string, unknown> }

function recordingSink(): WireCaptureEventSink & { events: EmittedEvent[] } {
  const events: EmittedEvent[] = [];
  return {
    events,
    emit<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]) {
      events.push({ kind, payload: payload as unknown as Record<string, unknown> });
    },
  };
}

function reply(fields: Partial<WireReply> = {}): WireReply {
  return { text: '', toolCalls: [], thinking: '', sealed: [], usage: emptyWireUsage(), stop: 'stop', endedCleanly: true, ...fields };
}

/** Feed one request (and its reply) the way the capture observer does, with the identity Phase 4 would resolve. */
function feed(
  assembler: WireCaptureAssembler,
  protocol: WireProtocol,
  body: unknown,
  identityFields: Partial<WireIdentity> = {},
  replyFields: Partial<WireReply> | null = {},
  suffixPath = '',
): void {
  const request = parseWireRequest(protocol, new TextEncoder().encode(JSON.stringify(body)), { suffixPath });
  const position = userTurnPositionOfRequest(request);
  const identity: WireIdentity = {
    agentId: 'claude-code',
    sessionId: 'session-1',
    sessionSource: 'header',
    kind: 'turn',
    workDir: '/Users/me/proj',
    userWords: latestUserWordsOfConversation(request),
    userTurnOrdinal: position.userTurnOrdinal,
    turnStart: position.userTurnOrdinal > 0 && !position.withinTurn,
    ...identityFields,
  };
  assembler.observeExchange({ identity, request, reply: replyFields ? reply(replyFields) : null, replyIsWhole: replyFields !== null });
}

const toolUse = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const toolResult = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, content: text });

describe('WireCaptureAssembler', () => {
  it('emits one init per user turn and one observation per result, using the prefix to skip history', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const user1 = { role: 'user', content: 'run the tests' };
    const call1 = { role: 'assistant', content: [toolUse('toolu_1', 'bun test')] };
    const result1 = { role: 'user', content: [toolResult('toolu_1', '3 pass')] };
    const answer1 = { role: 'assistant', content: 'All green.' };
    const user2 = { role: 'user', content: 'now lint' };

    feed(assembler, 'anthropic', { model: 'm', messages: [user1] }, {}, { toolCalls: [{ id: 'toolu_1', name: 'Bash', argsJson: '{"command":"bun test"}' }] });
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, call1, result1] }, {}, { text: 'All green.' });
    // A retry of the same request adds nothing.
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, call1, result1] }, {}, { text: 'All green.' });
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, call1, result1, answer1, user2] }, {}, { text: 'Clean.' });

    expect(sink.events.map(event => event.kind)).toEqual(['session_init', 'observation', 'session_init']);
    expect(sink.events[0].payload).toMatchObject({ contentSessionId: 'session-1', platformSource: 'claude-code', prompt: 'run the tests', cwd: '/Users/me/proj' });
    expect(sink.events[0].payload.nativePromptId).toMatch(/^wire:[0-9a-f]{32}$/);
    expect(sink.events[1].payload).toEqual({
      contentSessionId: 'session-1', platformSource: 'claude-code', toolName: 'Bash', toolInput: { command: 'bun test' },
      toolResponse: '3 pass', toolUseId: 'toolu_1', cwd: '/Users/me/proj',
    });
    expect(sink.events[2].payload).toMatchObject({ prompt: 'now lint' });
    expect(sink.events[2].payload.nativePromptId).not.toBe(sink.events[0].payload.nativePromptId);
  });

  it('the agent\'s own prompt id wins over the derived one', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    feed(assembler, 'anthropic', { model: 'm', messages: [{ role: 'user', content: 'hello' }] }, { nativePromptId: 'prompt-abc' });
    expect(sink.events[0].payload.nativePromptId).toBe('prompt-abc');
  });

  it('first sight mid-conversation replays nothing before the latest user turn', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    feed(assembler, 'anthropic', { model: 'm', messages: [
      { role: 'user', content: 'old ask' },
      { role: 'assistant', content: [toolUse('toolu_old', 'ls')] },
      { role: 'user', content: [toolResult('toolu_old', 'x')] },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'new ask' },
      { role: 'assistant', content: [toolUse('toolu_new', 'pwd')] },
      { role: 'user', content: [toolResult('toolu_new', '/x')] },
    ] });
    expect(sink.events.map(event => [event.kind, event.payload.prompt ?? event.payload.toolUseId])).toEqual([
      ['session_init', 'new ask'],
      ['observation', 'toolu_new'],
    ]);
  });

  it('a compaction mismatch adds no duplicate prompt or observation, and a later new turn still counts', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const user1 = { role: 'user', content: 'refactor the parser' };
    const call1 = { role: 'assistant', content: [toolUse('toolu_1', 'cat parser.ts')] };
    const result1 = { role: 'user', content: [toolResult('toolu_1', 'source')] };
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and the tests' }] });
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and the tests' }, call1, result1] });
    const before = sink.events.length;

    // The compaction side call keeps its summary as an observation.
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, call1, result1, { role: 'user', content: 'Summarize this conversation.' }] },
      { kind: 'compaction' }, { text: 'Summary: refactoring the parser; tests next.' });
    expect(sink.events.slice(before).map(event => event.payload.toolName)).toEqual(['context_compaction']);
    expect(sink.events.at(-1)!.payload.toolUseId).toMatch(/^compaction-[0-9a-f]{32}$/);

    // The history after compaction no longer matches; the same turn goes on.
    const compacted = [
      { role: 'user', content: 'Summary: refactoring the parser; tests next.' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and the tests' },
      call1, result1,
    ];
    const afterCompaction = sink.events.length;
    feed(assembler, 'anthropic', { model: 'm', messages: compacted });
    expect(sink.events.length).toBe(afterCompaction);

    // A new turn after the compaction is still a new turn.
    feed(assembler, 'anthropic', { model: 'm', messages: [...compacted, { role: 'assistant', content: 'done' }, { role: 'user', content: 'ship it' }] });
    expect(sink.events.slice(afterCompaction).map(event => [event.kind, event.payload.prompt])).toEqual([['session_init', 'ship it']]);
  });

  it('an image-only first turn still emits session_init, with the media placeholder', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const imageOnly = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] };
    feed(assembler, 'anthropic', { model: 'm', messages: [imageOnly] }, {}, { text: 'A cat.' });
    expect(sink.events.map(event => [event.kind, event.payload.prompt])).toEqual([['session_init', MEDIA_PROMPT_PLACEHOLDER]]);
    expect(sink.events[0].payload.nativePromptId).toMatch(/^wire:[0-9a-f]{32}$/);
  });

  it('an attachment-only turn after a text turn is saved with the placeholder, never the older words', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const user1 = { role: 'user', content: 'review this design' };
    const answer1 = { role: 'assistant', content: 'Send it over.' };
    const fileOnly = { role: 'user', content: [{ type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'AA' } }] };
    feed(assembler, 'anthropic', { model: 'm', messages: [user1] }, {}, { text: 'Send it over.' });
    feed(assembler, 'anthropic', { model: 'm', messages: [user1, answer1, fileOnly] }, {}, { text: 'Looks good.' });
    expect(sink.events.map(event => [event.kind, event.payload.prompt])).toEqual([
      ['session_init', 'review this design'],
      ['session_init', MEDIA_PROMPT_PLACEHOLDER],
    ]);
    expect(sink.events[1].payload.nativePromptId).not.toBe(sink.events[0].payload.nativePromptId);
  });

  it('first sight of an image-only turn with earlier text uses the placeholder, not the earlier words', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const imageOnly = { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] };
    feed(assembler, 'anthropic', { model: 'm', messages: [{ role: 'user', content: 'old words' }, { role: 'assistant', content: 'ok' }, imageOnly] });
    expect(sink.events.map(event => [event.kind, event.payload.prompt])).toEqual([['session_init', MEDIA_PROMPT_PLACEHOLDER]]);
  });

  it('helper requests never become events', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    feed(assembler, 'anthropic', { model: 'm', messages: [{ role: 'user', content: 'title this' }] }, { kind: 'helper:title' }, { text: 'A title' });
    expect(sink.events).toEqual([]);
  });

  it('a subagent\'s results are observations marked as a subagent\'s, and its task is not a user prompt', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    feed(assembler, 'anthropic', { model: 'm', messages: [
      { role: 'user', content: 'Explore the repo' },
      { role: 'assistant', content: [toolUse('toolu_sub', 'ls')] },
      { role: 'user', content: [toolResult('toolu_sub', 'src')] },
    ] }, { kind: 'subagent', subagent: 'a143287ac46b82a96' });
    expect(sink.events.map(event => event.kind)).toEqual(['observation']);
    expect(sink.events[0].payload).toMatchObject({ toolUseId: 'toolu_sub', agentId: 'a143287ac46b82a96', agentType: 'subagent', contentSessionId: 'session-1' });
  });

  it('an unknown folder files events under <agentId>-unattributed with no cwd, and counts them', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    feed(assembler, 'anthropic', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { workDir: undefined });
    expect(sink.events[0].payload).toMatchObject({ project: 'claude-code-unattributed' });
    expect(sink.events[0].payload.cwd).toBeUndefined();
    expect(assembler.unattributedEventCount).toBe(1);
  });

  it('Gemini calls without ids get ids from their content, never the positional ones, stable across turns', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const suffixPath = '/v1beta/models/gemini-3:streamGenerateContent';
    const user = { role: 'user', parts: [{ text: 'read both files' }] };
    const calls = { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }, { functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] };
    const results = { role: 'user', parts: [
      { functionResponse: { name: 'read_file', response: { output: 'A' } } },
      { functionResponse: { name: 'read_file', response: { output: 'A' } } },
    ] };
    feed(assembler, 'gemini', { contents: [user] }, { agentId: 'gemini-cli' },
      { toolCalls: [{ id: 'gemini:reply:0', name: 'read_file', argsJson: '{"path":"a.ts"}' }] }, suffixPath);
    feed(assembler, 'gemini', { contents: [user, calls, results] }, { agentId: 'gemini-cli' }, { text: 'Both say A.' }, suffixPath);
    feed(assembler, 'gemini', { contents: [user, calls, results, { role: 'model', parts: [{ text: 'Both say A.' }] }, { role: 'user', parts: [{ text: 'thanks' }] }] },
      { agentId: 'gemini-cli' }, { text: 'np' }, suffixPath);

    const observationIds = sink.events.filter(event => event.kind === 'observation').map(event => event.payload.toolUseId as string);
    expect(observationIds).toHaveLength(2);
    for (const id of observationIds) expect(id).toMatch(/^gemini-[0-9a-f]{32}$/);
    expect(new Set(observationIds).size).toBe(2);

    // The same history seen fresh (an assembler restart) derives the same ids.
    const freshSink = recordingSink();
    const fresh = new WireCaptureAssembler({ eventSink: freshSink });
    feed(fresh, 'gemini', { contents: [user, calls, results] }, { agentId: 'gemini-cli' }, null, suffixPath);
    expect(freshSink.events.filter(event => event.kind === 'observation').map(event => event.payload.toolUseId)).toEqual(observationIds);
  });

  it('Gemini: the same function called twice without ids pairs each result with its own call\'s args', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const suffixPath = '/v1beta/models/gemini-3:streamGenerateContent';
    feed(assembler, 'gemini', { contents: [
      { role: 'user', parts: [{ text: 'read both files' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }, { functionCall: { name: 'read_file', args: { path: 'b.ts' } } }] },
      { role: 'user', parts: [
        { functionResponse: { name: 'read_file', response: { output: 'contents of a' } } },
        { functionResponse: { name: 'read_file', response: { output: 'contents of b' } } },
      ] },
    ] }, { agentId: 'gemini-cli' }, { text: 'Read.' }, suffixPath);
    const observations = sink.events.filter(event => event.kind === 'observation').map(event => [event.payload.toolInput, event.payload.toolResponse]);
    expect(observations).toEqual([
      [{ path: 'a.ts' }, 'contents of a'],
      [{ path: 'b.ts' }, 'contents of b'],
    ]);
  });

  it('a new agent prompt id is a new turn even when the words and the sent input repeat (Responses previous_response_id)', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] }];
    feed(assembler, 'openai-responses', { model: 'm', input }, { agentId: 'codex', nativePromptId: 'turn-1' }, { text: 'Green.' }, '/v1/responses');
    // The same turn sent again (a retry) is not a new turn.
    feed(assembler, 'openai-responses', { model: 'm', input }, { agentId: 'codex', nativePromptId: 'turn-1' }, { text: 'Green.' }, '/v1/responses');
    // Only the new input goes up, and it is the same prompt as before: a new turn by its id.
    feed(assembler, 'openai-responses', { model: 'm', previous_response_id: 'resp_1', input }, { agentId: 'codex', nativePromptId: 'turn-2' }, { text: 'Green again.' }, '/v1/responses');
    const inits = sink.events.filter(event => event.kind === 'session_init').map(event => [event.payload.prompt, event.payload.nativePromptId]);
    expect(inits).toEqual([['run the tests', 'turn-1'], ['run the tests', 'turn-2']]);
  });

  it('a Responses result whose call is only in the previous reply pairs with that reply\'s call', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    feed(assembler, 'openai-responses', { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] }] },
      { agentId: 'opencode' }, { toolCalls: [{ id: 'call_w', name: 'get_weather', argsJson: '{"city":"Boston"}' }] }, '/v1/responses');
    // previous_response_id style: the call is not resent.
    feed(assembler, 'openai-responses', { model: 'm', previous_response_id: 'resp_1', input: [{ type: 'function_call_output', call_id: 'call_w', output: 'sunny' }] },
      { agentId: 'opencode' }, { text: 'Sunny.' }, '/v1/responses');
    const observation = sink.events.find(event => event.kind === 'observation');
    expect(observation?.payload).toMatchObject({ toolName: 'get_weather', toolInput: { city: 'Boston' }, toolResponse: 'sunny', toolUseId: 'call_w' });
  });

  it('turn ends summarize with the last reply text; a stale session ends and is forgotten', () => {
    const sink = recordingSink();
    const assembler = new WireCaptureAssembler({ eventSink: sink });
    // A session that produced nothing is unknown to the worker: no summary, no end.
    assembler.handleTurnEnd({ agentId: 'claude-code', sessionId: 'nothing', turnStartedAt: 0, lastReplyEndedAt: 1 });
    assembler.handleSessionStale({ agentId: 'claude-code', sessionId: 'nothing', lastActivityAt: 1 });
    expect(sink.events).toEqual([]);

    feed(assembler, 'anthropic', { model: 'm', messages: [{ role: 'user', content: 'hello' }] }, {}, { text: 'Hi there.' });
    assembler.handleTurnEnd({ agentId: 'claude-code', sessionId: 'session-1', workDir: '/Users/me/proj', turnStartedAt: 0, lastReplyEndedAt: 1 });
    assembler.handleSessionStale({ agentId: 'claude-code', sessionId: 'session-1', lastActivityAt: 1 });
    expect(sink.events.slice(1)).toEqual([
      { kind: 'summarize', payload: { contentSessionId: 'session-1', platformSource: 'claude-code', lastAssistantMessage: 'Hi there.', cwd: '/Users/me/proj' } },
      { kind: 'session_end', payload: { contentSessionId: 'session-1', platformSource: 'claude-code' } },
    ]);
    expect(assembler.trackedConversationCount).toBe(0);
  });
});
