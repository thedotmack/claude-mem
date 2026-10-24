// SPDX-License-Identifier: Apache-2.0
//
// The capture pipeline (plan D5, Phase 5): relay copy → recorder → assembler
// → neutral events → hook spool, beside the turn tracker and the usage
// ledger (Phase 10), all fed by one reply collection. It is a relay
// observer, so it sees the client-facing reply after it went out, after
// every rewrite stage, and nothing it does can touch the reply. Native-first (D6): an exchange on a
// `captureSource:'native'` route is never `captured`, so it is neither
// recorded nor assembled.

import { logger } from '../../../utils/logger.js';
import { createReplyCollectingRelayObserver, type CompletedRelayExchange, type RelayReplyConsumer } from '../ir/relay-reply-collection.js';
import { toRecorderParts } from '../ir/recorder-parts.js';
import { emptyWireUsage, type WireReply } from '../ir/types.js';
import { TurnTracker, createTurnTrackingConsumer } from '../identity/turn-tracker.js';
import type { WireIdentity } from '../identity/resolve-identity.js';
import type { RelayExchange, RelayObserver } from '../relay/relay.js';
import { WireUsageLedger, createUsageLedgerConsumer } from '../metrics/usage-ledger.js';
import { WireCaptureAssembler } from './capture-assembler.js';
import { createHookSpoolCaptureEventSink, type WireCaptureEventSink } from './capture-event-sink.js';
import { WireTurnRecorder, type WireGatewayTurn, type WireRecordingConsent } from './turn-recorder.js';

export interface WireCaptureObserverOptions {
  recorder: WireTurnRecorder;
  assembler: WireCaptureAssembler;
  /**
   * Whether a session may be captured at all. Every session may today; the
   * shared team gateway (Phase 16) refuses `sessionSource:'fingerprint'`
   * there, since a guessed id must never be recorded in shared mode.
   */
  isSessionCapturable?: (identity: WireIdentity) => boolean;
}

/** 401 and 403 from the vendor: the agent's credential was refused. */
const UPSTREAM_REFUSED_CREDENTIAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

function replyWithNothing(): WireReply {
  return { text: '', toolCalls: [], thinking: '', sealed: [], usage: emptyWireUsage(), stop: null, endedCleanly: false };
}

/** The reply consumer that records each captured exchange and hands it to the assembler. */
export function createWireCaptureConsumer(options: WireCaptureObserverOptions): RelayReplyConsumer {
  const generationAtStartByExchange = new Map<string, number>();
  const isSessionCapturable = options.isSessionCapturable ?? (() => true);

  return {
    onExchangeStarted(exchange: RelayExchange) {
      // Native-first (D6): only a captured exchange is recorded or assembled.
      if (!exchange.captured || !exchange.protocol || !exchange.request || !isSessionCapturable(exchange.identity)) return;
      generationAtStartByExchange.set(exchange.exchangeId, options.recorder.currentGeneration());
    },
    onExchangeCompleted({ exchange, result, collected }: CompletedRelayExchange) {
      const generationAtStart = generationAtStartByExchange.get(exchange.exchangeId);
      generationAtStartByExchange.delete(exchange.exchangeId);
      if (!collected || !exchange.request || generationAtStart === undefined) return;
      const { identity, request } = exchange;
      const reply = collected.reply;
      const replyIsWhole = result.outcome === 'complete'
        && result.recordedStatus < 400
        && !result.captureOverflowed
        && reply !== null
        && reply.endedCleanly
        && reply.error === undefined;

      // Helper requests are never recorded (plan Phase 5 task 3).
      if (!identity.kind.startsWith('helper:') && options.recorder.isRecordingOn()) {
        // No reply (upstream unreachable, the client left first): the request alone.
        const parts = toRecorderParts(request, reply ?? replyWithNothing());
        const turn: WireGatewayTurn = {
          agent: identity.agentId,
          session: identity.sessionId,
          time: new Date(exchange.startedAt).toISOString(),
          model: reply?.model || request.model,
          status: result.recordedStatus,
          input: parts.input,
          output: parts.output,
          routeId: exchange.routeId,
          kind: identity.kind,
          requestId: exchange.exchangeId,
        };
        if (result.outcome !== 'complete' || result.captureOverflowed || collected.passedByteCap) turn.cut = true;
        if (identity.subagent !== undefined) turn.subagent = identity.subagent;
        if (identity.parentSessionId !== undefined) turn.parentSession = identity.parentSessionId;
        if (identity.workDir !== undefined) turn.workDir = identity.workDir;
        if (reply) turn.usage = reply.usage;
        options.recorder.save(turn, generationAtStart);
      }

      // The vendor refused the agent's credential: no model work happened, so
      // nothing of this exchange becomes memory (the agent re-sends the request
      // once its credential works, and that exchange is captured). On a shared
      // gateway this also keeps a member with a bogus credential from filling
      // the outbox with events built from request bodies the vendor never took.
      if (UPSTREAM_REFUSED_CREDENTIAL_STATUSES.has(result.recordedStatus)) {
        logger.debug('WIRE', 'Not captured: the vendor refused the agent\'s credential', { agentId: identity.agentId, routeId: exchange.routeId, status: result.recordedStatus });
        return;
      }
      try {
        options.assembler.observeExchange({ identity, request, reply, replyIsWhole });
      } catch (error) {
        logger.error('WIRE', 'Wire capture assembler failed on an exchange', { agentId: identity.agentId, routeId: exchange.routeId },
          error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export interface WireCapturePipelineOptions {
  retentionDays: number;
  consent?: WireRecordingConsent;
  /** Test seam; defaults to the hook spool plus a worker nudge. */
  eventSink?: WireCaptureEventSink;
  /** Test seam; defaults to <DATA_DIR>/wire-gateway/recordings. */
  recordingsDirectory?: string;
  /** Test seams for the turn tracker. */
  turnQuietMs?: number;
  sessionStaleMs?: number;
  staleSweepIntervalMs?: number;
  /** Test seam for the recorder's hourly cleanup. */
  recordingCleanupIntervalMs?: number;
  isSessionCapturable?: (identity: WireIdentity) => boolean;
  /** Test seam; defaults to <DATA_DIR>/wire-gateway/usage. */
  usageLedger?: WireUsageLedger;
  /** More readers of the same collected replies, after the pipeline's own (the live trace feed, Phase 13). */
  extraReplyConsumers?: RelayReplyConsumer[];
}

export interface WireCapturePipeline {
  relayObserver: RelayObserver;
  assembler: WireCaptureAssembler;
  recorder: WireTurnRecorder;
  turnTracker: TurnTracker;
  usageLedger: WireUsageLedger;
  /** Stop every timer. Turn ends still waiting for their quiet are dropped. */
  dispose(): void;
}

export function createWireCapturePipeline(options: WireCapturePipelineOptions): WireCapturePipeline {
  const assembler = new WireCaptureAssembler({ eventSink: options.eventSink ?? createHookSpoolCaptureEventSink() });
  const recorder = new WireTurnRecorder({
    consent: options.consent,
    retentionDays: options.retentionDays,
    recordingsDirectory: options.recordingsDirectory,
    cleanupIntervalMs: options.recordingCleanupIntervalMs,
  });
  const turnTracker = new TurnTracker({
    onTurnEnd: turnEnd => assembler.handleTurnEnd(turnEnd),
    onSessionStale: stale => assembler.handleSessionStale(stale),
    turnQuietMs: options.turnQuietMs,
    sessionStaleMs: options.sessionStaleMs,
    staleSweepIntervalMs: options.staleSweepIntervalMs,
  });
  const usageLedger = options.usageLedger ?? new WireUsageLedger({ retentionDays: options.retentionDays });
  // Each reply is collected once for every consumer. Recorder and assembler
  // first, so a turn's last reply is assembled before its turn can end.
  const relayObserver = createReplyCollectingRelayObserver([
    createWireCaptureConsumer({ recorder, assembler, isSessionCapturable: options.isSessionCapturable }),
    createTurnTrackingConsumer(turnTracker),
    createUsageLedgerConsumer(usageLedger),
    ...(options.extraReplyConsumers ?? []),
  ]);
  recorder.pruneRecordings();
  try {
    usageLedger.pruneExpired();
  } catch (error) {
    logger.warn('WIRE', 'Usage ledger cleanup failed', { directory: usageLedger.directory },
      error instanceof Error ? error : new Error(String(error)));
  }
  return {
    relayObserver,
    assembler,
    recorder,
    turnTracker,
    usageLedger,
    dispose() {
      turnTracker.dispose();
      recorder.dispose();
    },
  };
}
