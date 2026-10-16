import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { collectWireReply, createWireReplyCollector } from '../../src/services/wire-gateway/ir/reply-collectors.js';
import { IncrementalSseReader, WIRE_SSE_MAX_EVENT_BYTES, type WireSseEvent } from '../../src/services/wire-gateway/ir/sse-event-reader.js';
import { ToolCallScanner } from '../../src/services/wire-gateway/ir/tool-scan.js';
import type { WireReply } from '../../src/services/wire-gateway/ir/types.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';

const FIXTURES = join(import.meta.dir, '../fixtures/wire-gateway');
const SSE = 'text/event-stream';
const JSON_TYPE = 'application/json';
const encoder = new TextEncoder();

function fixtureBytes(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, relativePath)));
}

function collectWhole(protocol: WireProtocol, contentType: string, bytes: Uint8Array): WireReply {
  return collectWireReply(protocol, contentType, [bytes]);
}

/** The reply is the same however the bytes are split: in two at every byte, and one byte at a time. */
function expectSameAtEverySplit(protocol: WireProtocol, contentType: string, bytes: Uint8Array): WireReply {
  const whole = collectWhole(protocol, contentType, bytes);
  for (let split = 1; split < bytes.length; split++) {
    expect(collectWireReply(protocol, contentType, [bytes.subarray(0, split), bytes.subarray(split)])).toEqual(whole);
  }
  const oneByteChunks = Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1));
  expect(collectWireReply(protocol, contentType, oneByteChunks)).toEqual(whole);
  return whole;
}

const STREAM_FIXTURES: Array<[string, WireProtocol, string]> = [
  ['official/anthropic-basic.sse', 'anthropic', SSE],
  ['official/anthropic-tool-use.sse', 'anthropic', SSE],
  ['official/anthropic-thinking.sse', 'anthropic', SSE],
  ['official/anthropic-error.sse', 'anthropic', SSE],
  ['official/openai-chat-basic.sse', 'openai-chat', SSE],
  ['official/openai-responses-basic.sse', 'openai-responses', SSE],
  ['official/gemini-stream.TODO-live-capture.sse', 'gemini', SSE],
  ['magpie/vertex_openai_thoughts.sse', 'openai-chat', SSE],
  ['official/openai-chat-tool-calls.json', 'openai-chat', JSON_TYPE],
  ['official/openai-responses-function-call.json', 'openai-responses', JSON_TYPE],
];

describe('wire IR reply collectors: every byte split', () => {
  for (const [fixture, protocol, contentType] of STREAM_FIXTURES) {
    it(`${fixture} rebuilds the same reply split at every byte`, () => {
      expectSameAtEverySplit(protocol, contentType, fixtureBytes(fixture));
    });
  }
  it('with CRLF line ends too', () => {
    const crlf = new TextDecoder().decode(fixtureBytes('official/anthropic-tool-use.sse')).replace(/\n/g, '\r\n');
    const reply = expectSameAtEverySplit('anthropic', SSE, encoder.encode(crlf));
    expect(reply).toEqual(collectWhole('anthropic', SSE, fixtureBytes('official/anthropic-tool-use.sse')));
  });
});

describe('wire IR reply collectors: the docs\' examples', () => {
  it('Anthropic basic: text, stop, and message_delta usage (cumulative, so the last wins)', () => {
    const reply = collectWhole('anthropic', SSE, fixtureBytes('official/anthropic-basic.sse'));
    expect(reply).toMatchObject({ text: 'Hello!', stop: 'stop', model: 'claude-opus-5-5', endedCleanly: true });
    expect(reply.usage).toMatchObject({ inputTokens: 25, outputTokens: 15 });
  });

  it('Anthropic tool use: args assembled from input_json_delta', () => {
    const reply = collectWhole('anthropic', SSE, fixtureBytes('official/anthropic-tool-use.sse'));
    expect(reply.text).toBe('Okay, let\'s check the weather for San Francisco, CA:');
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]).toMatchObject({ id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'get_weather' });
    expect(JSON.parse(reply.toolCalls[0].argsJson).location).toBe('San Francisco, CA');
    expect(reply).toMatchObject({ stop: 'tool', endedCleanly: true });
    expect(reply.usage).toMatchObject({ inputTokens: 472, outputTokens: 89 });
  });

  it('Anthropic thinking: thinking text and its signature, sealed', () => {
    const reply = collectWhole('anthropic', SSE, fixtureBytes('official/anthropic-thinking.sse'));
    expect(reply.thinking).toStartWith('I need to find the GCD of 1071 and 462');
    expect(reply.thinking).toEndWith('GCD(1071, 462) = 21.');
    expect(reply.sealed).toEqual([{ sealedBy: 'anthropic', form: 'signature', value: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds...' }]);
    expect(reply.text).toBe('The greatest common divisor of 1071 and 462 is **21**.');
  });

  it('Anthropic error event after HTTP 200: an end, but not a clean one', () => {
    const reply = collectWhole('anthropic', SSE, fixtureBytes('official/anthropic-error.sse'));
    expect(reply).toMatchObject({ error: 'Overloaded', endedCleanly: false });
  });

  it('OpenAI Chat stream and tool-call body', () => {
    expect(collectWhole('openai-chat', SSE, fixtureBytes('official/openai-chat-basic.sse')))
      .toMatchObject({ text: 'Hello', stop: 'stop', model: 'gpt-6-astra', endedCleanly: true });
    const reply = collectWhole('openai-chat', JSON_TYPE, fixtureBytes('official/openai-chat-tool-calls.json'));
    expect(reply.toolCalls).toEqual([{ id: 'call_abc123', name: 'get_current_weather', argsJson: '{\n"location": "Boston, MA"\n}' }]);
    expect(reply).toMatchObject({ stop: 'tool', endedCleanly: true });
    expect(reply.usage).toMatchObject({ inputTokens: 82, outputTokens: 17, cacheReadTokens: 0 });
  });

  it('OpenAI Responses stream and function-call body', () => {
    const streamed = collectWhole('openai-responses', SSE, fixtureBytes('official/openai-responses-basic.sse'));
    expect(streamed).toMatchObject({ text: 'Hi', stop: 'stop', model: 'gpt-6-astra', endedCleanly: true });
    expect(streamed.usage).toMatchObject({ inputTokens: 37, outputTokens: 11, reasoningTokens: 0 });
    const whole = collectWhole('openai-responses', JSON_TYPE, fixtureBytes('official/openai-responses-function-call.json'));
    expect(whole.toolCalls).toEqual([{ id: 'call_unLAR8MvFNptuiZK6K6HCy5k', name: 'get_current_weather', argsJson: '{"location":"Boston, MA","unit":"celsius"}' }]);
    expect(whole).toMatchObject({ stop: 'tool', endedCleanly: true });
    expect(whole.usage).toMatchObject({ inputTokens: 291, outputTokens: 23 });
  });

  it('Gemini (hand-built until a live capture): thoughts count as output and reasoning, cached tokens come off the prompt', () => {
    const reply = collectWhole('gemini', SSE, fixtureBytes('official/gemini-stream.TODO-live-capture.sse'));
    expect(reply).toMatchObject({ thinking: 'Thinking about the files.', text: 'I\'ll list the directory.', stop: 'tool', endedCleanly: true });
    expect(reply.toolCalls).toEqual([{ id: 'gemini:reply:0', name: 'list_directory', argsJson: '{"path":"."}' }]);
    expect(reply.usage).toMatchObject({ inputTokens: 80, cacheReadTokens: 40, outputTokens: 50, reasoningTokens: 32 });
    expect(reply.sealed).toEqual([{ sealedBy: 'gemini', form: 'signature', value: 'c2lnbmF0dXJl' }]);
  });

  it('Gemini thoughts through Vertex\'s OpenAI-compatible Chat (magpie fixture)', () => {
    const reply = collectWhole('openai-chat', SSE, fixtureBytes('magpie/vertex_openai_thoughts.sse'));
    expect(reply.thinking).toStartWith('**Acknowledging Greeting**');
    expect(reply.text).toBe('你好！很高兴与你交流。请问有什么我可以帮你的吗？');
    expect(reply.sealed[0]).toMatchObject({ sealedBy: 'gemini', form: 'signature' });
  });
});

describe('wire IR reply collectors: cut detection', () => {
  for (const [fixture, protocol, contentType] of STREAM_FIXTURES) {
    if (fixture.endsWith('anthropic-error.sse')) continue;
    it(`${fixture} cut before its end is not ended cleanly`, () => {
      const bytes = fixtureBytes(fixture);
      const text = new TextDecoder().decode(bytes);
      const endAt = contentType === SSE
        ? Math.min(...['message_stop', '[DONE]', 'response.completed', 'finishReason'].map(marker => text.indexOf(marker)).filter(index => index >= 0))
        : bytes.length - 2;
      expect(endAt).toBeGreaterThan(0);
      const cut = encoder.encode(text.slice(0, contentType === SSE ? text.lastIndexOf('\n', endAt) : endAt));
      expect(collectWhole(protocol, contentType, cut).endedCleanly).toBe(false);
      expect(collectWhole(protocol, contentType, bytes).endedCleanly).toBe(true);
    });
  }

  it('an empty body is not a reply', () => {
    expect(collectWhole('anthropic', SSE, new Uint8Array()).endedCleanly).toBe(false);
    expect(collectWhole('openai-chat', JSON_TYPE, new Uint8Array()).endedCleanly).toBe(false);
  });
});

describe('wire IR reply collectors: edge cases', () => {
  const sse = (events: object[]) => encoder.encode(events.map(event => `event: ${(event as { type?: string }).type ?? 'x'}\ndata: ${JSON.stringify(event)}\n\n`).join(''));

  it('Anthropic: a relay\'s whole tool input at block start, cumulative usage, redacted blocks, server tools, unknown events', () => {
    const redacted = '{"type":"redacted_thinking","data":"EmwK\\u002b"}';
    const stream = new TextDecoder().decode(sse([
      { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 10, cache_read_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }, output_tokens: 1 } } },
    ])) + `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":${redacted}}\n\n` + new TextDecoder().decode(sse([
      { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      { type: 'brand_new_event', index: 9 },
      { type: 'ping' },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 55, output_tokens_details: { thinking_tokens: 12 } } },
      { type: 'message_stop' },
    ]));
    const reply = expectSameAtEverySplit('anthropic', SSE, encoder.encode(stream));
    expect(reply.toolCalls).toEqual([{ id: 't1', name: 'Bash', argsJson: '{"command":"ls"}' }]);
    expect(reply.sealed).toEqual([{ sealedBy: 'anthropic', form: 'block', value: redacted }]);
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 55, cacheReadTokens: 500, cacheWriteTokens: 50, cacheWrite1hTokens: 30, reasoningTokens: 12 });
    expect(reply).toMatchObject({ stop: 'tool', endedCleanly: true });
  });

  it('Chat: tool_calls by index across chunks, usage chunk with cached tokens, magpie_deferred, no blank lines between events', () => {
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"p":' } }, { index: 1, id: 'call_b', function: { name: 'ls', arguments: '{}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ index: 1, delta: { content: 'other choice is ignored' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 5 }, magpie_deferred: { prompt_tokens: 7, completion_tokens: 3 } } },
    ];
    // One JSON event per data line and no blank line between them (a relay's habit, magpie sniff.go).
    const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n`).join('') + 'data: [DONE]\n';
    const reply = expectSameAtEverySplit('openai-chat', SSE, encoder.encode(body));
    expect(reply.toolCalls).toEqual([{ id: 'call_a', name: 'read', argsJson: '{"p":1}' }, { id: 'call_b', name: 'ls', argsJson: '{}' }]);
    expect(reply.text).toBe('');
    expect(reply.usage).toEqual({
      inputTokens: 400, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 5,
      deferred: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 },
    });
    expect(reply).toMatchObject({ stop: 'tool', endedCleanly: true });
  });

  it('Responses: deltas and done arguments, custom tool calls, sealed reasoning items, incomplete and failed', () => {
    const reasoningItem = '{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"gAAA\\u003d"}';
    const events = [
      { type: 'response.created', response: { model: 'gpt' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'plan' },
    ];
    const stream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
      + `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":${reasoningItem}}\n\n`
      + [
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'shell' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"cmd":' },
        { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"cmd":"ls"}' },
        { type: 'response.output_item.done', output_index: 2, item: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch' } },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const reply = expectSameAtEverySplit('openai-responses', SSE, encoder.encode(stream));
    expect(reply.thinking).toBe('plan');
    expect(reply.sealed).toEqual([{ sealedBy: 'openai-responses', form: 'block', value: reasoningItem }]);
    expect(reply.toolCalls).toEqual([
      { id: 'call_1', name: 'shell', argsJson: '{"cmd":"ls"}' },
      { id: 'call_2', name: 'apply_patch', argsJson: '{"input":"*** Begin Patch"}' },
    ]);
    expect(reply.usage).toMatchObject({ inputTokens: 36, cacheReadTokens: 64, outputTokens: 9, reasoningTokens: 4 });
    expect(reply).toMatchObject({ stop: 'tool', endedCleanly: true });

    const incomplete = 'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
    expect(collectWhole('openai-responses', SSE, encoder.encode(incomplete))).toMatchObject({ stop: 'length', endedCleanly: true });
    const failed = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"boom"}}}\n\n';
    expect(collectWhole('openai-responses', SSE, encoder.encode(failed))).toMatchObject({ error: 'boom', endedCleanly: false });
  });

  it('Gemini: a JSON array of chunks (streamGenerateContent without alt=sse) and Code Assist\'s {response} wrapper', () => {
    const chunks = [
      { response: { candidates: [{ content: { parts: [{ text: 'a' }] } }], modelVersion: 'gemini-x' } },
      { response: { candidates: [{ content: { parts: [{ functionCall: { id: 'fc1', name: 'default_api:bash', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } },
    ];
    const reply = expectSameAtEverySplit('gemini', JSON_TYPE, encoder.encode(JSON.stringify(chunks)));
    expect(reply).toMatchObject({ text: 'a', model: 'gemini-x', stop: 'tool', endedCleanly: true });
    expect(reply.toolCalls).toEqual([{ id: 'fc1', name: 'bash', argsJson: '{}' }]);
    expect(reply.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  });

  it('an error body (HTTP 4xx in the vendor\'s shape) is recorded as the error', () => {
    const body = encoder.encode('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}');
    expect(collectWhole('anthropic', JSON_TYPE, body)).toMatchObject({ error: 'bad', endedCleanly: false });
    expect(collectWhole('openai-chat', JSON_TYPE, encoder.encode('{"error":{"message":"nope"}}'))).toMatchObject({ error: 'nope' });
  });

  it('createWireReplyCollector picks SSE from the content type', () => {
    const collector = createWireReplyCollector('openai-chat', 'Text/Event-Stream; charset=utf-8');
    collector.push(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    expect(collector.finish()).toMatchObject({ text: 'x', endedCleanly: true });
  });
});

describe('wire IR toolScan', () => {
  function scan(chunks: string[]): boolean {
    const scanner = new ToolCallScanner();
    for (const chunk of chunks) scanner.observe(encoder.encode(chunk));
    return scanner.calledTool;
  }

  function scanAtEverySplit(text: string): boolean[] {
    const results: boolean[] = [];
    for (let split = 0; split <= text.length; split++) results.push(scan([text.slice(0, split), text.slice(split)]));
    return results;
  }

  it('sees a call in every wire format, at every split', () => {
    for (const text of [
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t"}}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"type":"response.output_item.added","item":{"type" :  "function_call"}}',
      '{"item":{"type":"custom_tool_call"}}',
      '{"item":{"type":"apply_patch_call"}}',
      '{"item":{"type":"mcp_approval_request"}}',
      'data: {"candidates":[{"content":{"parts":[{"functionCall" : {"name":"ls"}}]}}]}',
    ]) {
      expect(scanAtEverySplit(text).every(Boolean), text).toBe(true);
    }
  });

  it('never takes a key, an empty tool_calls list or an escaped string for a call', () => {
    for (const text of [
      'data: {"choices":[{"delta":{"content":"hi","tool_calls":[]}}]}',
      'data: {"delta":{"text":"say \\"tool_use\\": now"}}',
      '{"text":"the functionCall field"}',
      '{"tools":[{"name":"x"}]}',
    ]) {
      expect(scanAtEverySplit(text).some(Boolean), text).toBe(false);
    }
  });

  it('sees a value split over several chunks with spaces before it', () => {
    expect(scan(['{"type":', ' '.repeat(10), '"tool_use"}'])).toBe(true);
  });
});

describe('wire IR reply edge cases found in review', () => {
  it('a whole JSON reply with a UTF-8 byte order mark is read, raw blocks included', () => {
    const body = '{"type":"message","model":"m","content":[{"type":"redacted_thinking","data":"x"},{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}';
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(body)]);
    const reply = collectWhole('anthropic', JSON_TYPE, withMark);
    expect(reply).toMatchObject({ text: 'hi', endedCleanly: true, stop: 'stop' });
    expect(reply.sealed).toEqual([{ sealedBy: 'anthropic', form: 'block', value: '{"type":"redacted_thinking","data":"x"}' }]);
  });

  it('an oversized SSE event is dropped whole, even when the chunk that passes the limit ends its line, and the next event is still read', () => {
    const events: WireSseEvent[] = [];
    const reader = new IncrementalSseReader(event => events.push(event));
    const oversizedData = 'x'.repeat(WIRE_SSE_MAX_EVENT_BYTES + 10);
    // The chunk that passes the limit also ends the line; the event goes on with a second data line.
    reader.push(encoder.encode(`event: big\ndata: ${oversizedData.slice(0, 1000)}`));
    reader.push(encoder.encode(`${oversizedData.slice(1000)}\ndata: still-big-event\n\nevent: small\ndata: ok\n\n`));
    reader.finish();
    expect(events).toEqual([{ event: 'small', data: 'ok' }]);
    expect(reader.oversizedEventCount).toBe(1);
  });
});
