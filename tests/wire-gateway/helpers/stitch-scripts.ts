import type { WireProtocol } from '../../../src/services/wire-gateway/relay/protocols.js';
import type { FakeUpstreamReply } from './fake-upstream.js';

// Scripted vendor rounds for the hidden memory_search stitcher tests (plan
// Phase 12 task 2): each protocol's own stream and whole-JSON shapes for a
// round that says some text, may think, and may call tools.

export interface ScriptedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptedRound {
  text?: string;
  thinking?: string;
  calls: ScriptedCall[];
  usage: { input: number; output: number; cacheRead: number };
}

export interface StitchProtocolCase {
  protocol: WireProtocol;
  agentId: string;
  streamPath: string;
  wholePath: string;
  /** The agent's first request; Gemini says stream in its path. */
  requestBody(stream: boolean): string;
  streamRound(round: ScriptedRound, roundNumber: number): string[];
  wholeRound(round: ScriptedRound, roundNumber: number): unknown;
}

const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const dataOnly = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const CWD_TEXT = '<cwd>/work/app</cwd> fix the auth bug';

const anthropic: StitchProtocolCase = {
  protocol: 'anthropic',
  agentId: 'claude-code',
  streamPath: '/v1/messages',
  wholePath: '/v1/messages',
  requestBody: stream => JSON.stringify({
    model: 'claude-x', max_tokens: 32000, stream,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.300;' }, { type: 'text', text: 'You are careful.' }],
    tools: [{ name: 'Read', description: 'Reads', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: CWD_TEXT }],
  }),
  streamRound(round, roundNumber) {
    const chunks = [sse('message_start', { type: 'message_start', message: { id: `msg_${roundNumber}`, type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: round.usage.input, output_tokens: 1, cache_read_input_tokens: round.usage.cacheRead } } })];
    chunks.push(sse('ping', { type: 'ping' }));
    let index = 0;
    if (round.thinking !== undefined) {
      chunks.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
      chunks.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: round.thinking } }));
      chunks.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `sig-${roundNumber}` } }));
      chunks.push(sse('content_block_stop', { type: 'content_block_stop', index }));
      index++;
    }
    if (round.text !== undefined) {
      chunks.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      chunks.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: round.text } }));
      chunks.push(sse('content_block_stop', { type: 'content_block_stop', index }));
      index++;
    }
    for (const call of round.calls) {
      const args = JSON.stringify(call.args);
      chunks.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
      chunks.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args.slice(0, 5) } }));
      chunks.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args.slice(5) } }));
      chunks.push(sse('content_block_stop', { type: 'content_block_stop', index }));
      index++;
    }
    chunks.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: round.calls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: round.usage.output } }));
    chunks.push(sse('message_stop', { type: 'message_stop' }));
    return chunks;
  },
  wholeRound(round, roundNumber) {
    const content: unknown[] = [];
    if (round.thinking !== undefined) content.push({ type: 'thinking', thinking: round.thinking, signature: `sig-${roundNumber}` });
    if (round.text !== undefined) content.push({ type: 'text', text: round.text });
    for (const call of round.calls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    return {
      id: `msg_${roundNumber}`, type: 'message', role: 'assistant', model: 'claude-x', content,
      stop_reason: round.calls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: round.usage.input, output_tokens: round.usage.output, cache_read_input_tokens: round.usage.cacheRead },
    };
  },
};

const chat: StitchProtocolCase = {
  protocol: 'openai-chat',
  agentId: 'opencode',
  streamPath: '/v1/chat/completions',
  wholePath: '/v1/chat/completions',
  requestBody: stream => JSON.stringify({
    model: 'gpt-x', stream, ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [{ role: 'system', content: 'You are careful.' }, { role: 'user', content: CWD_TEXT }],
    tools: [{ type: 'function', function: { name: 'Read', description: 'Reads', parameters: { type: 'object' } } }],
  }),
  streamRound(round, roundNumber) {
    const base = { id: `chatcmpl-${roundNumber}`, object: 'chat.completion.chunk', created: 1, model: 'gpt-x' };
    const chunk = (delta: unknown, finishReason: string | null = null) => dataOnly({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    const chunks = [chunk({ role: 'assistant', content: '' })];
    if (round.text !== undefined) chunks.push(chunk({ content: round.text }));
    round.calls.forEach((call, index) => {
      const args = JSON.stringify(call.args);
      chunks.push(chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
      chunks.push(chunk({ tool_calls: [{ index, function: { arguments: args } }] }));
    });
    chunks.push(chunk({}, round.calls.length > 0 ? 'tool_calls' : 'stop'));
    chunks.push(dataOnly({ ...base, choices: [], usage: { prompt_tokens: round.usage.input + round.usage.cacheRead, completion_tokens: round.usage.output, total_tokens: round.usage.input + round.usage.cacheRead + round.usage.output, prompt_tokens_details: { cached_tokens: round.usage.cacheRead } } }));
    chunks.push('data: [DONE]\n\n');
    return chunks;
  },
  wholeRound(round, roundNumber) {
    const message: Record<string, unknown> = { role: 'assistant', content: round.text ?? null };
    if (round.calls.length > 0) {
      message.tool_calls = round.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
    }
    return {
      id: `chatcmpl-${roundNumber}`, object: 'chat.completion', created: 1, model: 'gpt-x',
      choices: [{ index: 0, message, finish_reason: round.calls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: round.usage.input + round.usage.cacheRead, completion_tokens: round.usage.output, total_tokens: round.usage.input + round.usage.cacheRead + round.usage.output, prompt_tokens_details: { cached_tokens: round.usage.cacheRead } },
    };
  },
};

function responsesItems(round: ScriptedRound, roundNumber: number): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (round.thinking !== undefined) items.push({ id: `rs_${roundNumber}`, type: 'reasoning', summary: [], encrypted_content: `ZW5j-${roundNumber}` });
  if (round.text !== undefined) items.push({ id: `msg_${roundNumber}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: round.text, annotations: [] }] });
  for (const call of round.calls) items.push({ id: `fc_${call.id}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
  return items;
}

function responsesUsage(round: ScriptedRound) {
  const input = round.usage.input + round.usage.cacheRead;
  return { input_tokens: input, input_tokens_details: { cached_tokens: round.usage.cacheRead }, output_tokens: round.usage.output, total_tokens: input + round.usage.output };
}

const responses: StitchProtocolCase = {
  protocol: 'openai-responses',
  agentId: 'codex',
  streamPath: '/v1/responses',
  wholePath: '/v1/responses',
  requestBody: stream => JSON.stringify({
    model: 'gpt-x', stream, store: false, instructions: 'You are careful.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: CWD_TEXT }] }],
    tools: [{ type: 'function', name: 'Read', description: 'Reads', parameters: { type: 'object' } }],
  }),
  streamRound(round, roundNumber) {
    let sequenceNumber = 0;
    const event = (type: string, fields: Record<string, unknown>) => sse(type, { type, sequence_number: sequenceNumber++, ...fields });
    const response = { id: `resp_${roundNumber}`, object: 'response', status: 'in_progress', output: [] };
    const chunks = [event('response.created', { response }), event('response.in_progress', { response })];
    const items = responsesItems(round, roundNumber);
    items.forEach((item, outputIndex) => {
      if (item.type === 'message') {
        chunks.push(event('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } }));
        chunks.push(event('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
        chunks.push(event('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: round.text }));
        chunks.push(event('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: round.text }));
      } else if (item.type === 'function_call') {
        chunks.push(event('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', arguments: '' } }));
        chunks.push(event('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments }));
        chunks.push(event('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments }));
      } else {
        chunks.push(event('response.output_item.added', { output_index: outputIndex, item }));
      }
      chunks.push(event('response.output_item.done', { output_index: outputIndex, item }));
    });
    chunks.push(event('response.completed', { response: { ...response, status: 'completed', output: items, usage: responsesUsage(round) } }));
    return chunks;
  },
  wholeRound(round, roundNumber) {
    return { id: `resp_${roundNumber}`, object: 'response', status: 'completed', output: responsesItems(round, roundNumber), usage: responsesUsage(round) };
  },
};

function geminiParts(round: ScriptedRound, roundNumber: number): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (round.thinking !== undefined) parts.push({ text: round.thinking, thought: true });
  if (round.text !== undefined) parts.push({ text: round.text });
  round.calls.forEach((call, index) => parts.push({
    functionCall: { id: call.id, name: call.name, args: call.args },
    ...(index === 0 ? { thoughtSignature: `c2ln-${roundNumber}` } : {}),
  }));
  return parts;
}

function geminiUsage(round: ScriptedRound, output: number) {
  return { promptTokenCount: round.usage.input + round.usage.cacheRead, cachedContentTokenCount: round.usage.cacheRead, candidatesTokenCount: output, totalTokenCount: round.usage.input + round.usage.cacheRead + output };
}

const gemini: StitchProtocolCase = {
  protocol: 'gemini',
  agentId: 'gemini-cli',
  streamPath: '/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
  wholePath: '/v1beta/models/gemini-x:generateContent',
  requestBody: () => JSON.stringify({
    systemInstruction: { parts: [{ text: 'You are careful.' }] },
    contents: [{ role: 'user', parts: [{ text: CWD_TEXT }] }],
    tools: [{ functionDeclarations: [{ name: 'Read', parameters: { type: 'object' } }] }],
  }),
  streamRound(round, roundNumber) {
    const parts = geminiParts(round, roundNumber);
    // Every part its own chunk; the last chunk says finishReason.
    return parts.map((part, index) => dataOnly({
      candidates: [{ content: { role: 'model', parts: [part] }, index: 0, ...(index === parts.length - 1 ? { finishReason: 'STOP' } : {}) }],
      usageMetadata: geminiUsage(round, index === parts.length - 1 ? round.usage.output : 1),
      modelVersion: 'gemini-x',
      responseId: `gem-resp-${roundNumber}`,
    }));
  },
  wholeRound(round, roundNumber) {
    return { candidates: [{ content: { role: 'model', parts: geminiParts(round, roundNumber) }, finishReason: 'STOP', index: 0 }], usageMetadata: geminiUsage(round, round.usage.output), modelVersion: 'gemini-x', responseId: `gem-resp-${roundNumber}` };
  },
};

export const STITCH_PROTOCOL_CASES: StitchProtocolCase[] = [anthropic, chat, responses, gemini];

/** A fake upstream script that plays `rounds` in order (the last one again after), streamed or whole. */
export function scriptedRounds(testCase: StitchProtocolCase, rounds: ScriptedRound[], stream: boolean): () => FakeUpstreamReply {
  let played = 0;
  return () => {
    const roundIndex = Math.min(played, rounds.length - 1);
    played++;
    return stream
      ? { kind: 'sse', chunks: testCase.streamRound(rounds[roundIndex], played) }
      : { kind: 'json', body: testCase.wholeRound(rounds[roundIndex], played) };
  };
}

export interface ClientSseEvent {
  name: string;
  data: string;
  json: Record<string, any> | null;
}

/** The client's stream as events (comments kept as name ':' so tests can see them). */
export function parseClientSse(text: string): ClientSseEvent[] {
  const events: ClientSseEvent[] = [];
  for (const block of text.split(/\n\n/)) {
    if (block.trim() === '') continue;
    if (block.startsWith(':')) {
      events.push({ name: ':', data: block, json: null });
      continue;
    }
    let name = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n');
    let json: Record<string, any> | null = null;
    try {
      json = JSON.parse(data);
    } catch {
      json = null;
    }
    events.push({ name, data, json });
  }
  return events;
}
