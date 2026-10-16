// SPDX-License-Identifier: Apache-2.0
//
// The reply of each captured exchange in flight, rebuilt from the relay's
// copy (plan Phase 5): a reply collector (what the model said, and whether
// it ended in an error after HTTP 200) beside a tool-call scan (which still
// sees a call when the collector could not parse the reply). Each relay
// observer that needs the reply keeps its own collection. A reply past
// WIRE_REPLY_MAX_BYTES stops being collected (`passedByteCap`); the scan,
// which holds only a few bytes, still sees the whole reply.

import type { RelayExchange, RelayResponseStart } from '../relay/relay.js';
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

  /** Start collecting `exchange`'s reply. Only a captured exchange of a known protocol gets chunks. */
  begin(exchange: RelayExchange): boolean {
    if (!exchange.captured || !exchange.protocol) return false;
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
