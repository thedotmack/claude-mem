// SPDX-License-Identifier: Apache-2.0
//
// Where a user's turn ends (plan Phase 4 task 8). Ported from magpie's
// `turns` (internal/gateway/turndone.go:31-149, MIT, Copyright (c) 2026
// yetone).
//
// The gateway sees requests, not turns. A turn is the requests one agent's
// session sends from the user's prompt to its last reply: each reply that
// asks the agent to run a tool is followed by another request once the tool
// has run, and the last reply asks for none. So a session's turn is done
// when a final reply (no tool call, status < 400, ended cleanly) has ended,
// nothing of the session is in flight, and nothing more came for 4 s. Only
// `turn` requests count: a helper's or a subagent's last reply is not the
// turn's. A session idle for 30 minutes with nothing in flight is stale.
//
// Where this differs from magpie, on purpose: a session outlives its turn
// end so it can be reported stale (magpie forgets it silently), and stale
// sessions are also swept on a timer, not only when a request comes.

import { logger } from '../../../utils/logger.js';
import type { CompletedRelayExchange, RelayReplyConsumer } from '../ir/relay-reply-collection.js';
import type { RelayExchange } from '../relay/relay.js';
import type { WireIdentity } from './resolve-identity.js';

/** After a final reply, how long nothing more of the session may come before its turn is done. */
export const TURN_QUIET_MS = 4_000;
/** A session with nothing for this long, and nothing in flight, is stale. */
export const SESSION_STALE_MS = 30 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 60_000;

export interface WireTurnEnd {
  agentId: string;
  sessionId: string;
  workDir?: string;
  /** When the turn's first request began. */
  turnStartedAt: number;
  /** When its last reply ended. */
  lastReplyEndedAt: number;
}

export interface WireSessionStale {
  agentId: string;
  sessionId: string;
  lastActivityAt: number;
}

export interface TurnTrackerOptions {
  onTurnEnd: (turnEnd: WireTurnEnd) => void;
  onSessionStale: (stale: WireSessionStale) => void;
  turnQuietMs?: number;
  sessionStaleMs?: number;
  /** How often stale sessions are swept; 0 sweeps only when a request begins. */
  staleSweepIntervalMs?: number;
  now?: () => number;
}

interface TrackedSession {
  agentId: string;
  sessionId: string;
  /** null between a turn's end and the next request. */
  turnStartedAt: number | null;
  lastActivityAt: number;
  requestsInFlight: number;
  workDir?: string;
  quietTimer: ReturnType<typeof setTimeout> | null;
}

/** The identity fields the tracker keys and reports by. */
export type TurnTrackedIdentity = Pick<WireIdentity, 'agentId' | 'sessionId' | 'kind' | 'workDir'>;

function sessionKeyOf(identity: Pick<WireIdentity, 'agentId' | 'sessionId'>): string {
  return `${identity.agentId}\u0000${identity.sessionId}`;
}

function notify(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    logger.error('WIRE', 'Turn tracker listener failed', {}, error instanceof Error ? error : new Error(String(error)));
  }
}

export class TurnTracker {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly options: TurnTrackerOptions;
  private readonly turnQuietMs: number;
  private readonly sessionStaleMs: number;
  private readonly now: () => number;
  private readonly sweepInterval: ReturnType<typeof setInterval> | null;

  constructor(options: TurnTrackerOptions) {
    this.options = options;
    this.turnQuietMs = options.turnQuietMs ?? TURN_QUIET_MS;
    this.sessionStaleMs = options.sessionStaleMs ?? SESSION_STALE_MS;
    this.now = options.now ?? Date.now;
    const sweepIntervalMs = options.staleSweepIntervalMs ?? STALE_SWEEP_INTERVAL_MS;
    this.sweepInterval = sweepIntervalMs > 0 ? setInterval(() => this.sweepStaleSessions(), sweepIntervalMs) : null;
    this.sweepInterval?.unref?.();
  }

  /** A request of the session's turn begins. Requests of any other kind are ignored. */
  begin(identity: TurnTrackedIdentity): void {
    if (identity.kind !== 'turn') return;
    this.sweepStaleSessions();
    const now = this.now();
    const key = sessionKeyOf(identity);
    let session = this.sessions.get(key);
    if (!session) {
      session = { agentId: identity.agentId, sessionId: identity.sessionId, turnStartedAt: null, lastActivityAt: now, requestsInFlight: 0, quietTimer: null };
      this.sessions.set(key, session);
    }
    if (session.turnStartedAt === null) session.turnStartedAt = now;
    if (identity.workDir !== undefined) session.workDir = identity.workDir;
    // The agent went on: not done yet.
    this.stopQuietTimer(session);
    session.requestsInFlight++;
    session.lastActivityAt = now;
  }

  /**
   * A request of the session's turn ended; `finalReply` when its reply went
   * whole to the agent, called no tool and was not an error.
   */
  end(identity: TurnTrackedIdentity, finalReply: boolean): void {
    if (identity.kind !== 'turn') return;
    const session = this.sessions.get(sessionKeyOf(identity));
    if (!session) return;
    const now = this.now();
    session.requestsInFlight = Math.max(session.requestsInFlight - 1, 0);
    session.lastActivityAt = now;
    if (session.requestsInFlight > 0 || !finalReply || session.turnStartedAt === null) return;
    const turnStartedAt = session.turnStartedAt;
    this.stopQuietTimer(session);
    const quietTimer = setTimeout(() => {
      if (session.quietTimer !== quietTimer) return; // stopped, or another took its place
      session.quietTimer = null;
      session.turnStartedAt = null;
      const turnEnd: WireTurnEnd = { agentId: session.agentId, sessionId: session.sessionId, turnStartedAt, lastReplyEndedAt: now };
      if (session.workDir !== undefined) turnEnd.workDir = session.workDir;
      notify(() => this.options.onTurnEnd(turnEnd));
    }, this.turnQuietMs);
    quietTimer.unref?.();
    session.quietTimer = quietTimer;
  }

  /** Report and forget sessions idle past the stale limit with nothing in flight. */
  sweepStaleSessions(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.requestsInFlight > 0 || now - session.lastActivityAt <= this.sessionStaleMs) continue;
      this.stopQuietTimer(session);
      this.sessions.delete(key);
      notify(() => this.options.onSessionStale({ agentId: session.agentId, sessionId: session.sessionId, lastActivityAt: session.lastActivityAt }));
    }
  }

  /** Stop every timer. Pending turn ends are dropped. */
  dispose(): void {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
    for (const session of this.sessions.values()) this.stopQuietTimer(session);
    this.sessions.clear();
  }

  private stopQuietTimer(session: TrackedSession): void {
    if (session.quietTimer) clearTimeout(session.quietTimer);
    session.quietTimer = null;
  }
}

/**
 * Feeds a TurnTracker from the shared reply collection: `begin` when a
 * captured turn request starts, `end` when it finishes. A reply is final
 * when its status is under 400, it ended whole, the collector saw it end
 * cleanly with no error (an `error` event after HTTP 200 is not a final
 * reply), no tool call was seen, and the capture copy did not overflow (an
 * overflowed scan may have missed a call).
 */
export function createTurnTrackingConsumer(turnTracker: TurnTracker): RelayReplyConsumer {
  const trackedExchangeIds = new Set<string>();
  return {
    onExchangeStarted(exchange: RelayExchange) {
      // Only a captured exchange's reply is read for the turn (a native route is never captured).
      if (exchange.identity.kind !== 'turn' || !exchange.captured || !exchange.protocol) return;
      trackedExchangeIds.add(exchange.exchangeId);
      turnTracker.begin(exchange.identity);
    },
    onExchangeCompleted({ exchange, result, collected }: CompletedRelayExchange) {
      if (!trackedExchangeIds.delete(exchange.exchangeId)) return;
      const reply = collected?.reply ?? null;
      const finalReply = result.recordedStatus < 400
        && result.outcome === 'complete'
        && !result.captureOverflowed
        && collected !== null
        && !collected.calledTool
        && reply !== null
        && reply.endedCleanly
        && reply.error === undefined;
      turnTracker.end(exchange.identity, finalReply);
    },
  };
}
