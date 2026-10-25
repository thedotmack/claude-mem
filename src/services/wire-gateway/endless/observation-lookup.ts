// SPDX-License-Identifier: Apache-2.0
//
// Which tool calls already have an observation (plan Phase 11 task 1;
// Endless Mode v2 Phase 4). Endless Mode culls a call's work only when an
// observation exists, and it never waits for one (§0.5: every earlier attempt hung its agent waiting
// on observations). So the request path reads only this cache, and
// lookups run in the background: a stage asks for a refresh and goes on
// at once; whatever the worker answers is there for a later request.
//
// The cache follows magpie's image-description cache (internal/gateway/
// vision.go:254-430, MIT, Copyright (c) 2026 yetone): keyed by what is
// looked up, one lookup in flight per conversation (a second ask joins it),
// and a failure is never cached: after a short wait the next request asks
// again. A result with no observation yet is not cached as missing either
// (it may get one later); it is asked about again after a wait that doubles
// each time, up to ten minutes.
//
// The worker is asked through POST /api/wire/tool-observations, which
// answers with each linked tool use's observation, of which the gateway
// reads its id and one-line timeline entry, and never the tools' bodies. The link is tool_uses.observation_id: the
// FIRST observation of the batch the call was summarized in
// (ResponseProcessor.ts:754-786). It is a loopback call, made over
// direct-http.ts so a proxy in the environment never stands between the
// gateway and its worker.

import { buildWorkerUrl } from '../../../shared/worker-utils.js';
import { logger } from '../../../utils/logger.js';
import { requestJsonDirectly } from '../direct-http.js';

/** The observation a tool call produced, as the worker answers it (the worker sends title, narrative and facts too; nothing here reads them). */
export interface WireToolObservation {
  observationId: number;
  /** Its row in the session-start timeline (`#<id> <time> <icon> <title>`), rendered by the worker: what a cull puts in place of the work. */
  timelineLine: string;
}

export interface WireToolObservationQuery {
  /** The session the tool uses were captured under (tool_uses.content_session_id). */
  contentSessionId: string;
  /** The agent id; the worker normalizes it as it did when capturing. */
  platformSource: string;
  toolUseIds: string[];
}

/** tool_use_id → its observation, for the ids that have one. Throws when the worker cannot be asked. */
export type WireToolObservationFetcher = (query: WireToolObservationQuery) => Promise<Map<string, WireToolObservation>>;

/** The worker route takes at most this many ids at once. */
const TOOL_USE_IDS_PER_WORKER_REQUEST = 500;
const WORKER_LOOKUP_TIMEOUT_MS = 5_000;

interface ToolObservationsAnswer {
  observations?: Array<{ toolUseId?: unknown; observationId?: unknown; timelineLine?: unknown }>;
}

/**
 * The worker's answer for `query` (POST /api/wire/tool-observations).
 * Throws when the worker cannot be asked. `workerUrlOf` is a test seam
 * (defaults to the configured worker address).
 */
export async function fetchToolObservationsFromWorker(
  query: WireToolObservationQuery,
  workerUrlOf: (apiPath: string) => string = buildWorkerUrl,
): Promise<Map<string, WireToolObservation>> {
  const found = new Map<string, WireToolObservation>();
  for (let start = 0; start < query.toolUseIds.length; start += TOOL_USE_IDS_PER_WORKER_REQUEST) {
    const apiPath = '/api/wire/tool-observations';
    const answer = await requestJsonDirectly<ToolObservationsAnswer>({
      url: workerUrlOf(apiPath),
      method: 'POST',
      jsonBody: {
        platformSource: query.platformSource,
        contentSessionId: query.contentSessionId,
        toolUseIds: query.toolUseIds.slice(start, start + TOOL_USE_IDS_PER_WORKER_REQUEST),
      },
      timeoutMs: WORKER_LOOKUP_TIMEOUT_MS,
    });
    if (!answer) throw new Error(`the worker did not answer ${apiPath}`);
    if (answer.statusCode !== 200 || !Array.isArray(answer.body?.observations)) {
      throw new Error(`the worker answered ${apiPath} with HTTP ${answer.statusCode}`);
    }
    for (const row of answer.body.observations) {
      // A row with no timeline line (a worker older than Endless Mode v2) is taken as no observation: the gateway never renders the line itself.
      if (typeof row.toolUseId !== 'string' || typeof row.observationId !== 'number' || !Number.isInteger(row.observationId)) continue;
      if (typeof row.timelineLine !== 'string' || row.timelineLine === '') continue;
      found.set(row.toolUseId, { observationId: row.observationId, timelineLine: row.timelineLine });
    }
  }
  return found;
}

/** Conversations whose answers are kept; the least recently used is let go past this. */
const CACHED_CONVERSATIONS_MAX = 2_000;
/** A tool use with no observation yet is asked about again after this, doubling each time it is still missing… */
export const OBSERVATION_MISS_BACKOFF_BASE_MS = 5_000;
/** … up to this. */
const OBSERVATION_MISS_BACKOFF_MAX_MS = 10 * 60_000;

export interface WireObservationLookupOptions {
  fetchToolObservations?: WireToolObservationFetcher;
  /** Test seam: the first wait after a miss, and after a failed lookup. */
  missBackoffBaseMs?: number;
  now?: () => number;
}

interface MissedToolUse {
  misses: number;
  askAgainAt: number;
}

interface ConversationObservations {
  byToolUseId: Map<string, WireToolObservation>;
  missedByToolUseId: Map<string, MissedToolUse>;
  refreshInFlight: Promise<void> | null;
  /** After a failed lookup (the worker down), nothing is asked before this. */
  retryAfter: number;
}

export class WireObservationLookup {
  private readonly fetchToolObservations: WireToolObservationFetcher;
  private readonly missBackoffBaseMs: number;
  private readonly now: () => number;
  private readonly conversations = new Map<string, ConversationObservations>();

  constructor(options: WireObservationLookupOptions = {}) {
    this.fetchToolObservations = options.fetchToolObservations ?? (query => fetchToolObservationsFromWorker(query));
    this.missBackoffBaseMs = options.missBackoffBaseMs ?? OBSERVATION_MISS_BACKOFF_BASE_MS;
    this.now = options.now ?? Date.now;
  }

  /** The conversation's entry, made the most recently used. */
  private conversationOf(conversationKey: string): ConversationObservations {
    let conversation = this.conversations.get(conversationKey);
    if (conversation) {
      this.conversations.delete(conversationKey);
    } else {
      conversation = { byToolUseId: new Map(), missedByToolUseId: new Map(), refreshInFlight: null, retryAfter: Number.NEGATIVE_INFINITY };
      if (this.conversations.size >= CACHED_CONVERSATIONS_MAX) {
        this.conversations.delete(this.conversations.keys().next().value as string);
      }
    }
    this.conversations.set(conversationKey, conversation);
    return conversation;
  }

  /** The observation already known for a tool use; never asks anyone. */
  cached(conversationKey: string, toolUseId: string): WireToolObservation | undefined {
    return this.conversations.get(conversationKey)?.byToolUseId.get(toolUseId);
  }

  /**
   * Ask, in the background, about the tool uses not known yet. Returns at
   * once; never throws. A conversation already being asked about is not
   * asked again now; a tool use found missing is asked again only after its
   * backoff, and nothing is asked for a while after a failed lookup. The
   * returned promise (for tests) settles when this lookup is over.
   */
  requestRefresh(conversationKey: string, query: WireToolObservationQuery): Promise<void> {
    const conversation = this.conversationOf(conversationKey);
    if (conversation.refreshInFlight) return conversation.refreshInFlight;
    const now = this.now();
    if (now < conversation.retryAfter) return Promise.resolve();
    const toolUseIdsToAsk = [...new Set(query.toolUseIds)].filter(toolUseId =>
      !conversation.byToolUseId.has(toolUseId) && (conversation.missedByToolUseId.get(toolUseId)?.askAgainAt ?? now) <= now);
    if (toolUseIdsToAsk.length === 0) return Promise.resolve();
    const refresh = (async () => {
      try {
        const found = await this.fetchToolObservations({ ...query, toolUseIds: toolUseIdsToAsk });
        const answeredAt = this.now();
        for (const toolUseId of toolUseIdsToAsk) {
          const observation = found.get(toolUseId);
          if (observation) {
            conversation.byToolUseId.set(toolUseId, observation);
            conversation.missedByToolUseId.delete(toolUseId);
            continue;
          }
          const misses = (conversation.missedByToolUseId.get(toolUseId)?.misses ?? 0) + 1;
          const backoffMs = Math.min(this.missBackoffBaseMs * 2 ** (misses - 1), OBSERVATION_MISS_BACKOFF_MAX_MS);
          conversation.missedByToolUseId.set(toolUseId, { misses, askAgainAt: answeredAt + backoffMs });
        }
      } catch (error) {
        // Not cached as a miss: asked again once the wait is over.
        conversation.retryAfter = this.now() + this.missBackoffBaseMs;
        logger.debug('WIRE', 'Endless Mode could not look observations up; nothing new is culled until it can', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        conversation.refreshInFlight = null;
      }
    })();
    conversation.refreshInFlight = refresh;
    return refresh;
  }
}
