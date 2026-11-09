import { describe, expect, it } from 'bun:test';
import { AnthropicStitcher } from '../../src/services/wire-gateway/memory/stitch/anthropic-stitcher.js';
import { OpenAiChatStitcher, accumulateDelta } from '../../src/services/wire-gateway/memory/stitch/openai-chat-stitcher.js';
import { RawSseEventSplitter, type HiddenToolResult } from '../../src/services/wire-gateway/memory/stitch/stitch-events.js';
import { hiddenToolLoopStream } from '../../src/services/wire-gateway/memory/stitch/hidden-tool-loop.js';
import { createMemoryInjectionStage } from '../../src/services/wire-gateway/memory/memory-injection-stage.js';
import { createMemorySearchStage } from '../../src/services/wire-gateway/memory/memory-search-stage.js';
import type { WireReplyStitchInput, WireRewriteContext } from '../../src/services/wire-gateway/rewrite/rewrite-stage.js';
import type { WireConversationLedgerView, WireLedgerEntry } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { STITCH_PROTOCOL_CASES } from './helpers/stitch-scripts.js';

// The stitcher pieces on their own: the loop's back-pressure and failure
// path, Chat's replayed assistant turn, and the memory stages' born gates.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const anthropicCase = STITCH_PROTOCOL_CASES[0];

function streamOf(chunks: string[], onPull?: () => void): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (next < chunks.length) controller.enqueue(encoder.encode(chunks[next++]));
      else controller.close();
    },
  }, { highWaterMark: 0 });
}

function loopInput(firstReplyBody: ReadableStream<Uint8Array>, askUpstreamAgain: WireReplyStitchInput['askUpstreamAgain'], failures: unknown[] = []): WireReplyStitchInput {
  return {
    forwardedBody: encoder.encode(anthropicCase.requestBody(true)),
    status: 200,
    contentType: 'text/event-stream',
    firstReplyBody,
    askUpstreamAgain,
    signal: new AbortController().signal,
    noteFailure: error => failures.push(error),
  };
}

const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe('the hidden tool loop', () => {
  it('reads upstream only as fast as the client takes the stitched reply (back-pressure)', async () => {
    const chunks = [sse('message_start', { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })];
    for (let index = 0; index < 200; index++) chunks.push(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `w${index} ` } }));
    chunks.push(sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } }),
      sse('message_stop', { type: 'message_stop' }));
    let pulls = 0;
    const stitched = hiddenToolLoopStream({
      stitcher: new AnthropicStitcher('memory_search'),
      mode: 'stream',
      input: loopInput(streamOf(chunks, () => pulls++), () => Promise.reject(new Error('no second round'))),
      search: async () => ({ text: '', isError: false }),
    });
    const reader = stitched.getReader();
    await reader.read();
    await new Promise(resolve => setTimeout(resolve, 50));
    // A slow client: only what it asked for (and a chunk of read-ahead) was read upstream.
    expect(pulls).toBeLessThanOrEqual(4);
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(pulls).toBeGreaterThanOrEqual(chunks.length);
    expect(text).toContain('w199 ');
    expect(text.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);
  });

  it('a later round that fails: the error event reaches the client, the stream ends without an end marker, and health hears of it', async () => {
    const hiddenRound = anthropicCase.streamRound({ text: 'Let me check.', calls: [{ id: 'call_1', name: 'memory_search', args: { query: 'x' } }], usage: { input: 1, output: 1, cacheRead: 0 } }, 1);
    const failures: unknown[] = [];
    const stitched = hiddenToolLoopStream({
      stitcher: new AnthropicStitcher('memory_search'),
      mode: 'stream',
      input: loopInput(streamOf(hiddenRound), async () => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }), failures),
      search: async () => ({ text: 'found', isError: false }),
    });
    const text = await new Response(stitched).text();
    expect(text).toContain('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"claude-mem memory_search: round 2 failed upstream (HTTP 529)');
    expect(text).toContain('Overloaded');
    expect(text).not.toContain('message_stop');
    expect(text).not.toContain('memory_search"');
    expect(failures).toHaveLength(1);
  });
});

describe('the Chat stitcher replays the assistant turn as it came', () => {
  it('keeps reasoning under its own name, reasoning_details, and a call\'s thought signature', () => {
    const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
    const chunk = (delta: unknown, finishReason: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    const events = [
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning: 'Think ', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'Think ' }] }),
      chunk({ reasoning: 'more.', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'more.', signature: 'sig-x' }] }),
      chunk({ content: 'Checking.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'memory_search', arguments: '' }, extra_content: { google: { thought_signature: 'c2ln' } } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"query":"auth"}' } }] }),
      chunk({}, 'stop'),
      'data: [DONE]\n\n',
    ];
    const stitcher = new OpenAiChatStitcher('memory_search');
    stitcher.startRound(1, true);
    const splitter = new RawSseEventSplitter();
    const client = events.flatMap(event => splitter.push(encoder.encode(event))).flatMap(event => stitcher.streamEvent(event)).map(bytes => decoder.decode(bytes)).join('');
    // A "stop" after calls of the hidden tool only is a hidden-only round all the same.
    const outcome = stitcher.endStreamRound();
    expect(outcome.continues).toBe(true);
    expect(client).not.toContain('memory_search');
    expect(client).not.toContain('[DONE]');

    const previous = encoder.encode('{"model":"m","messages":[{"role":"user","content":"hi"}]}');
    const results: HiddenToolResult[] = [{ call: outcome.hiddenCalls[0], text: 'found', isError: false }];
    const next = JSON.parse(decoder.decode(stitcher.nextRequestBody(previous, results)));
    expect(next.messages[1]).toEqual({
      role: 'assistant',
      content: 'Checking.',
      reasoning: 'Think more.',
      reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'Think more.', signature: 'sig-x' }],
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'memory_search', arguments: '{"query":"auth"}' }, extra_content: { google: { thought_signature: 'c2ln' } } }],
    });
    expect(next.messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'found' });
  });

  it('accumulates as a stream does: strings joined, names kept, entries merged by index', () => {
    const merged = accumulateDelta({}, { role: 'assistant', content: 'a', tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{' } }] });
    accumulateDelta(merged, { role: 'assistant', content: 'b', tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, id: 'y' }] });
    expect(merged).toEqual({ role: 'assistant', content: 'ab', tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{}' } }, { index: 1, id: 'y' }] });
  });

  it('a fixed field repeated in each delta is kept once; text that grows is joined, even a piece that repeats', () => {
    const merged = accumulateDelta({}, { reasoning: 'ha', reasoning_details: [{ index: 0, type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'ha' }] });
    accumulateDelta(merged, { reasoning: 'ha', reasoning_details: [{ index: 0, type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'ha' }] });
    accumulateDelta(merged, { reasoning: '!', reasoning_details: [{ index: 0, type: 'reasoning.text', format: 'anthropic-claude-v1', text: '!', signature: 'sig-x' }] });
    expect(merged).toEqual({
      reasoning: 'haha!',
      reasoning_details: [{ index: 0, type: 'reasoning.text', format: 'anthropic-claude-v1', text: 'haha!', signature: 'sig-x' }],
    });
  });
});

describe('the Chat stitcher holds a streamed round under the round cap', () => {
  it('a round whose deltas pass the cap fails through the loop\'s failure path, never truncated', async () => {
    const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm' };
    const chunk = (delta: unknown, finishReason: string | null = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
    const chunks = [chunk({ role: 'assistant', content: '' })];
    for (let index = 0; index < 10; index++) chunks.push(chunk({ content: 'x'.repeat(100) }));
    chunks.push(chunk({}, 'stop'), 'data: [DONE]\n\n');
    const failures: unknown[] = [];
    const input: WireReplyStitchInput = {
      ...loopInput(streamOf(chunks), () => Promise.reject(new Error('no second round')), failures),
      forwardedBody: encoder.encode('{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}'),
    };
    const stitched = hiddenToolLoopStream({
      stitcher: new OpenAiChatStitcher('memory_search', 500),
      mode: 'stream',
      input,
      search: async () => ({ text: '', isError: false }),
    });
    const text = await new Response(stitched).text();
    expect(text).toContain('"type":"api_error"');
    expect(text).toContain('a round\'s deltas are over 500 bytes');
    expect(text).not.toContain('[DONE]');
    expect(failures).toHaveLength(1);
  });
});

describe('the memory stages rewrite only conversations born under the gateway', () => {
  const ledgerWith = (status: WireConversationLedgerView['status'], entries: Record<string, WireLedgerEntry> = {}): WireConversationLedgerView => ({
    conversationKey: 'k',
    status,
    get: entryId => entries[entryId],
    entries: () => Object.values(entries),
    record: entry => entry,
  });
  const contextWith = (ledger: WireConversationLedgerView | null) => ({ ledger } as unknown as WireRewriteContext);

  for (const [stageName, stage] of [['memory-injection', createMemoryInjectionStage()], ['memory-search', createMemorySearchStage()]] as const) {
    it(`${stageName}: applies to a born conversation only`, () => {
      expect(stage.appliesTo!(contextWith(ledgerWith('born')))).toBe(true);
      expect(stage.appliesTo!(contextWith(ledgerWith('not_born')))).toBe(false);
      expect(stage.appliesTo!(contextWith(ledgerWith('unknown')))).toBe(false);
      expect(stage.appliesTo!(contextWith(null))).toBe(false);
      expect(stage.appliesTo!(contextWith(ledgerWith('born', { [`suspended:${stageName}`]: { type: 'suspended', stage: stageName, at: '' } })))).toBe(false);
    });
  }
});
