// SPDX-License-Identifier: Apache-2.0
//
// Exchanges from outside the relay — OTLP spans and magpie's recordings
// (plan Phase 13 tasks 2–3) — into the same assembler and turn tracker the
// relay feeds, so they become the same neutral events in the hook spool.
//
// Each exchange is captured once (D6). Which copy is taken follows magpie's
// actual behavior (verified in magpie's source at e297a8ab2):
// 1. An agent claude-mem already captures — a `captureSource:'wire'` route
//    for it, or claude-mem's native integration for it installed (Claude
//    Code always: D9) — is skipped by every outside source. When routes.json
//    cannot be read, whether the agent is wired is unknown, and unknown is
//    not "no" (§0.6): it is skipped.
// 2. magpie's OTLP spans, session and gateway alike, are all taken: magpie
//    makes them complementary itself. Its gateway withholds a call's span
//    only when the call is local, keyless, not `via` another magpie, not a
//    helper, and of a session its poller traces (internal/gateway/otel.go:
//    82-90, 24-35), which needs session export on (usage/otel_sessions.go:
//    28-36, 51-53, 115; off by default, settings/otel.go `Sessions`); every
//    other call gets its gateway span. So whatever magpie's settings, a call
//    is in a gateway span or in a session span, and no agent list is needed.
// 3. magpie's recordings (the follower) hold every gateway exchange that
//    names a session (internal/gateway/conversations.go:60-64), so they repeat
//    magpie's OTLP spans whenever those reach claude-mem too. A recorded line
//    is skipped when magpie's OTLP spans for its agent arrived within
//    FOREIGN_SOURCE_SETTLE_MS of the follower seeing the line (it waits that
//    long before deciding): magpie's export, with bodies, reaches claude-mem
//    and carries the exchange. Lines written while claude-mem was not running
//    (magpie's export to it failed then) are taken.
// 4. An agent that sends its own GenAI spans (service.name = the agent) is
//    taken from those: they hold all of its calls, through magpie or not.
//    magpie's copies of it are skipped while its own spans arrive.

import { logger } from '../../../utils/logger.js';
import { readWireGatewayRoutesFile } from '../routes.js';
import { currentAgentEnvironment } from '../agents/agent-paths.js';
import { loadAgentRegistry } from '../agents/agent-registry.js';
import type { AgentDescriptor, AgentEnvironment } from '../agents/types.js';
import { resolveIdentity, type WireIdentity } from '../identity/resolve-identity.js';
import { CLAUDE_MEM_SESSION_HEADER } from '../identity/session-id.js';
import type { TurnTracker } from '../identity/turn-tracker.js';
import type { WireReply, WireRequest } from '../ir/types.js';
import type { WireCaptureAssembler } from '../capture/capture-assembler.js';
import { paths } from '../../../shared/paths.js';

export type ForeignCaptureSource = 'otlp' | 'magpie';

/**
 * magpie's agent ids where claude-mem names the agent otherwise (magpie
 * internal/agent/*.go `ID`, claude-mem agents/builtin-agents.ts `id`); every
 * other id is the same in both.
 */
const MAGPIE_AGENT_ID_TO_CLAUDE_MEM: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  gemini: 'gemini-cli',
  agy: 'antigravity-cli',
  copilot: 'copilot-cli',
};

export function claudeMemAgentIdOfMagpieAgent(magpieAgentId: string): string {
  const normalized = magpieAgentId.trim().toLowerCase();
  return Object.hasOwn(MAGPIE_AGENT_ID_TO_CLAUDE_MEM, normalized) ? MAGPIE_AGENT_ID_TO_CLAUDE_MEM[normalized] : normalized;
}

/** The way an outside exchange came in. */
export type ForeignCaptureChannel =
  /** OTLP: a magpie session-poller span (it names `langfuse.session.id`). */
  | 'magpie_session_span'
  /** OTLP: a magpie gateway span (protocol bodies, no session id). */
  | 'magpie_gateway_span'
  /** The follower: a line of magpie's gateway recordings. */
  | 'magpie_recording'
  /** OTLP from any other emitter: the agent's own spans. */
  | 'otlp_other';

/**
 * How long one source's delivery for an agent counts as that source being on
 * for it, and how long the follower waits before deciding a line. magpie's
 * slowest path from a finished call to claude-mem is 19 s: its transcript
 * poll (2 s, usage/otel.go:61 `OTelSessionsEvery`), its export flush (5 s,
 * `OTelEvery`), and three send attempts of at most 3 s each with 1 s and 2 s
 * backoff between them (usage/otel.go:96, 289-330). 30 s covers that, the
 * follower's own 2 s look, and a flush that sends several body batches in
 * turn (usage/otel.go:252-262).
 */
export const FOREIGN_SOURCE_SETTLE_MS = 30_000;

/** What delivered an agent's work: magpie's OTLP spans, or the agent's own spans. */
export type ForeignDeliveryClass = 'magpie_otlp' | 'agent_otlp';

/** [first, last] delivery times (ms) of one source for one agent; deliveries less than the settle time apart join one interval. */
export type DeliveryInterval = [number, number];
export type ForeignDeliverySnapshot = Record<ForeignDeliveryClass, Record<string, DeliveryInterval[]>>;

function deliveryClassOf(channel: ForeignCaptureChannel): ForeignDeliveryClass | null {
  if (channel === 'magpie_session_span' || channel === 'magpie_gateway_span') return 'magpie_otlp';
  if (channel === 'otlp_other') return 'agent_otlp';
  return null;
}

/**
 * When each OTLP source delivered work for each agent: the real signal of how
 * magpie (and the agent) are set up, read from what claude-mem receives.
 */
export class ForeignSourceDeliveries {
  private readonly intervals: ForeignDeliverySnapshot = { magpie_otlp: {}, agent_otlp: {} };
  /** The follower's oldest undecided line looks back to here (null: no follower has said; -Infinity: just restored, keep all). */
  private followerKeepsSince: number | null = null;

  constructor(readonly settleMs: number = FOREIGN_SOURCE_SETTLE_MS) {}

  record(deliveryClass: ForeignDeliveryClass, agentId: string, at: number): void {
    const list = (this.intervals[deliveryClass][agentId] ??= []);
    const joined = list.find(([first, last]) => at >= first - this.settleMs && at <= last + this.settleMs);
    if (joined) {
      joined[0] = Math.min(joined[0], at);
      joined[1] = Math.max(joined[1], at);
    } else {
      list.push([at, at]);
      list.sort((a, b) => a[0] - b[0]);
    }
    // The OTLP receiver looks back one settle time; the follower as far as it said.
    this.dropEndingBefore(Math.min(this.followerKeepsSince ?? Infinity, at - this.settleMs));
  }

  /** Whether the source delivered work for the agent within the settle time of `at`. */
  deliveredAround(deliveryClass: ForeignDeliveryClass, agentId: string, at: number): boolean {
    return (this.intervals[deliveryClass][agentId] ?? []).some(([first, last]) => first <= at + this.settleMs && last >= at - this.settleMs);
  }

  /**
   * Drop what no decision can need any more: the follower's oldest undecided
   * line (or, with none, a decision now) looks back one settle time.
   */
  prune(oldestStillToDecideAt: number): void {
    this.followerKeepsSince = oldestStillToDecideAt - this.settleMs;
    this.dropEndingBefore(this.followerKeepsSince);
  }

  private dropEndingBefore(since: number): void {
    for (const byAgent of Object.values(this.intervals)) {
      for (const [agentId, list] of Object.entries(byAgent)) {
        const kept = list.filter(([, last]) => last >= since);
        if (kept.length === 0) delete byAgent[agentId];
        else byAgent[agentId] = kept;
      }
    }
  }

  snapshot(): ForeignDeliverySnapshot {
    return JSON.parse(JSON.stringify(this.intervals)) as ForeignDeliverySnapshot;
  }

  /** Merge what a previous run saw (the follower keeps it with its state), so lines seen then are decided as they would have been. */
  restore(snapshot: Partial<ForeignDeliverySnapshot> | undefined): void {
    // Kept whole until the follower next says how far back its undecided lines look.
    this.followerKeepsSince = -Infinity;
    for (const deliveryClass of ['magpie_otlp', 'agent_otlp'] as const) {
      for (const [agentId, list] of Object.entries(snapshot?.[deliveryClass] ?? {})) {
        for (const [first, last] of list) {
          this.record(deliveryClass, agentId, first);
          this.record(deliveryClass, agentId, last);
        }
      }
    }
  }
}

/** When and how a recorded line was seen: what rule 3 decides it by. */
export interface RecordingSighting {
  /** When the follower first saw the line (ms). */
  seenAt: number;
  /** Written while claude-mem was not running, or asked for by --backfill: no OTLP copy of it can be told apart, so it is taken. */
  unattended: boolean;
}

/** Why this copy is not the one taken (another source captures the agent's work), or null when it is. */
export type OtherCaptureSourceCheck = (agentId: string, channel: ForeignCaptureChannel, sighting?: RecordingSighting) => string | null;

export interface CaptureSourceRuleOptions {
  /** Test seams. */
  routesFilePath?: string;
  environment?: AgentEnvironment;
  descriptors?: AgentDescriptor[];
}

/** Rules 2-4 above: whether another outside copy of this agent's work is the one taken. */
export function otherOutsideCopyFor(
  agentId: string,
  channel: ForeignCaptureChannel,
  deliveries: ForeignSourceDeliveries,
  now: number,
  sighting?: RecordingSighting,
): string | null {
  const ownSpans = 'the agent sends its own GenAI spans, which hold all of its calls';
  if (channel === 'otlp_other') return null;
  if (channel === 'magpie_session_span' || channel === 'magpie_gateway_span') {
    return deliveries.deliveredAround('agent_otlp', agentId, now) ? ownSpans : null;
  }
  if (!sighting) throw new Error('a magpie recording is decided by when the follower saw it; none was given');
  if (sighting.unattended) return null;
  if (deliveries.deliveredAround('agent_otlp', agentId, sighting.seenAt)) return ownSpans;
  if (deliveries.deliveredAround('magpie_otlp', agentId, sighting.seenAt)) return 'magpie\'s OTLP spans for this agent reach claude-mem and carry this exchange';
  return null;
}

/**
 * A check for one batch (one OTLP post, one follower poll): routes.json and
 * the native integrations are read once per batch, never per span or line.
 */
export function otherCaptureSourceCheckForBatch(
  options: CaptureSourceRuleOptions = {},
  deliveries: ForeignSourceDeliveries = new ForeignSourceDeliveries(),
  now: () => number = Date.now,
): OtherCaptureSourceCheck {
  let wireAgentIds: Set<string> | null | undefined;
  let descriptors: AgentDescriptor[] | undefined = options.descriptors;
  const answerByAgent = new Map<string, string | null>();
  const claudeMemCaptures = (agentId: string): string | null => {
    const known = answerByAgent.get(agentId);
    if (known !== undefined) return known;
    if (wireAgentIds === undefined) {
      try {
        wireAgentIds = new Set(Object.values(readWireGatewayRoutesFile(options.routesFilePath ?? paths.wireGatewayRoutes()).routes)
          .filter(route => route.captureSource === 'wire')
          .map(route => route.agentId));
      } catch (error) {
        logger.warn('WIRE', 'routes.json could not be read, so no outside capture is taken until it can (an agent may be wired)', {},
          error instanceof Error ? error : new Error(String(error)));
        wireAgentIds = null;
      }
    }
    let answer: string | null;
    if (wireAgentIds === null) {
      answer = 'routes.json could not be read';
    } else if (wireAgentIds.has(agentId)) {
      answer = 'a claude-mem wire route captures this agent';
    } else {
      descriptors ??= loadAgentRegistry().descriptors;
      const descriptor = descriptors.find(candidate => candidate.id === agentId || (candidate.aliases ?? []).includes(agentId));
      answer = null;
      if (descriptor?.nativeIntegration) {
        try {
          if (descriptor.nativeIntegration.alwaysNative || descriptor.nativeIntegration.isInstalled(options.environment ?? currentAgentEnvironment())) {
            answer = 'claude-mem\'s native integration captures this agent';
          }
        } catch (error) {
          logger.warn('WIRE', 'Could not tell whether claude-mem\'s native integration is installed; not taking outside capture for the agent', { agentId },
            error instanceof Error ? error : new Error(String(error)));
          answer = 'whether claude-mem\'s native integration is installed is unknown';
        }
      }
    }
    answerByAgent.set(agentId, answer);
    return answer;
  };
  return (agentId, channel, sighting) => claudeMemCaptures(agentId)
    ?? otherOutsideCopyFor(agentId, channel, deliveries, now(), sighting);
}

/** Content-free counters per source, for `wire status`. */
export const foreignCaptureActivity: Record<ForeignCaptureSource, { exchanges: number; toolRuns: number; skippedOtherSource: number }> = {
  otlp: { exchanges: 0, toolRuns: 0, skippedOtherSource: 0 },
  magpie: { exchanges: 0, toolRuns: 0, skippedOtherSource: 0 },
};

export interface ForeignExchangeToCapture {
  source: ForeignCaptureSource;
  channel: ForeignCaptureChannel;
  agentId: string;
  /** The session the source names (magpie's `session`, `langfuse.session.id`, `gen_ai.conversation.id`); else it comes from the body or a fingerprint. */
  sessionId?: string;
  request: WireRequest;
  reply: WireReply | null;
  replyIsWhole: boolean;
  /** The reply ends the user's turn (no tool call, not an error): the turn tracker then summarizes it after its quiet. */
  finalReply: boolean;
  /** A recorded line: when the follower saw it (rule 3). */
  sighting?: RecordingSighting;
}

export interface ForeignToolRunToCapture {
  source: ForeignCaptureSource;
  channel: ForeignCaptureChannel;
  agentId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  argsText: string;
  resultText: string;
}

export type ForeignCaptureOutcome = 'captured' | 'skipped_other_source';

export interface WireForeignCaptureOptions {
  assembler: WireCaptureAssembler;
  turnTracker: TurnTracker;
  /** Test seams. */
  settleMs?: number;
  now?: () => number;
}

export class WireForeignCapture {
  /** What each OTLP source delivered, per agent: shared by the OTLP receiver and the follower. */
  readonly deliveries: ForeignSourceDeliveries;
  readonly now: () => number;

  constructor(private readonly options: WireForeignCaptureOptions) {
    this.deliveries = new ForeignSourceDeliveries(options.settleMs);
    this.now = options.now ?? Date.now;
  }

  /** The one-copy check for one batch (one OTLP post, one follower poll). */
  checkForBatch(rule: CaptureSourceRuleOptions = {}): OtherCaptureSourceCheck {
    return otherCaptureSourceCheckForBatch(rule, this.deliveries, this.now);
  }

  /** An OTLP copy says its source is on for the agent, whether or not this copy is taken. */
  private noteDelivery(channel: ForeignCaptureChannel, agentId: string): void {
    const deliveryClass = deliveryClassOf(channel);
    if (deliveryClass) this.deliveries.record(deliveryClass, agentId, this.now());
  }

  private identityOf(agentId: string, sessionId: string | undefined, request: WireRequest | null): WireIdentity {
    const headers = new Headers();
    if (sessionId) headers.set(CLAUDE_MEM_SESSION_HEADER, sessionId);
    return resolveIdentity({ agentId }, headers, request, { suffixPath: '' });
  }

  observeExchange(exchange: ForeignExchangeToCapture, otherCaptureSource: OtherCaptureSourceCheck): ForeignCaptureOutcome {
    const activity = foreignCaptureActivity[exchange.source];
    this.noteDelivery(exchange.channel, exchange.agentId);
    const otherSource = otherCaptureSource(exchange.agentId, exchange.channel, exchange.sighting);
    if (otherSource) {
      activity.skippedOtherSource++;
      logger.debug('WIRE', 'Outside exchange skipped: the agent is captured another way', { source: exchange.source, channel: exchange.channel, agentId: exchange.agentId, reason: otherSource });
      return 'skipped_other_source';
    }
    const identity = this.identityOf(exchange.agentId, exchange.sessionId, exchange.request);
    activity.exchanges++;
    // Same order as the relay's consumers: begin, assemble, end.
    this.options.turnTracker.begin(identity);
    try {
      this.options.assembler.observeExchange({ identity, request: exchange.request, reply: exchange.reply, replyIsWhole: exchange.replyIsWhole });
    } finally {
      this.options.turnTracker.end(identity, exchange.finalReply);
    }
    return 'captured';
  }

  observeToolRun(run: ForeignToolRunToCapture, otherCaptureSource: OtherCaptureSourceCheck): ForeignCaptureOutcome {
    const activity = foreignCaptureActivity[run.source];
    this.noteDelivery(run.channel, run.agentId);
    const otherSource = otherCaptureSource(run.agentId, run.channel);
    if (otherSource) {
      activity.skippedOtherSource++;
      logger.debug('WIRE', 'Outside tool run skipped: the agent is captured another way', { source: run.source, channel: run.channel, agentId: run.agentId, reason: otherSource });
      return 'skipped_other_source';
    }
    activity.toolRuns++;
    this.options.assembler.observeToolRun({
      identity: this.identityOf(run.agentId, run.sessionId, null),
      callId: run.callId,
      toolName: run.toolName,
      argsText: run.argsText,
      resultText: run.resultText,
    });
    return 'captured';
  }
}
