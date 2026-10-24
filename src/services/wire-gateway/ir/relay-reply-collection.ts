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

import { notifyObserver, type RelayExchange, type RelayExchangeResult, type RelayObserver, type RelayResponseStart } from '../relay/relay.js';
import { createWireReplyCollector, type WireReplyCollector } from './reply-collectors.js';
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

/** One exchange once it is over, with its reply collected once for every consumer. */
export interface CompletedRelayExchange {
  exchange: RelayExchange;
  result: RelayExchangeResult;
  /** Null when the reply was not collected (not a metered exchange). */
  collected: CollectedRelayReply | null;
}

/** Something that reads replies: told when an exchange starts and once it is over. */
export interface RelayReplyConsumer {
  onExchangeStarted?(exchange: RelayExchange): void;
  onExchangeCompleted(completed: CompletedRelayExchange): void;
}

/**
 * The relay observer that collects each metered reply once and hands every
 * consumer the result, in order. A consumer that throws does not stop the
 * others. Only a metered exchange (a model call of a known protocol) is
 * collected: its tool-call scan beside its reply collector, made when
 * upstream answers.
 */
export function createReplyCollectingRelayObserver(consumers: RelayReplyConsumer[]): RelayObserver {
  const repliesInProgress = new Map<string, { collector: WireReplyCollector | null; toolCallScanner: ToolCallScanner }>();
  return {
    onExchangeStarted(exchange: RelayExchange) {
      if (exchange.metered && exchange.protocol) repliesInProgress.set(exchange.exchangeId, { collector: null, toolCallScanner: new ToolCallScanner() });
      for (const consumer of consumers) {
        if (consumer.onExchangeStarted) notifyObserver(() => consumer.onExchangeStarted!(exchange));
      }
    },
    onResponseStarted(exchange: RelayExchange, response: RelayResponseStart) {
      const inProgress = repliesInProgress.get(exchange.exchangeId);
      if (inProgress && exchange.protocol) inProgress.collector = createWireReplyCollector(exchange.protocol, response.contentType);
    },
    onResponseChunk(exchange: RelayExchange, chunk: Uint8Array) {
      const inProgress = repliesInProgress.get(exchange.exchangeId);
      if (!inProgress) return;
      inProgress.toolCallScanner.observe(chunk);
      inProgress.collector?.push(chunk);
    },
    onExchangeFinished(exchange: RelayExchange, result: RelayExchangeResult) {
      // The reply as far as it went, or null when the exchange was never collected.
      const inProgress = repliesInProgress.get(exchange.exchangeId);
      repliesInProgress.delete(exchange.exchangeId);
      let collected: CollectedRelayReply | null = null;
      if (inProgress) {
        const reply = inProgress.collector ? inProgress.collector.finish() : null;
        collected = {
          reply,
          calledTool: inProgress.toolCallScanner.calledTool || (reply?.toolCalls.length ?? 0) > 0,
          passedByteCap: inProgress.collector?.passedByteCap ?? false,
        };
      }
      const completed: CompletedRelayExchange = { exchange, result, collected };
      for (const consumer of consumers) notifyObserver(() => consumer.onExchangeCompleted(completed));
    },
  };
}
