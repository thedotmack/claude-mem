// SPDX-License-Identifier: Apache-2.0
//
// An exchange the gateway did not relay — a magpie recording line, a GenAI
// semantic-conventions span — as the wire IR the assembler reads (plan
// Phase 13 tasks 2–3). These sources name messages and parts, not bytes, so
// the request has no body and its spans point nowhere: only the relay's
// rewrite stages read spans, and they never see these.
//
// Call ids. magpie's recorder keeps a tool call's name and arguments but not
// its id (internal/sessions/content.go:18-24: Part{role, kind, name, text}),
// and a GenAI part's id is optional. A call without one gets an id derived
// from the scope (agent, session), its name, its arguments and how many
// identical calls came before it in the history. Every magpie line replays
// the whole history, so a call keeps its id from line to line, and the
// assembler observes its result once. A result without an id answers the
// oldest call still unanswered (of the same tool when the result names one).

import { createHash } from 'crypto';
import type { JsonSpan } from '../json/scanner.js';
import type { WireProtocol } from '../relay/protocols.js';
import {
  emptyWireUsage,
  type WireMessage,
  type WireMessageRole,
  type WirePart,
  type WireReply,
  type WireRequest,
  type WireToolCall,
  type WireUsage,
} from '../ir/types.js';

export type ForeignPartKind = 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'image' | 'context';

export interface ForeignPart {
  kind: ForeignPartKind;
  text?: string;
  /** tool_call: the tool; tool_result: the tool, when the source names it. */
  name?: string;
  /** tool_call: its id; tool_result: the id of the call it answers. Absent when the source has none. */
  callId?: string;
  /** tool_call: the arguments as JSON text. */
  argsJson?: string;
  hasImages?: boolean;
  isError?: boolean;
}

export type ForeignRole = WireMessageRole | 'tool';

export interface ForeignMessage {
  role: ForeignRole;
  parts: ForeignPart[];
}

/** Where a foreign request's parts sit: nowhere (it has no body). */
const NO_SPAN: JsonSpan = { start: 0, end: 0, type: 'object' };

/** Which protocol a foreign request is labelled with; it only matters to Codex metadata lookups, which these never carry. */
const FOREIGN_REQUEST_PROTOCOL: WireProtocol = 'openai-chat';

function sha256Hex(...fields: string[]): string {
  const hash = createHash('sha256');
  fields.forEach((field, index) => {
    if (index > 0) hash.update('\u0000');
    hash.update(field);
  });
  return hash.digest('hex');
}

/** Gives calls without an id a stable one and pairs id-less results with their calls, in history order. */
class CallIdPairing {
  private readonly occurrencesByCall = new Map<string, number>();
  private readonly unanswered: Array<{ callId: string; name: string }> = [];

  constructor(private readonly idPrefix: string, private readonly scope: readonly string[]) {}

  idForCall(name: string, argsJson: string, callId: string | undefined): string {
    let id = callId;
    if (!id) {
      const callKey = sha256Hex(name, argsJson);
      const occurrence = this.occurrencesByCall.get(callKey) ?? 0;
      this.occurrencesByCall.set(callKey, occurrence + 1);
      id = `${this.idPrefix}-${sha256Hex(...this.scope, name, argsJson, String(occurrence)).slice(0, 32)}`;
    }
    this.unanswered.push({ callId: id, name });
    return id;
  }

  idForResult(name: string | undefined, callId: string | undefined): string | undefined {
    if (callId) {
      const index = this.unanswered.findIndex(call => call.callId === callId);
      if (index >= 0) this.unanswered.splice(index, 1);
      return callId;
    }
    let index = name ? this.unanswered.findIndex(call => call.name === name) : -1;
    if (index < 0) index = this.unanswered.length > 0 ? 0 : -1;
    if (index < 0) return undefined;
    return this.unanswered.splice(index, 1)[0].callId;
  }
}

function wirePartOf(part: ForeignPart, pairing: CallIdPairing): WirePart {
  switch (part.kind) {
    case 'tool_call': {
      const argsJson = part.argsJson ?? '{}';
      return { kind: 'tool_call', name: part.name ?? '', argsJson, callId: pairing.idForCall(part.name ?? '', argsJson, part.callId), span: NO_SPAN };
    }
    case 'tool_result': {
      const wirePart: WirePart = { kind: 'tool_result', text: part.text ?? '', span: NO_SPAN };
      const callId = pairing.idForResult(part.name, part.callId);
      if (callId !== undefined) wirePart.callId = callId;
      if (part.name) wirePart.name = part.name;
      if (part.hasImages) wirePart.hasImages = true;
      if (part.isError) wirePart.isError = true;
      return wirePart;
    }
    case 'context':
      // What an agent put in as the user reads as text here, as on the wire: the
      // identity helpers tell the user's words from the agent's (user-words.ts).
      return { kind: 'text', text: part.text ?? '', span: NO_SPAN };
    default:
      return { kind: part.kind, text: part.text ?? '', span: NO_SPAN };
  }
}

export interface ForeignExchangeInput {
  /** System instructions, in order. */
  system: string[];
  /** The conversation the request carried (tool results under role `tool` or `user`). */
  messages: ForeignMessage[];
  /** What the reply said, in order (assistant parts). Null when there was no reply. */
  output: ForeignPart[] | null;
  model: string;
  /** The reply's HTTP status (200 when the source has none). */
  status: number;
  /** The source cut the exchange short (magpie `cut`, a body cut at its capture limit). */
  cut: boolean;
  usage?: WireUsage;
  /** Scopes derived call ids: the agent and session. */
  callIdScope: readonly string[];
  /** Prefix of derived call ids (`magpie`, `otlp`). */
  callIdPrefix: string;
}

export interface ForeignExchange {
  request: WireRequest;
  reply: WireReply | null;
  /** The reply was whole and not an error (the assembler then keeps its text and calls). */
  replyIsWhole: boolean;
}

/** The request and reply a foreign exchange stands for. */
export function foreignExchangeOf(input: ForeignExchangeInput): ForeignExchange {
  const pairing = new CallIdPairing(input.callIdPrefix, input.callIdScope);
  const messages: WireMessage[] = [];
  const system: WirePart[] = input.system.filter(text => text !== '').map(text => ({ kind: 'text', text, span: NO_SPAN }));
  for (const message of input.messages) {
    if (message.role === 'system') {
      for (const part of message.parts) if (part.text) system.push({ kind: 'text', text: part.text, span: NO_SPAN });
      continue;
    }
    // A tool's result is the user's side of the conversation, as Anthropic and Gemini carry it.
    const role: WireMessageRole = message.role === 'tool' ? 'user' : message.role;
    const parts = message.parts.map(part => wirePartOf(part, pairing));
    if (parts.length === 0) continue;
    const previous = messages.at(-1);
    // Consecutive parts of one side are one message, so words beside results still start a turn.
    if (previous && previous.role === role) previous.parts.push(...parts);
    else messages.push({ role, parts, span: NO_SPAN });
  }
  const request: WireRequest = {
    protocol: FOREIGN_REQUEST_PROTOCOL,
    body: new Uint8Array(0),
    model: input.model,
    stream: false,
    system,
    tools: [],
    messages,
  };
  if (input.output === null) return { request, reply: null, replyIsWhole: false };

  const toolCalls: WireToolCall[] = [];
  const texts: string[] = [];
  const thinking: string[] = [];
  const errors: string[] = [];
  for (const part of input.output) {
    if (part.kind === 'tool_call') {
      const argsJson = part.argsJson ?? '{}';
      toolCalls.push({ id: pairing.idForCall(part.name ?? '', argsJson, part.callId), name: part.name ?? '', argsJson });
    } else if (part.kind === 'thinking') {
      if (part.text) thinking.push(part.text);
    } else if (part.kind === 'context') {
      // magpie writes a reply's error as a context part (conversations.go `c.err`).
      if (part.text) errors.push(part.text);
    } else if (part.kind === 'text' && part.text) {
      texts.push(part.text);
    }
  }
  const failed = input.status >= 400 || errors.length > 0;
  const reply: WireReply = {
    text: texts.join(''),
    toolCalls,
    thinking: thinking.join(''),
    usage: input.usage ?? emptyWireUsage(),
    stop: toolCalls.length > 0 ? 'tool' : (failed || input.cut ? null : 'stop'),
    endedCleanly: !input.cut && !failed,
  };
  if (input.model) reply.model = input.model;
  if (errors.length > 0) reply.error = errors.join('\n');
  return { request, reply, replyIsWhole: reply.endedCleanly };
}

export type JsonTextParse = { ok: true; value: unknown } | { ok: false; error: string };

/** What a text that is not JSON is said to be. JSON.parse's own message quotes the text it stopped at, which can be a secret, and the reason reaches logs. */
export const NOT_JSON_REASON = 'not valid JSON';

/** JSON text parsed, or that it is not JSON: the sources here send text that may or may not be JSON, and the caller decides what each means. */
export function parseJsonText(text: string): JsonTextParse {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    // Only a SyntaxError means "not JSON"; anything else is thrown on.
    if (!(error instanceof SyntaxError)) throw error;
    // [ANTI-PATTERN IGNORED]: not swallowed; that it is not JSON is returned to the caller, which reports or branches on it.
    return { ok: false, error: NOT_JSON_REASON };
  }
}
