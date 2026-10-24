// SPDX-License-Identifier: Apache-2.0
//
// Session ids (plan Phase 4 task 2). The header list and the 128-byte cap
// follow magpie `sessionOf` (internal/gateway/gateway.go:5421-5451, MIT,
// Copyright (c) 2026 yetone), with Codex's `thread-id` added (magpie's list
// lacks it). magpie reads no session id from a body; the body ids here are
// new, backed by magpie's captured fixtures (claude-code-2.1.296,
// codex-0.162.x, opencode2_responses_tools).

import { createHash } from 'crypto';
import type { WireRequest } from '../ir/types.js';
import type { CodexTurnMetadata } from './codex-turn-metadata.js';
import { utf8CutIndex } from '../../../shared/utf8-cut.js';

/** A session the client names to claude-mem itself; also echoed back on the response. */
export const CLAUDE_MEM_SESSION_HEADER = 'x-claude-mem-session';

/** Where agents already name their conversation, in precedence order. */
export const AGENT_SESSION_HEADERS: readonly string[] = [
  'x-claude-code-session-id',
  'x-opencode-session',
  'x-session-affinity',
  'x-session-id',
  'session_id',
  'session-id',
  'thread-id',
];

export const MAX_SESSION_ID_BYTES = 128;

// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Cut text to at most maxBytes of UTF-8, never inside a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  return utf8Decoder.decode(bytes.subarray(0, utf8CutIndex(bytes, maxBytes)));
}

/**
 * A usable id from a header or body value: trimmed, refused (undefined) when
 * empty or holding a control character, and capped at 128 bytes.
 */
export function cleanSessionId(rawValue: string | null | undefined): string | undefined {
  const trimmed = (rawValue ?? '').trim();
  if (trimmed === '' || CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;
  return truncateUtf8(trimmed, MAX_SESSION_ID_BYTES);
}

/** The first usable id among the agent session headers. */
export function sessionIdFromAgentHeaders(headers: Headers): string | undefined {
  for (const headerName of AGENT_SESSION_HEADERS) {
    const sessionId = cleanSessionId(headers.get(headerName));
    if (sessionId) return sessionId;
  }
  return undefined;
}

/** Claude Code's `metadata.user_id` is a JSON *string* holding `{device_id, account_uuid, session_id}`. */
function claudeCodeSessionIdFromMetadata(metadataJson: string | undefined): string | undefined {
  if (!metadataJson) return undefined;
  try {
    const metadata: unknown = JSON.parse(metadataJson);
    const userId = (metadata as { user_id?: unknown } | null)?.user_id;
    if (typeof userId !== 'string') return undefined;
    const userFields: unknown = JSON.parse(userId);
    const sessionId = (userFields as { session_id?: unknown } | null)?.session_id;
    return typeof sessionId === 'string' ? cleanSessionId(sessionId) : undefined;
  } catch {
    return undefined;
  }
}

const OPENCODE_SESSION_KEY_PREFIX = 'ses_';

/**
 * A session id the body names:
 * - Claude Code `metadata.user_id` → `session_id`
 * - Codex `client_metadata.thread_id`/`session_id`, or those of `client_metadata["x-codex-turn-metadata"]`
 * - OpenCode `prompt_cache_key` starting `ses_`
 */
export function sessionIdFromRequestBody(request: WireRequest, codexMetadata: CodexTurnMetadata): string | undefined {
  return claudeCodeSessionIdFromMetadata(request.metadata)
    ?? cleanSessionId(codexMetadata.threadId)
    ?? cleanSessionId(codexMetadata.sessionId)
    ?? (request.cacheKey?.startsWith(OPENCODE_SESSION_KEY_PREFIX) ? cleanSessionId(request.cacheKey) : undefined);
}

const FINGERPRINT_SESSION_PREFIX = 'wire-';
const FINGERPRINT_HEX_LENGTH = 24;

/**
 * The last resort: `wire-` + hex(sha256(agentId ‖ 0x00 ‖ firstUserWords))[0:24].
 * Only the user's own words are hashed, so an edited instruction file never
 * splits a session. Never used for recording in shared mode (Phase 16).
 */
export function fingerprintSessionId(agentId: string, firstUserWords: string): string {
  const digest = createHash('sha256').update(agentId).update('\u0000').update(firstUserWords).digest('hex');
  return FINGERPRINT_SESSION_PREFIX + digest.slice(0, FINGERPRINT_HEX_LENGTH);
}
