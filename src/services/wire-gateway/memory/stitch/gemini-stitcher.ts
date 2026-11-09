// SPDX-License-Identifier: Apache-2.0
//
// The Gemini generateContent stitcher for the hidden memory_search loop
// (plan Phase 12 task 2). What the client gets is one reply:
// - functionCall parts of the hidden tool are taken out of each chunk's
//   candidates[0].content.parts; a chunk left with nothing is dropped.
// - Gemini signs only the first functionCall of a step (report 07 §2.2):
//   when that first call is the hidden one, its thoughtSignature moves to
//   the first call the agent does see, so the agent's next request still
//   carries the step's signature where Gemini looks for it.
// - Gemini ends a round with finishReason (STOP for calls too): a round
//   that called only the hidden tool has its finishReason taken out, so the
//   client reads the next round as more of the same reply.
// - Every later chunk's usageMetadata carries the earlier rounds' added in,
//   and round 1's responseId.
// - Text after a search goes on after a blank line.
// - The next round's request appends the model's parts exactly as they came
//   (every functionCall with its thoughtSignature unchanged) and a user turn
//   of functionResponse parts.
// - Never a keepalive: Gemini clients (agy) fail on any SSE comment, and a
//   Gemini stream has no event that says nothing (magpie gemini.go:621).
// Gemini has no index to renumber.

import { ScannedObject, objectElements } from '../../ir/scanned-object.js';
import { rawText, scanDocument } from '../../json/scanner.js';
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

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const PARTS_PATH = ['candidates', 0, 'content', 'parts'];

function functionCallOf(part: ScannedObject): ScannedObject | undefined {
  return part.object('functionCall', 'function_call');
}

function signatureKeyOf(part: ScannedObject): string | null {
  if (part.spanOf('thoughtSignature')) return 'thoughtSignature';
  if (part.spanOf('thought_signature')) return 'thought_signature';
  return null;
}

export class GeminiStitcher implements ProtocolStitcher {
  private round = 0;
  private maySearchAgain = true;
  private roundParts: string[] = [];
  private roundHiddenCalls: HiddenToolCall[] = [];
  private clientCalls = 0;
  private withheldEnd = false;
  private textSaid = false;
  private gapPending = false;
  /** A hidden call's signature (key and raw value) waiting for the round's first call the agent sees. */
  private pendingSignature: { key: string; rawValue: string } | null = null;
  private roundUsage: Record<string, unknown> | null = {};
  private readonly usage = new UsageAcrossRounds();
  private assistantPartsForNext: string[] = [];
  private anyHiddenCall = false;
  private firstResponseId: string | null = null;
  // Whole rounds.
  private readonly visibleWholeParts: string[] = [];
  private lastWholeReply: Uint8Array | null = null;
  private lastWholeUsage: Record<string, unknown> | null = {};

  constructor(private readonly hiddenToolName: string) {}

  startRound(round: number, maySearchAgain: boolean): void {
    this.round = round;
    this.maySearchAgain = maySearchAgain;
    this.roundParts = [];
    this.roundHiddenCalls = [];
    this.clientCalls = 0;
    this.withheldEnd = false;
    this.pendingSignature = null;
    this.roundUsage = {};
  }

  /**
   * What a part of this round is: the hidden call it makes, else null.
   * Counts the agent's own calls, and keeps a hidden call's signature for
   * the first call the agent sees.
   */
  private notePart(part: ScannedObject, position: number): HiddenToolCall | null {
    this.roundParts.push(rawText(part.bytes, part.span));
    const functionCall = functionCallOf(part);
    if (!functionCall) return null;
    const name = functionCall.string('name') ?? '';
    if (name !== this.hiddenToolName) {
      this.clientCalls++;
      return null;
    }
    this.anyHiddenCall = true;
    const signatureKey = signatureKeyOf(part);
    if (signatureKey && this.clientCalls === 0 && !this.pendingSignature) {
      this.pendingSignature = { key: signatureKey, rawValue: part.raw(signatureKey) as string };
    }
    // A call without an id is answered by name (its result then carries no id either).
    return { callId: functionCall.string('id') ?? `gemini:${this.round}:${this.roundParts.length - 1}:${position}`, name, argsJson: functionCall.raw('args') ?? '{}' };
  }

  /** The signature a client call shown now must carry, when the step's first (hidden) call had it and this one has none. */
  private signatureFor(part: ScannedObject): { key: string; rawValue: string } | null {
    const pending = this.pendingSignature;
    if (!pending || !functionCallOf(part)) return null;
    this.pendingSignature = null;
    return signatureKeyOf(part) ? null : pending;
  }

  streamEvent(event: RawSseEvent): Uint8Array[] {
    const json = event.json;
    if (!json) return [event.bytes];
    const root = json.root;
    const responseId = root.string('responseId');
    if (this.round === 1) this.firstResponseId ??= responseId ?? null;
    else if (responseId !== undefined && this.firstResponseId !== null) json.replace(['responseId'], encodeJsonString(this.firstResponseId));
    let removedSomething = false;
    const candidate = ScannedObject.of(root.bytes, root.elements('candidates')[0]);
    if (candidate) {
      const parts = objectElements(candidate.bytes, candidate.object('content')?.spanOf('parts'));
      const hiddenPositions = new Set<number>();
      parts.forEach((part, position) => {
        const hiddenCall = this.notePart(part, position);
        if (hiddenCall) {
          this.roundHiddenCalls.push(hiddenCall);
          hiddenPositions.add(position);
          return;
        }
        const signature = this.signatureFor(part);
        if (signature) json.set([...PARTS_PATH, position], signature.key, signature.rawValue);
        const text = part.string('text') ?? '';
        if (text !== '' && !part.isTrue('thought') && !functionCallOf(part)) {
          if (this.gapPending) {
            json.replace([...PARTS_PATH, position, 'text'], encodeJsonString(textAfterGap(text)));
            this.gapPending = false;
          }
          this.textSaid = true;
        }
      });
      if (hiddenPositions.size > 0) {
        json.removeElements(PARTS_PATH, (_span, position) => hiddenPositions.has(position));
        removedSomething = true;
      }
      const finishKey = candidate.spanOf('finishReason') ? 'finishReason' : candidate.spanOf('finish_reason') ? 'finish_reason' : null;
      if (finishKey && this.roundHiddenCalls.length > 0 && this.clientCalls === 0 && this.maySearchAgain) {
        this.withheldEnd = true;
        json.removeMember(['candidates', 0], finishKey);
        removedSomething = true;
      }
    }
    const usageKey = json.spanAt(['usageMetadata']) ? 'usageMetadata' : json.spanAt(['usage_metadata']) ? 'usage_metadata' : null;
    if (usageKey) {
      this.roundUsage = decodedUsage(rawText(json.bytes, json.spanAt([usageKey])!));
      const total = this.usage.hasEarlierRounds ? this.usage.totalWith(this.roundUsage) : null;
      if (total) json.replace([usageKey], JSON.stringify(total));
    }
    if (removedSomething) {
      const edited = json.root;
      const editedCandidate = ScannedObject.of(edited.bytes, edited.elements('candidates')[0]);
      const partsLeft = editedCandidate ? objectElements(edited.bytes, editedCandidate.object('content')?.spanOf('parts')).length : 0;
      const finishLeft = editedCandidate?.spanOf('finishReason', 'finish_reason') !== undefined;
      if (partsLeft === 0 && !finishLeft) return [];
    }
    return [eventWithJson(event, json)];
  }

  endStreamRound(): StitchRoundOutcome {
    const hiddenCalls = this.roundHiddenCalls;
    if (!this.withheldEnd) return { continues: false, hiddenCalls };
    this.usage.addRound(this.roundUsage);
    this.gapPending = this.textSaid;
    this.assistantPartsForNext = this.roundParts;
    return { continues: true, hiddenCalls };
  }

  wholeRound(json: Uint8Array): StitchRoundOutcome {
    const root = ScannedObject.of(json, scanDocument(json));
    if (!root) throw new Error('the reply is not a JSON object');
    this.firstResponseId ??= root.string('responseId') ?? null;
    const candidate = ScannedObject.of(json, root.elements('candidates')[0]);
    const parts = objectElements(json, candidate?.object('content')?.spanOf('parts'));
    parts.forEach((part, position) => {
      const raw = rawText(json, part.span);
      const hiddenCall = this.notePart(part, position);
      if (hiddenCall) {
        this.roundHiddenCalls.push(hiddenCall);
        return;
      }
      const edited = new EditableEventJson(raw);
      const signature = this.signatureFor(part);
      if (signature) edited.set([], signature.key, signature.rawValue);
      const text = part.string('text') ?? '';
      if (text !== '' && !part.isTrue('thought') && !functionCallOf(part)) {
        if (this.gapPending) {
          edited.replace(['text'], encodeJsonString(textAfterGap(text)));
          this.gapPending = false;
        }
        this.textSaid = true;
      }
      this.visibleWholeParts.push(edited.text());
    });
    const hiddenOnly = this.roundHiddenCalls.length > 0 && this.clientCalls === 0;
    const roundUsage = decodedUsage(root.raw('usageMetadata', 'usage_metadata'));
    this.lastWholeReply = json;
    this.lastWholeUsage = this.usage.totalWith(roundUsage);
    if (hiddenOnly && this.maySearchAgain) {
      this.usage.addRound(roundUsage);
      this.gapPending = this.textSaid;
      this.assistantPartsForNext = this.roundParts;
      return { continues: true, hiddenCalls: this.roundHiddenCalls };
    }
    return { continues: false, hiddenCalls: this.roundHiddenCalls };
  }

  mergedWholeReply(): Uint8Array {
    const reply = this.lastWholeReply;
    if (!reply) throw new Error('no round was read');
    if (this.round === 1 && !this.anyHiddenCall) return reply;
    const json = new EditableEventJson(utf8Decoder.decode(reply));
    json.replace(PARTS_PATH, `[${this.visibleWholeParts.join(',')}]`);
    const usageKey = json.spanAt(['usageMetadata']) ? 'usageMetadata' : json.spanAt(['usage_metadata']) ? 'usage_metadata' : null;
    if (usageKey && this.lastWholeUsage) json.replace([usageKey], JSON.stringify(this.lastWholeUsage));
    if (this.firstResponseId !== null) json.replace(['responseId'], encodeJsonString(this.firstResponseId));
    return json.bytes;
  }

  nextRequestBody(previousBody: Uint8Array, results: HiddenToolResult[]): Uint8Array {
    const { span: contentsSpan } = rootMember(previousBody, 'contents');
    if (contentsSpan?.type !== 'array') throw new Error('the request has no contents array');
    const model = `{"role":"model","parts":[${this.assistantPartsForNext.join(',')}]}`;
    const responses = results.map(result => {
      const id = result.call.callId.startsWith('gemini:') ? '' : `,"id":${encodeJsonString(result.call.callId)}`;
      const response = result.isError ? `{"error":${encodeJsonString(result.text)}}` : `{"output":${encodeJsonString(result.text)}}`;
      return `{"functionResponse":{"name":${encodeJsonString(result.call.name)}${id},"response":${response}}}`;
    });
    const user = `{"role":"user","parts":[${responses.join(',')}]}`;
    return appendArrayItems(previousBody, contentsSpan, [model, user]);
  }

  keepalive(): null {
    return null;
  }

  errorJson(message: string): string {
    return `{"error":{"code":502,"message":${encodeJsonString(message)},"status":"UNAVAILABLE"}}`;
  }

  errorEvent(message: string): Uint8Array {
    return utf8Encoder.encode(`data: ${this.errorJson(message)}\n\n`);
  }
}
