// SPDX-License-Identifier: Apache-2.0
//
// The Anthropic Messages stitcher for the hidden memory_search loop (plan
// Phase 12 task 2). What the client gets is one message:
// - message_start of round 1 only; later rounds' are dropped.
// - Content blocks of the hidden tool (content_block_start/delta/stop) are
//   withheld; every other block's `index` is renumbered so the client's
//   indexes run 0, 1, 2… across rounds.
// - A round that ends in hidden calls only withholds its message_delta and
//   message_stop; the last round's message_delta carries the usage of every
//   round added up.
// - The next round's request appends the assistant turn exactly as it came
//   (thinking blocks with their signatures, the hidden tool_use blocks) and
//   a user turn of tool_result blocks.
// - ping and error events, and events this does not know, pass as they are.
// magpie's anthropic encoder keeps its client alive with `ping`
// (anthropic.go:1498-1502, MIT, Copyright (c) 2026 yetone).

import { ScannedObject, objectElements } from '../../ir/scanned-object.js';
import { rawText, scanDocument } from '../../json/scanner.js';
import { encodeJsonString, insertObjectMember } from '../../json/splice.js';
import {
  EditableEventJson,
  UsageAcrossRounds,
  appendArrayItems,
  decodedUsage,
  eventWithJson,
  overlayUsage,
  rootMember,
  sseEventBytes,
  textAfterGap,
  type HiddenToolCall,
  type HiddenToolResult,
  type ProtocolStitcher,
  type RawSseEvent,
  type StitchRoundOutcome,
} from './stitch-events.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

interface StreamedBlock {
  startJson: string;
  type: string;
  hidden: boolean;
  id: string;
  name: string;
  text: string;
  thinking: string;
  signature: string;
  partialJson: string;
}

/** A streamed block as a whole content block, built on its content_block_start. */
function wholeBlockJson(block: StreamedBlock): string {
  let bytes: Uint8Array = utf8Encoder.encode(block.startJson);
  const set = (key: string, valueJson: string) => {
    bytes = insertObjectMember(bytes, scanDocument(bytes), key, valueJson);
  };
  switch (block.type) {
    case 'text':
      set('text', encodeJsonString(block.text));
      break;
    case 'thinking':
      set('thinking', encodeJsonString(block.thinking));
      set('signature', encodeJsonString(block.signature));
      break;
    case 'tool_use':
    case 'server_tool_use':
      set('input', block.partialJson.trim() === '' ? '{}' : block.partialJson);
      break;
  }
  return utf8Decoder.decode(bytes);
}

export class AnthropicStitcher implements ProtocolStitcher {
  private round = 0;
  private maySearchAgain = true;
  private nextClientIndex = 0;
  private readonly indexMap = new Map<number, number | null>();
  private readonly blocks = new Map<number, StreamedBlock>();
  private clientCalls = 0;
  private withheldEnd = false;
  private textSaid = false;
  private gapPending = false;
  private startUsage: Record<string, unknown> | null = {};
  private deltaUsage: Record<string, unknown> | null = {};
  private readonly usage = new UsageAcrossRounds();
  /** Round 1's message id: the one reply keeps it. */
  private firstMessageId: string | null = null;
  /** The assistant turn of the round that just ended in hidden calls, as content blocks. */
  private roundAssistantBlocks: string[] = [];
  // Whole (non-stream) rounds.
  private readonly visibleWholeBlocks: string[] = [];
  private lastWholeReply: Uint8Array | null = null;
  private lastWholeUsage: Record<string, unknown> | null = {};
  private anyHiddenCall = false;
  private forcedStop = false;

  constructor(private readonly hiddenToolName: string) {}

  startRound(round: number, maySearchAgain: boolean): void {
    this.round = round;
    this.maySearchAgain = maySearchAgain;
    this.indexMap.clear();
    this.blocks.clear();
    this.clientCalls = 0;
    this.withheldEnd = false;
    this.startUsage = {};
    this.deltaUsage = {};
    this.forcedStop = false;
  }

  private hiddenCallsOfRound(): HiddenToolCall[] {
    return [...this.blocks.values()].filter(block => block.hidden)
      .map(block => ({ callId: block.id, name: block.name, argsJson: block.partialJson.trim() === '' ? '{}' : block.partialJson }));
  }

  /** The round's usage: message_delta's over message_start's; null when either could not be read. */
  private roundUsage(): Record<string, unknown> | null {
    return this.startUsage === null || this.deltaUsage === null ? null : overlayUsage(this.startUsage, this.deltaUsage);
  }

  streamEvent(event: RawSseEvent): Uint8Array[] {
    const json = event.json;
    if (!json) return [event.bytes];
    const root = json.root;
    const type = root.string('type') ?? event.name;
    switch (type) {
      case 'message_start':
        this.startUsage = decodedUsage(root.object('message')?.raw('usage'));
        return this.round === 1 ? [event.bytes] : [];
      case 'content_block_start': {
        const index = root.number('index');
        const contentBlock = root.object('content_block');
        if (index === undefined || !contentBlock) return [event.bytes];
        const blockType = contentBlock.string('type') ?? '';
        const name = contentBlock.string('name') ?? '';
        const hidden = blockType === 'tool_use' && name === this.hiddenToolName;
        this.blocks.set(index, {
          startJson: rawText(contentBlock.bytes, contentBlock.span), type: blockType, hidden,
          id: contentBlock.string('id') ?? '', name, text: '', thinking: '', signature: '', partialJson: '',
        });
        if (hidden) {
          this.anyHiddenCall = true;
          this.indexMap.set(index, null);
          return [];
        }
        if (blockType === 'tool_use') this.clientCalls++;
        const clientIndex = this.nextClientIndex++;
        this.indexMap.set(index, clientIndex);
        json.replace(['index'], String(clientIndex));
        return [eventWithJson(event, json)];
      }
      case 'content_block_delta': {
        const index = root.number('index');
        const block = index === undefined ? undefined : this.blocks.get(index);
        const delta = root.object('delta');
        if (index === undefined || !block || !delta) return [event.bytes];
        const deltaType = delta.string('type');
        const text = delta.string('text') ?? '';
        if (deltaType === 'text_delta') block.text += text;
        else if (deltaType === 'thinking_delta') block.thinking += delta.string('thinking') ?? '';
        else if (deltaType === 'signature_delta') block.signature += delta.string('signature') ?? '';
        else if (deltaType === 'input_json_delta') block.partialJson += delta.string('partial_json') ?? '';
        const clientIndex = this.indexMap.get(index);
        if (clientIndex === null || clientIndex === undefined) return [];
        json.replace(['index'], String(clientIndex));
        if (deltaType === 'text_delta' && text !== '') {
          if (this.gapPending) {
            json.replace(['delta', 'text'], encodeJsonString(textAfterGap(text)));
            this.gapPending = false;
          }
          this.textSaid = true;
        }
        return [eventWithJson(event, json)];
      }
      case 'content_block_stop': {
        const index = root.number('index');
        const clientIndex = index === undefined ? undefined : this.indexMap.get(index);
        if (clientIndex === undefined) return [event.bytes];
        if (clientIndex === null) return [];
        json.replace(['index'], String(clientIndex));
        return [eventWithJson(event, json)];
      }
      case 'message_delta': {
        this.deltaUsage = decodedUsage(root.raw('usage'));
        const stopReason = root.object('delta')?.string('stop_reason');
        const hiddenOnly = this.hiddenCallsOfRound().length > 0 && this.clientCalls === 0 && stopReason === 'tool_use';
        if (hiddenOnly && this.maySearchAgain) {
          this.withheldEnd = true;
          return [];
        }
        const total = this.usage.hasEarlierRounds ? this.usage.totalWith(this.roundUsage()) : null;
        if (total) json.set([], 'usage', JSON.stringify(total));
        // The last round may not search again: its hidden-only end is a plain stop.
        if (hiddenOnly) json.replace(['delta', 'stop_reason'], '"end_turn"');
        return [eventWithJson(event, json)];
      }
      case 'message_stop':
        return this.withheldEnd ? [] : [event.bytes];
      default:
        return [event.bytes];
    }
  }

  endStreamRound(): StitchRoundOutcome {
    const hiddenCalls = this.hiddenCallsOfRound();
    if (!this.withheldEnd) return { continues: false, hiddenCalls };
    this.usage.addRound(this.roundUsage());
    this.gapPending = this.textSaid;
    this.roundAssistantBlocks = [...this.blocks.values()].map(wholeBlockJson);
    return { continues: true, hiddenCalls };
  }

  wholeRound(json: Uint8Array): StitchRoundOutcome {
    const root = ScannedObject.of(json, scanDocument(json));
    if (!root) throw new Error('the reply is not a JSON object');
    const hiddenCalls: HiddenToolCall[] = [];
    let clientCalls = 0;
    const allBlocks: string[] = [];
    for (const block of objectElements(json, root.spanOf('content'))) {
      const raw = rawText(json, block.span);
      allBlocks.push(raw);
      const blockType = block.string('type');
      if (blockType === 'tool_use' && block.string('name') === this.hiddenToolName) {
        hiddenCalls.push({ callId: block.string('id') ?? '', name: this.hiddenToolName, argsJson: block.raw('input') ?? '{}' });
        continue;
      }
      if (blockType === 'tool_use') clientCalls++;
      const text = blockType === 'text' ? block.string('text') ?? '' : '';
      if (text !== '' && this.gapPending) {
        const rawBytes = utf8Encoder.encode(raw);
        this.visibleWholeBlocks.push(utf8Decoder.decode(insertObjectMember(rawBytes, scanDocument(rawBytes), 'text', encodeJsonString(textAfterGap(text)))));
        this.gapPending = false;
      } else {
        this.visibleWholeBlocks.push(raw);
      }
      if (text !== '') this.textSaid = true;
    }
    if (hiddenCalls.length > 0) this.anyHiddenCall = true;
    const hiddenOnly = hiddenCalls.length > 0 && clientCalls === 0 && root.string('stop_reason') === 'tool_use';
    const roundUsage = decodedUsage(root.raw('usage'));
    this.firstMessageId ??= root.string('id') ?? null;
    this.lastWholeReply = json;
    this.lastWholeUsage = this.usage.totalWith(roundUsage);
    if (hiddenOnly && this.maySearchAgain) {
      this.usage.addRound(roundUsage);
      this.gapPending = this.textSaid;
      this.roundAssistantBlocks = allBlocks;
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
    json.replace(['content'], `[${this.visibleWholeBlocks.join(',')}]`);
    if (this.lastWholeUsage && json.spanAt(['usage'])?.type === 'object') json.replace(['usage'], JSON.stringify(this.lastWholeUsage));
    if (this.firstMessageId !== null) json.replace(['id'], encodeJsonString(this.firstMessageId));
    if (this.forcedStop) json.replace(['stop_reason'], '"end_turn"');
    return json.bytes;
  }

  nextRequestBody(previousBody: Uint8Array, results: HiddenToolResult[]): Uint8Array {
    const { span: messagesSpan } = rootMember(previousBody, 'messages');
    if (messagesSpan?.type !== 'array') throw new Error('the request has no messages array');
    const assistant = `{"role":"assistant","content":[${this.roundAssistantBlocks.join(',')}]}`;
    const toolResults = results.map(result => `{"type":"tool_result","tool_use_id":${encodeJsonString(result.call.callId)},"content":${encodeJsonString(result.text)}${result.isError ? ',"is_error":true' : ''}}`);
    const user = `{"role":"user","content":[${toolResults.join(',')}]}`;
    return appendArrayItems(previousBody, messagesSpan, [assistant, user]);
  }

  keepalive(): Uint8Array {
    return sseEventBytes('ping', '{"type": "ping"}');
  }

  errorJson(message: string): string {
    return `{"type":"error","error":{"type":"api_error","message":${encodeJsonString(message)}}}`;
  }

  errorEvent(message: string): Uint8Array {
    return sseEventBytes('error', this.errorJson(message));
  }
}
