// SPDX-License-Identifier: Apache-2.0
//
// The OpenAI Chat Completions stitcher for the hidden memory_search loop
// (plan Phase 12 task 2). What the client gets is one completion:
// - The hidden tool's entries in `delta.tool_calls` are taken out; the
//   agent's own calls are renumbered (`tool_calls[].index`) to run 0, 1, 2…
//   A chunk left with nothing to say is dropped.
// - A round whose calls are all the hidden tool's has its finish_reason set
//   to null whatever it was (compatible providers say "stop" for calls too),
//   and its usage chunk and `data: [DONE]` withheld; the last round's usage
//   chunk carries every round's usage added up. Later rounds' chunks carry
//   round 1's id.
// - Text after a search goes on after a blank line.
// - The next round's request appends the assistant message as it came:
//   every delta field accumulated as the OpenAI SDKs accumulate a stream
//   (strings joined, objects merged, array entries merged by their `index`),
//   so reasoning in any spelling, `reasoning_details` and a call's
//   `extra_content.google.thought_signature` go back as the model sent them
//   (D7.6); then one `tool` message per result.
// - While waiting, `: keepalive` comments, never an empty-data event
//   (magpie chat.go:1170-1172, MIT, Copyright (c) 2026 yetone; an empty
//   data event crashes openai-go v2).

import { ScannedObject, objectElements } from '../../ir/scanned-object.js';
import { rawText, scanDocument, type JsonSpan } from '../../json/scanner.js';
import { encodeJsonString } from '../../json/splice.js';
import {
  EditableEventJson,
  UsageAcrossRounds,
  appendArrayItems,
  decodedUsage,
  eventWithJson,
  rootMember,
  textAfterGap,
  type HiddenToolCall,
  type HiddenToolResult,
  type ProtocolStitcher,
  type RawSseEvent,
  type StitchRoundOutcome,
} from './stitch-events.js';
import { WHOLE_ROUND_MAX_BYTES } from './hidden-tool-loop.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strings that name rather than grow: kept from their first delta. */
const NAMING_KEYS = new Set(['id', 'type', 'name', 'role', 'call_id', 'index']);
/**
 * Strings that grow across deltas, each delta carrying the next piece:
 * message text, reasoning in its spellings, a call's arguments, and the
 * text/summary/data of a `reasoning_details` entry.
 */
const GROWING_TEXT_KEYS = new Set([
  'content', 'refusal', 'reasoning', 'reasoning_content', 'reasoning_text', 'thinking',
  'arguments', 'text', 'summary', 'data',
]);

/**
 * `delta` merged into `target` the way a stream accumulates (openai-node
 * ChatCompletionStream's accumulateDelta). The rule for a string key seen again:
 * - a growing text key (GROWING_TEXT_KEYS) is joined, always — a piece may
 *   repeat the one before it ("ha", "ha");
 * - a naming key (NAMING_KEYS) keeps its first non-empty value;
 * - any other key: a value equal to the one held is a fixed field the
 *   provider repeats in each delta (OpenRouter's `reasoning_details[].format`)
 *   and is kept once; a different value is a field we do not know growing, and
 *   is joined.
 */
export function accumulateDelta(target: JsonObject, delta: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(delta)) {
    const existing = target[key];
    if (value === null || value === undefined) {
      if (!(key in target)) target[key] = value;
    } else if (typeof value === 'string') {
      if (typeof existing !== 'string') target[key] = value;
      else if (GROWING_TEXT_KEYS.has(key)) target[key] = existing + value;
      else if (NAMING_KEYS.has(key)) {
        if (existing === '') target[key] = value;
      } else if (existing !== value) target[key] = existing + value;
    } else if (Array.isArray(value)) {
      const list: unknown[] = Array.isArray(existing) ? existing : [];
      for (const item of value) {
        const match = isJsonObject(item) && typeof item.index === 'number'
          ? list.find(entry => isJsonObject(entry) && entry.index === item.index)
          : undefined;
        if (isJsonObject(match) && isJsonObject(item)) accumulateDelta(match, item);
        else list.push(isJsonObject(item) ? accumulateDelta({}, item) : item);
      }
      target[key] = list;
    } else if (isJsonObject(value)) {
      target[key] = accumulateDelta(isJsonObject(existing) ? existing : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

interface StreamedCall {
  hidden: boolean;
  clientIndex: number | null;
}

/** A delta with nothing in it but its role, null or empty text. */
function deltaIsEmpty(delta: ScannedObject | undefined): boolean {
  if (!delta) return true;
  for (const key of delta.keys()) {
    if (key === 'role') continue;
    const span = delta.spanOf(key) as JsonSpan;
    if (span.type === 'null') continue;
    if (span.type === 'string' && delta.string(key) === '') continue;
    if (span.type === 'array' && delta.elements(key).length === 0) continue;
    return false;
  }
  return true;
}

export class OpenAiChatStitcher implements ProtocolStitcher {
  private round = 0;
  private maySearchAgain = true;
  private nextClientIndex = 0;
  private readonly calls = new Map<number, StreamedCall>();
  private clientCalls = 0;
  private hiddenCallCount = 0;
  private withheldEnd = false;
  private textSaid = false;
  private gapPending = false;
  /** Every delta of the round's choice 0, accumulated. */
  private roundMessage: JsonObject = {};
  /** The bytes of the deltas accumulated into roundMessage this round. */
  private roundMessageBytes = 0;
  private roundUsage: JsonObject | null = {};
  private readonly usage = new UsageAcrossRounds();
  private roundAssistantMessage = '';
  private firstCompletionId: string | null = null;
  // Whole rounds.
  private readonly wholeTexts: string[] = [];
  private lastWholeReply: Uint8Array | null = null;
  private lastWholeUsage: JsonObject | null = {};
  private anyHiddenCall = false;
  private forcedStop = false;

  /** `roundMessageMaxBytes`: the most of a round's deltas held for the replay (a test seam; WHOLE_ROUND_MAX_BYTES). */
  constructor(private readonly hiddenToolName: string, private readonly roundMessageMaxBytes: number = WHOLE_ROUND_MAX_BYTES) {}

  startRound(round: number, maySearchAgain: boolean): void {
    this.round = round;
    this.maySearchAgain = maySearchAgain;
    this.calls.clear();
    this.clientCalls = 0;
    this.hiddenCallCount = 0;
    this.withheldEnd = false;
    this.roundMessage = {};
    this.roundMessageBytes = 0;
    this.roundUsage = {};
    this.forcedStop = false;
  }

  /** The round's calls as accumulated, in index order. */
  private accumulatedCalls(): JsonObject[] {
    const toolCalls = this.roundMessage.tool_calls;
    return Array.isArray(toolCalls) ? toolCalls.filter(isJsonObject) : [];
  }

  private hiddenCallsOfRound(): HiddenToolCall[] {
    return this.accumulatedCalls()
      .filter(call => isJsonObject(call.function) && call.function.name === this.hiddenToolName)
      .map(call => {
        const fn = call.function as JsonObject;
        const args = typeof fn.arguments === 'string' ? fn.arguments : '';
        return { callId: typeof call.id === 'string' ? call.id : '', name: this.hiddenToolName, argsJson: args.trim() === '' ? '{}' : args };
      });
  }

  streamEvent(event: RawSseEvent): Uint8Array[] {
    const json = event.json;
    if (!json) {
      if (event.dataText === '[DONE]' && this.withheldEnd) return [];
      return [event.bytes];
    }
    const root = json.root;
    const chunkId = root.string('id');
    if (this.round === 1) this.firstCompletionId ??= chunkId ?? null;
    else if (chunkId !== undefined && this.firstCompletionId !== null) json.replace(['id'], encodeJsonString(this.firstCompletionId));
    let removedSomething = false;
    const choice = ScannedObject.of(root.bytes, root.elements('choices')[0]);
    const delta = choice?.object('delta');
    if (choice && delta) {
      // Held for the replay like a whole round, under the same cap; past it the round fails (the loop's failure path).
      this.roundMessageBytes += delta.span.end - delta.span.start;
      if (this.roundMessageBytes > this.roundMessageMaxBytes) throw new Error(`a round's deltas are over ${this.roundMessageMaxBytes} bytes`);
      accumulateDelta(this.roundMessage, JSON.parse(rawText(delta.bytes, delta.span)) as JsonObject);
      // The calls this chunk speaks of, in the order its array lists them.
      const entries = objectElements(delta.bytes, delta.spanOf('tool_calls')).map((entry, position) => {
        const index = entry.number('index') ?? position;
        let call = this.calls.get(index);
        if (!call) {
          const hidden = entry.object('function')?.string('name') === this.hiddenToolName;
          call = { hidden, clientIndex: hidden ? null : this.nextClientIndex++ };
          if (hidden) {
            this.anyHiddenCall = true;
            this.hiddenCallCount++;
          } else {
            this.clientCalls++;
          }
          this.calls.set(index, call);
        }
        return call;
      });
      const content = delta.string('content') ?? '';
      if (content !== '') {
        if (this.gapPending) {
          json.replace(['choices', 0, 'delta', 'content'], encodeJsonString(textAfterGap(content)));
          this.gapPending = false;
        }
        this.textSaid = true;
      }
      if (entries.some(call => call.hidden)) {
        if (entries.every(call => call.hidden)) {
          json.removeMember(['choices', 0, 'delta'], 'tool_calls');
        } else {
          json.removeElements(['choices', 0, 'delta', 'tool_calls'], (_span, position) => entries[position].hidden);
        }
        removedSomething = true;
      }
      entries.filter(call => !call.hidden).forEach((call, position) => {
        json.replace(['choices', 0, 'delta', 'tool_calls', position, 'index'], String(call.clientIndex));
      });
      const finishReason = choice.string('finish_reason');
      if (finishReason) {
        // Whatever the stop says: a compatible provider may say "stop" after calls.
        const hiddenOnly = this.hiddenCallCount > 0 && this.clientCalls === 0;
        if (hiddenOnly && this.maySearchAgain) {
          this.withheldEnd = true;
          json.replace(['choices', 0, 'finish_reason'], 'null');
          removedSomething = true;
        } else if (hiddenOnly) {
          json.replace(['choices', 0, 'finish_reason'], '"stop"');
        }
      }
    }
    const usageSpan = json.spanAt(['usage']);
    if (usageSpan?.type === 'object') {
      this.roundUsage = decodedUsage(rawText(json.bytes, usageSpan));
      if (this.withheldEnd) {
        if (!choice) return [];
        json.replace(['usage'], 'null');
      } else if (this.usage.hasEarlierRounds) {
        const total = this.usage.totalWith(this.roundUsage);
        if (total) json.replace(['usage'], JSON.stringify(total));
      }
    }
    // A chunk left with nothing to say (or a later round's opening one) is dropped.
    if (removedSomething || this.round > 1) {
      const edited = json.root;
      const editedChoice = ScannedObject.of(edited.bytes, edited.elements('choices')[0]);
      const finishSpan = editedChoice?.spanOf('finish_reason');
      const usageAfter = edited.spanOf('usage');
      const saysNothing = editedChoice !== undefined && deltaIsEmpty(editedChoice.object('delta'))
        && (!finishSpan || finishSpan.type === 'null') && (!usageAfter || usageAfter.type === 'null');
      if (saysNothing) return [];
    }
    return [eventWithJson(event, json)];
  }

  endStreamRound(): StitchRoundOutcome {
    if (!this.withheldEnd) return { continues: false, hiddenCalls: this.hiddenCallsOfRound() };
    this.usage.addRound(this.roundUsage);
    this.gapPending = this.textSaid;
    this.roundAssistantMessage = this.assistantMessageOfRound();
    return { continues: true, hiddenCalls: this.hiddenCallsOfRound() };
  }

  /** The round's assistant message as it came, for the next request. */
  private assistantMessageOfRound(): string {
    // A call the upstream gave no id gets one, the same in the call and its result.
    let unnamed = 0;
    for (const call of this.accumulatedCalls()) if (typeof call.id !== 'string' || call.id === '') call.id = `call_claude_mem_${this.round}_${unnamed++}`;
    const message: JsonObject = { role: 'assistant' };
    for (const [key, value] of Object.entries(this.roundMessage)) {
      // A null says nothing a request needs; content is kept (null when empty).
      if (value === null && key !== 'content') continue;
      message[key] = value;
    }
    if (typeof message.content !== 'string' || message.content === '') message.content = null;
    // `index` belongs to the stream; a request's tool_calls have none.
    message.tool_calls = this.accumulatedCalls().map(call => Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'index')));
    return JSON.stringify(message);
  }

  wholeRound(json: Uint8Array): StitchRoundOutcome {
    const root = ScannedObject.of(json, scanDocument(json));
    if (!root) throw new Error('the reply is not a JSON object');
    this.firstCompletionId ??= root.string('id') ?? null;
    const choice = ScannedObject.of(json, root.elements('choices')[0]);
    const message = choice?.object('message');
    const hiddenCalls: HiddenToolCall[] = [];
    let clientCalls = 0;
    for (const call of objectElements(json, message?.spanOf('tool_calls'))) {
      const fn = call.object('function');
      if (fn?.string('name') === this.hiddenToolName) {
        hiddenCalls.push({ callId: call.string('id') ?? '', name: this.hiddenToolName, argsJson: fn.string('arguments') ?? '{}' });
      } else {
        clientCalls++;
      }
    }
    if (hiddenCalls.length > 0) this.anyHiddenCall = true;
    const text = message?.string('content') ?? '';
    if (text !== '') {
      this.wholeTexts.push(this.gapPending ? textAfterGap(text) : text);
      this.gapPending = false;
      this.textSaid = true;
    }
    const hiddenOnly = hiddenCalls.length > 0 && clientCalls === 0;
    const roundUsage = decodedUsage(root.raw('usage'));
    this.lastWholeReply = json;
    this.lastWholeUsage = this.usage.totalWith(roundUsage);
    if (hiddenOnly && this.maySearchAgain) {
      if (hiddenCalls.some(call => call.callId === '')) throw new Error('a hidden call came without an id');
      this.usage.addRound(roundUsage);
      this.gapPending = this.textSaid;
      this.roundAssistantMessage = message ? rawText(json, message.span) : '{"role":"assistant","content":null}';
      return { continues: true, hiddenCalls };
    }
    this.forcedStop = hiddenOnly;
    return { continues: false, hiddenCalls };
  }

  mergedWholeReply(): Uint8Array {
    const reply = this.lastWholeReply;
    if (!reply) throw new Error('no round was read');
    if (this.round === 1 && !this.anyHiddenCall) return reply;
    const json = new EditableEventJson(utf8Decoder.decode(reply));
    const text = this.wholeTexts.join('');
    // Every round's text, whether or not the last one had a content member.
    if (json.spanAt(['choices', 0, 'message'])?.type === 'object') json.set(['choices', 0, 'message'], 'content', text === '' ? 'null' : encodeJsonString(text));
    const message = ScannedObject.of(json.bytes, json.spanAt(['choices', 0, 'message']) ?? undefined);
    const calls = objectElements(json.bytes, message?.spanOf('tool_calls'));
    const isHidden = calls.map(call => call.object('function')?.string('name') === this.hiddenToolName);
    if (isHidden.some(Boolean)) {
      if (isHidden.every(Boolean)) json.removeMember(['choices', 0, 'message'], 'tool_calls');
      else json.removeElements(['choices', 0, 'message', 'tool_calls'], (_span, position) => isHidden[position]);
    }
    if (this.forcedStop) json.replace(['choices', 0, 'finish_reason'], '"stop"');
    if (this.lastWholeUsage && json.spanAt(['usage'])?.type === 'object') json.replace(['usage'], JSON.stringify(this.lastWholeUsage));
    if (this.firstCompletionId !== null) json.replace(['id'], encodeJsonString(this.firstCompletionId));
    return json.bytes;
  }

  nextRequestBody(previousBody: Uint8Array, results: HiddenToolResult[]): Uint8Array {
    const { span: messagesSpan } = rootMember(previousBody, 'messages');
    if (messagesSpan?.type !== 'array') throw new Error('the request has no messages array');
    const toolMessages = results.map(result => `{"role":"tool","tool_call_id":${encodeJsonString(result.call.callId)},"content":${encodeJsonString(result.text)}}`);
    return appendArrayItems(previousBody, messagesSpan, [this.roundAssistantMessage, ...toolMessages]);
  }

  keepalive(): Uint8Array {
    return utf8Encoder.encode(': keepalive\n\n');
  }

  errorJson(message: string): string {
    return `{"error":{"message":${encodeJsonString(message)},"type":"api_error"}}`;
  }

  errorEvent(message: string): Uint8Array {
    return utf8Encoder.encode(`data: ${this.errorJson(message)}\n\n`);
  }
}
