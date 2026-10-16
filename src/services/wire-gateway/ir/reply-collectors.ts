// SPDX-License-Identifier: Apache-2.0
//
// Reply collectors (plan Phase 3 task 4): fed the relay's copy of a reply one
// chunk at a time (RelayObserver onResponseChunk), they rebuild what the model
// said as a WireReply. One collector per protocol, for an SSE stream or a
// whole JSON body. Ported from magpie (MIT, Copyright (c) 2026 yetone):
// collector ir.go:416-553, anthropicDecoder anthropic.go:1083-1225,
// chatDecoder chat.go:916-1040, responsesDecoder responses.go:1230-1370,
// codeAssistDecoder codeassist.go:742-830, and conversationJSON
// conversations.go:205-250 for whole replies.
//
// Differences from magpie, on purpose: tool arguments are keyed by the
// wire's own index (block index, tool_calls[index], output_index) rather than
// "the open call"; Responses custom_tool_call items are collected; Chat
// <think> tags in text are left as text (the reply is recorded, not
// re-rendered); a Gemini call written out as text is left as text.
// Unknown events and fields are ignored, never thrown on.

import { getSpan, rawText, scanDocument, type JsonSpan } from '../json/scanner.js';
import { StreamEndMarkerDetector, type WireProtocol } from '../relay/protocols.js';
import { IncrementalSseReader } from './sse-event-reader.js';
import { emptyWireUsage, type WireReply, type WireSealedReplyItem, type WireSealOwner, type WireStopReason, type WireUsage } from './types.js';
import { anthropicUsage, geminiUsage, mergeWireUsage, openAiChatUsage, openAiResponsesUsage } from './usage.js';

/**
 * The most bytes of one reply a collector takes in, streamed or whole. Past
 * it, collecting stops: a whole JSON reply is not parsed, a stream keeps what
 * came before, and either way the reply is marked as not ended cleanly (so it
 * is never taken as whole). The relay is untouched; only the capture copy is cut.
 */
export const WIRE_REPLY_MAX_BYTES = 64 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** What an error value says: a string, or an object's message or type (magpie streamErrorText). */
function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  const record = asRecord(error);
  return asString(record.message).trim() || asString(record.type).trim() || fallback;
}

/** The raw JSON text at `path` inside an event's data, byte for byte. */
function rawJsonAt(data: string, path: ReadonlyArray<string | number>): string | undefined {
  try {
    const bytes = new TextEncoder().encode(data);
    const span = getSpan(bytes, path, scanDocument(bytes));
    return span ? rawText(bytes, span) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The accumulator every decoder writes into (magpie `collector`)

interface ToolCallInProgress {
  id: string;
  name: string;
  streamedArgs: string;
  /** Arguments as a done event gave them (Responses), when it did. */
  doneArgs?: string;
}

/** The fuller of a call's streamed and done arguments, valid JSON first (magpie pickArgs). */
function pickArgs(streamed: string, done: string | undefined): string {
  if (done === undefined) return streamed;
  const isValidJson = (text: string) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  const streamedTrimmed = streamed.trim();
  const doneTrimmed = done.trim();
  const streamedValid = isValidJson(streamedTrimmed);
  const doneValid = isValidJson(doneTrimmed);
  if (doneValid && (!streamedValid || doneTrimmed.length > streamedTrimmed.length)) return done;
  if (streamedValid || doneTrimmed === '') return streamed;
  return done;
}

class WireReplyAccumulator {
  private text = '';
  private thinking = '';
  private readonly toolCalls = new Map<string, ToolCallInProgress>();
  private readonly sealedByKey = new Map<string, WireSealedReplyItem>();
  private sealedCounter = 0;
  readonly usage: WireUsage = emptyWireUsage();
  stop: WireStopReason | null = null;
  model?: string;
  error?: string;

  appendText(text: string): void {
    this.text += text;
  }

  appendThinking(text: string): void {
    this.thinking += text;
  }

  /** Starts (or, with the same key, keeps) a tool call. */
  startToolCall(key: string, id: string, name: string): ToolCallInProgress {
    let call = this.toolCalls.get(key);
    if (!call) {
      call = { id, name, streamedArgs: '' };
      this.toolCalls.set(key, call);
    } else {
      if (!call.id) call.id = id;
      if (!call.name) call.name = name;
    }
    return call;
  }

  toolCall(key: string): ToolCallInProgress | undefined {
    return this.toolCalls.get(key);
  }

  /** A sealed item; a keyed signature grows by its deltas. */
  addSealed(sealedBy: WireSealOwner, form: WireSealedReplyItem['form'], value: string, key?: string): void {
    if (!value) return;
    const itemKey = key ?? `unkeyed:${this.sealedCounter++}`;
    const existing = this.sealedByKey.get(itemKey);
    if (existing && existing.form === form) {
      existing.value += value;
      return;
    }
    this.sealedByKey.set(itemKey, { sealedBy, form, value });
  }

  mergeUsage(update: Partial<WireUsage>): void {
    mergeWireUsage(this.usage, update);
  }

  setError(text: string): void {
    if (this.error === undefined) this.error = text;
  }

  finish(endedCleanly: boolean): WireReply {
    const toolCalls = [...this.toolCalls.values()].map(call => {
      const args = pickArgs(call.streamedArgs, call.doneArgs).trim();
      return { id: call.id, name: call.name, argsJson: args === '' ? '{}' : args };
    });
    // A reply of tool calls that said "stop" is the client's to run (magpie collector.finish).
    let stop = this.stop;
    if (stop === 'stop' && toolCalls.length > 0) stop = 'tool';
    return {
      text: this.text,
      toolCalls,
      thinking: this.thinking,
      sealed: [...this.sealedByKey.values()],
      usage: { ...this.usage },
      stop,
      model: this.model,
      error: this.error,
      endedCleanly: endedCleanly && this.error === undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Stop reasons (magpie stopFromAnthropic anthropic.go:1262, stopFromChat chat.go:1067, stopFromGemini codeassist.go:1106)

function anthropicStop(reason: string): WireStopReason {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'length':
      return 'length';
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool';
    case 'refusal':
    case 'content_filter':
      return 'filter';
  }
  return 'stop';
}

function chatStop(reason: string): WireStopReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool';
    case 'content_filter':
      return 'filter';
  }
  return 'stop';
}

function geminiStop(reason: string): WireStopReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
    case 'OTHER':
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      return 'stop';
  }
  return 'filter';
}

// ---------------------------------------------------------------------------
// Protocol decoders: each reads one event (or one whole body) into the accumulator.

interface WireReplyDecoder {
  /** One SSE event's data. */
  decodeEvent(data: string, accumulator: WireReplyAccumulator): void;
  /** A whole JSON body; rawAt gives a value's raw JSON text from the body's bytes. */
  decodeWhole(body: unknown, accumulator: WireReplyAccumulator, rawAt: (path: ReadonlyArray<string | number>) => string | undefined): void;
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function anthropicDecoder(): WireReplyDecoder {
  // Blocks of server tools (their deltas are the vendor's, not the client's calls).
  const serverToolBlockIndexes = new Set<number>();
  // tool_use blocks whose start carried the whole input (a relay's), so their deltas are skipped.
  const wholeInputBlockIndexes = new Set<number>();

  const contentBlock = (block: JsonRecord, blockIndex: number, accumulator: WireReplyAccumulator, rawBlock: () => string | undefined, fromStream: boolean) => {
    const blockKey = String(blockIndex);
    switch (block.type) {
      case 'text':
        accumulator.appendText(asString(block.text));
        break;
      case 'thinking':
        accumulator.appendThinking(asString(block.thinking));
        accumulator.addSealed('anthropic', 'signature', asString(block.signature), blockKey);
        break;
      case 'redacted_thinking':
        accumulator.addSealed('anthropic', 'block', rawBlock() ?? '', blockKey);
        break;
      case 'tool_use': {
        const call = accumulator.startToolCall(blockKey, asString(block.id), asString(block.name));
        const input = asRecord(block.input);
        // Anthropic's own start has an empty input and the deltas after it; a relay may send it whole.
        if (!fromStream || Object.keys(input).length > 0) {
          call.streamedArgs = JSON.stringify(block.input ?? {});
          const raw = rawBlock();
          if (raw) call.streamedArgs = rawJsonAt(raw, ['input']) ?? call.streamedArgs;
          wholeInputBlockIndexes.add(blockIndex);
        }
        break;
      }
      case 'server_tool_use':
        serverToolBlockIndexes.add(blockIndex);
        break;
    }
  };

  return {
    decodeEvent(data, accumulator) {
      const event = asRecord(parseEventData(data));
      const blockIndex = typeof event.index === 'number' ? event.index : 0;
      switch (event.type) {
        case 'message_start': {
          const message = asRecord(event.message);
          if (typeof message.model === 'string') accumulator.model = message.model;
          accumulator.mergeUsage(anthropicUsage(message.usage));
          break;
        }
        case 'content_block_start':
          contentBlock(asRecord(event.content_block), blockIndex, accumulator, () => rawJsonAt(data, ['content_block']), true);
          break;
        case 'content_block_delta': {
          if (serverToolBlockIndexes.has(blockIndex)) break;
          const delta = asRecord(event.delta);
          switch (delta.type) {
            case 'text_delta':
              accumulator.appendText(asString(delta.text));
              break;
            case 'thinking_delta':
              accumulator.appendThinking(asString(delta.thinking));
              break;
            case 'signature_delta':
              accumulator.addSealed('anthropic', 'signature', asString(delta.signature), String(blockIndex));
              break;
            case 'input_json_delta': {
              if (wholeInputBlockIndexes.has(blockIndex)) break;
              const call = accumulator.toolCall(String(blockIndex));
              if (call) call.streamedArgs += asString(delta.partial_json);
              break;
            }
          }
          break;
        }
        case 'message_delta': {
          const delta = asRecord(event.delta);
          if (typeof delta.stop_reason === 'string' && delta.stop_reason) accumulator.stop = anthropicStop(delta.stop_reason);
          accumulator.mergeUsage(anthropicUsage(event.usage));
          break;
        }
        case 'error':
          accumulator.setError(errorText(event.error, 'upstream stream failed'));
          break;
        default:
          if (event.type === undefined && event.error !== undefined) accumulator.setError(errorText(event.error, 'upstream stream failed'));
      }
    },
    decodeWhole(body, accumulator, rawAt) {
      const message = asRecord(body);
      if (message.type === 'error' || message.error !== undefined) {
        accumulator.setError(errorText(message.error, 'upstream error'));
        return;
      }
      if (typeof message.model === 'string') accumulator.model = message.model;
      asArray(message.content).forEach((block, blockIndex) => {
        contentBlock(asRecord(block), blockIndex, accumulator, () => rawAt(['content', blockIndex]), false);
      });
      if (typeof message.stop_reason === 'string' && message.stop_reason) accumulator.stop = anthropicStop(message.stop_reason);
      accumulator.mergeUsage(anthropicUsage(message.usage));
    },
  };
}

/** Chat message content: a string or typed text parts (Mistral's). */
function chatContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return asArray(content)
    .map(part => asRecord(part))
    .filter(part => part.type === 'text')
    .map(part => asString(part.text))
    .join('');
}

function googleThoughtSignature(holder: JsonRecord): string {
  const google = asRecord(asRecord(holder.extra_content).google);
  return asString(google.thought_signature) || asString(google.thoughtSignature);
}

function openAiChatDecoder(): WireReplyDecoder {
  // Translation-free, but one reply: lock onto the first choice index seen (magpie chatChoiceIndex).
  let lockedChoiceIndex: number | null = null;
  // tool_calls[index] → the key of the call open at that index; a new id at the same index starts the next call.
  const callKeyByIndex = new Map<number, { key: string; id: string }>();
  let callCounter = 0;

  return {
    decodeEvent(data, accumulator) {
      if (data.trim() === '[DONE]') return;
      const chunk = asRecord(parseEventData(data));
      if (chunk.error !== undefined && chunk.error !== null) {
        accumulator.setError(errorText(chunk.error, 'upstream stream failed'));
        return;
      }
      if (typeof chunk.model === 'string' && chunk.model) accumulator.model = chunk.model;
      for (const rawChoice of asArray(chunk.choices)) {
        const choice = asRecord(rawChoice);
        const choiceIndex = typeof choice.index === 'number' ? choice.index : null;
        if (choiceIndex !== null) {
          if (lockedChoiceIndex === null) lockedChoiceIndex = choiceIndex;
          else if (choiceIndex !== lockedChoiceIndex) continue;
        }
        const delta = asRecord(choice.delta);
        let thinking = asString(delta.reasoning_content) || asString(delta.reasoning);
        let content = chatContentText(delta.content);
        const google = asRecord(asRecord(delta.extra_content).google);
        if (google.thought === true) {
          thinking += content;
          content = '';
        }
        accumulator.appendThinking(thinking);
        accumulator.appendText(content);
        accumulator.addSealed('gemini', 'signature', googleThoughtSignature(delta));
        asArray(delta.tool_calls).forEach((rawCall, position) => {
          const call = asRecord(rawCall);
          const callIndex = typeof call.index === 'number' ? call.index : position;
          const callId = asString(call.id);
          const fn = asRecord(call.function);
          let open = callKeyByIndex.get(callIndex);
          if (!open || (callId !== '' && callId !== open.id)) {
            open = { key: `chat:${callCounter++}`, id: callId };
            callKeyByIndex.set(callIndex, open);
          }
          const inProgress = accumulator.startToolCall(open.key, callId, asString(fn.name));
          inProgress.streamedArgs += asString(fn.arguments);
          accumulator.addSealed('gemini', 'signature', googleThoughtSignature(call), `chat-signature:${open.key}`);
        });
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) accumulator.stop = chatStop(choice.finish_reason);
      }
      if (chunk.usage !== undefined && chunk.usage !== null) accumulator.mergeUsage(openAiChatUsage(chunk.usage));
    },
    decodeWhole(body, accumulator) {
      const completion = asRecord(body);
      if (completion.error !== undefined && completion.error !== null) {
        accumulator.setError(errorText(completion.error, 'upstream error'));
        return;
      }
      if (typeof completion.model === 'string') accumulator.model = completion.model;
      const choice = asRecord(asArray(completion.choices)[0]);
      const message = asRecord(choice.message);
      accumulator.appendThinking(asString(message.reasoning_content) || asString(message.reasoning));
      accumulator.appendText(chatContentText(message.content));
      asArray(message.tool_calls).forEach((rawCall, position) => {
        const call = asRecord(rawCall);
        const fn = asRecord(call.function);
        const inProgress = accumulator.startToolCall(`chat:${position}`, asString(call.id), asString(fn.name));
        inProgress.streamedArgs = asString(fn.arguments);
        accumulator.addSealed('gemini', 'signature', googleThoughtSignature(call), `chat-signature:${position}`);
      });
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) accumulator.stop = chatStop(choice.finish_reason);
      accumulator.mergeUsage(openAiChatUsage(completion.usage));
    },
  };
}

/** A Responses function or custom tool call's name, with its namespace (as the request parser names it). */
function responsesCallName(item: JsonRecord): string {
  const name = asString(item.name);
  const namespace = asString(item.namespace);
  return namespace && name ? `${namespace}.${name}` : name;
}

function responsesReasoningText(item: JsonRecord): string {
  let text = asArray(item.content).map(asRecord).filter(part => part.type === 'reasoning_text').map(part => asString(part.text)).join('');
  if (text === '') text = asArray(item.summary).map(part => asString(asRecord(part).text)).join('');
  return text;
}

function openAiResponsesDecoder(): WireReplyDecoder {
  let sawToolCall = false;

  /** A whole output item (output_item.done, or a whole reply's output[]). */
  const outputItemDone = (item: JsonRecord, itemKey: string, accumulator: WireReplyAccumulator, rawItem: () => string | undefined, fromStream: boolean) => {
    switch (item.type) {
      case 'function_call': {
        sawToolCall = true;
        const call = accumulator.startToolCall(itemKey, asString(item.call_id), responsesCallName(item));
        if (typeof item.arguments === 'string' && item.arguments !== '') call.doneArgs = item.arguments;
        break;
      }
      case 'custom_tool_call': {
        sawToolCall = true;
        const call = accumulator.startToolCall(itemKey, asString(item.call_id), responsesCallName(item));
        call.streamedArgs = '';
        call.doneArgs = JSON.stringify({ input: asString(item.input) });
        break;
      }
      case 'reasoning':
        if (!fromStream) accumulator.appendThinking(responsesReasoningText(item));
        if (asString(item.encrypted_content)) accumulator.addSealed('openai-responses', 'block', rawItem() ?? '', `responses-item:${itemKey}`);
        break;
      case 'message':
        if (!fromStream) {
          for (const part of asArray(item.content).map(asRecord)) {
            if (part.type === 'output_text') accumulator.appendText(asString(part.text));
            if (part.type === 'refusal') accumulator.appendText(asString(part.refusal));
          }
        }
        break;
    }
  };

  const finishedResponse = (eventType: string, response: JsonRecord, accumulator: WireReplyAccumulator) => {
    if (typeof response.model === 'string' && response.model) accumulator.model = response.model;
    if ((response.error !== undefined && response.error !== null) || eventType === 'response.failed' || response.status === 'failed') {
      accumulator.setError(errorText(response.error, 'upstream response failed'));
    }
    let stop: WireStopReason = 'stop';
    if (response.status === 'incomplete') {
      stop = asRecord(response.incomplete_details).reason === 'content_filter' ? 'filter' : 'length';
    } else if (sawToolCall || asArray(response.output).some(item => {
      const itemType = asRecord(item).type;
      return itemType === 'function_call' || itemType === 'custom_tool_call';
    })) {
      stop = 'tool';
    }
    accumulator.stop = stop;
    accumulator.mergeUsage(openAiResponsesUsage(response.usage));
  };

  const itemKeyOf = (event: JsonRecord) => String(typeof event.output_index === 'number' ? event.output_index : asString(event.item_id));

  return {
    decodeEvent(data, accumulator) {
      const event = asRecord(parseEventData(data));
      const eventType = asString(event.type);
      switch (eventType) {
        case 'response.created':
        case 'response.in_progress': {
          const model = asRecord(event.response).model;
          if (typeof model === 'string' && model) accumulator.model = model;
          break;
        }
        case 'response.output_item.added': {
          const item = asRecord(event.item);
          if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            sawToolCall = true;
            accumulator.startToolCall(itemKeyOf(event), asString(item.call_id), responsesCallName(item));
          }
          break;
        }
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          accumulator.appendText(asString(event.delta));
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          accumulator.appendThinking(asString(event.delta));
          break;
        case 'response.function_call_arguments.delta': {
          const call = accumulator.toolCall(itemKeyOf(event));
          if (call) call.streamedArgs += asString(event.delta);
          break;
        }
        case 'response.function_call_arguments.done': {
          const call = accumulator.toolCall(itemKeyOf(event));
          if (call && typeof event.arguments === 'string' && event.arguments !== '') call.doneArgs = event.arguments;
          break;
        }
        case 'response.output_item.done':
          outputItemDone(asRecord(event.item), itemKeyOf(event), accumulator, () => rawJsonAt(data, ['item']), true);
          break;
        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed':
          finishedResponse(eventType, asRecord(event.response), accumulator);
          break;
        case 'error':
          accumulator.setError(errorText(event.error ?? event, 'upstream stream failed'));
          break;
      }
    },
    decodeWhole(body, accumulator, rawAt) {
      const response = asRecord(body);
      if (response.error !== undefined && response.error !== null && response.output === undefined) {
        accumulator.setError(errorText(response.error, 'upstream error'));
        return;
      }
      asArray(response.output).forEach((item, outputIndex) => {
        outputItemDone(asRecord(item), String(outputIndex), accumulator, () => rawAt(['output', outputIndex]), false);
      });
      finishedResponse('', response, accumulator);
    },
  };
}

/** Gemini's own namespace on a call's name is taken off (magpie toolOfCall). */
function geminiToolName(name: string): string {
  for (const separator of [':', '.']) {
    const prefix = `default_api${separator}`;
    if (name.startsWith(prefix) && name.length > prefix.length) return name.slice(prefix.length);
  }
  return name;
}

function geminiDecoder(): WireReplyDecoder {
  let sawToolCall = false;
  let sawStop = false;
  let replyCallCounter = 0;

  const decodeChunk = (rawChunk: unknown, accumulator: WireReplyAccumulator) => {
    const wrapper = asRecord(rawChunk);
    if (wrapper.error !== undefined && wrapper.error !== null) {
      accumulator.setError(errorText(wrapper.error, 'upstream stream failed'));
      return;
    }
    // Code Assist wraps each chunk in {response}.
    const chunk = wrapper.response !== undefined ? asRecord(wrapper.response) : wrapper;
    if (typeof chunk.modelVersion === 'string' && chunk.modelVersion) accumulator.model = chunk.modelVersion;
    if (chunk.usageMetadata !== undefined) accumulator.mergeUsage(geminiUsage(chunk.usageMetadata));
    for (const rawCandidate of asArray(chunk.candidates)) {
      const candidate = asRecord(rawCandidate);
      for (const rawPart of asArray(asRecord(candidate.content).parts)) {
        const part = asRecord(rawPart);
        const signature = asString(part.thoughtSignature);
        const functionCall = asRecord(part.functionCall);
        if (part.functionCall !== undefined) {
          sawToolCall = true;
          const callId = asString(functionCall.id) || `gemini:reply:${replyCallCounter}`;
          const call = accumulator.startToolCall(`gemini:${replyCallCounter++}`, callId, geminiToolName(asString(functionCall.name)));
          call.streamedArgs = functionCall.args === undefined || functionCall.args === null ? '{}' : JSON.stringify(functionCall.args);
          accumulator.addSealed('gemini', 'signature', signature);
        } else if (part.thought === true) {
          accumulator.appendThinking(asString(part.text));
          accumulator.addSealed('gemini', 'signature', signature);
        } else if (typeof part.text === 'string' || signature) {
          accumulator.appendText(asString(part.text));
          accumulator.addSealed('gemini', 'signature', signature);
        }
      }
      if (typeof candidate.finishReason === 'string' && candidate.finishReason && !sawStop) {
        sawStop = true;
        let stop = geminiStop(candidate.finishReason);
        if (sawToolCall && stop === 'stop') stop = 'tool';
        accumulator.stop = stop;
      }
    }
  };

  return {
    decodeEvent(data, accumulator) {
      decodeChunk(parseEventData(data), accumulator);
    },
    decodeWhole(body, accumulator) {
      // streamGenerateContent without alt=sse answers a JSON array of chunks.
      if (Array.isArray(body)) {
        for (const chunk of body) decodeChunk(chunk, accumulator);
      } else {
        decodeChunk(body, accumulator);
      }
    },
  };
}

function decoderFor(protocol: WireProtocol): WireReplyDecoder {
  switch (protocol) {
    case 'anthropic':
      return anthropicDecoder();
    case 'openai-chat':
      return openAiChatDecoder();
    case 'openai-responses':
      return openAiResponsesDecoder();
    case 'gemini':
      return geminiDecoder();
  }
}

// ---------------------------------------------------------------------------
// Collectors

export interface WireReplyCollector {
  /** One chunk of the reply copy, in order. */
  push(chunk: Uint8Array): void;
  /** The body ended (or was cut): the reply as far as it went. */
  finish(): WireReply;
  /** The reply passed the byte cap and collecting stopped. */
  readonly passedByteCap: boolean;
}

export interface WireReplyCollectorOptions {
  /** Test seam; defaults to WIRE_REPLY_MAX_BYTES. */
  maxReplyBytes?: number;
}

/** Collects an SSE reply. endedCleanly comes from the Phase 2 end markers, so it agrees with the relay's cut detection. */
class SseReplyCollector implements WireReplyCollector {
  private readonly accumulator = new WireReplyAccumulator();
  private readonly endDetector: StreamEndMarkerDetector;
  private readonly reader: IncrementalSseReader;
  private totalBytes = 0;
  passedByteCap = false;

  constructor(protocol: WireProtocol, private readonly maxReplyBytes: number) {
    const decoder = decoderFor(protocol);
    this.endDetector = new StreamEndMarkerDetector(protocol);
    this.reader = new IncrementalSseReader(event => decoder.decodeEvent(event.data, this.accumulator));
  }

  push(chunk: Uint8Array): void {
    if (this.passedByteCap) return;
    if (this.totalBytes + chunk.length > this.maxReplyBytes) {
      this.passedByteCap = true;
      return;
    }
    this.totalBytes += chunk.length;
    this.endDetector.observe(chunk);
    this.reader.push(chunk);
  }

  finish(): WireReply {
    this.reader.finish();
    return this.accumulator.finish(!this.passedByteCap && this.endDetector.hasSeenEnd && this.reader.oversizedEventCount === 0);
  }
}

/** Collects a whole JSON reply: it ended cleanly when the body parses. */
class WholeJsonReplyCollector implements WireReplyCollector {
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;
  passedByteCap = false;

  constructor(private readonly protocol: WireProtocol, private readonly maxReplyBytes: number) {}

  push(chunk: Uint8Array): void {
    if (this.passedByteCap) return;
    if (this.totalBytes + chunk.length > this.maxReplyBytes) {
      this.passedByteCap = true;
      this.chunks.length = 0;
      return;
    }
    this.chunks.push(chunk.slice());
    this.totalBytes += chunk.length;
  }

  finish(): WireReply {
    const accumulator = new WireReplyAccumulator();
    if (this.passedByteCap) return accumulator.finish(false);
    const joined = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    // A leading UTF-8 BOM is not JSON: TextDecoder drops it, so the scanner must too.
    const hasByteOrderMark = joined[0] === 0xef && joined[1] === 0xbb && joined[2] === 0xbf;
    const bytes = hasByteOrderMark ? joined.subarray(3) : joined;
    let body: unknown;
    let rootSpan: JsonSpan;
    try {
      body = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      rootSpan = scanDocument(bytes);
    } catch {
      return accumulator.finish(false);
    }
    const rawAt = (path: ReadonlyArray<string | number>) => {
      const span = getSpan(bytes, path, rootSpan);
      return span ? rawText(bytes, span) : undefined;
    };
    decoderFor(this.protocol).decodeWhole(body, accumulator, rawAt);
    return accumulator.finish(true);
  }
}

/** A collector for a reply of `contentType` (an SSE stream when it is text/event-stream). */
export function createWireReplyCollector(protocol: WireProtocol, contentType: string | null, options: WireReplyCollectorOptions = {}): WireReplyCollector {
  const isEventStream = (contentType ?? '').toLowerCase().includes('text/event-stream');
  const maxReplyBytes = options.maxReplyBytes ?? WIRE_REPLY_MAX_BYTES;
  return isEventStream ? new SseReplyCollector(protocol, maxReplyBytes) : new WholeJsonReplyCollector(protocol, maxReplyBytes);
}

/** Collect a whole reply at once (tests and replays). */
export function collectWireReply(protocol: WireProtocol, contentType: string | null, chunks: Iterable<Uint8Array>): WireReply {
  const collector = createWireReplyCollector(protocol, contentType);
  for (const chunk of chunks) collector.push(chunk);
  return collector.finish();
}
