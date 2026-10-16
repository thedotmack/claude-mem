// SPDX-License-Identifier: Apache-2.0
//
// The capture pipeline (plan D5, Phase 5): relay copy → recorder → assembler
// → neutral events → hook spool. It is a relay observer, so it sees the
// client-facing reply after it went out, outside every rewrite stage, and
// nothing it does can touch the reply. Native-first (D6): an exchange on a
// `captureSource:'native'` route is never `captured`, so it is neither
// recorded nor assembled.

import { logger } from '../../../utils/logger.js';
import { RelayReplyCollection } from '../ir/relay-reply-collection.js';
import { toRecorderParts } from '../ir/recorder-parts.js';
import { emptyWireUsage, type WireReply } from '../ir/types.js';
import { TurnTracker, createTurnTrackingRelayObserver } from '../identity/turn-tracker.js';
import type { WireIdentity } from '../identity/resolve-identity.js';
import {
  composeRelayObservers,
  type RelayExchange,
  type RelayExchangeResult,
  type RelayObserver,
  type RelayResponseStart,
} from '../relay/relay.js';
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

function replyWithNothing(): WireReply {
  return { text: '', toolCalls: [], thinking: '', sealed: [], usage: emptyWireUsage(), stop: null, endedCleanly: false };
}

/** The relay observer that records each captured exchange and hands it to the assembler. */
export function createWireCaptureObserver(options: WireCaptureObserverOptions): RelayObserver {
  const replyCollection = new RelayReplyCollection();
  const generationAtStartByExchange = new Map<string, number>();
  const isSessionCapturable = options.isSessionCapturable ?? (() => true);

  return {
    onExchangeStarted(exchange: RelayExchange) {
      if (!exchange.request || !isSessionCapturable(exchange.identity)) return;
      if (!replyCollection.begin(exchange)) return;
      generationAtStartByExchange.set(exchange.exchangeId, options.recorder.currentGeneration());
    },
    onResponseStarted(exchange: RelayExchange, response: RelayResponseStart) {
      replyCollection.responseStarted(exchange, response);
    },
    onResponseChunk(exchange: RelayExchange, chunk: Uint8Array) {
      replyCollection.chunk(exchange, chunk);
    },
    onExchangeFinished(exchange: RelayExchange, result: RelayExchangeResult) {
      const collected = replyCollection.finish(exchange);
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
}

export interface WireCapturePipeline {
  relayObserver: RelayObserver;
  assembler: WireCaptureAssembler;
  recorder: WireTurnRecorder;
  turnTracker: TurnTracker;
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
  // Recorder and assembler first, so a turn's last reply is assembled before its turn can end.
  const relayObserver = composeRelayObservers(
    createWireCaptureObserver({ recorder, assembler, isSessionCapturable: options.isSessionCapturable }),
    createTurnTrackingRelayObserver(turnTracker),
  );
  recorder.pruneRecordings();
  return {
    relayObserver,
    assembler,
    recorder,
    turnTracker,
    dispose() {
      turnTracker.dispose();
      recorder.dispose();
    },
  };
}
