import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JsonScanError, rawText, scanValue } from '../../src/services/wire-gateway/json/scanner.js';
import { parseWireRequest, WireRequestParseError } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { toRecorderParts } from '../../src/services/wire-gateway/ir/recorder-parts.js';
import { emptyWireUsage, type WirePart, type WireRequest } from '../../src/services/wire-gateway/ir/types.js';
import type { WireProtocol } from '../../src/services/wire-gateway/relay/protocols.js';

const MAGPIE_FIXTURES = join(import.meta.dir, '../fixtures/wire-gateway/magpie');
const encoder = new TextEncoder();

function parseFixture(relativePath: string, protocol: WireProtocol): WireRequest {
  return parseWireRequest(protocol, new Uint8Array(readFileSync(join(MAGPIE_FIXTURES, relativePath))));
}

function parseText(protocol: WireProtocol, body: string, suffixPath?: string): WireRequest {
  return parseWireRequest(protocol, encoder.encode(body), { suffixPath });
}

function allParts(request: WireRequest): WirePart[] {
  return [...request.system, ...request.messages.flatMap(message => message.parts)];
}

/** Every part's span is one whole JSON value inside the body. */
function expectPartSpansAreValues(request: WireRequest): void {
  for (const part of allParts(request)) {
    expect(part.span.end).toBeLessThanOrEqual(request.body.length);
    expect(scanValue(request.body, part.span.start)).toEqual(part.span);
    expect(() => JSON.parse(rawText(request.body, part.span))).not.toThrow();
  }
}

const emptyReply = { text: '', toolCalls: [], thinking: '', sealed: [], usage: emptyWireUsage(), stop: null, endedCleanly: true };

describe('wire IR request parsers: magpie fixtures', () => {
  const cases: Array<[string, WireProtocol]> = [
    ['workdir/claude-code-2.1.296.json', 'anthropic'],
    ['context/claude-code.json', 'anthropic'],
    ['workdir/codex-0.162.0.json', 'openai-responses'],
    ['workdir/codex-0.162.1-tool-search.json', 'openai-responses'],
    ['context/codex.json', 'openai-responses'],
    ['opencode2_responses_tools.json', 'openai-responses'],
    ['workdir/pi-1.1.0.json', 'openai-chat'],
    ['opencode2_chat_tools.json', 'openai-chat'],
  ];
  for (const [fixture, protocol] of cases) {
    it(`parses ${fixture} with byte-exact part spans`, () => {
      const request = parseFixture(fixture, protocol);
      expect(request.protocol).toBe(protocol);
      expect(request.model).not.toBe('');
      expect(request.stream).toBe(true);
      expect(request.system.length).toBeGreaterThan(0);
      expect(request.tools.length).toBeGreaterThan(0);
      expect(request.messages.length).toBeGreaterThan(0);
      expectPartSpansAreValues(request);
    });
  }

  it('Claude Code 2.1.296: its # Environment block is a role:"system" message, metadata is kept raw', () => {
    const request = parseFixture('workdir/claude-code-2.1.296.json', 'anthropic');
    expect(request.messages.map(message => message.role)).toEqual(['user', 'system']);
    expect(request.metadata).toContain('user_id');
    expect(request.maxOutputTokens).toBe(128000);
    expect(request.tools.map(tool => tool.name)).toContain('Bash');
  });

  it('Claude Code context fixture: tool calls and results keep ids and args', () => {
    const request = parseFixture('context/claude-code.json', 'anthropic');
    const calls = allParts(request).filter(part => part.kind === 'tool_call');
    const results = allParts(request).filter(part => part.kind === 'tool_result');
    expect(calls.map(call => call.name)).toEqual(['Read', 'Read', 'Bash']);
    expect(results.map(result => result.callId)).toEqual(calls.map(call => call.callId));
    for (const call of calls) expect(() => JSON.parse(call.argsJson!)).not.toThrow();
  });

  it('Codex: ids for Phase 4 (prompt_cache_key, client_metadata) and the tool_search round trip', () => {
    const request = parseFixture('workdir/codex-0.162.1-tool-search.json', 'openai-responses');
    expect(request.cacheKey).toBeTruthy();
    expect(JSON.parse(request.clientMetadata!)).toHaveProperty('turn_id');
    expect(request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
    const call = request.messages[1].parts.find(part => part.kind === 'tool_call')!;
    expect(call.name).toBe('tool_search');
    expect(request.messages[2].parts[0]).toMatchObject({ kind: 'tool_result', callId: call.callId });
  });

  it('Codex context fixture: additional_tools items are tools, custom_tool_call args are {input}', () => {
    const request = parseFixture('context/codex.json', 'openai-responses');
    expect(request.tools.length).toBeGreaterThan(0);
    expect(request.toolsSpan).toBeDefined();
    const call = allParts(request).find(part => part.kind === 'tool_call')!;
    expect(call.name).toBe('exec');
    expect(Object.keys(JSON.parse(call.argsJson!))).toEqual(['input']);
    // A merged Responses turn spans its items contiguously.
    const assistant = request.messages.find(message => message.role === 'assistant')!;
    for (const part of assistant.parts) {
      expect(part.span.start).toBeGreaterThanOrEqual(assistant.span.start);
      expect(part.span.end).toBeLessThanOrEqual(assistant.span.end);
    }
  });
});

describe('wire IR request parsers: protocol rules', () => {
  it('Codex items: developer before a reply is system, after a reply is context; compaction items, standalone outputs and agent_message are kept', () => {
    const request = parseText('openai-responses', JSON.stringify({
      model: 'gpt',
      instructions: 'base',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'early dev' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA' },
        { type: 'function_call', call_id: 'c1', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"a":1}' },
        { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'done' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
        { type: 'function_call_output', output: 'standalone note' },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'late dev' }] },
        { type: 'compaction', encrypted_content: 'xyz' },
        { type: 'compaction_trigger' },
        { type: 'local_shell_call', call_id: 'l1', action: { type: 'exec', command: ['ls', '-la'] } },
        { type: 'web_search_call', action: { type: 'search', query: 'bun zlib' } },
        { type: 'item_reference', id: 'msg_1' },
        { type: 'agent_message', author: 'parent', recipient: 'worker-1', content: [{ type: 'input_text', text: 'task' }] },
        { type: 'some_future_item', whatever: true },
      ],
    }));
    expect(request.system.map(part => part.text)).toEqual(['base', 'early dev']);
    const parts = allParts(request);
    expect(parts.find(part => part.kind === 'sealed')).toMatchObject({ sealedBy: 'openai-responses' });
    expect(parts.find(part => part.kind === 'tool_call')).toMatchObject({ callId: 'c1', name: 'collaboration.spawn_agent', argsJson: '{"a":1}' });
    expect(parts.filter(part => part.kind === 'tool_result')).toMatchObject([
      { callId: 'c1', text: 'done', hasImages: true },
      { callId: undefined, text: 'standalone note' },
    ]);
    const contextParts = parts.filter(part => part.kind === 'context');
    expect(contextParts.map(part => part.name)).toEqual(['developer', 'compaction', 'compaction_trigger', 'local_shell_call', 'web_search_call', 'item_reference']);
    expect(contextParts.find(part => part.name === 'developer')!.text).toBe('late dev');
    expect(contextParts.find(part => part.name === 'local_shell_call')!.text).toBe('ls -la');
    expect(contextParts.find(part => part.name === 'web_search_call')!.text).toBe('bun zlib');
    expect(parts.find(part => part.author)).toMatchObject({ kind: 'text', text: 'task', author: 'parent', recipient: 'worker-1' });
    expectPartSpansAreValues(request);
  });

  it('sealed parts keep byte-identical spans (odd spacing and escapes intact)', () => {
    const redactedBlock = '{ "type" : "redacted_thinking",\n  "data":"EmwKAhgBEgy3va\\u002b+/=" }';
    const thinkingBlock = '{"type":"thinking","thinking":"hm \\u00e9","signature":"sig\\/abc=="}';
    const anthropicBody = `{"model":"claude","messages":[{"role":"assistant","content":[${redactedBlock} , ${thinkingBlock},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{ "command" : "ls" }}]}]}`;
    const anthropic = parseText('anthropic', anthropicBody);
    const [redacted, thinking, toolUse] = anthropic.messages[0].parts;
    expect(redacted).toMatchObject({ kind: 'sealed', sealedBy: 'anthropic' });
    expect(rawText(anthropic.body, redacted.span)).toBe(redactedBlock);
    expect(thinking).toMatchObject({ kind: 'thinking', text: 'hm é', sealedBy: 'anthropic' });
    expect(rawText(anthropic.body, thinking.span)).toBe(thinkingBlock);
    expect(toolUse.argsJson).toBe('{ "command" : "ls" }');

    const reasoningItem = '{"type":"reasoning","id":"rs_9","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"gAAAAB\\u003d"}';
    const responses = parseText('openai-responses', `{"model":"m","input":[{"role":"user","content":"x"},${reasoningItem}]}`);
    const reasoning = responses.messages[1].parts[0];
    expect(reasoning).toMatchObject({ kind: 'thinking', text: 'plan', sealedBy: 'openai-responses' });
    expect(rawText(responses.body, reasoning.span)).toBe(reasoningItem);

    const signedCall = '{"functionCall":{"name":"ls","args":{"p":"."}},"thoughtSignature":"Q0FGRQ=="}';
    const gemini = parseText('gemini', `{"contents":[{"role":"user","parts":[{"text":"go"}]},{"role":"model","parts":[${signedCall}]}]}`, '/v1beta/models/gemini-2.5-pro:streamGenerateContent');
    const call = gemini.messages[1].parts[0];
    expect(call).toMatchObject({ kind: 'tool_call', sealedBy: 'gemini', argsJson: '{"p":"."}' });
    expect(rawText(gemini.body, call.span)).toBe(signedCall);
  });

  it('Gemini: model and streaming from the path, snake_case fields, results matched to calls, model-role results on the user side', () => {
    const request = parseText('gemini', JSON.stringify({
      system_instruction: { parts: [{ text: 'You are terse.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'list' }] },
        { role: 'model', parts: [{ function_call: { name: 'ls', args: { path: '.' } } }, { functionResponse: { name: 'ls', response: { output: 'a\nb' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'ls', response: { error: 'denied' } } }, { inline_data: { mime_type: 'image/png', data: 'AA' } }] },
      ],
      tools: [{ function_declarations: [{ name: 'ls' }] }],
      generation_config: { max_output_tokens: 512 },
    }), '/v1beta/models/gemini-2.5-pro:generateContent');
    expect(request.model).toBe('gemini-2.5-pro');
    expect(request.stream).toBe(false);
    expect(request.system.map(part => part.text)).toEqual(['You are terse.']);
    expect(request.tools.map(tool => tool.name)).toEqual(['ls']);
    expect(request.maxOutputTokens).toBe(512);
    expect(request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'user']);
    const call = request.messages[1].parts[0];
    expect(call).toMatchObject({ kind: 'tool_call', callId: 'gemini:1:0', name: 'ls' });
    expect(request.messages[2].parts[0]).toMatchObject({ kind: 'tool_result', callId: 'gemini:1:0', text: 'a\nb' });
    expect(request.messages[3].parts[0]).toMatchObject({ kind: 'tool_result', callId: 'gemini:1:0', text: 'denied', isError: true });
    expect(request.messages[3].parts[1].kind).toBe('image');
  });

  it('Gemini: id-less results of the same function pair with its calls in order, not all with the latest', () => {
    const request = parseText('gemini', JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: 'read both' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }, { functionCall: { name: 'read_file', args: { path: 'b.ts' } } }] },
        { role: 'user', parts: [
          { functionResponse: { name: 'read_file', response: { output: 'A' } } },
          { functionResponse: { name: 'read_file', response: { output: 'B' } } },
        ] },
      ],
    }), '/v1beta/models/gemini-2.5-pro:generateContent');
    expect(request.messages[1].parts.map(part => part.callId)).toEqual(['gemini:1:0', 'gemini:1:1']);
    expect(request.messages[2].parts.map(part => [part.callId, part.text])).toEqual([['gemini:1:0', 'A'], ['gemini:1:1', 'B']]);
  });

  it('Chat: system and developer go to system, tool messages are results, custom tool calls carry {input}', () => {
    const request = parseText('openai-chat', JSON.stringify({
      model: 'm',
      max_tokens: 99,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'developer', content: [{ type: 'text', text: 'dev' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
        { role: 'assistant', reasoning_content: 'think', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
          { id: 'c2', type: 'custom', custom: { name: 'apply_patch', input: '*** Begin' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'file' },
        { role: 'function', name: 'legacy', content: 'ignored' },
      ],
    }));
    expect(request.system.map(part => part.text)).toEqual(['sys', 'dev']);
    expect(request.maxOutputTokens).toBe(99);
    expect(request.messages[0].parts.map(part => part.kind)).toEqual(['text', 'image']);
    expect(request.messages[1].parts).toMatchObject([
      { kind: 'thinking', text: 'think' },
      { kind: 'tool_call', callId: 'c1', name: 'read', argsJson: '{"p":1}' },
      { kind: 'tool_call', callId: 'c2', name: 'apply_patch', argsJson: '{"input":"*** Begin"}' },
    ]);
    expect(request.messages[2]).toMatchObject({ role: 'user', parts: [{ kind: 'tool_result', callId: 'c1', text: 'file' }] });
    expect(request.messages).toHaveLength(3);
  });

  it('ignores unknown fields and blocks, and fails fast on a body that is not a JSON object', () => {
    const request = parseText('anthropic', '{"model":"m","new_field":{"x":[1]},"messages":[{"role":"user","content":[{"type":"brand_new_block","x":1},{"type":"text","text":"ok"}]}],"system":7,"tools":"nope"}');
    expect(request.messages[0].parts).toMatchObject([{ kind: 'text', text: 'ok' }]);
    expect(request.system).toEqual([]);
    expect(request.tools).toEqual([]);
    expect(() => parseText('anthropic', '[1]')).toThrow(WireRequestParseError);
    expect(() => parseText('openai-chat', '{"model":')).toThrow(JsonScanError);
  });
});

describe('wire IR recorder parts', () => {
  it('ports conversationParts: system and tools as context, tool_use args, tool role results, images and files', () => {
    const request = parseText('anthropic', JSON.stringify({
      model: 'm',
      system: [{ type: 'text', text: 'be brief' }],
      tools: [{ name: 'Bash', input_schema: {} }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }, { type: 'document', title: 'spec.pdf', source: {} }] },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a b' }, { type: 'image', source: {} }] }] },
      ],
    }));
    const parts = toRecorderParts(request, {
      ...emptyReply,
      thinking: 'hmm',
      text: 'Done.',
      toolCalls: [{ id: 't2', name: 'Read', argsJson: '{"p":"a"}' }],
      error: 'overloaded',
    });
    expect(parts.input).toEqual([
      { role: 'system', kind: 'context', name: 'System prompt', text: 'be brief' },
      { role: 'system', kind: 'context', name: 'Tools', text: '[{"name":"Bash","input_schema":{}}]' },
      { role: 'user', kind: 'text', text: 'run it' },
      { role: 'user', kind: 'image', text: '[image]' },
      { role: 'user', kind: 'context', text: 'spec.pdf' },
      { role: 'assistant', kind: 'tool_use', name: 'Bash', text: '{"command":"ls"}' },
      { role: 'tool', kind: 'tool_result', text: 'a b\n[image]' },
    ]);
    expect(parts.output).toEqual([
      { role: 'assistant', kind: 'thinking', text: 'hmm' },
      { role: 'assistant', kind: 'text', text: 'Done.' },
      { role: 'assistant', kind: 'tool_use', name: 'Read', text: '{"p":"a"}' },
      { role: 'assistant', kind: 'context', text: 'overloaded' },
    ]);
  });
});
