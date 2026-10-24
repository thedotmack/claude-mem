// SPDX-License-Identifier: Apache-2.0
//
// Where each tool result's content sits in a request, per protocol (plan
// Phase 11 task 4), in the manner of magpie's per-protocol image walker
// (internal/gateway/image_input.go:53-259, MIT, Copyright (c) 2026 yetone):
// only the CONTENT VALUE is ever replaced, so the result keeps its id, its
// place and its pairing with its call.
//
// - Anthropic: `tool_result.content` (a string or blocks)
// - OpenAI Chat: a `role:"tool"` message's `content`
// - OpenAI Responses: `function_call_output.output` / `custom_tool_call_output.output`
// - Gemini: `functionResponse.response`

import { toolUseIdOfResult } from '../capture/capture-assembler.js';
import { startsUserTurn } from '../identity/turn-start.js';
import { ScannedObject, objectElements } from '../ir/scanned-object.js';
import type { WirePart, WireRequest } from '../ir/types.js';
import type { JsonSpan } from '../json/scanner.js';
import type { WireProtocol } from '../relay/protocols.js';

export interface ToolResultSite {
  /** Where the result sits in request.messages. */
  messageIndex: number;
  /** Its call's id, as the wire carries it (what the ledger keys its swap by). */
  callId: string;
  /** The id its observation was captured under (the call id, or a derived Gemini id). */
  toolUseId: string;
  toolName: string;
  /** The content value: the span a swap replaces. */
  contentSpan: JsonSpan;
  /** The result's text as the IR read it. */
  text: string;
  isError: boolean;
  hasImages: boolean;
  /** The content carries a cache breakpoint of its own (Anthropic blocks), which a swap would lose. */
  hasCacheControl: boolean;
  /** User turns begun after this result: its age. */
  userTurnsAfter: number;
}

const RESPONSES_OUTPUT_ITEM_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

/** The span of a tool result part's content value, or null when it has none the stage may replace. */
function contentSpanOf(protocol: WireProtocol, bytes: Uint8Array, part: WirePart): JsonSpan | null {
  const holder = ScannedObject.of(bytes, part.span);
  if (!holder) return null;
  switch (protocol) {
    case 'anthropic':
      return holder.string('type') === 'tool_result' ? holder.spanOf('content') ?? null : null;
    case 'openai-chat':
      return holder.string('role') === 'tool' ? holder.spanOf('content') ?? null : null;
    case 'openai-responses':
      return RESPONSES_OUTPUT_ITEM_TYPES.has(holder.string('type') ?? '') ? holder.spanOf('output') ?? null : null;
    case 'gemini': {
      const responseSpan = holder.object('functionResponse', 'function_response')?.spanOf('response');
      return responseSpan?.type === 'object' ? responseSpan : null;
    }
  }
}

function contentHasCacheControl(bytes: Uint8Array, contentSpan: JsonSpan): boolean {
  return objectElements(bytes, contentSpan).some(block => block.spanOf('cache_control') !== undefined);
}

/**
 * Every tool result of `request` whose call is in the request too (pair
 * discipline: beta-release save-hook.ts:319-379 replaced only results whose
 * call it also saw), in order.
 */
export function toolResultSitesOf(request: WireRequest): ToolResultSite[] {
  const turnStartIndexes: number[] = [];
  request.messages.forEach((message, messageIndex) => {
    if (startsUserTurn(message)) turnStartIndexes.push(messageIndex);
  });
  const callsById = new Map<string, WirePart>();
  const derivedIdOccurrences = new Map<string, number>();
  const sites: ToolResultSite[] = [];
  request.messages.forEach((message, messageIndex) => {
    for (const part of message.parts) {
      if (part.kind === 'tool_call' && part.callId) {
        callsById.set(part.callId, part);
        continue;
      }
      if (part.kind !== 'tool_result') continue;
      const call = part.callId ? callsById.get(part.callId) : undefined;
      const toolName = call?.name || part.name || '';
      const resultText = (part.text ?? '') + (part.hasImages ? '\n[image]' : '');
      // Counted for every result, as the assembler counts them, so derived ids match its.
      const toolUseId = toolUseIdOfResult({ callId: part.callId, toolName, argsText: call?.argsJson ?? '{}', resultText }, derivedIdOccurrences);
      if (!part.callId || !call) continue;
      const contentSpan = contentSpanOf(request.protocol, request.body, part);
      if (!contentSpan) continue;
      sites.push({
        messageIndex,
        callId: part.callId,
        toolUseId,
        toolName,
        contentSpan,
        text: part.text ?? '',
        isError: part.isError === true,
        hasImages: part.hasImages === true,
        hasCacheControl: request.protocol === 'anthropic' && contentHasCacheControl(request.body, contentSpan),
        userTurnsAfter: turnStartIndexes.filter(turnStartIndex => turnStartIndex > messageIndex).length,
      });
    }
  });
  return sites;
}

/** The index of the latest message that begins a user turn; -1 when none does. */
export function latestUserTurnStartIndex(request: WireRequest): number {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex--) {
    if (startsUserTurn(request.messages[messageIndex])) return messageIndex;
  }
  return -1;
}
