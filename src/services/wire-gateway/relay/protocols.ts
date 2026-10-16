// SPDX-License-Identifier: Apache-2.0
//
// What a relayed request speaks, how each protocol says "error", and how each
// protocol's stream says it is over (plan Phase 2 tasks 2, 6, 7).

/** The four captured wire protocols; null for a transparent, uncaptured relay. */
export type WireProtocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';

export interface RelayClassification {
  /** The protocol the suffix speaks, or null for "anything else" (/v1/models, HEAD /api/hello, …). */
  protocol: WireProtocol | null;
  /** Whether a later phase may record this exchange. count_tokens and compact are relay-only. */
  captured: boolean;
}

// Gemini: …/models/{model}:generateContent and :streamGenerateContent
// (report 07 §2.6). The model segment never holds a slash.
const GEMINI_GENERATE_PATH = /\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/;

/**
 * Classify a route suffix (the path after /r/<routeId>, query excluded).
 * Claude Code posts /v1/messages?beta=true, so only the path is matched
 * (report 07 §2.3, "Match on the path").
 */
export function classifyRelaySuffix(suffixPath: string): RelayClassification {
  if (suffixPath.endsWith('/v1/messages/count_tokens')) return { protocol: 'anthropic', captured: false };
  if (suffixPath.endsWith('/v1/messages')) return { protocol: 'anthropic', captured: true };
  if (suffixPath.endsWith('/chat/completions')) return { protocol: 'openai-chat', captured: true };
  if (suffixPath.endsWith('/responses/compact')) return { protocol: 'openai-responses', captured: false };
  if (suffixPath.endsWith('/responses')) return { protocol: 'openai-responses', captured: true };
  if (GEMINI_GENERATE_PATH.test(suffixPath)) return { protocol: 'gemini', captured: true };
  return { protocol: null, captured: false };
}

/** Which vendor's error envelope a reply should use. */
export type ErrorEnvelopeFamily = 'anthropic' | 'openai' | 'gemini';

export function errorEnvelopeFamilyOf(protocol: WireProtocol | null): ErrorEnvelopeFamily {
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'gemini') return 'gemini';
  return 'openai';
}

// Anthropic status → error.type (report 07 §2.1 "Errors").
const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  408: 'timeout_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'overloaded_error',
  504: 'timeout_error',
};

// Google API status names (google.rpc.Code), as Gemini's error body carries them.
const GEMINI_ERROR_STATUSES: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  408: 'DEADLINE_EXCEEDED',
  413: 'INVALID_ARGUMENT',
  500: 'INTERNAL',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
};

// OpenAI error.type by status (report 07 §2.4 "Errors"; the envelope is from its examples).
const OPENAI_ERROR_TYPES: Record<number, string> = {
  400: 'invalid_request_error',
  403: 'invalid_request_error',
  404: 'invalid_request_error',
  408: 'invalid_request_error',
  413: 'invalid_request_error',
  500: 'server_error',
  502: 'server_error',
  503: 'service_unavailable_error',
};

export interface GatewayErrorDetails {
  status: number;
  message: string;
  /** OpenAI's machine-readable `code`; also used as the Anthropic `type` when given there. */
  openAiCode?: string;
  /** Extra response headers (e.g. `connection: close` after an unread body). */
  headers?: Record<string, string>;
}

/**
 * A gateway-made error in the client's own protocol, so an agent shows the
 * message instead of choking on a foreign shape:
 * - Anthropic `{"type":"error","error":{"type","message"}}`
 * - OpenAI `{"error":{"type","code","message"}}`
 * - Gemini `{"error":{"code","message","status"}}`
 */
export function protocolErrorResponse(family: ErrorEnvelopeFamily, details: GatewayErrorDetails): Response {
  const { status, message } = details;
  let body: unknown;
  if (family === 'anthropic') {
    body = { type: 'error', error: { type: ANTHROPIC_ERROR_TYPES[status] ?? 'api_error', message } };
  } else if (family === 'gemini') {
    body = { error: { code: status, message, status: GEMINI_ERROR_STATUSES[status] ?? 'UNKNOWN' } };
  } else {
    body = {
      error: {
        type: OPENAI_ERROR_TYPES[status] ?? 'server_error',
        code: details.openAiCode ?? null,
        message,
      },
    };
  }
  return Response.json(body, { status, headers: details.headers });
}

// ---------------------------------------------------------------------------
// End markers (magpie continuation.go `streamEnds`, MIT, Copyright (c) 2026
// yetone): every spelling a relay sends. SSE makes the space after "data:" and
// "event:" optional, JSON the one after a colon. A JSON marker can only appear
// outside a quoted string (text that says it is escaped); an SSE one starts a
// line. Gemini ends on a candidate's finishReason (magpie fallback.go
// `geminiEnds`, sniff.go `lastEvent`).

const STREAM_END_MARKERS: Record<WireProtocol, string[]> = {
  anthropic: [
    '"type":"message_stop"', '"type": "message_stop"',
    '\nevent: message_stop', '\nevent:message_stop',
    '\nevent: error', '\nevent:error',
    '"type":"error"', '"type": "error"',
  ],
  'openai-responses': [
    '"type":"response.completed"', '"type": "response.completed"',
    '"type":"response.incomplete"', '"type": "response.incomplete"',
    '"type":"response.failed"', '"type": "response.failed"',
    '\nevent: response.completed', '\nevent:response.completed',
    '\nevent: response.incomplete', '\nevent:response.incomplete',
    '\nevent: response.failed', '\nevent:response.failed',
    '\nevent: error', '\nevent:error',
    '"type":"error"', '"type": "error"',
  ],
  'openai-chat': ['\ndata: [DONE]', '\ndata:[DONE]'],
  gemini: ['"finishReason"'],
};

const SSE_LINE_STARTS = ['event:', 'data:', 'id:', 'retry:', ':'];

/**
 * Whether a reply with no content-type is an SSE stream, from its first
 * bytes: an SSE line starts with "event:", "data:", "id:", "retry:" or ":"
 * (a comment). ChatGPT's Codex backend (chatgpt.com/backend-api/codex)
 * streams SSE with no content-type at all (seen live, codex-cli 0.162.1).
 * null: too few bytes to tell yet (`ended` decides on what there is).
 */
export function sniffEventStream(head: Uint8Array, ended: boolean): boolean | null {
  const text = new TextDecoder('latin1').decode(head.subarray(0, 64)).trimStart();
  if (SSE_LINE_STARTS.some(start => text.startsWith(start))) return true;
  if (!ended && (text === '' || SSE_LINE_STARTS.some(start => start.startsWith(text)))) return null;
  return false;
}

/** Whether a declared content-type is SSE. */
export function isEventStreamContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('text/event-stream');
}

/**
 * Holds a reply's first chunks until sniffEventStream can tell (replies with
 * no content-type only), then hands back every chunk held so far.
 */
export class EventStreamSniffer {
  private held: Uint8Array[] = [];
  private heldBytes = 0;

  /** The decision and the chunks held up to it, or null while still undecided. */
  push(chunk: Uint8Array, ended = false): { isEventStream: boolean; heldChunks: Uint8Array[] } | null {
    if (chunk.byteLength > 0) {
      this.held.push(chunk);
      this.heldBytes += chunk.byteLength;
    }
    const head = new Uint8Array(this.heldBytes);
    let offset = 0;
    for (const heldChunk of this.held) {
      head.set(heldChunk, offset);
      offset += heldChunk.byteLength;
    }
    const decision = sniffEventStream(head, ended || this.heldBytes >= 64);
    if (decision === null) return null;
    const heldChunks = this.held;
    this.held = [];
    return { isEventStream: decision, heldChunks };
  }
}

/** Bytes kept from the previous chunk so a marker split across chunks is still seen. */
const END_MARKER_CARRY_BYTES = 32;

/**
 * Watches a response stream for its protocol's end marker with a 32-byte
 * carry tail (magpie continuation.go `holdWriter.see`). Latin-1 decoding keeps
 * one char per byte, so the carry is exact and a split UTF-8 sequence can
 * never hide an ASCII marker.
 */
export class StreamEndMarkerDetector {
  private readonly markers: string[];
  private carry = '';
  private started = false;
  private endSeen = false;
  private readonly decoder = new TextDecoder('latin1');

  constructor(protocol: WireProtocol) {
    this.markers = STREAM_END_MARKERS[protocol];
  }

  get hasSeenEnd(): boolean {
    return this.endSeen;
  }

  observe(chunk: Uint8Array): void {
    if (this.endSeen) return;
    // The stream starts a line, so a first-line marker is seen too.
    const text = (this.started ? this.carry : '\n') + this.decoder.decode(chunk);
    this.started = true;
    if (this.markers.some(marker => text.includes(marker))) {
      this.endSeen = true;
      return;
    }
    this.carry = text.slice(-END_MARKER_CARRY_BYTES);
  }
}
