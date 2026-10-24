// SPDX-License-Identifier: Apache-2.0
//
// The wire IR (plan Phase 3 task 2): one shape for a request and its reply in
// any of the four protocols. Unlike magpie's IR (internal/gateway/ir.go,
// MIT, Copyright (c) 2026 yetone) it is read-only: there is no IR→bytes
// encoder, because the gateway never translates. Every request part keeps
// its byte span in the decoded request body so later phases can splice it.

import type { JsonSpan } from '../json/scanner.js';
import type { WireProtocol } from '../relay/protocols.js';

export type WirePartKind =
  | 'text'
  | 'image'
  | 'file'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  /** Reasoning with no readable text, only a vendor's sealed bytes. */
  | 'sealed'
  /** Something the agent or harness placed in the conversation that is not a turn of words (Codex compaction items, a developer note after a reply). */
  | 'context';

/** Whose seal a part carries. Bytes with a seal are never edited (plan D7.6). */
export type WireSealOwner = 'anthropic' | 'openai-responses' | 'gemini';

export interface WirePart {
  kind: WirePartKind;
  text?: string;
  /** tool_call: the call's id; tool_result: the id of the call it answers. */
  callId?: string;
  /** tool_call: the tool; tool_result: the tool when the wire names it (Gemini); context: the item type it came from. */
  name?: string;
  /** tool_call: the arguments as JSON text, exactly as the wire carried them. */
  argsJson?: string;
  /** tool_result: the tool said it failed. */
  isError?: boolean;
  /** tool_result: the result carried images beside its text. */
  hasImages?: boolean;
  /** The part carries a signature, encrypted content or a redacted block. */
  sealedBy?: WireSealOwner;
  /** Where the part sits in the decoded request body. */
  span: JsonSpan;
}

export type WireMessageRole = 'user' | 'assistant' | 'system';

export interface WireMessage {
  role: WireMessageRole;
  parts: WirePart[];
  /**
   * Where the message sits. A message joined from consecutive items (a
   * Responses turn is one item per part) spans from the first item's start
   * to the last item's end.
   */
  span: JsonSpan;
}

export interface WireToolDefinition {
  name: string;
  span: JsonSpan;
}

export interface WireRequest {
  protocol: WireProtocol;
  /** The decoded request body the spans point into. */
  body: Uint8Array;
  model: string;
  stream: boolean;
  system: WirePart[];
  tools: WireToolDefinition[];
  /** The whole `tools` array (Gemini: `tools` too), when there is one. */
  toolsSpan?: JsonSpan;
  messages: WireMessage[];
  /** max_tokens / max_completion_tokens / max_output_tokens / maxOutputTokens, when sent. */
  maxOutputTokens?: number;
  /** OpenAI `prompt_cache_key` (Codex sends its thread id; OpenCode a `ses_` id). */
  cacheKey?: string;
  /** Responses `client_metadata`, as raw JSON text. */
  clientMetadata?: string;
  /** Anthropic `metadata`, as raw JSON text (Claude Code's user_id). */
  metadata?: string;
}

export interface WireToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface WireUsage {
  /** Prompt tokens neither read from nor written to a cache (Anthropic's `input_tokens` sense). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of cacheWriteTokens, those kept for an hour. */
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  /** What this reply counted of earlier requests (magpie's `magpie_deferred`). */
  deferred?: Omit<WireUsage, 'deferred'>;
}

/** Why the model stopped, normalized as magpie does: stop | length | tool | filter. */
export type WireStopReason = 'stop' | 'length' | 'tool' | 'filter';

export interface WireReply {
  /** Every text part, joined in order. */
  text: string;
  toolCalls: WireToolCall[];
  /** Readable reasoning, joined in order. */
  thinking: string;
  usage: WireUsage;
  /** Null when the reply never said why it ended. */
  stop: WireStopReason | null;
  /** The upstream's model, when the reply named it. */
  model?: string;
  /** What an error the reply carried said (an `error` event after HTTP 200, or an error body). */
  error?: string;
  /** The reply reached its protocol's end (the Phase 2 end markers, or a whole JSON body) without an error. */
  endedCleanly: boolean;
}

export function emptyWireUsage(): WireUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 };
}
