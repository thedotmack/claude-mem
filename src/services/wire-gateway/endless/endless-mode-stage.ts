// SPDX-License-Identifier: Apache-2.0
//
// Endless Mode at the wire (plan Phase 11, D7): in a conversation born under
// the gateway, an old, bulky tool result whose observation already exists is
// replaced by that observation's text. The replacement is frozen in the
// conversation ledger the first time it is made and put back byte for byte
// on every later request (and after a restart), so the vendor's cache prefix
// changes once, at a turn boundary, and then holds.
//
// The rules, each from the plan:
// - New swaps are added only on a request that starts a user turn, never
//   mid tool-loop (D7.5). Swaps already in the ledger are put back on every
//   request, mid-loop ones included: they are the history the model has
//   seen since (D7.2).
// - Only a result's content value is replaced; ids, order and pairing stay
//   (tool-result-sites.ts). A result is swapped only when its call is in the
//   request too.
// - The agent never waits: observations come from a cache a background
//   lookup fills (observation-lookup.ts); no observation, no swap (§0.5).
// - Anthropic: shortening an earlier tool_result invalidates thinking blocks
//   replayed after it (report 07 §2.2), so the thinking and
//   redacted_thinking blocks of the assistant messages after the earliest
//   new swap are dropped, as Claude Code's own retry drops them (§2.3). An
//   assistant message that would be left empty means no new swaps this turn.
// - Responses `reasoning` items and Gemini `thoughtSignature` parts are
//   never touched; neither are `system` and `tools`.
// - Any failure leaves the bytes as they came (the seam fails open, D7.7).

import { createHash } from 'crypto';
import { logger } from '../../../utils/logger.js';
import { contentSessionIdOf } from '../capture/capture-assembler.js';
import { ScannedObject } from '../ir/scanned-object.js';
import type { WireRequest } from '../ir/types.js';
import { applyByteSplices, type ByteSplice } from '../json/byte-splices.js';
import { arrayItemRemovalSplices, encodeJsonString } from '../json/splice.js';
import type { WireConversationLedgerView, WireLedgerEntry } from '../ledger/conversation-ledger.js';
import { estimateTextTokens } from '../metrics/context-buckets.js';
import type { WireGatewayRoute } from '../routes.js';
import type { WireRewriteContext, WireRewriteStage } from '../rewrite/rewrite-stage.js';
import type { WireObservationLookup, WireSwapObservation } from './observation-lookup.js';
import { latestUserTurnStartIndex, toolResultSitesOf, type ToolResultSite } from './tool-result-sites.js';

export const ENDLESS_MODE_STAGE_NAME = 'endless-mode';

/**
 * Endless Mode's settings. All three are read by the gateway at start
 * (config.ts validates them; changing one needs `claude-mem wire restart`).
 * A route's `features.endlessMode` is read live.
 */
export const ENDLESS_MODE_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE';
/** A result is swapped once MORE than this many user turns have begun after it (0: any earlier turn). */
export const ENDLESS_MIN_AGE_TURNS_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS';
export const ENDLESS_MIN_RESULT_BYTES_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES';

/** A replacement is at most this many characters (plan Phase 11 task 3). */
export const ENDLESS_REPLACEMENT_MAX_CHARS = 4_000;

/** A call id longer than this is shown as its sha256 (magpie provider/codex_request.go:362-374 `BoundCallID`). */
const BOUND_CALL_ID_MAX_CHARS = 64;

/** Tool names that edit files whatever the agent: their results are the record of a change and are kept. */
const EDIT_TOOL_NAME_PATTERN = /edit|write|patch/i;

/** Whether Endless Mode is on for a route: its own `features.endlessMode`, else the setting (off by default, D9). */
export function endlessModeEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return route.features?.endlessMode ?? settings[ENDLESS_MODE_SETTING] === 'true';
}

/**
 * A call's id as it is shown: as it is when it fits 64 characters, else the
 * sha256 hex of it trimmed (magpie `BoundCallID`), so the same id always
 * reads the same.
 */
export function boundCallId(callId: string): string {
  if (callId.length <= BOUND_CALL_ID_MAX_CHARS) return callId;
  return createHash('sha256').update(callId.trim()).digest('hex');
}

function cutToMaxChars(text: string): string {
  const codePoints = [...text];
  return codePoints.length <= ENDLESS_REPLACEMENT_MAX_CHARS ? text : codePoints.slice(0, ENDLESS_REPLACEMENT_MAX_CHARS).join('');
}

/** The text a result is replaced by when its observation is shown here. */
export function observationReplacementText(toolName: string, callId: string, observation: WireSwapObservation): string {
  const lines = [`[claude-mem: this ${toolName} result (call_id=${boundCallId(callId)}) was replaced by observation #${observation.observationId}]`];
  if (observation.title !== '') lines.push(observation.title);
  if (observation.narrative !== '') lines.push(observation.narrative);
  for (const fact of observation.facts) lines.push(`- ${fact}`);
  return cutToMaxChars(lines.join('\n'));
}

/** The text a result is replaced by when an earlier result of its batch already shows its observation. */
export function coveredReplacementText(toolName: string, callId: string, observationId: number, firstCallId: string): string {
  return cutToMaxChars(`[claude-mem: this ${toolName} result (call_id=${boundCallId(callId)}) is covered by observation #${observationId} above (call_id=${boundCallId(firstCallId)})]`);
}

/** The content value a replacement is spliced in as: Gemini's `response` must be an object. */
function replacementValueJson(protocol: WireRequest['protocol'], replacementText: string): string {
  const text = encodeJsonString(replacementText);
  return protocol === 'gemini' ? `{"output":${text}}` : text;
}

const utf8Encoder = new TextEncoder();

function bytesEqual(bytes: Uint8Array, start: number, end: number, other: Uint8Array): boolean {
  if (end - start !== other.length) return false;
  for (let index = 0; index < other.length; index++) {
    if (bytes[start + index] !== other[index]) return false;
  }
  return true;
}

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

/** The splices that drop an assistant message's thinking blocks; null when the message would be left empty. */
function thinkingDropSplices(request: WireRequest, messageIndex: number): ByteSplice[] | null {
  const message = ScannedObject.of(request.body, request.messages[messageIndex].span);
  const contentSpan = message?.spanOf('content');
  if (contentSpan?.type !== 'array') return [];
  let kept = 0;
  const splices = arrayItemRemovalSplices(request.body, contentSpan, elementSpan => {
    const isThinking = THINKING_BLOCK_TYPES.has(ScannedObject.of(request.body, elementSpan)?.string('type') ?? '');
    if (!isThinking) kept++;
    return isThinking;
  });
  return splices.length > 0 && kept === 0 ? null : splices;
}

type ThinkingDropEntry = Extract<WireLedgerEntry, { type: 'thinkingDrop' }>;

/** The assistant messages whose thinking `drops` take out: after a boundary, before its end. */
function assistantMessagesToStripOfThinking(request: WireRequest, drops: ThinkingDropEntry[]): number[] {
  const indexes: number[] = [];
  request.messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant') return;
    if (drops.some(drop => messageIndex > drop.boundaryMessageIndex && messageIndex < drop.untilMessageIndex)) indexes.push(messageIndex);
  });
  return indexes;
}

/** Whether `drops` already take out everything `candidate` would (one of them spans its whole range). */
function dropIsCovered(drops: ThinkingDropEntry[], candidate: ThinkingDropEntry): boolean {
  return drops.some(drop => drop.boundaryMessageIndex <= candidate.boundaryMessageIndex && drop.untilMessageIndex >= candidate.untilMessageIndex);
}

const SUSPENDED_ENTRY_ID = `suspended:${ENDLESS_MODE_STAGE_NAME}`;

export interface EndlessModeStageOptions {
  observationLookup: WireObservationLookup;
  /** The agent's edit tools (its descriptor's `editToolNames`). */
  editToolNamesOf?: (agentId: string) => readonly string[];
  now?: () => number;
}

interface NewSwap {
  site: ToolResultSite;
  replacementText: string;
  observationId: number;
  coveredByCallId?: string;
}

export function createEndlessModeStage(options: EndlessModeStageOptions): WireRewriteStage {
  const now = options.now ?? Date.now;
  const editToolNamesOf = options.editToolNamesOf ?? (() => []);

  return {
    name: ENDLESS_MODE_STAGE_NAME,
    enabledFor: endlessModeEnabledFor,
    // A conversation whose swaps once went missing (the stage was off for one
    // of its requests) is never swapped again: the model has answered the
    // original history since, so putting the swaps back would rewrite it.
    appliesTo: context => context.ledger?.status === 'born' && context.ledger.get(SUSPENDED_ENTRY_ID) === undefined,

    whileOff(ledger) {
      if (ledger.status !== 'born' || ledger.get(SUSPENDED_ENTRY_ID)) return;
      if (!ledger.entries().some(entry => entry.type === 'swap')) return;
      ledger.record({ type: 'suspended', stage: ENDLESS_MODE_STAGE_NAME, at: new Date(now()).toISOString() });
      logger.debug('WIRE', 'Endless Mode was off for a conversation it had swapped; it never swaps that conversation again', {
        conversationKey: ledger.conversationKey,
      });
    },

    onRequest(context: WireRewriteContext, body: Uint8Array) {
      const ledger = context.ledger as WireConversationLedgerView;
      const request = context.requestOf(body);
      const minAgeTurns = Number(context.settings[ENDLESS_MIN_AGE_TURNS_SETTING]);
      const minResultBytes = Number(context.settings[ENDLESS_MIN_RESULT_BYTES_SETTING]);
      const editToolNames = new Set(editToolNamesOf(context.identity.agentId));
      const sites = toolResultSitesOf(request);
      const swapOf = (site: ToolResultSite) => {
        const entry = ledger.get(`swap:${site.callId}`);
        return entry?.type === 'swap' ? entry : undefined;
      };
      const mayBeSwapped = (site: ToolResultSite) => !site.isError
        && !site.hasImages
        && !site.hasCacheControl
        && !editToolNames.has(site.toolName)
        && !EDIT_TOOL_NAME_PATTERN.test(site.toolName)
        && site.contentSpan.end - site.contentSpan.start >= minResultBytes;

      // Ask in the background about results that may be swapped later; never waited for.
      const toolUseIdsToLookUp = sites.filter(site => mayBeSwapped(site) && !swapOf(site)).map(site => site.toolUseId);
      if (toolUseIdsToLookUp.length > 0) {
        void options.observationLookup.requestRefresh(ledger.conversationKey, {
          contentSessionId: contentSessionIdOf(context.identity),
          platformSource: context.identity.agentId,
          toolUseIds: toolUseIdsToLookUp,
        });
      }

      // The swaps already made: put back as they were frozen.
      const replacementBySite = new Map<ToolResultSite, string>();
      const firstSiteShowingObservation = new Map<number, ToolResultSite>();
      for (const site of sites) {
        const swap = swapOf(site);
        if (!swap) continue;
        replacementBySite.set(site, swap.replacementText);
        if (swap.coveredByCallId === undefined && !firstSiteShowingObservation.has(swap.observationId)) firstSiteShowingObservation.set(swap.observationId, site);
      }

      // New swaps: only where the user's new turn begins (D7.5), of results
      // older than the minimum age (Gemini: earlier turns only, as every age
      // counted here is at least one turn).
      let newSwaps: NewSwap[] = [];
      if (context.identity.turnStart) {
        const callIdCounts = new Map<string, number>();
        for (const site of sites) callIdCounts.set(site.callId, (callIdCounts.get(site.callId) ?? 0) + 1);
        sites.forEach((site, siteIndex) => {
          if (replacementBySite.has(site) || callIdCounts.get(site.callId) !== 1) return;
          if (!(site.userTurnsAfter > minAgeTurns) || !mayBeSwapped(site)) return;
          const observation = options.observationLookup.cached(ledger.conversationKey, site.toolUseId);
          if (!observation) return;
          const firstSite = firstSiteShowingObservation.get(observation.observationId);
          const coveredAbove = firstSite !== undefined && sites.indexOf(firstSite) < siteIndex;
          const replacementText = coveredAbove
            ? coveredReplacementText(site.toolName, site.callId, observation.observationId, firstSite.callId)
            : observationReplacementText(site.toolName, site.callId, observation);
          // A swap must make the history smaller.
          if (utf8Encoder.encode(replacementValueJson(request.protocol, replacementText)).length >= site.contentSpan.end - site.contentSpan.start) return;
          if (!coveredAbove) firstSiteShowingObservation.set(observation.observationId, site);
          newSwaps.push({ site, replacementText, observationId: observation.observationId, ...(coveredAbove ? { coveredByCallId: firstSite.callId } : {}) });
        });
      }

      // Anthropic: the thinking to drop, decided before anything is recorded, so
      // a request that goes as it came leaves nothing new in the ledger.
      const recordedDrops = request.protocol === 'anthropic'
        ? ledger.entries().filter((entry): entry is ThinkingDropEntry => entry.type === 'thinkingDrop')
        : [];
      const thinkingSplicesFor = (drops: ThinkingDropEntry[]): ByteSplice[] | null => {
        const splices: ByteSplice[] = [];
        for (const messageIndex of assistantMessagesToStripOfThinking(request, drops)) {
          const dropSplices = thinkingDropSplices(request, messageIndex);
          if (dropSplices === null) return null;
          splices.push(...dropSplices);
        }
        return splices;
      };
      let thinkingSplices = thinkingSplicesFor(recordedDrops);
      if (thinkingSplices === null) {
        // Never send an empty assistant message: the request goes as it came,
        // and since the model then answers the original history, the
        // conversation is never swapped again (as when the stage is off).
        ledger.record({ type: 'suspended', stage: ENDLESS_MODE_STAGE_NAME, at: new Date(now()).toISOString() });
        logger.debug('WIRE', 'Endless Mode sent a request unswapped and suspended the conversation: a recorded thinking drop would leave an assistant message empty', {
          agentId: context.identity.agentId, conversationKey: ledger.conversationKey,
        });
        return undefined;
      }
      let newThinkingDrop: ThinkingDropEntry | null = null;
      if (newSwaps.length > 0 && request.protocol === 'anthropic') {
        const candidate: ThinkingDropEntry = {
          type: 'thinkingDrop',
          boundaryMessageIndex: Math.min(...newSwaps.map(swap => swap.site.messageIndex)),
          untilMessageIndex: latestUserTurnStartIndex(request),
        };
        const alreadyCovered = dropIsCovered(recordedDrops, candidate);
        const withCandidate = alreadyCovered ? thinkingSplices : thinkingSplicesFor([...recordedDrops, candidate]);
        if (withCandidate === null) {
          logger.debug('WIRE', 'Endless Mode added no swaps this turn: dropping thinking would leave an assistant message empty', {
            agentId: context.identity.agentId, conversationKey: ledger.conversationKey,
          });
          newSwaps = [];
        } else {
          thinkingSplices = withCandidate;
          if (!alreadyCovered) newThinkingDrop = candidate;
        }
      }

      // Frozen first (first write wins), then applied as the ledger has them.
      const firstRequestAt = new Date(now()).toISOString();
      for (const swap of newSwaps) {
        const recorded = ledger.record({
          type: 'swap',
          callId: swap.site.callId,
          replacementText: swap.replacementText,
          firstRequestAt,
          observationId: swap.observationId,
          ...(swap.coveredByCallId !== undefined ? { coveredByCallId: swap.coveredByCallId } : {}),
        });
        if (recorded.type === 'swap') replacementBySite.set(swap.site, recorded.replacementText);
      }
      if (newThinkingDrop) ledger.record(newThinkingDrop);

      const splices: ByteSplice[] = [...thinkingSplices];
      let swappedTokens = 0;
      for (const [site, replacementText] of replacementBySite) {
        const replacement = utf8Encoder.encode(replacementValueJson(request.protocol, replacementText));
        if (bytesEqual(request.body, site.contentSpan.start, site.contentSpan.end, replacement)) continue;
        splices.push({ start: site.contentSpan.start, end: site.contentSpan.end, replacement });
        swappedTokens += Math.max(0, estimateTextTokens(site.text) - estimateTextTokens(replacementText));
      }
      if (splices.length === 0) return undefined;
      context.estimates.swappedTokens += swappedTokens;
      return applyByteSplices(request.body, splices);
    },
  };
}
