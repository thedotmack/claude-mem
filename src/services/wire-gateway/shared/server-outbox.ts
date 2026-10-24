// SPDX-License-Identifier: Apache-2.0
//
// The shared team gateway's durable outbox (plan D15, Phase 16 task 4): the
// neutral events of a member's sessions go to the claude-mem server runtime
// their client key names, with that key's server API key.
//
// Layout: <outbox>/<key name>/<key record id>/{pending,delivered,rejected,expired}/.
// An event is bound to the keys.json record that queued it (its random id),
// never to the name alone: a name removed and added again for someone else
// is a new record, so the first member's events are never sent with the new
// member's server key. Once the record is gone its events are moved to
// rejected/, unsent (its server API key is gone with it).
//
// Exactly once, by eventId:
// - An event's id is derived from what it is (hook-spool.ts `hookSpoolKeyFor`:
//   the tool_use_id or native prompt id within its session, else a hash of
//   the payload), so the same event emitted twice is queued once: the second
//   finds its pending file or its marker.
// - Each event is one file, written atomically before `enqueue` returns, and
//   survives a restart or a server outage. It is retried with backoff until
//   the server accepts it, and the request sent is byte-for-byte the one first
//   built, so the server's own idempotency keys see one event: the
//   observation's session-scoped tool_use_id (compat route), the session's
//   ended_at and its one summary job (compat summarize), and /v1/events' hash
//   of team, project, session, type, occurredAt and payload
//   (storage/postgres/agent-events.ts buildAgentEventIdempotencyKey).
// - Once accepted, the event becomes a line in its key's delivered index
//   (<outbox>/<name>/<id>/delivered.log: `<deliveredAtEpochMs> <eventId>`, no
//   content), one file per key rather than one per event, so markers cost
//   bytes, not inodes. The rule for how long a marker is kept: as long as
//   losing it could make the server store the event twice. /v1/events kinds
//   (session_init, summarize, …) are keyed on the server by occurredAt, which
//   is the time this gateway first queued them; the assembler can re-emit one
//   whenever it first sees a request of that turn again (after a restart or
//   an eviction), with no bound in time, and the re-emit would carry a new
//   occurredAt. So their markers are not pruned by age; the index is bounded
//   by OUTBOX_DELIVERED_INDEX_MAX_BYTES_PER_KEY instead, and past it the
//   oldest half is let go with a warning (a re-emit of one of those, rare and
//   only for a turn seen again, could then be stored twice). An observation's
//   server key is its session-scoped tool_use_id and a session end's is the
//   session itself (ended_at is set once, one summary job per session),
//   neither with a time, so their markers are pruned with the recordings'
//   retention.
//
// Disk: everything a key leaves on disk (pending/, rejected/, expired/ and its
// delivered index) counts toward its byte cap, and every key together toward a
// global one; past either an event is refused loudly. rejected/ and expired/
// are only ever filled from pending/, so they can never hold more than was
// admitted. An event larger than the server's request limit is trimmed to fit
// before it is queued (its longest strings cut the way the worker cuts stored
// tool payloads, marked `…[truncated: N bytes]`), so a large tool output is
// captured, not refused by the server and lost.
//
// Where each kind goes (the server runtime's routes, report 01 Q9):
// - observation → POST /api/sessions/observations (compat: the worker's own
//   payload, project-scoped key, server session created from contentSessionId)
// - session_end → POST /api/sessions/summarize (compat: ends the server
//   session and queues its one summary). The server keeps one summary per
//   session (EndSessionService: ended_at COALESCE, one outbox row per session),
//   so a resumed session that ends again would change nothing there; the
//   outbox's own dedupe (one session_end per session) matches it.
// - every other kind (session_init, summarize, …) → POST /v1/events with the
//   key's project, the kind as eventType and the payload as sent to the worker
//
// Keys are delivered independently: each key's queue has its own pass, so a
// server that hangs (up to the delivery timeout per attempt) delays only the
// members whose key names it.
//
// HTTP goes through direct-http.ts: https:// uses fetch (TLS, and the proxy
// the environment names), http:// a plain socket that never takes a proxy.
// An http:// server must resolve to this host or a private network
// (client-keys.ts resolvePlainHttpServer), checked at `keys add` and again
// before each delivery pass, and the connection goes to the very address the
// check resolved, so the server API key never crosses the internet in clear
// text. The key's record is looked up again before every event: a key removed
// mid-pass has nothing more sent.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { writeFileAtomic, writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { HOOK_SPOOL_RETRY_WINDOW_MS, hookSpoolKeyFor, sessionScopeKey, type HookSpoolKind, type HookSpoolPayloadByKind } from '../../../shared/hook-spool.js';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, paths } from '../../../shared/paths.js';
import { RECORDED_STORE_SOFT_CAP_BYTES } from '../capture/turn-recorder.js';
import { truncatePayload } from '../../sqlite/tool-uses.js';
import { logger } from '../../../utils/logger.js';
import { describeDirectHttpFailure, requestDirectlyWithOutcome, type DirectHttpOutcome, type DirectHttpRequest } from '../direct-http.js';
import {
  WIRE_CLIENT_KEY_NAME_PATTERN,
  WIRE_CLIENT_KEY_RECORD_ID_PATTERN,
  resolvePlainHttpServer,
  type WireClientKeyIdentity,
  type WireClientKeyLookup,
} from './client-keys.js';

/**
 * One delivery may take this long. The compat routes and /v1/events do one
 * database write and a queue add, answered in milliseconds; 10 s covers a
 * slow or distant server while a hung connection cannot hold its key's queue
 * for longer than that (other keys are delivered meanwhile).
 */
export const OUTBOX_DELIVERY_TIMEOUT_MS = 10_000;
/** The answers are a few hundred bytes (a validation error lists its issues); only the status and a message for the log are read. */
const OUTBOX_RESPONSE_MAXIMUM_BYTES = 1024 * 1024;
/** First retry after a failed delivery: a blip (a restart, a deploy) clears in about a second. */
export const OUTBOX_RETRY_BASE_DELAY_MS = 1_000;
/**
 * Retries back off by doubling up to this: a server back from an outage gets
 * the backlog within a minute, and a server that stays down costs one request
 * per key per minute.
 */
export const OUTBOX_RETRY_MAX_DELAY_MS = 60_000;
/** How often the outbox looks for events whose retry time came: the pace of retries only (an enqueue drains at once). */
const OUTBOX_TICK_INTERVAL_MS = 1_000;
const OUTBOX_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * A log line carries the start of a refusing server's answer: the runtime's
 * JSON `error` and `message` come first and fit well inside 300 characters
 * (its longest compat message, the project-scoped one, is 69), while a
 * validation error's issue list can run to kilobytes per refused event.
 */
const LOGGED_ANSWER_CHARACTERS = 300;
/**
 * The most a key may leave on disk: pending/, rejected/, expired/ and its
 * delivered index together. A member's server that stays down, refuses
 * everything, or a member who floods events must not fill the gateway host's
 * disk: the same 256 MiB that bounds this gateway's own raw recordings
 * (turn-recorder.ts RECORDED_STORE_SOFT_CAP_BYTES, magpie gatewayStoreMax).
 * Past it an event is refused loudly (logged as lost, counted in
 * `wire status`), never dropped silently.
 */
export const OUTBOX_MAX_BYTES_PER_KEY = RECORDED_STORE_SOFT_CAP_BYTES;
/**
 * The most every key together may leave on disk (abuse protection: the
 * per-key cap alone lets N keys take N × 256 MiB of the host's disk). Four
 * keys at their own cap, the same 4 × 256 MiB budget for every member: a team
 * whose servers are all down past it gets loud refusals, not a full disk.
 */
export const OUTBOX_MAX_BYTES_TOTAL = 4 * OUTBOX_MAX_BYTES_PER_KEY;
/**
 * A key's delivered index stops growing here; the oldest half of its markers
 * is then let go (logged). The index is also held in memory for the duplicate
 * check, so this bounds memory per key as well as disk: at ~150 bytes a line
 * (an event id is a kind, a 64-hex session scope and a prompt or tool id) it
 * holds ~110,000 markers, ~55,000 turns, a heavy member's months; a re-emit
 * only happens for a turn the assembler sees again, which is a recent one.
 */
export const OUTBOX_DELIVERED_INDEX_MAX_BYTES_PER_KEY = 16 * 1024 * 1024;
/**
 * The server runtime's request body limit: express.json({ limit: '5mb' })
 * (src/services/worker/http/middleware.ts createMiddleware, which the server
 * runtime mounts through services/server/Server.ts for every route, the
 * compat /api/sessions/* routes and /v1/events included; body-parser's 5mb is
 * 5 × 1024 × 1024 bytes). A body above it is answered 413 and could never be
 * delivered, so an event is trimmed to fit before it is queued.
 */
export const OUTBOX_SERVER_REQUEST_MAX_BYTES = 5 * 1024 * 1024;
/** Room for the `…[truncated: N bytes]` marker a cut string gains (it is under 40 bytes). */
const TRUNCATION_MARKER_ROOM_BYTES = 64;
/**
 * Pending file names start with the enqueue time and a sequence, fixed width,
 * so a directory listing sorts in queue order. 15 digits hold any epoch
 * millisecond until the year 33658; the 9-digit sequence only orders events
 * queued in the same millisecond, so wrapping after 10^9 in one process is
 * harmless. With the longest event id (205 characters) a name stays under
 * the 255-byte file-name limit of common file systems.
 */
const ENQUEUED_AT_DIGITS = 15;
const SEQUENCE_DIGITS = 9;
const PENDING_NAME_PATTERN = /^(\d{15})-(\d{9})-(.+)\.json$/;

const PENDING = 'pending';
/** Per-event marker files of builds before the delivered index; only pruned now. */
const LEGACY_DELIVERED = 'delivered';
const DELIVERED_INDEX = 'delivered.log';
const REJECTED = 'rejected';
const EXPIRED = 'expired';

/** Kinds whose server idempotency key holds no time: their delivered markers may be pruned (the rule above). */
const TIME_FREE_SERVER_KEY_KINDS: readonly HookSpoolKind[] = ['observation', 'session_end'];

export type OutboxRoute = '/api/sessions/observations' | '/api/sessions/summarize' | '/v1/events';

interface OutboxEntry {
  eventId: string;
  keyName: string;
  /** The keys.json record that queued it; it is sent only while that record holds the name. */
  keyId: string;
  kind: HookSpoolKind;
  enqueuedAtEpochMs: number;
  route: OutboxRoute;
  /** The exact JSON body every attempt sends. */
  body: Record<string, unknown>;
}

/** A refused enqueue: the key's (or every key's) disk budget is used up. The caller logs the event as lost. */
export class OutboxFullError extends Error {}

export interface WireServerOutboxOptions {
  /** Test seam; defaults to <DATA_DIR>/wire-gateway/outbox. */
  directory?: string;
  /** A key's record by name (WireClientKeyStore.lookupByName). */
  lookupKey: (keyName: string) => WireClientKeyLookup;
  /** How long rejected/ and expired/ entries and time-free delivered markers are kept (the recordings' retention). */
  retentionMs: number;
  /** Test seams. */
  send?: (request: DirectHttpRequest) => Promise<DirectHttpOutcome>;
  resolveHost?: (hostname: string) => Promise<string[]>;
  retryWindowMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  tickIntervalMs?: number;
  maxBytesPerKey?: number;
  maxBytesTotal?: number;
  deliveredIndexMaxBytesPerKey?: number;
  serverRequestMaxBytes?: number;
  now?: () => number;
}

/** Content-free counters for `wire status` (plan Phase 6 task 4 rule: counts only). */
export const serverOutboxActivity = { queued: 0, duplicates: 0, delivered: 0, retried: 0, rejected: 0, expired: 0, refusedFull: 0, orphaned: 0, trimmedToFit: 0, deliveredMarkersDropped: 0 };

/** The request body for the server runtime, built once at enqueue. */
export function serverRequestFor<K extends HookSpoolKind>(
  kind: K,
  payload: HookSpoolPayloadByKind[K],
  identity: WireClientKeyIdentity,
  eventId: string,
  occurredAtEpochMs: number,
): { route: OutboxRoute; body: Record<string, unknown> } {
  if (kind === 'observation') {
    const observation = payload as HookSpoolPayloadByKind['observation'];
    return {
      route: '/api/sessions/observations',
      body: {
        contentSessionId: observation.contentSessionId,
        platformSource: observation.platformSource,
        tool_name: observation.toolName,
        tool_input: observation.toolInput ?? null,
        tool_response: observation.toolResponse ?? null,
        ...(observation.cwd !== undefined ? { cwd: observation.cwd } : {}),
        ...(observation.agentId !== undefined ? { agentId: observation.agentId } : {}),
        ...(observation.agentType !== undefined ? { agentType: observation.agentType } : {}),
        ...(observation.project !== undefined ? { project: observation.project } : {}),
        // The compat route's idempotency key (sourceEventId), which the server scopes by team,
        // project, adapter and platform but not by session. Tool ids are opaque host values that
        // some hosts (and Gemini's derived ids) repeat across sessions, so it is scoped by session
        // as the hook spool scopes its files (hook-spool.ts hookSpoolKeyFor). An observation without
        // one would be keyed by the server's own clock and duplicated on a retry, so it gets the
        // outbox's event id (already session-scoped: a hash over the payload).
        tool_use_id: observation.toolUseId ? `${sessionScopeKey(observation)}-${observation.toolUseId}` : eventId,
      },
    };
  }
  if (kind === 'session_end') {
    return {
      route: '/api/sessions/summarize',
      body: { contentSessionId: payload.contentSessionId, platformSource: payload.platformSource },
    };
  }
  return {
    route: '/v1/events',
    body: {
      projectId: identity.server.projectId,
      sourceType: 'hook',
      eventType: kind,
      platformSource: payload.platformSource,
      contentSessionId: payload.contentSessionId,
      payload,
      occurredAtEpoch: occurredAtEpochMs,
    },
  };
}

/**
 * A request body cut down to `maxBytes` of JSON: its longest strings first,
 * each by truncatePayload (the worker's own cut for stored tool payloads,
 * sqlite/tool-uses.ts: UTF-8 safe, marked `…[truncated: N bytes]`). Returns
 * the body untouched when it fits. Throws when cutting every string cannot
 * make it fit (the caller logs the event as lost).
 */
export function fitBodyToLimit(body: Record<string, unknown>, maxBytes: number): { body: Record<string, unknown>; truncatedStrings: number } {
  let size = Buffer.byteLength(JSON.stringify(body));
  if (size <= maxBytes) return { body, truncatedStrings: 0 };
  const copy = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const leaves: Array<{ holder: Record<string, unknown> | unknown[]; key: string | number; bytes: number }> = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach((item, index) => (typeof item === 'string' ? leaves.push({ holder: value, key: index, bytes: Buffer.byteLength(item) }) : collect(item)));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') leaves.push({ holder: value as Record<string, unknown>, key, bytes: Buffer.byteLength(item) });
        else collect(item);
      }
    }
  };
  collect(copy);
  leaves.sort((a, b) => b.bytes - a.bytes);
  let truncatedStrings = 0;
  for (const leaf of leaves) {
    if (size <= maxBytes) break;
    const holder = leaf.holder as Record<string | number, string>;
    // Every UTF-8 byte cut takes at least one byte of JSON with it (escapes only make a byte longer).
    const keepBytes = Math.max(0, leaf.bytes - (size - maxBytes) - TRUNCATION_MARKER_ROOM_BYTES);
    holder[leaf.key] = truncatePayload(holder[leaf.key], keepBytes);
    truncatedStrings++;
    size = Buffer.byteLength(JSON.stringify(copy));
  }
  if (size > maxBytes) throw new Error(`the event is ${size} bytes of JSON even with every string cut, over the server runtime's ${maxBytes}-byte request limit`);
  return { body: copy, truncatedStrings };
}

type DeliveryVerdict = 'delivered' | 'retry' | 'rejected';

function answerForLog(bodyText: string): string {
  return bodyText.length > LOGGED_ANSWER_CHARACTERS
    ? `${bodyText.slice(0, LOGGED_ANSWER_CHARACTERS)}… (${bodyText.length - LOGGED_ANSWER_CHARACTERS} more characters)`
    : bodyText;
}

/** 2xx accepted; a server that is down, busy or not authorized yet is retried; any other 4xx will never be accepted. */
function verdictOf(outcome: DirectHttpOutcome): { verdict: DeliveryVerdict; detail: string; keyProblem: boolean } {
  if ('failure' in outcome) {
    // A header the server API key made unusable can never be sent: keys.json must be fixed, and then it is retried.
    return { verdict: 'retry', detail: describeDirectHttpFailure(outcome.failure, 'the claude-mem server runtime'), keyProblem: outcome.failure.reason === 'bad_header' };
  }
  const status = outcome.response.statusCode;
  if (status >= 200 && status < 300) return { verdict: 'delivered', detail: String(status), keyProblem: false };
  const message = answerForLog(outcome.response.bodyText);
  // 401/403: the server API key is wrong or revoked. A 400 naming the project scope: the key is
  // not project-scoped (the compat routes need one). Either way the host must fix the key; events wait.
  if (status === 401 || status === 403 || (status === 400 && outcome.response.bodyText.includes('project-scoped'))) {
    return { verdict: 'retry', detail: `HTTP ${status}: ${message}`, keyProblem: true };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { verdict: 'retry', detail: `HTTP ${status}: ${message}`, keyProblem: false };
  }
  return { verdict: 'rejected', detail: `HTTP ${status}: ${message}`, keyProblem: false };
}

interface KeyRetryState {
  failures: number;
  nextAttemptAt: number;
}

/** One key record's queue: <outbox>/<name>/<id>. */
interface KeyQueue {
  name: string;
  id: string;
  directory: string;
}

function queueLabel(queue: KeyQueue): string {
  return `${queue.name}/${queue.id}`;
}

/** What one queue holds, read from file names, sizes and its delivered index on first use (never the event contents). */
interface QueueUsage {
  pendingEventIds: Set<string>;
  pendingBytes: number;
  /** rejected/, expired/ and legacy delivered/ files. */
  retainedBytes: number;
  /** Delivered markers by event id, with the time each was delivered. */
  delivered: Map<string, number>;
  deliveredIndexBytes: number;
}

function totalBytesOf(usage: QueueUsage): number {
  return usage.pendingBytes + usage.retainedBytes + usage.deliveredIndexBytes;
}

function deliveredIndexLine(eventId: string, deliveredAtEpochMs: number): string {
  return `${deliveredAtEpochMs} ${eventId}\n`;
}

/** The server key and address an event is sent with: its record, as looked up for this event. */
interface SendTarget {
  identity: WireClientKeyIdentity;
  /** http:// only: the address the private-network check resolved; the connection goes there. */
  connectAddress: string | null;
}

function sameServer(a: WireClientKeyIdentity, b: WireClientKeyIdentity): boolean {
  return a.server.url === b.server.url && a.server.apiKey === b.server.apiKey && a.server.projectId === b.server.projectId;
}

export class WireServerOutbox {
  readonly directory: string;
  private readonly options: WireServerOutboxOptions;
  private readonly send: (request: DirectHttpRequest) => Promise<DirectHttpOutcome>;
  private readonly now: () => number;
  private readonly maxBytesPerKey: number;
  private readonly maxBytesTotal: number;
  private readonly deliveredIndexMaxBytes: number;
  private readonly serverRequestMaxBytes: number;
  private readonly retryByQueue = new Map<string, KeyRetryState>();
  private readonly usageByQueue = new Map<string, QueueUsage>();
  /** Every queue's bytes together; null until every queue on disk was read (on the first enqueue). */
  private totalBytes: number | null = null;
  private sequence = 0;
  /** One delivery pass per queue at a time; queues run side by side. */
  private readonly drainsInFlight = new Map<string, Promise<void>>();
  private readonly drainAgain = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private lastPruneAt = 0;

  constructor(options: WireServerOutboxOptions) {
    this.options = options;
    this.directory = options.directory ?? paths.wireGatewayOutbox();
    this.send = options.send ?? requestDirectlyWithOutcome;
    this.now = options.now ?? Date.now;
    this.maxBytesPerKey = options.maxBytesPerKey ?? OUTBOX_MAX_BYTES_PER_KEY;
    this.maxBytesTotal = options.maxBytesTotal ?? OUTBOX_MAX_BYTES_TOTAL;
    this.deliveredIndexMaxBytes = options.deliveredIndexMaxBytesPerKey ?? OUTBOX_DELIVERED_INDEX_MAX_BYTES_PER_KEY;
    this.serverRequestMaxBytes = options.serverRequestMaxBytes ?? OUTBOX_SERVER_REQUEST_MAX_BYTES;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.tick(), this.options.tickIntervalMs ?? OUTBOX_TICK_INTERVAL_MS);
    this.timer.unref?.();
    this.tick();
  }

  private tick(): void {
    // Pruned at start and then once a day (the conversation ledgers' pace).
    if (this.now() - this.lastPruneAt >= OUTBOX_PRUNE_INTERVAL_MS) {
      this.lastPruneAt = this.now();
      this.prune();
    }
    this.scheduleDrains(false);
  }

  /** Stops the timer and waits for the deliveries in flight. Pending events stay on disk for the next start. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.drainsInFlight.values()]);
  }

  /**
   * Queue one event for a key's server. Durable before it returns. Returns
   * `duplicate` (logged, counted) when that event is already pending or was
   * delivered, rejected or expired. Throws OutboxFullError when the key's or
   * every key's disk budget is used up, and any write error or an event that
   * cannot be cut to the server's request limit: the caller logs the loss.
   */
  enqueue<K extends HookSpoolKind>(identity: WireClientKeyIdentity, kind: K, payload: HookSpoolPayloadByKind[K]): 'queued' | 'duplicate' {
    if (!WIRE_CLIENT_KEY_NAME_PATTERN.test(identity.name)) throw new Error(`client key name "${identity.name}" cannot name an outbox folder`);
    if (!WIRE_CLIENT_KEY_RECORD_ID_PATTERN.test(identity.keyId)) throw new Error(`client key "${identity.name}" has no usable record id`);
    const queue: KeyQueue = { name: identity.name, id: identity.keyId, directory: join(this.directory, identity.name, identity.keyId) };
    const eventId = `${kind}-${hookSpoolKeyFor(kind, payload)}`;
    const totalBytes = this.everyQueueBytes();
    const usage = this.usageOf(queue);
    const markerName = `${eventId}.json`;
    const foundIn = usage.pendingEventIds.has(eventId)
      ? PENDING
      : usage.delivered.has(eventId)
        ? 'delivered'
        : [REJECTED, EXPIRED].find(state => existsSync(join(queue.directory, state, markerName)));
    if (foundIn) {
      serverOutboxActivity.duplicates++;
      logger.debug('WIRE', 'Event already in the outbox; not queued twice', { client: identity.name, kind, eventId, state: foundIn });
      return 'duplicate';
    }
    const enqueuedAtEpochMs = this.now();
    const request = serverRequestFor(kind, payload, identity, eventId, enqueuedAtEpochMs);
    const fitted = fitBodyToLimit(request.body, this.serverRequestMaxBytes);
    if (fitted.truncatedStrings > 0) {
      serverOutboxActivity.trimmedToFit++;
      logger.warn('WIRE', 'An event was over the server runtime\'s request limit; its longest strings were cut (marked …[truncated: N bytes]) so it can be delivered', {
        client: identity.name, kind, eventId, limitBytes: this.serverRequestMaxBytes, truncatedStrings: fitted.truncatedStrings,
      });
    }
    const entry: OutboxEntry = { eventId, keyName: identity.name, keyId: identity.keyId, kind, enqueuedAtEpochMs, route: request.route, body: fitted.body };
    const bytes = Buffer.byteLength(JSON.stringify(entry, null, 2) + '\n');
    if (totalBytesOf(usage) + bytes > this.maxBytesPerKey) {
      serverOutboxActivity.refusedFull++;
      throw new OutboxFullError(`the outbox for client key "${identity.name}" holds ${totalBytesOf(usage)} bytes (pending ${usage.pendingBytes}, rejected or expired ${usage.retainedBytes}, delivered markers ${usage.deliveredIndexBytes}), its limit is ${this.maxBytesPerKey}; is its server runtime down or refusing its events?`);
    }
    if (totalBytes + bytes > this.maxBytesTotal) {
      serverOutboxActivity.refusedFull++;
      throw new OutboxFullError(`the outbox holds ${totalBytes} bytes for every client key together, its limit is ${this.maxBytesTotal}; are members' server runtimes down or refusing their events?`);
    }
    const sequence = this.sequence++ % 10 ** SEQUENCE_DIGITS;
    const fileName = `${String(enqueuedAtEpochMs).padStart(ENQUEUED_AT_DIGITS, '0')}-${String(sequence).padStart(SEQUENCE_DIGITS, '0')}-${markerName}`;
    mkdirSync(join(queue.directory, PENDING), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    writeJsonFileAtomic(join(queue.directory, PENDING, fileName), entry, { mode: WIRE_GATEWAY_FILE_MODE });
    usage.pendingEventIds.add(eventId);
    this.addBytes(usage, 'pendingBytes', bytes);
    serverOutboxActivity.queued++;
    this.scheduleDrain(queue, false);
    return 'queued';
  }

  /** Pending events per key name (every record that held it), for status and tests. */
  pendingCount(keyName?: string): number {
    return this.queues()
      .filter(queue => keyName === undefined || queue.name === keyName)
      .reduce((total, queue) => total + this.pendingFileNames(queue).length, 0);
  }

  /** What every queue holds on disk together, in bytes (for status and tests). */
  usedBytes(): number {
    return this.everyQueueBytes();
  }

  /** Whether an event was delivered (its marker is in its key's index), for tests. */
  isDelivered(identity: Pick<WireClientKeyIdentity, 'name' | 'keyId'>, eventIdPrefix: string): boolean {
    const usage = this.usageOf({ name: identity.name, id: identity.keyId, directory: join(this.directory, identity.name, identity.keyId) });
    return [...usage.delivered.keys()].some(eventId => eventId.startsWith(eventIdPrefix));
  }

  /** Runs a delivery pass for every queue now (or joins the ones in flight) and resolves when none is left to run. */
  async drainNow(): Promise<void> {
    this.scheduleDrains(true);
    while (this.drainsInFlight.size > 0) await Promise.all([...this.drainsInFlight.values()]);
  }

  private scheduleDrains(ignoreBackoff: boolean): void {
    for (const queue of this.queues()) this.scheduleDrain(queue, ignoreBackoff);
  }

  private scheduleDrain(queue: KeyQueue, ignoreBackoff: boolean): void {
    if (this.stopping) return;
    const label = queueLabel(queue);
    if (this.drainsInFlight.has(label)) {
      this.drainAgain.add(label);
      return;
    }
    const retry = this.retryByQueue.get(label);
    if (!ignoreBackoff && retry && this.now() < retry.nextAttemptAt) return;
    const drain = this.drainQueue(queue)
      .catch(error => {
        logger.error('WIRE', 'Outbox delivery pass failed; it runs again on the next tick', { client: queue.name }, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.drainsInFlight.delete(label);
        if (this.drainAgain.delete(label) && !this.stopping) this.scheduleDrain(queue, false);
      });
    this.drainsInFlight.set(label, drain);
  }

  private queues(): KeyQueue[] {
    if (!existsSync(this.directory)) return [];
    const queues: KeyQueue[] = [];
    for (const nameEntry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!nameEntry.isDirectory() || !WIRE_CLIENT_KEY_NAME_PATTERN.test(nameEntry.name)) continue;
      for (const idEntry of readdirSync(join(this.directory, nameEntry.name), { withFileTypes: true })) {
        if (!idEntry.isDirectory() || !WIRE_CLIENT_KEY_RECORD_ID_PATTERN.test(idEntry.name)) continue;
        queues.push({ name: nameEntry.name, id: idEntry.name, directory: join(this.directory, nameEntry.name, idEntry.name) });
      }
    }
    return queues;
  }

  private listJsonFiles(directory: string): string[] {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith('.json'));
  }

  /** Pending file names in queue order (the fixed-width time and sequence prefix sorts them). */
  private pendingFileNames(queue: KeyQueue): string[] {
    return this.listJsonFiles(join(queue.directory, PENDING)).sort();
  }

  private directoryBytes(directory: string): number {
    return this.listJsonFiles(directory).reduce((total, fileName) => total + fileSizeOrZero(join(directory, fileName)), 0);
  }

  /** Every queue on disk read once, so the global cap counts what earlier runs left. */
  private everyQueueBytes(): number {
    if (this.totalBytes === null) {
      this.totalBytes = 0;
      for (const queue of this.queues()) this.usageOf(queue);
    }
    return this.totalBytes;
  }

  private usageOf(queue: KeyQueue): QueueUsage {
    const label = queueLabel(queue);
    let usage = this.usageByQueue.get(label);
    if (usage) return usage;
    usage = { pendingEventIds: new Set(), pendingBytes: 0, retainedBytes: 0, delivered: new Map(), deliveredIndexBytes: 0 };
    const pendingDirectory = join(queue.directory, PENDING);
    for (const fileName of this.listJsonFiles(pendingDirectory)) {
      const match = PENDING_NAME_PATTERN.exec(fileName);
      if (match) usage.pendingEventIds.add(match[3]);
      usage.pendingBytes += fileSizeOrZero(join(pendingDirectory, fileName));
    }
    for (const state of [REJECTED, EXPIRED, LEGACY_DELIVERED]) usage.retainedBytes += this.directoryBytes(join(queue.directory, state));
    this.readDeliveredIndex(queue, usage);
    this.usageByQueue.set(label, usage);
    if (this.totalBytes !== null) this.totalBytes += totalBytesOf(usage);
    return usage;
  }

  private addBytes(usage: QueueUsage, field: 'pendingBytes' | 'retainedBytes' | 'deliveredIndexBytes', delta: number): void {
    const applied = Math.max(-usage[field], delta);
    usage[field] += applied;
    if (this.totalBytes !== null) this.totalBytes = Math.max(0, this.totalBytes + applied);
  }

  private readDeliveredIndex(queue: KeyQueue, usage: QueueUsage): void {
    const indexPath = join(queue.directory, DELIVERED_INDEX);
    if (!existsSync(indexPath)) return;
    const text = readFileSync(indexPath, 'utf-8');
    usage.deliveredIndexBytes = Buffer.byteLength(text);
    const lines = text.split('\n');
    // A crash mid-append can leave a cut last line; its event is pending still (the pending file is removed after the append).
    if (lines[lines.length - 1] !== '') {
      logger.warn('WIRE', 'The delivered index ends in a cut line; it is ignored (its event is still pending and is sent again, which its server key absorbs)', { client: queue.name });
    }
    for (const line of lines.slice(0, -1)) {
      const space = line.indexOf(' ');
      const deliveredAt = Number(line.slice(0, space));
      if (space <= 0 || !Number.isFinite(deliveredAt)) {
        logger.warn('WIRE', 'A delivered index line does not read; ignored', { client: queue.name });
        continue;
      }
      usage.delivered.set(line.slice(space + 1), deliveredAt);
    }
  }

  /** Rewrites a queue's delivered index from `usage.delivered` (prune and compaction). */
  private rewriteDeliveredIndex(queue: KeyQueue, usage: QueueUsage): void {
    const text = [...usage.delivered].map(([eventId, deliveredAt]) => deliveredIndexLine(eventId, deliveredAt)).join('');
    writeFileAtomic(join(queue.directory, DELIVERED_INDEX), Buffer.from(text), { mode: WIRE_GATEWAY_FILE_MODE });
    this.addBytes(usage, 'deliveredIndexBytes', Buffer.byteLength(text) - usage.deliveredIndexBytes);
  }

  /**
   * Delivers one queue's pending events in the order they were queued,
   * stopping at the first that must be retried. Files are read one at a time
   * (a long outage's backlog is never held in memory at once). The key's
   * record is looked up before every event, so a key removed during a pass
   * has nothing more sent.
   */
  private async drainQueue(queue: KeyQueue): Promise<void> {
    const label = queueLabel(queue);
    const pendingDirectory = join(queue.directory, PENDING);
    const retryWindowMs = this.options.retryWindowMs ?? HOOK_SPOOL_RETRY_WINDOW_MS;
    let target: SendTarget | null = null;

    for (const fileName of this.pendingFileNames(queue)) {
      // stop() was called: what is left waits for the next start.
      if (this.stopping) return;
      const path = join(pendingDirectory, fileName);
      const eventId = PENDING_NAME_PATTERN.exec(fileName)?.[3] ?? null;
      let entry: OutboxEntry;
      let size: number;
      try {
        const text = readFileSync(path, 'utf-8');
        size = Buffer.byteLength(text);
        entry = JSON.parse(text) as OutboxEntry;
        if (!eventId || entry.eventId !== eventId) throw new Error(`the file name does not match its event id (${String(entry.eventId)})`);
      } catch (error) {
        // An entry that does not read is moved aside, never deleted.
        logger.error('WIRE', 'Outbox entry does not read; moved to rejected/', { client: queue.name, file: fileName }, error instanceof Error ? error : new Error(String(error)));
        this.moveAside(queue, path, fileName, REJECTED, eventId);
        serverOutboxActivity.rejected++;
        continue;
      }
      if (this.now() - entry.enqueuedAtEpochMs > retryWindowMs) {
        logger.error('WIRE', 'Outbox event was not accepted within the retry window; moved to expired/', {
          client: queue.name, kind: entry.kind, eventId: entry.eventId, retryWindowMs,
        });
        this.moveAside(queue, path, `${entry.eventId}.json`, EXPIRED, entry.eventId, size);
        serverOutboxActivity.expired++;
        continue;
      }
      target = await this.targetToSendWith(queue, target);
      if (!target) return;
      const outcome = await this.send({
        url: `${target.identity.server.url}${entry.route}`,
        method: 'POST',
        jsonBody: entry.body,
        headers: { authorization: `Bearer ${target.identity.server.apiKey}` },
        timeoutMs: OUTBOX_DELIVERY_TIMEOUT_MS,
        maximumResponseBytes: OUTBOX_RESPONSE_MAXIMUM_BYTES,
        ...(target.connectAddress ? { connectAddress: target.connectAddress } : {}),
      });
      const { verdict, detail, keyProblem } = verdictOf(outcome);
      if (verdict === 'delivered') {
        this.markDelivered(queue, path, entry.eventId, size);
        serverOutboxActivity.delivered++;
        this.retryByQueue.delete(label);
        continue;
      }
      if (verdict === 'rejected') {
        logger.error('WIRE', 'The claude-mem server runtime refused an outbox event; moved to rejected/', {
          client: queue.name, kind: entry.kind, eventId: entry.eventId, route: entry.route, detail,
        });
        this.moveAside(queue, path, `${entry.eventId}.json`, REJECTED, entry.eventId, size);
        serverOutboxActivity.rejected++;
        continue;
      }
      serverOutboxActivity.retried++;
      const delayMs = this.noteFailure(label);
      const logContext = { client: queue.name, kind: entry.kind, eventId: entry.eventId, route: entry.route, detail, retryInMs: delayMs };
      if (keyProblem) {
        logger.error('WIRE', 'The claude-mem server runtime does not take this client key\'s server API key (wrong, revoked or not project-scoped); its events wait until the key is fixed (claude-mem wire keys remove, then keys add)', logContext);
      } else {
        logger.warn('WIRE', 'Outbox delivery failed; retrying with backoff', logContext);
      }
      return;
    }
  }

  /**
   * The record to send a queue's next event with: its own, still in
   * keys.json, looked up again for every event. A record that is gone
   * (removed, or its name now another record's) moves every event of the
   * queue to rejected/, unsent; an unreadable keys.json or an http:// server
   * that is not private makes them wait. The server's address is resolved
   * (and checked) once per pass, again only when the record's server changes.
   */
  private async targetToSendWith(queue: KeyQueue, previous: SendTarget | null): Promise<SendTarget | null> {
    const label = queueLabel(queue);
    const lookup = this.options.lookupKey(queue.name);
    if (lookup.kind === 'unreadable') {
      const delayMs = this.noteFailure(label);
      logger.warn('WIRE', 'Outbox events wait: keys.json cannot be read', { client: queue.name, reason: lookup.reason, retryInMs: delayMs });
      return null;
    }
    if (lookup.kind === 'absent' || lookup.identity.keyId !== queue.id) {
      const moved = this.orphanQueue(queue);
      logger.error('WIRE', 'Outbox events of a removed client key moved to rejected/, never sent (its record and server API key are gone; a key added later under the same name is someone else\'s)', {
        client: queue.name, events: moved, nameNowHeldByAnotherKey: lookup.kind === 'found',
      });
      return null;
    }
    if (previous && sameServer(previous.identity, lookup.identity)) return previous;
    const resolved = await resolvePlainHttpServer(lookup.identity.server.url, this.options.resolveHost);
    if ('refusal' in resolved) {
      const delayMs = this.noteFailure(label);
      logger.error('WIRE', 'Outbox events wait: the client key\'s http:// server runtime is not on this host or a private network, so its server API key is not sent', { client: queue.name, reason: resolved.refusal, retryInMs: delayMs });
      return null;
    }
    return { identity: lookup.identity, connectAddress: resolved.connectAddress };
  }

  private orphanQueue(queue: KeyQueue): number {
    let moved = 0;
    for (const fileName of this.pendingFileNames(queue)) {
      const eventId = PENDING_NAME_PATTERN.exec(fileName)?.[3] ?? null;
      this.moveAside(queue, join(queue.directory, PENDING, fileName), eventId ? `${eventId}.json` : fileName, REJECTED, eventId);
      moved++;
    }
    serverOutboxActivity.orphaned += moved;
    serverOutboxActivity.rejected += moved;
    return moved;
  }

  private noteFailure(label: string): number {
    const failures = (this.retryByQueue.get(label)?.failures ?? 0) + 1;
    const base = this.options.retryBaseDelayMs ?? OUTBOX_RETRY_BASE_DELAY_MS;
    const max = this.options.retryMaxDelayMs ?? OUTBOX_RETRY_MAX_DELAY_MS;
    // The exponent stops at 30 only so 2 ** n stays a safe integer; the cap above is reached long before.
    const delayMs = Math.min(max, base * 2 ** Math.min(failures - 1, 30));
    this.retryByQueue.set(label, { failures, nextAttemptAt: this.now() + delayMs });
    return delayMs;
  }

  private markDelivered(queue: KeyQueue, pendingPath: string, eventId: string, size: number): void {
    const usage = this.usageOf(queue);
    const deliveredAt = this.now();
    const line = deliveredIndexLine(eventId, deliveredAt);
    const lineBytes = Buffer.byteLength(line);
    if (usage.deliveredIndexBytes + lineBytes > this.deliveredIndexMaxBytes) this.compactDeliveredIndex(queue, usage);
    // The marker holds no content: it only keeps a late re-emit a duplicate. Appended before the
    // pending file goes, so a crash between the two re-sends the event, which its server key absorbs.
    appendFileSync(join(queue.directory, DELIVERED_INDEX), line, { mode: WIRE_GATEWAY_FILE_MODE });
    usage.delivered.set(eventId, deliveredAt);
    this.addBytes(usage, 'deliveredIndexBytes', lineBytes);
    rmSync(pendingPath, { force: true });
    usage.pendingEventIds.delete(eventId);
    this.addBytes(usage, 'pendingBytes', -size);
  }

  /** The index at its cap: the newest half of its markers is kept, and how many went is logged. */
  private compactDeliveredIndex(queue: KeyQueue, usage: QueueUsage): void {
    const newestFirst = [...usage.delivered].sort((a, b) => b[1] - a[1]);
    const kept = new Map<string, number>();
    let keptBytes = 0;
    for (const [eventId, deliveredAt] of newestFirst) {
      const lineBytes = Buffer.byteLength(deliveredIndexLine(eventId, deliveredAt));
      if (keptBytes + lineBytes > this.deliveredIndexMaxBytes / 2) break;
      kept.set(eventId, deliveredAt);
      keptBytes += lineBytes;
    }
    const dropped = usage.delivered.size - kept.size;
    usage.delivered = new Map([...kept].reverse());
    this.rewriteDeliveredIndex(queue, usage);
    serverOutboxActivity.deliveredMarkersDropped += dropped;
    logger.warn('WIRE', 'A client key\'s delivered index reached its limit; its oldest markers were let go (an assembler re-emit of one of those events could be stored twice on the server)', {
      client: queue.name, dropped, kept: kept.size, limitBytes: this.deliveredIndexMaxBytes,
    });
  }

  /** Moves a pending file (content and all) to rejected/ or expired/: renamed, never rewritten or deleted. */
  private moveAside(queue: KeyQueue, pendingPath: string, targetName: string, state: string, eventId: string | null, size?: number): void {
    const usage = this.usageOf(queue);
    const directory = join(queue.directory, state);
    mkdirSync(directory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    const bytes = size ?? fileSizeOrZero(pendingPath);
    renameSync(pendingPath, join(directory, targetName));
    if (eventId) usage.pendingEventIds.delete(eventId);
    this.addBytes(usage, 'pendingBytes', -bytes);
    this.addBytes(usage, 'retainedBytes', bytes);
  }

  /**
   * Retention (the recordings'): rejected/ and expired/ entries (they hold
   * prompts and tool output), legacy per-event marker files, and the
   * delivered markers whose server key holds no time are deleted once older;
   * other markers are kept (the rule above).
   */
  prune(): void {
    const cutoff = this.now() - this.options.retentionMs;
    for (const queue of this.queues()) {
      const usage = this.usageOf(queue);
      for (const state of [REJECTED, EXPIRED, LEGACY_DELIVERED]) {
        const directory = join(queue.directory, state);
        for (const fileName of this.listJsonFiles(directory)) {
          const path = join(directory, fileName);
          try {
            const stats = statSync(path);
            if (stats.mtimeMs >= cutoff) continue;
            rmSync(path, { force: true });
            this.addBytes(usage, 'retainedBytes', -stats.size);
          } catch (error) {
            logger.warn('WIRE', 'Could not prune an outbox file', { client: queue.name, state, file: fileName, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      let prunedMarkers = 0;
      for (const [eventId, deliveredAt] of usage.delivered) {
        if (deliveredAt < cutoff && TIME_FREE_SERVER_KEY_KINDS.some(kind => eventId.startsWith(`${kind}-`))) {
          usage.delivered.delete(eventId);
          prunedMarkers++;
        }
      }
      if (prunedMarkers > 0) this.rewriteDeliveredIndex(queue, usage);
    }
  }
}

function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    logger.warn('WIRE', 'Outbox file size unknown; its byte count may read low until the next restart', { path, error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

