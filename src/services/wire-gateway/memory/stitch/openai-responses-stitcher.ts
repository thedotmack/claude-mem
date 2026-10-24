// SPDX-License-Identifier: Apache-2.0
//
// The OpenAI Responses stitcher for the hidden memory_search loop (plan
// Phase 12 task 2). What the client gets is one response:
// - response.created and response.in_progress of round 1 only.
// - Every event of a hidden function_call item (its output_item.added and
//   .done, its argument deltas) is withheld; every other event gets its
//   `output_index` renumbered to run 0, 1, 2… across rounds, and every event
//   forwarded gets the client's own `sequence_number`, so both stay
//   contiguous.
// - A reasoning item belongs to the items after it, up to the next reasoning
//   item: the API refuses a replayed reasoning item without its following
//   item, and a function_call without the reasoning item that preceded it.
//   So a reasoning item's events are held until an item the client sees
//   follows it (then it goes out first, even when a hidden call came in
//   between: reasoning → hidden call → the agent's call gives the client
//   reasoning → the agent's call), and withheld when only hidden calls
//   follow it before the next reasoning item or the end of the round.
// - A round that ends in hidden calls only withholds its response.completed;
//   the last round's carries, as `output`, every item the client was shown
//   (all rounds), and every round's usage added up.
// - The next round's request appends the round's output items as they came
//   (reasoning with its encrypted_content, the hidden function_call items)
//   and a function_call_output per result. With `store: false` nothing is
//   stored upstream, so the items go without their `id` (an id refers to a
//   stored item: "Item with id … not found"), and the client's response
//   keeps round 1's id. With storage on, the last round's id stays: it is
//   the response upstream holds the whole exchange under.
// - While waiting, response.in_progress again: Codex's idle timer counts
//   events, never an SSE comment (magpie responses.go:1654-1662, MIT,
//   Copyright (c) 2026 yetone).
// Text after a search is not given a blank line here: each round's text is
// its own message item, which the client shows apart already.

import { ScannedObject, objectElements } from '../../ir/scanned-object.js';
import { rawText, scanDocument } from '../../json/scanner.js';
import { encodeJsonString, insertObjectMember } from '../../json/splice.js';
import { applyByteSplices } from '../../json/byte-splices.js';
import {
  EditableEventJson,
  UsageAcrossRounds,
  appendArrayItems,
  decodedUsage,
  eventWithJson,
  rootMember,
  sseEventBytes,
  withoutRootMember,
  type HiddenToolCall,
  type HiddenToolResult,
  type ProtocolStitcher,
  type RawSseEvent,
  type StitchRoundOutcome,
} from './stitch-events.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

interface StreamedItem {
  hidden: boolean;
  /** A reasoning item whose following item is the hidden call: withheld with it. */
  withheld: boolean;
  type: string;
  clientIndex: number | null;
  itemJson: string;
  callId: string;
  name: string;
  args: string;
}

const FUNCTION_CALL_ITEM_TYPES = new Set(['function_call', 'custom_tool_call']);
const RESPONSE_END_TYPES = new Set(['response.completed', 'response.incomplete', 'response.failed']);

export interface OpenAiResponsesStitcherOptions {
  /** The request said `store: false`: nothing is kept upstream to refer to by id. */
  storeDisabled: boolean;
}

export class OpenAiResponsesStitcher implements ProtocolStitcher {
  private round = 0;
  private maySearchAgain = true;
  private nextSequenceNumber: number | null = null;
  private nextClientOutputIndex = 0;
  private readonly items = new Map<number, StreamedItem>();
  private clientCalls = 0;
  private withheldEnd = false;
  private latestResponseJson: string | null = null;
  private firstResponseId: string | null = null;
  private readonly forwardedItems: string[] = [];
  /**
   * A reasoning item's events, held until an item after it shows whether it
   * goes (output index, events, and whether a hidden call has followed it).
   */
  private heldReasoning: { outputIndex: number; followedByHidden: boolean; events: Array<{ event: RawSseEvent; json: EditableEventJson }> } | null = null;
  private roundUsage: Record<string, unknown> | null = {};
  private readonly usage = new UsageAcrossRounds();
  private roundOutputItems: string[] = [];
  private anyHiddenCall = false;
  // Whole rounds.
  private readonly visibleWholeItems: string[] = [];
  private lastWholeReply: Uint8Array | null = null;
  private lastWholeUsage: Record<string, unknown> | null = {};

  constructor(private readonly hiddenToolName: string, private readonly options: OpenAiResponsesStitcherOptions = { storeDisabled: false }) {}

  startRound(round: number, maySearchAgain: boolean): void {
    this.round = round;
    this.maySearchAgain = maySearchAgain;
    this.items.clear();
    this.clientCalls = 0;
    this.withheldEnd = false;
    this.heldReasoning = null;
    this.roundUsage = {};
  }

  private hiddenCallsOfRound(): HiddenToolCall[] {
    return [...this.items.values()].filter(item => item.hidden)
      .map(item => ({ callId: item.callId, name: item.name, argsJson: item.args.trim() === '' ? '{}' : item.args }));
  }

  /** The event as the client gets it: its item's client output index, and the client's next sequence number. */
  private forward(event: RawSseEvent, json: EditableEventJson, item?: StreamedItem): Uint8Array[] {
    if (item) {
      if (item.clientIndex === null) item.clientIndex = this.nextClientOutputIndex++;
      json.replace(['output_index'], String(item.clientIndex));
      if (json.root.string('type') === 'response.output_item.done') this.forwardedItems.push(item.itemJson);
    }
    const sequenceSpan = json.spanAt(['sequence_number']);
    if (sequenceSpan?.type === 'number') {
      const upstreamNumber = Number(rawText(json.bytes, sequenceSpan));
      const clientNumber = this.nextSequenceNumber ?? upstreamNumber;
      this.nextSequenceNumber = clientNumber + 1;
      json.replace(['sequence_number'], String(clientNumber));
    }
    return [eventWithJson(event, json)];
  }

  /** The held reasoning item's events: sent (it is followed by an item the client sees) or dropped (only by hidden calls). */
  private releaseHeldReasoning(send: boolean): Uint8Array[] {
    const held = this.heldReasoning;
    this.heldReasoning = null;
    if (!held) return [];
    const item = this.items.get(held.outputIndex)!;
    if (!send) {
      item.withheld = true;
      return [];
    }
    return held.events.flatMap(({ event, json }) => this.forward(event, json, item));
  }

  /** The held reasoning item when no item the client sees follows it: dropped if hidden calls did, sent if nothing did. */
  private settleHeldReasoning(): Uint8Array[] {
    return this.releaseHeldReasoning(!this.heldReasoning?.followedByHidden);
  }

  streamEvent(event: RawSseEvent): Uint8Array[] {
    const json = event.json;
    if (!json) return [event.bytes];
    const root = json.root;
    const type = root.string('type') ?? event.name;
    if (type === 'response.created' || type === 'response.in_progress') {
      if (this.round > 1) return [];
      // Round 1's response is the one the client knows; keepalives repeat it.
      this.latestResponseJson = root.raw('response') ?? this.latestResponseJson;
      this.firstResponseId ??= root.object('response')?.string('id') ?? null;
      return this.forward(event, json);
    }
    if (type === 'response.output_item.added') {
      const outputIndex = root.number('output_index');
      const item = root.object('item');
      if (outputIndex === undefined || !item) return this.forward(event, json);
      const itemType = item.string('type') ?? '';
      const name = item.string('name') ?? '';
      const hidden = itemType === 'function_call' && name === this.hiddenToolName;
      const record: StreamedItem = {
        hidden, withheld: false, type: itemType, clientIndex: null, itemJson: rawText(item.bytes, item.span),
        callId: item.string('call_id') ?? '', name, args: item.string('arguments') ?? '',
      };
      this.items.set(outputIndex, record);
      if (hidden) {
        // The held reasoning stays held: an item the client sees may still follow it.
        if (this.heldReasoning) this.heldReasoning.followedByHidden = true;
        this.anyHiddenCall = true;
        return [];
      }
      if (FUNCTION_CALL_ITEM_TYPES.has(itemType)) this.clientCalls++;
      if (itemType === 'reasoning') {
        // The next reasoning item ends the held one's run of items.
        const released = this.settleHeldReasoning();
        this.heldReasoning = { outputIndex, followedByHidden: false, events: [{ event, json }] };
        return released;
      }
      return [...this.releaseHeldReasoning(true), ...this.forward(event, json, record)];
    }
    if (RESPONSE_END_TYPES.has(type)) {
      this.roundUsage = decodedUsage(root.object('response')?.raw('usage'));
      const hiddenOnly = this.hiddenCallsOfRound().length > 0 && this.clientCalls === 0 && type === 'response.completed';
      if (hiddenOnly && this.maySearchAgain) {
        this.withheldEnd = true;
        return this.releaseHeldReasoning(false);
      }
      // A reasoning item last in the reply has nothing after it to lose.
      const released = this.settleHeldReasoning();
      if (this.round > 1 || this.anyHiddenCall) {
        if (json.spanAt(['response', 'output'])?.type === 'array') json.replace(['response', 'output'], `[${this.forwardedItems.join(',')}]`);
      }
      const total = this.usage.hasEarlierRounds ? this.usage.totalWith(this.roundUsage) : null;
      if (total && json.spanAt(['response', 'usage'])?.type === 'object') json.replace(['response', 'usage'], JSON.stringify(total));
      if (this.round > 1 && this.options.storeDisabled && this.firstResponseId !== null) json.replace(['response', 'id'], encodeJsonString(this.firstResponseId));
      return [...released, ...this.forward(event, json)];
    }
    const outputIndex = root.number('output_index');
    const item = outputIndex === undefined ? undefined : this.items.get(outputIndex);
    if (outputIndex === undefined || !item) return this.forward(event, json);
    if (type === 'response.output_item.done') {
      const doneItem = root.object('item');
      if (doneItem) {
        item.itemJson = rawText(doneItem.bytes, doneItem.span);
        item.args = doneItem.string('arguments') ?? item.args;
      }
    } else if (type === 'response.function_call_arguments.delta') {
      item.args += root.string('delta') ?? '';
    } else if (type === 'response.function_call_arguments.done') {
      item.args = root.string('arguments') ?? item.args;
    }
    if (item.hidden || item.withheld) return [];
    if (this.heldReasoning?.outputIndex === outputIndex) {
      this.heldReasoning.events.push({ event, json });
      return [];
    }
    return this.forward(event, json, item);
  }

  endStreamRound(): StitchRoundOutcome & { held?: Uint8Array[] } {
    const hiddenCalls = this.hiddenCallsOfRound();
    if (!this.withheldEnd) return { continues: false, hiddenCalls, held: this.settleHeldReasoning() };
    this.usage.addRound(this.roundUsage);
    this.roundOutputItems = [...this.items.entries()].sort(([first], [second]) => first - second).map(([, item]) => this.itemForNextRound(item.itemJson));
    return { continues: true, hiddenCalls };
  }

  /** An output item as the next round sends it: without its id when nothing is stored upstream. */
  private itemForNextRound(itemJson: string): string {
    return this.options.storeDisabled ? withoutRootMember(itemJson, 'id') : itemJson;
  }

  wholeRound(json: Uint8Array): StitchRoundOutcome {
    const root = ScannedObject.of(json, scanDocument(json));
    if (!root) throw new Error('the reply is not a JSON object');
    this.firstResponseId ??= root.string('id') ?? null;
    const hiddenCalls: HiddenToolCall[] = [];
    let clientCalls = 0;
    const outputItems = objectElements(json, root.spanOf('output'));
    const allItems: string[] = [];
    outputItems.forEach((item, position) => {
      const raw = rawText(json, item.span);
      allItems.push(raw);
      const itemType = item.string('type') ?? '';
      if (itemType === 'function_call' && item.string('name') === this.hiddenToolName) {
        hiddenCalls.push({ callId: item.string('call_id') ?? '', name: this.hiddenToolName, argsJson: item.string('arguments') ?? '{}' });
        return;
      }
      if (itemType === 'reasoning' && this.onlyHiddenCallsFollow(outputItems, position)) return;
      if (FUNCTION_CALL_ITEM_TYPES.has(itemType)) clientCalls++;
      this.visibleWholeItems.push(raw);
    });
    if (hiddenCalls.length > 0) this.anyHiddenCall = true;
    const status = root.string('status');
    const hiddenOnly = hiddenCalls.length > 0 && clientCalls === 0 && (status === undefined || status === 'completed');
    const roundUsage = decodedUsage(root.raw('usage'));
    this.lastWholeReply = json;
    this.lastWholeUsage = this.usage.totalWith(roundUsage);
    if (hiddenOnly && this.maySearchAgain) {
      this.usage.addRound(roundUsage);
      this.roundOutputItems = allItems.map(itemJson => this.itemForNextRound(itemJson));
      return { continues: true, hiddenCalls };
    }
    return { continues: false, hiddenCalls };
  }

  /** Whether the items after a reasoning item, up to the next reasoning item, are hidden calls and there is one at least. */
  private onlyHiddenCallsFollow(outputItems: ScannedObject[], reasoningPosition: number): boolean {
    let followers = 0;
    for (const item of outputItems.slice(reasoningPosition + 1)) {
      if (item.string('type') === 'reasoning') break;
      if (!(item.string('type') === 'function_call' && item.string('name') === this.hiddenToolName)) return false;
      followers++;
    }
    return followers > 0;
  }

  mergedWholeReply(): Uint8Array {
    const reply = this.lastWholeReply;
    if (!reply) throw new Error('no round was read');
    if (this.round === 1 && !this.anyHiddenCall) return reply;
    const json = new EditableEventJson(utf8Decoder.decode(reply));
    json.replace(['output'], `[${this.visibleWholeItems.join(',')}]`);
    if (this.lastWholeUsage && json.spanAt(['usage'])?.type === 'object') json.replace(['usage'], JSON.stringify(this.lastWholeUsage));
    if (this.options.storeDisabled && this.firstResponseId !== null) json.replace(['id'], encodeJsonString(this.firstResponseId));
    return json.bytes;
  }

  nextRequestBody(previousBody: Uint8Array, results: HiddenToolResult[]): Uint8Array {
    const { root, span: inputSpan } = rootMember(previousBody, 'input');
    const outputs = results.map(result => `{"type":"function_call_output","call_id":${encodeJsonString(result.call.callId)},"output":${encodeJsonString(result.text)}}`);
    const appended = [...this.roundOutputItems, ...outputs];
    if (inputSpan?.type === 'array') return appendArrayItems(previousBody, inputSpan, appended);
    if (inputSpan?.type === 'string') {
      // A string input is the user's message: it becomes the first item, its bytes as they were.
      const userItem = `{"type":"message","role":"user","content":[{"type":"input_text","text":${rawText(previousBody, inputSpan)}}]}`;
      return applyByteSplices(previousBody, [{ start: inputSpan.start, end: inputSpan.end, replacement: utf8Encoder.encode(`[${[userItem, ...appended].join(',')}]`) }]);
    }
    if (!inputSpan) return insertObjectMember(previousBody, root.span, 'input', `[${appended.join(',')}]`);
    throw new Error(`input is a ${inputSpan.type}`);
  }

  keepalive(): Uint8Array | null {
    if (this.latestResponseJson === null || this.nextSequenceNumber === null) return null;
    const sequenceNumber = this.nextSequenceNumber++;
    return sseEventBytes('response.in_progress', `{"type":"response.in_progress","sequence_number":${sequenceNumber},"response":${this.latestResponseJson}}`);
  }

  errorJson(message: string): string {
    return `{"type":"error","code":"server_error","message":${encodeJsonString(message)},"param":null}`;
  }

  errorEvent(message: string): Uint8Array {
    const sequenceNumber = this.nextSequenceNumber ?? 0;
    this.nextSequenceNumber = sequenceNumber + 1;
    return sseEventBytes('error', `{"type":"error","sequence_number":${sequenceNumber},"code":"server_error","message":${encodeJsonString(message)},"param":null}`);
  }
}
