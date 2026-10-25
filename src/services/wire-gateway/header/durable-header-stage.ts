// SPDX-License-Identifier: Apache-2.0
//
// The durable header (Endless Mode v2, plan Phase 3): the owner's
// rule-scoped markdown (GET /api/wire/header, MY-RULES.md narrowed to the
// agent's folder) goes into the system prompt of a conversation born under
// the gateway, wrapped in <claude-mem-rules>, before claude-mem's
// <claude-mem-context> block. It is frozen in the conversation ledger and
// put back byte for byte on every request, so it sits in the cached head.
//
// The rules, each from the plan and the owner's spec:
// - The conversation's first request asks the worker, within
//   CONTEXT_TIMEOUT_MS, as memory injection does. No answer: the
//   conversation starts with no header.
// - "If one is updated, that busts cache on next turn": every user-turn
//   start asks again within the same budget, and an answer whose hash
//   differs from the header in force is recorded as the next header. Without
//   an answer in time, the header in force stays. A request within a turn
//   (mid tool-loop) never asks and never changes it.
// - Anthropic: a new header changes the system prompt, which every earlier
//   thinking block was signed against (prefix binding), so the request that
//   records it first records `thinkingCut {untilTurnOrdinal: <this turn>}`
//   (held writes commit in order, with no rollback), and every request
//   applies the cut in force.
// - Positions are user-turn ordinals, never message indexes, which shift
//   on compaction, rewind, culls and an inserted Chat system message.
// - A request that already holds the My Rules file (the agent loads it
//   natively) gets no header: the rules would be there twice.
// - Appended with memory injection's per-protocol logic; this stage runs
//   before memory injection, so the header lands before the timeline.
// - Once a header with text has gone out, a request that goes without it
//   (the stage turned off) suspends the stage for the conversation.
// - Any failure leaves the bytes as they came (the seam fails open, D7.7).

import { logger } from '../../../utils/logger.js';
import type { WireRequest } from '../ir/types.js';
import { applyByteSplices } from '../json/byte-splices.js';
import { requestStartsConversation, type WireConversationLedgerView, type WireLedgerEntry } from '../ledger/conversation-ledger.js';
import { DEFAULT_CONTEXT_TIMEOUT_MS, appendToSystemPrompt, tagWrappedBlock, wireRouteFeatureEnabledFor } from '../memory/memory-injection-stage.js';
import { fetchDurableHeaderFromWorker, type DurableHeaderAnswer, type DurableHeaderFetcher } from '../memory/memory-worker-client.js';
import { estimateTextTokens } from '../metrics/context-buckets.js';
import type { WireGatewayRoute } from '../routes.js';
import { STAGE_BUDGET_MARGIN_MS, type WireRewriteContext, type WireRewriteStage } from '../rewrite/rewrite-stage.js';
import { thinkingCutInForce, thinkingCutSplices } from '../rewrite/thinking-drop.js';

export const DURABLE_HEADER_STAGE_NAME = 'durable-header';

/** On for `captureSource: 'wire'` routes unless 'false'; a route's `features.durableHeader` wins. Read at gateway start. */
export const DURABLE_HEADER_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER';

const RULES_TAG_NAME = 'claude-mem-rules';

/** The line MY-RULES.md opens with (src/services/work-view/my-rules.mjs renderRulesFile): its presence means the agent loaded the file itself. */
export const MY_RULES_FILE_MARKER = 'Written by claude-mem from the rules I set or approved';

/**
 * The hash of a header recorded with no answer from the worker (it was
 * down, the folder unknown, or the stage first saw the conversation after
 * its first request). The worker's hashes are sha256 hex, never '', so the
 * first answer a later turn start gets is taken up.
 */
const NO_ANSWER_HASH = '';

const SUSPENDED_ENTRY_ID = `suspended:${DURABLE_HEADER_STAGE_NAME}`;

type HeaderEntry = Extract<WireLedgerEntry, { type: 'header' }>;

/** Whether the header is on for a route (memory injection's rule, with `features.durableHeader` and its own setting). */
export function durableHeaderEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return wireRouteFeatureEnabledFor(route, settings, 'durableHeader', DURABLE_HEADER_SETTING);
}

/** The block as it is appended. */
export function durableHeaderBlock(rulesText: string): string {
  return tagWrappedBlock(RULES_TAG_NAME, rulesText);
}

/** The header in force: the one with the largest sequence number. */
export function headerInForce(ledger: WireConversationLedgerView): HeaderEntry | undefined {
  let inForce: HeaderEntry | undefined;
  for (const entry of ledger.entries()) {
    if (entry.type === 'header' && (!inForce || entry.sequence > inForce.sequence)) inForce = entry;
  }
  return inForce;
}

/** Whether the agent sent the My Rules file itself: in its system prompt or the user's own text (never a tool result). */
function requestHoldsMyRules(request: WireRequest): boolean {
  if (request.system.some(part => (part.text ?? '').includes(MY_RULES_FILE_MARKER))) return true;
  return request.messages.some(message => message.role !== 'assistant'
    && message.parts.some(part => part.kind === 'text' && (part.text ?? '').includes(MY_RULES_FILE_MARKER)));
}

export interface DurableHeaderStageOptions {
  /** CONTEXT_TIMEOUT_MS: how long the first request and each turn start wait for the worker. */
  contextTimeoutMs?: number;
  /** Test seam; defaults to the worker's /api/wire/header over direct-http. */
  fetchHeader?: DurableHeaderFetcher;
  now?: () => number;
}

export function createDurableHeaderStage(options: DurableHeaderStageOptions = {}): WireRewriteStage {
  const contextTimeoutMs = options.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const fetchHeader = options.fetchHeader ?? (query => fetchDurableHeaderFromWorker(query));
  const now = options.now ?? Date.now;

  return {
    name: DURABLE_HEADER_STAGE_NAME,
    budgetMs: contextTimeoutMs + STAGE_BUDGET_MARGIN_MS,
    enabledFor: durableHeaderEnabledFor,
    appliesTo: context => context.ledger?.status === 'born' && context.ledger.get(SUSPENDED_ENTRY_ID) === undefined,

    whileOff(ledger: WireConversationLedgerView) {
      if (ledger.status !== 'born' || ledger.get(SUSPENDED_ENTRY_ID)) return;
      if (!ledger.entries().some(entry => entry.type === 'header' && entry.text !== null)) return;
      ledger.record({ type: 'suspended', stage: DURABLE_HEADER_STAGE_NAME, at: new Date(now()).toISOString() });
      logger.debug('WIRE', 'The durable header was off for a conversation it had added to; it never adds to that conversation again', {
        conversationKey: ledger.conversationKey,
      });
    },

    async onRequest(context: WireRewriteContext, body: Uint8Array) {
      const ledger = context.ledger as WireConversationLedgerView;
      const request = context.requestOf(body);
      const turnOrdinal = context.identity.userTurnOrdinal;
      let cutUntilTurnOrdinal = request.protocol === 'anthropic' ? thinkingCutInForce(ledger) : null;

      let header = headerInForce(ledger);
      if (header === undefined) {
        // The first header: only the conversation's first request asks.
        const answer = requestStartsConversation(request, turnOrdinal) && !requestHoldsMyRules(request)
          ? await fetchedHeaderOrNull(fetchHeader, context, contextTimeoutMs)
          : null;
        header = ledger.record({
          type: 'header',
          text: answer?.text ? durableHeaderBlock(answer.text) : null,
          hash: answer?.hash ?? NO_ANSWER_HASH,
          sequence: 0,
          turnOrdinal,
        }) as HeaderEntry;
      } else if (context.identity.turnStart && !requestHoldsMyRules(request)) {
        // A turn start: a changed rule lands here, once.
        const answer = await fetchedHeaderOrNull(fetchHeader, context, contextTimeoutMs);
        if (answer && answer.hash !== header.hash) {
          const text = answer.text ? durableHeaderBlock(answer.text) : null;
          if (request.protocol === 'anthropic' && text !== header.text && (cutUntilTurnOrdinal === null || turnOrdinal > cutUntilTurnOrdinal)) {
            // Recorded before the header that needs it: held writes commit in order.
            ledger.record({ type: 'thinkingCut', untilTurnOrdinal: turnOrdinal });
            cutUntilTurnOrdinal = turnOrdinal;
          }
          header = ledger.record({ type: 'header', text, hash: answer.hash, sequence: header.sequence + 1, turnOrdinal }) as HeaderEntry;
        }
      }

      const cutSplices = cutUntilTurnOrdinal === null ? [] : thinkingCutSplices(request, cutUntilTurnOrdinal);
      let rewritten = cutSplices.length > 0 ? applyByteSplices(request.body, cutSplices) : request.body;
      if (header.text !== null) {
        const before = rewritten;
        rewritten = appendToSystemPrompt(rewritten === request.body ? request : context.requestOf(rewritten), header.text);
        if (rewritten !== before) context.estimates.injectedTokens += estimateTextTokens(header.text);
      }
      return rewritten === request.body ? undefined : rewritten;
    },
  };
}

/** The worker's header for the agent's folder; null (logged) when the folder is unknown or no answer came in time. */
async function fetchedHeaderOrNull(fetchHeader: DurableHeaderFetcher, context: WireRewriteContext, timeoutMs: number): Promise<DurableHeaderAnswer | null> {
  const workDir = context.identity.workDir;
  if (!workDir) {
    logger.debug('WIRE', 'Durable header not asked for: the agent\'s folder is unknown', { agentId: context.identity.agentId });
    return null;
  }
  try {
    return await fetchHeader({ workDir, timeoutMs });
  } catch (error) {
    logger.debug('WIRE', 'Durable header not had in time: the header in force stays', {
      agentId: context.identity.agentId, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
