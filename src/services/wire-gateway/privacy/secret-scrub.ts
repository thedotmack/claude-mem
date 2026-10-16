// SPDX-License-Identifier: Apache-2.0
//
// The on-disk scrub for wire capture (plan Phase 6 task 2): always on, and
// independent of CLAUDE_MEM_REDACT_ENABLED. What the gateway keeps (recorded
// turns, spooled capture events) has its secrets gone for good, as
// `[REDACTED:KIND]`; a field named for a secret is replaced whole by
// `[REDACTED]`. No placeholder is ever written to disk. Ported from magpie's
// `ScrubJSON` (internal/redact/scrub.go:1-78, MIT, Copyright (c) 2026 yetone).
// The hook path is untouched: it keeps its own opt-in redaction.

import type { HookSpoolKind, HookSpoolPayloadByKind } from '../../../shared/hook-spool.js';
import { SECRET_NAMED_FIELD_MARKER, isSecretFieldName, scrubSecretsToKindMarkers } from '../../../utils/redaction.js';
import { rewriteJsonStringsInText } from '../json/string-walker.js';
import type { WireRecorderPart } from '../ir/recorder-parts.js';

/** A string under `key`, scrubbed: an encoded data: value is kept, a secret-named field goes whole. */
function scrubKeyedString(key: string, value: string): string {
  if (value.startsWith('data:')) return value;
  if (key !== '' && isSecretFieldName(key)) return SECRET_NAMED_FIELD_MARKER;
  return scrubSecretsToKindMarkers(value);
}

function scrubJsonText(text: string): { ok: boolean; text: string } {
  return rewriteJsonStringsInText(text, (_path, key, value) => scrubKeyedString(key, value));
}

/**
 * A text with its secrets taken out: a JSON one string by string; a stream's
 * `data:` lines each as JSON; anything else as text (magpie `ScrubJSON`).
 */
export function scrubWireText(text: string): string {
  if (text === '') return text;
  const asJson = scrubJsonText(text);
  if (asJson.ok) return asJson.text;
  if (!text.includes('data:')) return scrubSecretsToKindMarkers(text);
  // Split after each newline, keeping it (Go strings.SplitAfter).
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return lines.map(line => {
    if (line.startsWith('data:')) {
      const rest = line.slice('data:'.length);
      const trimmed = rest.trim();
      const lineEnding = line.slice(line.replace(/[\r\n]+$/, '').length);
      if (trimmed !== '') {
        const scrubbedData = scrubJsonText(trimmed);
        if (scrubbedData.ok) return `data: ${scrubbedData.text}${lineEnding}`;
      }
    }
    return scrubSecretsToKindMarkers(line);
  }).join('');
}

/** A structured value (a tool's input) with every string in it scrubbed; secret-named fields go whole. */
export function scrubWireStructuredValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return key === '' ? scrubWireText(value) : scrubKeyedString(key, value);
  if (Array.isArray(value)) return value.map(element => scrubWireStructuredValue(element, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrubWireStructuredValue(child, childKey)]));
  }
  return value;
}

/** One recorder part with its text (and name) scrubbed. */
export function scrubWireRecorderPart(part: WireRecorderPart): WireRecorderPart {
  const scrubbed: WireRecorderPart = { ...part, text: scrubWireText(part.text) };
  if (part.name !== undefined) scrubbed.name = scrubSecretsToKindMarkers(part.name);
  return scrubbed;
}

/**
 * A spooled capture event with its content scrubbed: the prompt, the tool's
 * input and response, and the last assistant message. Ids, names and places
 * are kept as they are.
 */
export function scrubWireSpoolPayload<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]): HookSpoolPayloadByKind[K] {
  switch (kind) {
    case 'session_init': {
      const sessionInit = payload as HookSpoolPayloadByKind['session_init'];
      if (sessionInit.prompt === undefined) return payload;
      return { ...sessionInit, prompt: scrubWireText(sessionInit.prompt) } as HookSpoolPayloadByKind[K];
    }
    case 'observation':
    case 'file_edit': {
      const observation = payload as HookSpoolPayloadByKind['observation'];
      const scrubbed = { ...observation };
      if (observation.toolInput !== undefined) scrubbed.toolInput = scrubWireStructuredValue(observation.toolInput);
      if (observation.toolResponse !== undefined) scrubbed.toolResponse = scrubWireStructuredValue(observation.toolResponse);
      return scrubbed as HookSpoolPayloadByKind[K];
    }
    case 'summarize': {
      const summarize = payload as HookSpoolPayloadByKind['summarize'];
      return { ...summarize, lastAssistantMessage: scrubWireText(summarize.lastAssistantMessage) } as HookSpoolPayloadByKind[K];
    }
    default:
      return payload;
  }
}
