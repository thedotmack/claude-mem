// SPDX-License-Identifier: Apache-2.0
//
// The id each tool call's observation was captured under, so Endless Mode
// can ask the worker about it: the call id, or, for a Gemini call with only
// a positional id, the id the capture assembler derives from the call and
// its result (toolUseIdOfResult). Counted over every result in order, as
// the assembler counts them, so derived ids match its.

import { toolUseIdOfResult } from '../capture/capture-assembler.js';
import type { WirePart, WireRequest } from '../ir/types.js';

/** Call id → the id its observation is looked up by, for every call whose result is in the request too. */
export function toolUseIdsByCallIdOf(request: WireRequest): Map<string, string> {
  const callsById = new Map<string, WirePart>();
  const derivedIdOccurrences = new Map<string, number>();
  const toolUseIdByCallId = new Map<string, string>();
  for (const message of request.messages) {
    for (const part of message.parts) {
      if (part.kind === 'tool_call' && part.callId) {
        callsById.set(part.callId, part);
        continue;
      }
      if (part.kind !== 'tool_result') continue;
      const call = part.callId ? callsById.get(part.callId) : undefined;
      const toolName = call?.name || part.name || '';
      const resultText = (part.text ?? '') + (part.hasImages ? '\n[image]' : '');
      const toolUseId = toolUseIdOfResult({ callId: part.callId, toolName, argsText: call?.argsJson ?? '{}', resultText }, derivedIdOccurrences);
      if (part.callId && call) toolUseIdByCallId.set(part.callId, toolUseId);
    }
  }
  return toolUseIdByCallId;
}
