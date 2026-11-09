// SPDX-License-Identifier: Apache-2.0
//
// Request parsers for the four protocols (plan Phase 3 task 3). The field
// mappings are ported from magpie (MIT, Copyright (c) 2026 yetone):
// parseAnthropic anthropic.go:113-218, parseChat chat.go:69-146,
// parseResponses responses.go:251-483, parseGemini gemini.go:214-361,
// stringOrText/toolOutput ir.go:604-681. They read through the byte-offset
// scanner so every part keeps its span; nothing is re-encoded.
//
// Where this differs from magpie, on purpose:
// - Codex `compaction`, `compaction_trigger`, `local_shell_call`,
//   `web_search_call` and `item_reference` items are kept as `context` parts
//   named by their type (magpie drops them; compaction detection needs them).
// - A developer/system item after a reply is a `context` part, not text
//   wrapped in <system-reminder>.
// - A Gemini call without an id gets a position id (`gemini:<content>:<part>`),
//   not a random one, so the same history always yields the same ids.

import { decodeString, rawText, scanDocument, type JsonSpan } from '../json/scanner.js';
import type { WireProtocol } from '../relay/protocols.js';
import { ScannedObject, joinSpans, objectElements } from './scanned-object.js';
import type { WireMessage, WireMessageRole, WirePart, WireRequest, WireToolDefinition } from './types.js';

export class WireRequestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireRequestParseError';
  }
}

/**
 * Parse a decoded request body. Throws JsonScanError on bytes that are not
 * JSON and WireRequestParseError on a root that is not an object; unknown
 * fields and item types are ignored. `suffixPath` is the route suffix
 * (Gemini names its model and streaming in the path).
 */
export function parseWireRequest(protocol: WireProtocol, body: Uint8Array, suffixPath = ''): WireRequest {
  const rootSpan = scanDocument(body);
  const root = ScannedObject.of(body, rootSpan);
  if (!root) throw new WireRequestParseError(`a ${protocol} request body must be a JSON object`);
  switch (protocol) {
    case 'anthropic':
      return parseAnthropicRequest(root);
    case 'openai-chat':
      return parseOpenAiChatRequest(root);
    case 'openai-responses':
      return parseOpenAiResponsesRequest(root);
    case 'gemini':
      return parseGeminiRequest(root, suffixPath);
  }
}

// ---------------------------------------------------------------------------
// Shared readers

const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text']);

/**
 * A value that is a string or an array of text blocks, as text (magpie
 * `stringOrText`). Claude Code's `tool_reference` blocks read as magpie
 * words them.
 */
function stringOrBlocksText(bytes: Uint8Array, span: JsonSpan | undefined): string {
  if (!span) return '';
  if (span.type === 'string') return decodeString(bytes, span);
  if (span.type !== 'array') return '';
  let text = '';
  for (const block of objectElements(bytes, span)) {
    const blockType = block.string('type');
    if (blockType && TEXT_BLOCK_TYPES.has(blockType)) {
      text += block.string('text') ?? '';
    } else if (blockType === 'tool_reference') {
      if (text.length > 0) text += '\n';
      text += `Tool ${block.string('tool_name') ?? ''} is loaded and can be called now.`;
    }
  }
  return text;
}

/** A tool's result: its text and whether it carried images (magpie `toolOutput`). */
function toolOutputOf(bytes: Uint8Array, span: JsonSpan | undefined): { text: string; hasImages: boolean } {
  const text = stringOrBlocksText(bytes, span);
  if (span?.type !== 'array') return { text, hasImages: false };
  const hasImages = objectElements(bytes, span).some(block => {
    const blockType = block.string('type');
    return blockType === 'image' || blockType === 'input_image' || blockType === 'image_url';
  });
  return { text, hasImages };
}

function textPart(text: string, span: JsonSpan): WirePart {
  return { kind: 'text', text, span };
}

function roleOf(role: string | undefined): WireMessageRole {
  if (role === 'assistant' || role === 'system') return role;
  return 'user';
}

function toolDefinitions(tools: ScannedObject[], nameOf: (tool: ScannedObject) => string | undefined): WireToolDefinition[] {
  const definitions: WireToolDefinition[] = [];
  for (const tool of tools) {
    const name = nameOf(tool);
    if (name) definitions.push({ name, span: tool.span });
  }
  return definitions;
}

// ---------------------------------------------------------------------------
// Anthropic Messages (magpie parseAnthropic, anthropic.go:113-218)

function anthropicBlockPart(block: ScannedObject): WirePart | null {
  const span = block.span;
  switch (block.string('type')) {
    case 'text':
      return textPart(block.string('text') ?? '', span);
    case 'image':
      return { kind: 'image', span };
    case 'document':
      return { kind: 'file', text: block.string('title') ?? '[document]', span };
    case 'tool_use':
      return { kind: 'tool_call', callId: block.string('id'), name: block.string('name'), argsJson: block.raw('input') ?? '{}', span };
    case 'tool_result': {
      const output = toolOutputOf(block.bytes, block.spanOf('content'));
      return {
        kind: 'tool_result',
        callId: block.string('tool_use_id'),
        text: output.text,
        hasImages: output.hasImages || undefined,
        isError: block.isTrue('is_error') || undefined,
        span,
      };
    }
    case 'thinking':
      return { kind: 'thinking', text: block.string('thinking') ?? '', sealedBy: block.string('signature') ? 'anthropic' : undefined, span };
    case 'redacted_thinking':
      return { kind: 'sealed', sealedBy: 'anthropic', span };
    default:
      return null;
  }
}

function parseAnthropicRequest(root: ScannedObject): WireRequest {
  const bytes = root.bytes;
  const system: WirePart[] = [];
  const systemSpan = root.spanOf('system');
  if (systemSpan?.type === 'string') {
    system.push(textPart(decodeString(bytes, systemSpan), systemSpan));
  } else if (systemSpan?.type === 'array') {
    for (const block of objectElements(bytes, systemSpan)) {
      if (block.string('type') === 'text') system.push(textPart(block.string('text') ?? '', block.span));
    }
  }

  const messages: WireMessage[] = [];
  for (const message of objectElements(bytes, root.spanOf('messages'))) {
    const contentSpan = message.spanOf('content');
    const parts: WirePart[] = [];
    if (contentSpan?.type === 'string') {
      const text = decodeString(bytes, contentSpan);
      if (text !== '') parts.push(textPart(text, contentSpan));
    } else if (contentSpan?.type === 'array') {
      for (const block of objectElements(bytes, contentSpan)) {
        const part = anthropicBlockPart(block);
        if (part) parts.push(part);
      }
    }
    messages.push({ role: roleOf(message.string('role')), parts, span: message.span });
  }

  const toolsSpan = root.spanOf('tools');
  return {
    protocol: 'anthropic',
    body: bytes,
    model: root.string('model') ?? '',
    stream: root.isTrue('stream'),
    system,
    tools: toolDefinitions(objectElements(bytes, toolsSpan), tool => tool.string('name')),
    toolsSpan: toolsSpan?.type === 'array' ? toolsSpan : undefined,
    messages,
    maxOutputTokens: root.number('max_tokens'),
    metadata: root.raw('metadata'),
  };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (magpie parseChat/chatParts, chat.go:69-206)

function chatContentParts(bytes: Uint8Array, contentSpan: JsonSpan | undefined): WirePart[] {
  if (!contentSpan) return [];
  if (contentSpan.type === 'string') {
    const text = decodeString(bytes, contentSpan);
    return text === '' ? [] : [textPart(text, contentSpan)];
  }
  const parts: WirePart[] = [];
  for (const item of objectElements(bytes, contentSpan)) {
    switch (item.string('type')) {
      case 'text':
        parts.push(textPart(item.string('text') ?? '', item.span));
        break;
      case 'image_url':
        parts.push({ kind: 'image', span: item.span });
        break;
      case 'file':
        parts.push({ kind: 'file', text: item.object('file')?.string('filename') ?? '[file]', span: item.span });
        break;
    }
  }
  return parts;
}

/** Gemini's OpenAI-compatible API carries a call's thought signature in extra_content.google. */
function hasGoogleThoughtSignature(holder: ScannedObject): boolean {
  const google = holder.object('extra_content')?.object('google');
  return Boolean(google?.string('thought_signature', 'thoughtSignature'));
}

function chatToolCallPart(call: ScannedObject): WirePart {
  const custom = call.object('custom');
  if (call.string('type') === 'custom' && custom) {
    return {
      kind: 'tool_call',
      callId: call.string('id'),
      name: custom.string('name'),
      argsJson: JSON.stringify({ input: custom.string('input') ?? '' }),
      span: call.span,
    };
  }
  const fn = call.object('function');
  return {
    kind: 'tool_call',
    callId: call.string('id'),
    name: fn?.string('name'),
    argsJson: fn?.string('arguments') ?? '{}',
    sealedBy: hasGoogleThoughtSignature(call) ? 'gemini' : undefined,
    span: call.span,
  };
}

function parseOpenAiChatRequest(root: ScannedObject): WireRequest {
  const bytes = root.bytes;
  const system: WirePart[] = [];
  const messages: WireMessage[] = [];
  for (const message of objectElements(bytes, root.spanOf('messages'))) {
    const role = message.string('role');
    const contentSpan = message.spanOf('content');
    if (role === 'system' || role === 'developer') {
      system.push(...chatContentParts(bytes, contentSpan));
      continue;
    }
    if (role === 'tool') {
      const output = toolOutputOf(bytes, contentSpan);
      messages.push({
        role: 'user',
        parts: [{ kind: 'tool_result', callId: message.string('tool_call_id'), text: output.text, hasImages: output.hasImages || undefined, span: message.span }],
        span: message.span,
      });
      continue;
    }
    if (role === 'assistant') {
      const parts: WirePart[] = [];
      // An earlier turn's thinking, in either spelling (magpie reasoningText).
      const reasoningSpan = message.spanOf('reasoning_content', 'reasoning');
      if (reasoningSpan?.type === 'string') {
        const reasoning = decodeString(bytes, reasoningSpan);
        if (reasoning !== '') parts.push({ kind: 'thinking', text: reasoning, span: reasoningSpan });
      }
      parts.push(...chatContentParts(bytes, contentSpan));
      for (const call of objectElements(bytes, message.spanOf('tool_calls'))) parts.push(chatToolCallPart(call));
      messages.push({ role: 'assistant', parts, span: message.span });
      continue;
    }
    if (role === 'user') messages.push({ role: 'user', parts: chatContentParts(bytes, contentSpan), span: message.span });
  }

  const toolsSpan = root.spanOf('tools');
  return {
    protocol: 'openai-chat',
    body: bytes,
    model: root.string('model') ?? '',
    stream: root.isTrue('stream'),
    system,
    tools: toolDefinitions(objectElements(bytes, toolsSpan), tool => tool.object('function')?.string('name') ?? tool.object('custom')?.string('name')),
    toolsSpan: toolsSpan?.type === 'array' ? toolsSpan : undefined,
    messages,
    maxOutputTokens: root.number('max_completion_tokens') ?? root.number('max_tokens'),
    cacheKey: root.string('prompt_cache_key'),
  };
}

// ---------------------------------------------------------------------------
// OpenAI Responses (magpie parseResponses, responses.go:251-483)

/** Codex items magpie drops that compaction detection needs: kept as context parts. */
const RESPONSES_CONTEXT_ITEM_TYPES = new Set(['compaction', 'compaction_trigger', 'local_shell_call', 'web_search_call', 'item_reference']);

function responsesContentParts(bytes: Uint8Array, contentSpan: JsonSpan | undefined): WirePart[] {
  if (!contentSpan) return [];
  if (contentSpan.type === 'string') {
    const text = decodeString(bytes, contentSpan);
    return text === '' ? [] : [textPart(text, contentSpan)];
  }
  const parts: WirePart[] = [];
  for (const item of objectElements(bytes, contentSpan)) {
    switch (item.string('type')) {
      case 'input_text':
      case 'output_text':
      case 'text':
        parts.push(textPart(item.string('text') ?? '', item.span));
        break;
      case 'refusal':
        parts.push(textPart(item.string('refusal') ?? '', item.span));
        break;
      case 'input_image':
        parts.push({ kind: 'image', span: item.span });
        break;
      case 'input_file':
        parts.push({ kind: 'file', text: item.string('filename') ?? '[file]', span: item.span });
        break;
    }
  }
  return parts;
}

function joinedText(parts: WirePart[]): string {
  return parts.filter(part => part.kind === 'text').map(part => part.text ?? '').join('');
}

/** A function or custom tool's name as the client knows it, with its namespace. */
function responsesToolName(item: ScannedObject): string | undefined {
  const name = item.string('name');
  const namespace = item.string('namespace');
  return namespace && name ? `${namespace}.${name}` : name;
}

/** A Codex context item's readable gist (a search query, a shell command), when it has one. */
function responsesContextItemText(item: ScannedObject): string | undefined {
  const action = item.object('action');
  if (!action) return undefined;
  const query = action.string('query');
  if (query) return query;
  const command = action.elements('command').filter(span => span.type === 'string').map(span => decodeString(item.bytes, span));
  return command.length > 0 ? command.join(' ') : undefined;
}

/** Which side of the conversation an input item is on, or null for an item that adds nothing. */
function responsesItemMessage(item: ScannedObject, replied: boolean): { role: WireMessageRole; part: WirePart[] } | null {
  const bytes = item.bytes;
  const itemType = item.string('type') ?? '';
  const role = item.string('role');
  const span = item.span;

  if (itemType === 'message' || (itemType === '' && role)) {
    const parts = responsesContentParts(bytes, item.spanOf('content'));
    if (role === 'system' || role === 'developer') {
      if (!replied) return { role: 'system', part: parts };
      // After a reply: where Codex put it, told as context, not the user's words.
      const text = joinedText(parts);
      return text ? { role: 'user', part: [{ kind: 'context', name: role, text, span }] } : null;
    }
    return { role: role === 'assistant' ? 'assistant' : 'user', part: parts };
  }
  switch (itemType) {
    case 'agent_message': {
      const parts = responsesContentParts(bytes, item.spanOf('content'));
      return parts.length > 0 ? { role: 'user', part: parts } : null;
    }
    case 'function_call':
      return {
        role: 'assistant',
        part: [{ kind: 'tool_call', callId: item.string('call_id'), name: responsesToolName(item), argsJson: item.string('arguments') ?? item.raw('arguments') ?? '{}', span }],
      };
    case 'custom_tool_call':
      return {
        role: 'assistant',
        part: [{ kind: 'tool_call', callId: item.string('call_id'), name: responsesToolName(item), argsJson: JSON.stringify({ input: item.string('input') ?? '' }), span }],
      };
    case 'tool_search_call':
      return {
        role: 'assistant',
        part: [{ kind: 'tool_call', callId: item.string('call_id'), name: 'tool_search', argsJson: item.raw('arguments') ?? '{}', span }],
      };
    case 'tool_search_output':
      return { role: 'user', part: [{ kind: 'tool_result', callId: item.string('call_id'), text: item.raw('tools') ?? '', span }] };
    case 'function_call_output':
    case 'custom_tool_call_output': {
      // A standalone output (no call_id) is kept: callId stays undefined.
      const output = toolOutputOf(bytes, item.spanOf('output'));
      return {
        role: 'user',
        part: [{ kind: 'tool_result', callId: item.string('call_id'), text: output.text, hasImages: output.hasImages || undefined, span }],
      };
    }
    case 'reasoning': {
      let text = '';
      for (const content of objectElements(bytes, item.spanOf('content'))) {
        if (content.string('type') === 'reasoning_text') text += content.string('text') ?? '';
      }
      if (text === '') {
        for (const summary of objectElements(bytes, item.spanOf('summary'))) text += summary.string('text') ?? '';
      }
      const sealed = Boolean(item.string('encrypted_content'));
      if (text === '' && !sealed) return null;
      return {
        role: 'assistant',
        part: [{ kind: text === '' ? 'sealed' : 'thinking', text: text || undefined, sealedBy: sealed ? 'openai-responses' : undefined, span }],
      };
    }
  }
  if (RESPONSES_CONTEXT_ITEM_TYPES.has(itemType)) {
    return {
      role: itemType === 'compaction_trigger' ? 'user' : 'assistant',
      part: [{ kind: 'context', name: itemType, text: responsesContextItemText(item), span }],
    };
  }
  return null;
}

/** Whether an item means the conversation has had a reply (magpie's `replied`). */
function responsesItemIsReply(item: ScannedObject): boolean {
  const itemType = item.string('type') ?? '';
  return item.string('role') === 'assistant'
    || itemType.startsWith('function_call')
    || itemType.startsWith('custom_tool_call')
    || itemType.startsWith('tool_search')
    || itemType === 'reasoning';
}

function parseOpenAiResponsesRequest(root: ScannedObject): WireRequest {
  const bytes = root.bytes;
  const system: WirePart[] = [];
  const instructionsSpan = root.spanOf('instructions');
  if (instructionsSpan?.type === 'string') system.push(textPart(decodeString(bytes, instructionsSpan), instructionsSpan));

  const messages: WireMessage[] = [];
  const appendMessage = (role: WireMessageRole, parts: WirePart[], span: JsonSpan, isMessageItem = false) => {
    // A Responses turn is one item per part: consecutive items of one role are one message (magpie mergeTurns),
    // except a user `message` item after function_call_output items: that is a message the agent sent of its own
    // (Codex's next prompt after an interrupt), never text beside a tool result.
    const previous = messages[messages.length - 1];
    const startsOwnMessage = isMessageItem && role === 'user' && previous?.parts.some(part => part.kind === 'tool_result');
    if (previous && previous.role === role && !startsOwnMessage) {
      previous.parts.push(...parts);
      previous.span = joinSpans(previous.span, span);
      return;
    }
    messages.push({ role, parts, span });
  };

  const toolsSpan = root.spanOf('tools');
  const nameOfResponsesTool = (tool: ScannedObject) => tool.string('name') ?? tool.string('type');
  const tools = toolDefinitions(objectElements(bytes, toolsSpan), nameOfResponsesTool);
  let definedToolsSpan = toolsSpan?.type === 'array' ? toolsSpan : undefined;

  const inputSpan = root.spanOf('input');
  if (inputSpan?.type === 'string') {
    appendMessage('user', [textPart(decodeString(bytes, inputSpan), inputSpan)], inputSpan);
  } else {
    let replied = false;
    for (const item of objectElements(bytes, inputSpan)) {
      if (item.string('type') === 'additional_tools') {
        // Responses Lite's tools, sent as an input item (magpie liftAdditionalTools).
        const itemToolsSpan = item.spanOf('tools');
        tools.push(...toolDefinitions(objectElements(bytes, itemToolsSpan), nameOfResponsesTool));
        if (!definedToolsSpan && itemToolsSpan?.type === 'array') definedToolsSpan = itemToolsSpan;
        continue;
      }
      if (responsesItemIsReply(item)) replied = true;
      const message = responsesItemMessage(item, replied);
      if (!message) continue;
      if (message.role === 'system') {
        system.push(...message.part);
        continue;
      }
      const itemType = item.string('type');
      const isUserMessageItem = (itemType === 'message' || (itemType === undefined && item.string('role') !== undefined))
        && message.part.every(part => part.kind !== 'context');
      appendMessage(message.role, message.part, item.span, isUserMessageItem);
    }
  }

  return {
    protocol: 'openai-responses',
    body: bytes,
    model: root.string('model') ?? '',
    stream: root.isTrue('stream'),
    system,
    tools,
    toolsSpan: definedToolsSpan,
    messages,
    maxOutputTokens: root.number('max_output_tokens'),
    cacheKey: root.string('prompt_cache_key'),
    clientMetadata: root.raw('client_metadata'),
  };
}

// ---------------------------------------------------------------------------
// Gemini generateContent (magpie parseGemini, gemini.go:214-361). Google
// accepts snake_case and camelCase field names (magpie geminiCamel), so both
// are read.

const GEMINI_PATH_PATTERN = /\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

/** A functionResponse's `response` as text: Gemini CLI wraps output in {output} or {error} (magpie functionResponseText). */
function geminiFunctionResponseText(bytes: Uint8Array, responseSpan: JsonSpan | undefined): { text: string; isError: boolean } {
  if (!responseSpan) return { text: '', isError: false };
  if (responseSpan.type === 'string') return { text: decodeString(bytes, responseSpan), isError: false };
  const response = ScannedObject.of(bytes, responseSpan);
  if (response && response.keys().length === 1) {
    const errorSpan = response.spanOf('error');
    if (errorSpan) return { text: errorSpan.type === 'string' ? decodeString(bytes, errorSpan) : rawText(bytes, errorSpan), isError: true };
    const outputSpan = response.spanOf('output');
    if (outputSpan) return { text: outputSpan.type === 'string' ? decodeString(bytes, outputSpan) : rawText(bytes, outputSpan), isError: false };
  }
  return { text: rawText(bytes, responseSpan), isError: false };
}

function geminiSystemParts(bytes: Uint8Array, systemSpan: JsonSpan | undefined): WirePart[] {
  if (!systemSpan) return [];
  if (systemSpan.type === 'string') return [textPart(decodeString(bytes, systemSpan), systemSpan)];
  const partsSpan = systemSpan.type === 'object' ? new ScannedObject(bytes, systemSpan).spanOf('parts') : systemSpan;
  const parts: WirePart[] = [];
  for (const part of objectElements(bytes, partsSpan)) {
    const text = part.string('text');
    if (text && !part.isTrue('thought')) parts.push(textPart(text, part.span));
  }
  return parts;
}

function parseGeminiRequest(root: ScannedObject, suffixPath: string): WireRequest {
  const bytes = root.bytes;
  const pathMatch = GEMINI_PATH_PATTERN.exec(suffixPath);
  const messages: WireMessage[] = [];
  // Results name their call by id when the client kept it; older clients by name only. An id-less result
  // takes the oldest call of its name not yet answered (Gemini answers calls in order), else the latest call
  // of that name: so read(a.ts), read(b.ts) then two results pair a.ts with the first and b.ts with the second.
  const unansweredCallIdsByName = new Map<string, string[]>();
  const latestCallIdByName = new Map<string, string>();
  const answeredCallIds = new Set<string>();
  const callIdForResult = (name: string, explicitId: string | undefined): string | undefined => {
    if (explicitId !== undefined) {
      answeredCallIds.add(explicitId);
      return explicitId;
    }
    const unanswered = unansweredCallIdsByName.get(name) ?? [];
    let callId = unanswered.shift();
    while (callId !== undefined && answeredCallIds.has(callId)) callId = unanswered.shift();
    if (callId === undefined) return latestCallIdByName.get(name);
    answeredCallIds.add(callId);
    return callId;
  };

  objectElements(bytes, root.spanOf('contents')).forEach((content, contentIndex) => {
    const contentRole: WireMessageRole = content.string('role') === 'model' || content.string('role') === 'assistant' ? 'assistant' : 'user';
    // A function's result is the user's side whatever role it came under (Antigravity sends results as "model").
    let current: WireMessage | null = null;
    const turn = (role: WireMessageRole, span: JsonSpan) => {
      if (current && current.role === role) {
        current.span = joinSpans(current.span, span);
        return current;
      }
      current = { role, parts: [], span };
      messages.push(current);
      return current;
    };

    objectElements(bytes, content.spanOf('parts')).forEach((part, partIndex) => {
      const span = part.span;
      const signed = part.string('thoughtSignature', 'thought_signature') ? 'gemini' as const : undefined;
      const functionCall = part.object('functionCall', 'function_call');
      const functionResponse = part.object('functionResponse', 'function_response');
      const inlineData = part.object('inlineData', 'inline_data');
      const fileData = part.object('fileData', 'file_data');

      if (functionCall) {
        const name = functionCall.string('name') ?? '';
        const callId = functionCall.string('id') ?? `gemini:${contentIndex}:${partIndex}`;
        latestCallIdByName.set(name, callId);
        const unanswered = unansweredCallIdsByName.get(name);
        if (unanswered) unanswered.push(callId);
        else unansweredCallIdsByName.set(name, [callId]);
        turn(contentRole, span).parts.push({ kind: 'tool_call', callId, name, argsJson: functionCall.raw('args') ?? '{}', sealedBy: signed, span });
      } else if (functionResponse) {
        const name = functionResponse.string('name') ?? '';
        const responseSpan = functionResponse.spanOf('response');
        const result = geminiFunctionResponseText(bytes, responseSpan);
        const hasImages = objectElements(bytes, functionResponse.spanOf('parts')).some(inner =>
          (inner.object('inlineData', 'inline_data') ?? inner.object('fileData', 'file_data'))?.string('mimeType', 'mime_type')?.startsWith('image/'));
        turn('user', span).parts.push({
          kind: 'tool_result',
          callId: callIdForResult(name, functionResponse.string('id')),
          name,
          text: result.text,
          isError: result.isError || undefined,
          hasImages: hasImages || undefined,
          span,
        });
      } else if (inlineData || fileData) {
        const mimeType = (inlineData ?? fileData)!.string('mimeType', 'mime_type') ?? '';
        turn(contentRole, span).parts.push(mimeType.startsWith('image/')
          ? { kind: 'image', span }
          : { kind: 'file', text: `[attachment ${mimeType}]`, span });
      } else if (part.isTrue('thought')) {
        turn(contentRole, span).parts.push({ kind: 'thinking', text: part.string('text') ?? '', sealedBy: signed, span });
      } else {
        const text = part.string('text');
        if (text || signed) turn(contentRole, span).parts.push({ kind: 'text', text: text ?? '', sealedBy: signed, span });
      }
    });
  });

  const generationConfig = root.object('generationConfig', 'generation_config');
  const toolsSpan = root.spanOf('tools');
  const tools: WireToolDefinition[] = [];
  for (const tool of objectElements(bytes, toolsSpan)) {
    for (const declaration of objectElements(bytes, tool.spanOf('functionDeclarations', 'function_declarations'))) {
      const name = declaration.string('name');
      if (name) tools.push({ name, span: declaration.span });
    }
  }
  return {
    protocol: 'gemini',
    body: bytes,
    model: root.string('model') ?? pathMatch?.[1] ?? '',
    stream: pathMatch?.[2] === 'streamGenerateContent',
    system: geminiSystemParts(bytes, root.spanOf('systemInstruction', 'system_instruction')),
    tools,
    toolsSpan: toolsSpan?.type === 'array' ? toolsSpan : undefined,
    messages,
    maxOutputTokens: generationConfig?.number('maxOutputTokens', 'max_output_tokens'),
  };
}
