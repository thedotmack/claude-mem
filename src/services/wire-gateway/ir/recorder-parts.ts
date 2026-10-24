// SPDX-License-Identifier: Apache-2.0
//
// A request and its reply as recorder parts (plan Phase 3 task 6), in the
// shape magpie's session reader takes (sessions.Part, internal/sessions/
// content.go:18-24). Ported from magpie `conversationParts` and
// `conversationTurn` (internal/gateway/conversations.go:93-201, MIT,
// Copyright (c) 2026 yetone). Bounds (`cut`) and scrubbing are applied by
// the recorder that stores them (Phases 5 and 6).

import { rawText } from '../json/scanner.js';
import type { WireMessageRole, WirePart, WireReply, WireRequest } from './types.js';
import { isAgentContextText } from '../identity/user-words.js';

export type WireRecorderPartRole = WireMessageRole | 'tool';

/** text, thinking, tool_use, tool_result, context or image (magpie sessions.Part.Kind). */
export type WireRecorderPartKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'context' | 'image';

export interface WireRecorderPart {
  role: WireRecorderPartRole;
  kind: WireRecorderPartKind;
  name?: string;
  text: string;
  /** Characters left off the end, when the recorder cut the part. */
  cut?: number;
}

export interface WireRecorderTurnParts {
  input: WireRecorderPart[];
  output: WireRecorderPart[];
}

function recorderPartOf(role: WireMessageRole, part: WirePart): WireRecorderPart | null {
  let recorderPart: WireRecorderPart;
  switch (part.kind) {
    case 'text':
      // What the agent put in as the user (a <…> reminder, Codex's AGENTS.md)
      // is context, not words said. magpie applies this only in its session
      // file readers; the wire recorder applies it on purpose (plan Phase 4 task 6).
      recorderPart = { role, kind: role !== 'assistant' && isAgentContextText(part.text ?? '') ? 'context' : 'text', text: part.text ?? '' };
      break;
    case 'thinking':
      recorderPart = { role, kind: 'thinking', text: part.text ?? '' };
      break;
    case 'sealed':
      // Nothing readable: magpie's empty-text rule drops it.
      return null;
    case 'tool_call':
      recorderPart = { role, kind: 'tool_use', name: part.name, text: part.argsJson ?? '{}' };
      break;
    case 'tool_result':
      recorderPart = { role: 'tool', kind: 'tool_result', name: part.name, text: (part.text ?? '') + (part.hasImages ? '\n[image]' : '') };
      break;
    case 'image':
      recorderPart = { role, kind: 'image', text: '[image]' };
      break;
    case 'file':
      recorderPart = { role, kind: 'context', text: part.text ?? '' };
      break;
    case 'context':
      recorderPart = { role, kind: 'context', name: part.name, text: part.text ?? '' };
      break;
  }
  if (recorderPart.name === undefined) delete recorderPart.name;
  return recorderPart.text === '' ? null : recorderPart;
}

/** The request's input and the reply's output as recorder parts (empty parts are dropped). */
export function toRecorderParts(request: WireRequest, reply: WireReply): WireRecorderTurnParts {
  const input: WireRecorderPart[] = [];
  const systemText = request.system.map(part => part.text ?? '').filter(text => text !== '').join('\n\n');
  if (systemText !== '') input.push({ role: 'system', kind: 'context', name: 'System prompt', text: systemText });
  // Tool definitions are kept as context, as they were sent.
  if (request.toolsSpan) input.push({ role: 'system', kind: 'context', name: 'Tools', text: rawText(request.body, request.toolsSpan) });
  for (const message of request.messages) {
    for (const part of message.parts) {
      const recorderPart = recorderPartOf(message.role, part);
      if (recorderPart) input.push(recorderPart);
    }
  }

  const output: WireRecorderPart[] = [];
  if (reply.thinking !== '') output.push({ role: 'assistant', kind: 'thinking', text: reply.thinking });
  if (reply.text !== '') output.push({ role: 'assistant', kind: 'text', text: reply.text });
  for (const call of reply.toolCalls) {
    output.push({ role: 'assistant', kind: 'tool_use', name: call.name, text: call.argsJson });
  }
  if (reply.error !== undefined) output.push({ role: 'assistant', kind: 'context', text: reply.error });
  return { input, output };
}
