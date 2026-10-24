// SPDX-License-Identifier: Apache-2.0
//
// The push endpoint `POST /v1/claude-mem/events` (plan Phase 13 task 1,
// design Part 10): a tool the gateway cannot relay hands claude-mem the same
// neutral events the assembler makes — session_init, observation, summarize,
// session_end — and they go into the hook spool like every other capture
// event (D5), never straight into the worker.
//
// Ported from magpie's usage push (internal/gateway/usage_ingest.go:42-346,
// usage/reported.go:13-147; MIT, Copyright (c) 2026 yetone): one record or an
// array, the same body and count caps, all-or-nothing validation answered
// with the first bad record's index and field, and a per-record answer
// {accepted, skipped, records}. A record's id is remembered once accepted,
// so a client that sends it twice, or again after a restart, adds it once
// (magpie `IngestReported`, which reads the ids back from its own log).

import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { writeFileAtomic } from '../../../shared/atomic-json.js';
import { HookSpool, type HookSpoolPayloadByKind } from '../../../shared/hook-spool.js';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, paths } from '../../../shared/paths.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';
import { logger } from '../../../utils/logger.js';
import { scrubWireSpoolPayload } from '../privacy/secret-scrub.js';
import { parseJsonText } from './foreign-exchange.js';
import { DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS, decodeRequestBodyCopy, readBoundedRequestBody } from '../relay/request-body.js';

/** The most a post may carry (plan Phase 13 task 1; magpie usage_ingest.go `ingestMaxBody`). */
export const PUSH_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** The most events one post may carry (plan Phase 13 task 1; magpie `ingestMaxRecords`, for a client's backfill sent in batches). */
export const PUSH_MAX_EVENTS = 5000;
/** The longest event id (plan Phase 13 task 1). */
export const PUSH_MAX_EVENT_ID_LENGTH = 128;
/** nativePromptId's bound and shape, as the worker's own route checks it (SessionRoutes sessionInitByClaudeIdSchema). */
const NATIVE_PROMPT_ID_MAX_LENGTH = 256;
const NATIVE_PROMPT_ID_PATTERN = /^[^\s\x00-\x1f\x7f]+$/;
/** observedModel / observedBilling bounds, as SessionRoutes summarizeByClaudeIdSchema checks them. */
const OBSERVED_MODEL_MAX_LENGTH = 200;
const OBSERVED_BILLING_MAX_LENGTH = 40;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

export const PUSH_EVENT_KINDS = ['session_init', 'observation', 'summarize', 'session_end'] as const;
export type PushEventKind = typeof PUSH_EVENT_KINDS[number];

type FieldType = 'string' | 'any';
interface FieldRule { type: FieldType; required?: boolean; nonEmpty?: boolean; maxLength?: number; pattern?: RegExp; patternHint?: string }

/** Every event carries these; the rest are exactly the payload fields of the matching spool kind (src/shared/hook-spool.ts). */
const COMMON_FIELDS: Record<string, FieldRule> = {
  eventId: { type: 'string', required: true, nonEmpty: true, maxLength: PUSH_MAX_EVENT_ID_LENGTH },
  kind: { type: 'string', required: true },
  platformSource: { type: 'string', required: true, nonEmpty: true },
  contentSessionId: { type: 'string', required: true, nonEmpty: true },
};

const FIELDS_BY_KIND: Record<PushEventKind, Record<string, FieldRule>> = {
  session_init: {
    prompt: { type: 'string' },
    nativePromptId: { type: 'string', nonEmpty: true, maxLength: NATIVE_PROMPT_ID_MAX_LENGTH, pattern: NATIVE_PROMPT_ID_PATTERN, patternHint: 'no whitespace or control characters' },
    project: { type: 'string' },
    projectKeySource: { type: 'string' },
    customTitle: { type: 'string' },
    cwd: { type: 'string' },
  },
  observation: {
    telemetryPlatformSource: { type: 'string' },
    toolName: { type: 'string', required: true, nonEmpty: true },
    toolInput: { type: 'any' },
    toolResponse: { type: 'any' },
    cwd: { type: 'string' },
    agentId: { type: 'string' },
    agentType: { type: 'string' },
    toolUseId: { type: 'string', nonEmpty: true },
    project: { type: 'string' },
  },
  summarize: {
    lastAssistantMessage: { type: 'string', required: true },
    observedModel: { type: 'string', nonEmpty: true, maxLength: OBSERVED_MODEL_MAX_LENGTH },
    observedBilling: { type: 'string', nonEmpty: true, maxLength: OBSERVED_BILLING_MAX_LENGTH },
    cwd: { type: 'string' },
  },
  session_end: {},
};

export type PushEvent = {
  [K in PushEventKind]: { eventId: string; kind: K; payload: HookSpoolPayloadByKind[K] }
}[PushEventKind];

export class PushValidationError extends Error {
  constructor(readonly index: number | null, readonly field: string, message: string) {
    super(index === null ? `${field}: ${message}` : `event ${index}: ${field}: ${message}`);
    this.name = 'PushValidationError';
  }
}

function checkField(index: number, name: string, value: unknown, rule: FieldRule): void {
  if (value === undefined || value === null) {
    if (rule.required) throw new PushValidationError(index, name, 'required');
    return;
  }
  if (rule.type === 'any') return;
  if (typeof value !== 'string') throw new PushValidationError(index, name, 'must be a string');
  if (rule.nonEmpty && value.trim() === '') throw new PushValidationError(index, name, 'must not be empty');
  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    throw new PushValidationError(index, name, `longer than ${rule.maxLength} characters`);
  }
  if (rule.pattern && !rule.pattern.test(value)) throw new PushValidationError(index, name, `must have ${rule.patternHint}`);
}

/** One event, field by field, so what is wrong is named by its field (magpie `parseReported`). */
export function parsePushEvent(index: number, raw: unknown): PushEvent {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PushValidationError(index, 'event', 'not a JSON object');
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !(PUSH_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new PushValidationError(index, 'kind', `must be one of ${PUSH_EVENT_KINDS.join(', ')}`);
  }
  const kindFields = FIELDS_BY_KIND[kind as PushEventKind];
  // Sorted, so the same body always names the same field first.
  for (const name of Object.keys(record).sort()) {
    // Own keys only: `in` would take inherited names (toString, constructor) as fields.
    if (!Object.hasOwn(COMMON_FIELDS, name) && !Object.hasOwn(kindFields, name)) {
      throw new PushValidationError(index, name, `not a field a ${kind} event takes (${[...Object.keys(COMMON_FIELDS), ...Object.keys(kindFields)].join(', ')})`);
    }
  }
  for (const [name, rule] of Object.entries({ ...COMMON_FIELDS, ...kindFields })) checkField(index, name, record[name], rule);
  if (CONTROL_CHARACTER_PATTERN.test(record.eventId as string)) throw new PushValidationError(index, 'eventId', 'has a control character');

  const payload: Record<string, unknown> = {};
  for (const name of Object.keys(kindFields)) {
    if (record[name] !== undefined && record[name] !== null) payload[name] = record[name];
  }
  payload.platformSource = record.platformSource;
  payload.contentSessionId = record.contentSessionId;
  return { eventId: record.eventId as string, kind: kind as PushEventKind, payload } as unknown as PushEvent;
}

/** A post's events: one object, or a non-empty array of at most PUSH_MAX_EVENTS. Throws on the first bad one. */
export function parsePushBody(text: string): PushEvent[] {
  const parsedText = parseJsonText(text);
  if (!parsedText.ok) throw new PushValidationError(null, 'body', `it is ${parsedText.error}`);
  const parsed = parsedText.value;
  const raws = Array.isArray(parsed) ? parsed : [parsed];
  if (Array.isArray(parsed) && parsed.length === 0) throw new PushValidationError(null, 'body', 'the array has no events');
  if (raws.length > PUSH_MAX_EVENTS) throw new PushValidationError(null, 'body', `${raws.length} events: send at most ${PUSH_MAX_EVENTS} a post`);
  if (!Array.isArray(parsed) && (parsed === null || typeof parsed !== 'object')) {
    throw new PushValidationError(null, 'body', 'send a JSON event object, or an array of them');
  }
  return raws.map((raw, index) => parsePushEvent(index, raw));
}

function sha256Hex(...fields: string[]): string {
  const hash = createHash('sha256');
  fields.forEach((field, index) => {
    if (index > 0) hash.update('\u0000');
    hash.update(field);
  });
  return hash.digest('hex');
}

/**
 * The key an accepted event is remembered under: derived from its id, scoped
 * by the platform and session it names, so two tools' ids never collide.
 */
export function pushEventDedupeKey(event: PushEvent): string {
  return `push_${sha256Hex(normalizePlatformSource(event.payload.platformSource), event.payload.contentSessionId, event.eventId)}`;
}

/**
 * The payload as spooled. An observation without a toolUseId, and a
 * session_init without a nativePromptId, get one derived from the event id:
 * the worker keeps one row per (session, tool_use_id) and per (session,
 * native prompt id), so the same event drained twice still makes one row;
 * and the spool files an entry by those ids (hookSpoolKeyFor), so a re-sent
 * event overwrites its own pending file.
 */
export function spooledPayloadOf(event: PushEvent): PushEvent['payload'] {
  const derivedId = `push-${sha256Hex(normalizePlatformSource(event.payload.platformSource), event.payload.contentSessionId, event.eventId).slice(0, 32)}`;
  if (event.kind === 'observation' && event.payload.toolUseId === undefined) return { ...event.payload, toolUseId: derivedId };
  if (event.kind === 'session_init' && event.payload.nativePromptId === undefined) return { ...event.payload, nativePromptId: derivedId };
  return event.payload;
}

// ---------------------------------------------------------------------------
// Which events were accepted (the durable dedupe)

interface AcceptedPushEventLine { key: string; at: number }

/**
 * The dedupe keys of accepted events, kept in `state/push-events.jsonl`.
 *
 * Retention: a key is kept for CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS, the
 * owner-set window that bounds every other kept capture record of the
 * gateway. An event re-sent after that is accepted again; the worker still
 * keeps one row for it (its toolUseId / nativePromptId is derived from the
 * event id, spooledPayloadOf).
 *
 * The file is what says what was accepted: it is read back at first use.
 * Expired keys leave memory as new ones come in, and the file is rewritten
 * with the live keys only once it holds more than twice as many lines as
 * there are live keys: each rewrite then follows at least as many appends
 * as it writes lines, so the file never grows past twice the live keys and
 * rewriting costs O(1) per accepted event.
 */
export class PushEventLedger {
  /** In acceptance order (oldest first), so the expired ones are at the front. */
  private acceptedAtByKey: Map<string, number> | null = null;
  /** Lines in the file now, live or not. */
  private linesInFile = 0;

  constructor(
    private readonly filePath: string = paths.wireGatewayPushEventLedger(),
    private readonly retentionMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private cutoff(): number {
    return this.now() - this.retentionMs;
  }

  private load(): Map<string, number> {
    if (this.acceptedAtByKey) return this.acceptedAtByKey;
    const lines: AcceptedPushEventLine[] = [];
    let unreadableLines = 0;
    if (existsSync(this.filePath)) {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        const parsedLine = parseJsonText(line);
        const parsed = (parsedLine.ok ? parsedLine.value : null) as Partial<AcceptedPushEventLine> | null;
        if (!parsed || typeof parsed.key !== 'string' || typeof parsed.at !== 'number') {
          unreadableLines++;
          continue;
        }
        lines.push({ key: parsed.key, at: parsed.at });
      }
      if (unreadableLines > 0) {
        // A torn last line from a crash mid-append; its event may be accepted again, which the worker's own ids dedupe.
        logger.warn('WIRE', 'Push event ledger had unreadable lines; they were dropped', { filePath: this.filePath, unreadableLines });
      }
    }
    this.acceptedAtByKey = new Map();
    for (const line of lines.sort((a, b) => a.at - b.at)) {
      this.acceptedAtByKey.delete(line.key);
      this.acceptedAtByKey.set(line.key, line.at);
    }
    this.linesInFile = lines.length + unreadableLines;
    // An unreadable line is rewritten away at once: a torn last line would swallow the next append.
    this.expireAndCompact(unreadableLines > 0);
    return this.acceptedAtByKey;
  }

  /** Forget expired keys; rewrite the file once it is over twice the live keys (see the class comment). */
  private expireAndCompact(rewrite = false): void {
    const acceptedAtByKey = this.acceptedAtByKey!;
    const cutoff = this.cutoff();
    for (const [key, at] of acceptedAtByKey) {
      if (at >= cutoff) break;
      acceptedAtByKey.delete(key);
    }
    if (!rewrite && this.linesInFile <= 2 * acceptedAtByKey.size) return;
    const lines = [...acceptedAtByKey].map(([key, at]) => `${JSON.stringify({ key, at })}\n`).join('');
    mkdirSync(dirname(this.filePath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    writeFileAtomic(this.filePath, Buffer.from(lines, 'utf8'), { mode: WIRE_GATEWAY_FILE_MODE });
    this.linesInFile = acceptedAtByKey.size;
  }

  has(key: string): boolean {
    const at = this.load().get(key);
    return at !== undefined && at >= this.cutoff();
  }

  /**
   * Remember `keys` as accepted. They are remembered in memory first, so this
   * gateway skips them again even when the file cannot be written (then this
   * throws, and only a restart forgets them; the worker's own ids dedupe that).
   */
  remember(keys: string[]): void {
    if (keys.length === 0) return;
    const acceptedAtByKey = this.load();
    const at = this.now();
    for (const key of keys) {
      // Re-inserted, so the map stays oldest first.
      acceptedAtByKey.delete(key);
      acceptedAtByKey.set(key, at);
    }
    mkdirSync(dirname(this.filePath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    appendFileSync(this.filePath, keys.map(key => `${JSON.stringify({ key, at })}\n`).join(''), { mode: WIRE_GATEWAY_FILE_MODE });
    this.linesInFile += keys.length;
    this.expireAndCompact();
  }
}

// ---------------------------------------------------------------------------
// The spool writer and the HTTP handler

/** Where accepted push events go: the hook spool, scrubbed (plan Phase 6 task 2), plus a worker nudge. Throws when an event cannot be spooled. */
export interface PushEventSpool {
  enqueue(event: PushEvent): void;
}

export function createHookSpoolPushEventSpool(options: { spool?: HookSpool; nudgeWorker: () => void }): PushEventSpool {
  const spool = options.spool ?? new HookSpool();
  return {
    enqueue(event) {
      spool.enqueue(event.kind, scrubWireSpoolPayload(event.kind, spooledPayloadOf(event) as never));
      options.nudgeWorker();
    },
  };
}

export interface PushEventsHandlerOptions {
  spool: PushEventSpool;
  ledger: PushEventLedger;
  /** Test seam; defaults to 60 s, the relay's own body idle timeout. */
  requestBodyIdleTimeoutMs?: number;
}

export type PushRecordStatus = 'accepted' | 'skipped';

export interface PushEventsResponse {
  accepted: number;
  skipped: number;
  records: Array<{ index: number; eventId: string; status: PushRecordStatus }>;
}

/** Content-free counters for `wire status`. */
export const pushEventActivity = { postsAnswered: 0, eventsAccepted: 0, eventsSkipped: 0, postsRefused: 0 };

function pushError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  pushEventActivity.postsRefused++;
  return Response.json({ error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message, ...extra } }, { status });
}

export function createPushEventsHandler(options: PushEventsHandlerOptions): (request: Request) => Promise<Response> {
  return async function handlePushEvents(request: Request): Promise<Response> {
    if (request.method !== 'POST') return pushError(405, 'POST /v1/claude-mem/events only');
    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return pushError(415, 'send the events as JSON, with Content-Type: application/json');

    const bodyRead = await readBoundedRequestBody(request, {
      maxRequestBytes: PUSH_MAX_BODY_BYTES,
      idleTimeoutMs: options.requestBodyIdleTimeoutMs ?? DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS,
    });
    if (bodyRead.kind === 'too_large') {
      return pushError(413, `the body is over ${PUSH_MAX_BODY_BYTES} bytes: send at most ${PUSH_MAX_EVENTS} events a post`);
    }
    if (bodyRead.kind === 'idle_timeout') return pushError(408, `the body stalled for ${Math.round(bodyRead.idleTimeoutMs / 1000)} s`);
    const decoded = decodeRequestBodyCopy(bodyRead.body, request.headers.get('content-encoding'), PUSH_MAX_BODY_BYTES);
    if (decoded.kind === 'skipped') {
      return decoded.reason === 'decoded_too_large'
        ? pushError(413, `the decoded body is over ${PUSH_MAX_BODY_BYTES} bytes`)
        : pushError(415, `the body's content-encoding "${decoded.contentEncoding}" could not be decoded (${decoded.reason}); send identity, gzip, br or zstd`);
    }

    let events: PushEvent[];
    try {
      events = parsePushBody(new TextDecoder().decode(decoded.bytes));
    } catch (error) {
      if (!(error instanceof PushValidationError)) throw error;
      // All or nothing: nothing of this post was taken.
      return pushError(400, error.message, { param: error.field, ...(error.index !== null ? { index: error.index } : {}) });
    }

    const response: PushEventsResponse = { accepted: 0, skipped: 0, records: [] };
    const acceptedKeys: string[] = [];
    const keysInThisPost = new Set<string>();
    for (const [index, event] of events.entries()) {
      const key = pushEventDedupeKey(event);
      if (keysInThisPost.has(key) || options.ledger.has(key)) {
        response.skipped++;
        response.records.push({ index, eventId: event.eventId, status: 'skipped' });
        continue;
      }
      try {
        options.spool.enqueue(event);
      } catch (error) {
        const spoolError = error instanceof Error ? error : new Error(String(error));
        logger.error('WIRE', 'A pushed event could not be spooled', { index, kind: event.kind }, spoolError);
        // What was spooled before stays (it is durable); say which ones so the client resends only the rest.
        // The ledger keeps them in memory even if its file cannot be written, and that failure is said beside the spool's, never instead of it.
        let ledgerFailure: string | undefined;
        try {
          options.ledger.remember(acceptedKeys);
        } catch (ledgerError) {
          ledgerFailure = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
          logger.error('WIRE', 'The accepted push events could not be written to the ledger file; this gateway still skips them until it restarts', { accepted: acceptedKeys.length },
            ledgerError instanceof Error ? ledgerError : new Error(ledgerFailure));
        }
        return pushError(500, `event ${index} could not be spooled: ${spoolError.message}; events before it were accepted`, {
          index, accepted: response.accepted, records: response.records,
          ...(ledgerFailure !== undefined ? { ledgerError: `the accepted events could not be written to the ledger file: ${ledgerFailure}` } : {}),
        });
      }
      keysInThisPost.add(key);
      acceptedKeys.push(key);
      response.accepted++;
      response.records.push({ index, eventId: event.eventId, status: 'accepted' });
    }
    options.ledger.remember(acceptedKeys);
    pushEventActivity.postsAnswered++;
    pushEventActivity.eventsAccepted += response.accepted;
    pushEventActivity.eventsSkipped += response.skipped;
    return Response.json(response);
  };
}
