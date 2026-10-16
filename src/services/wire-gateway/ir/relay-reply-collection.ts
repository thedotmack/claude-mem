// SPDX-License-Identifier: Apache-2.0
//
// The reply of each captured exchange in flight, rebuilt from the relay's
// copy (plan Phase 5): a reply collector (what the model said, and whether
// it ended in an error after HTTP 200) beside a tool-call scan (which still
// sees a call when the collector could not parse the reply). The gateway
// collects each reply once and hands it to every consumer that needs it
// (recorder and assembler, turn tracker, usage ledger: plan Phase 10). A
// reply past WIRE_REPLY_MAX_BYTES stops being collected (`passedByteCap`);
// the scan, which holds only a few bytes, still sees the whole reply.

import { logger } from '../../../utils/logger.js';
import type { RelayExchange, RelayExchangeResult, RelayObserver, RelayResponseStart } from '../relay/relay.js';
import { createWireReplyCollector, type WireReplyCollector, type WireReplyCollectorOptions } from './reply-collectors.js';
import { ToolCallScanner } from './tool-scan.js';
import type { WireReply } from './types.js';

export interface CollectedRelayReply {
  /** Null when upstream never answered (unreachable, or the client left first). */
  reply: WireReply | null;
  /** The reply asked the agent to run a tool (seen by the collector or the scan). */
  calledTool: boolean;
  /** The reply passed the collector's byte cap: what was collected is cut short and never ended cleanly. */
  passedByteCap: boolean;
}

interface ReplyInProgress {
  collector: WireReplyCollector | null;
  toolCallScanner: ToolCallScanner;
}

export class RelayReplyCollection {
  private readonly repliesInProgress = new Map<string, ReplyInProgress>();

  constructor(private readonly collectorOptions: WireReplyCollectorOptions = {}) {}

  /** Start collecting `exchange`'s reply. Only a metered exchange (a model call of a known protocol) gets chunks. */
  begin(exchange: RelayExchange): boolean {
    if (!exchange.metered || !exchange.protocol) return false;
    this.repliesInProgress.set(exchange.exchangeId, { collector: null, toolCallScanner: new ToolCallScanner() });
    return true;
  }

  responseStarted(exchange: RelayExchange, response: RelayResponseStart): void {
    const inProgress = this.repliesInProgress.get(exchange.exchangeId);
    if (!inProgress || !exchange.protocol) return;
    inProgress.collector = createWireReplyCollector(exchange.protocol, response.contentType, this.collectorOptions);
  }

  chunk(exchange: RelayExchange, chunk: Uint8Array): void {
    const inProgress = this.repliesInProgress.get(exchange.exchangeId);
    if (!inProgress) return;
    inProgress.toolCallScanner.observe(chunk);
    inProgress.collector?.push(chunk);
  }

  /** The reply as far as it went, or null when `exchange` was never collected. Forgets the exchange. */
  finish(exchange: RelayExchange): CollectedRelayReply | null {
    const inProgress = this.repliesInProgress.get(exchange.exchangeId);
    if (!inProgress) return null;
    this.repliesInProgress.delete(exchange.exchangeId);
    const reply = inProgress.collector ? inProgress.collector.finish() : null;
    return {
      reply,
      calledTool: inProgress.toolCallScanner.calledTool || (reply?.toolCalls.length ?? 0) > 0,
      passedByteCap: inProgress.collector?.passedByteCap ?? false,
    };
  }
}

/** One exchange once it is over, with its reply collected once for every consumer. */
export interface CompletedRelayExchange {
  exchange: RelayExchange;
  result: RelayExchangeResult;
  /** Null when the reply was not collected (not a metered exchange). */
  collected: CollectedRelayReply | null;
  /** When the first reply byte reached the observers; null when none did. */
  firstResponseChunkAt: number | null;
}

/** Something that reads replies: told when an exchange starts and once it is over. */
export interface RelayReplyConsumer {
  onExchangeStarted?(exchange: RelayExchange): void;
  onExchangeCompleted(completed: CompletedRelayExchange): void;
}

function notifyConsumer(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    logger.error('WIRE', 'A relay reply consumer failed', {}, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The relay observer that collects each metered reply once and hands every
 * consumer the result, in order. A consumer that throws does not stop the
 * others.
 */
export function createReplyCollectingRelayObserver(consumers: RelayReplyConsumer[], collectorOptions: WireReplyCollectorOptions = {}): RelayObserver {
  const replyCollection = new RelayReplyCollection(collectorOptions);
  const firstResponseChunkAtByExchange = new Map<string, number | null>();
  return {
    onExchangeStarted(exchange: RelayExchange) {
      if (replyCollection.begin(exchange)) firstResponseChunkAtByExchange.set(exchange.exchangeId, null);
      for (const consumer of consumers) {
        if (consumer.onExchangeStarted) notifyConsumer(() => consumer.onExchangeStarted!(exchange));
      }
    },
    onResponseStarted(exchange: RelayExchange, response: RelayResponseStart) {
      replyCollection.responseStarted(exchange, response);
    },
    onResponseChunk(exchange: RelayExchange, chunk: Uint8Array) {
      if (firstResponseChunkAtByExchange.get(exchange.exchangeId) === null) firstResponseChunkAtByExchange.set(exchange.exchangeId, Date.now());
      replyCollection.chunk(exchange, chunk);
    },
    onExchangeFinished(exchange: RelayExchange, result: RelayExchangeResult) {
      const collected = replyCollection.finish(exchange);
      const firstResponseChunkAt = firstResponseChunkAtByExchange.get(exchange.exchangeId) ?? null;
      firstResponseChunkAtByExchange.delete(exchange.exchangeId);
      const completed: CompletedRelayExchange = { exchange, result, collected, firstResponseChunkAt };
      for (const consumer of consumers) notifyConsumer(() => consumer.onExchangeCompleted(completed));
    },
  };
}
