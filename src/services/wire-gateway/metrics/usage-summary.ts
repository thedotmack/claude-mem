// SPDX-License-Identifier: Apache-2.0
//
// The viewer's Wire page numbers (plan Phase 15): Endless Mode savings, the
// cost of injected memory and each agent's context buckets, all from the
// usage ledger's records (metrics/usage-ledger.ts). Counts and names only.

import { buildEndlessModeReport, type EndlessAgentReport } from '../endless/endless-report.js';
import { summarizeAgentContext, type WireAgentContextSummary } from './context-buckets.js';
import type { WireUsageLedgerReadResult, WireUsageLedgerRecord } from './usage-ledger.js';

export interface WireInjectedMemoryReport {
  agentId: string;
  /** Requests that went upstream with injected memory in them. */
  requestsInjected: number;
  /** Estimated tokens injected, over all of those requests. */
  injectedTokensEst: number;
  /** injectedTokensEst / requestsInjected, rounded; 0 when none. */
  averageTokensPerRequest: number;
}

export interface WireUsageSummary {
  /** The days of usage the ledger keeps (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS). */
  usageDays: number;
  /** Records read. */
  requests: number;
  /** Ledger lines in those days that are not records (not JSON, or not a record's shape): not counted, and shown. */
  unreadableLines: number;
  endless: EndlessAgentReport[];
  injectedMemory: WireInjectedMemoryReport[];
  context: WireAgentContextSummary[];
}

/** Per agent: requests that carried injected memory and its estimated tokens; in agent order. */
export function summarizeInjectedMemory(records: WireUsageLedgerRecord[]): WireInjectedMemoryReport[] {
  const byAgent = new Map<string, { requestsInjected: number; injectedTokensEst: number }>();
  for (const record of records) {
    if (!(record.injectedTokensEst > 0)) continue;
    const totals = byAgent.get(record.agent) ?? { requestsInjected: 0, injectedTokensEst: 0 };
    totals.requestsInjected++;
    totals.injectedTokensEst += record.injectedTokensEst;
    byAgent.set(record.agent, totals);
  }
  return [...byAgent.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([agentId, totals]) => ({
      agentId,
      ...totals,
      averageTokensPerRequest: Math.round(totals.injectedTokensEst / totals.requestsInjected),
    }));
}

export function buildWireUsageSummary({ records, unreadableLines }: WireUsageLedgerReadResult, usageDays: number): WireUsageSummary {
  return {
    usageDays,
    requests: records.length,
    unreadableLines,
    endless: buildEndlessModeReport(records),
    injectedMemory: summarizeInjectedMemory(records),
    context: summarizeAgentContext(records),
  };
}
