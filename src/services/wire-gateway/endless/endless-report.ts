// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire status --endless` (plan Phase 11 task 6): what Endless
// Mode costs and saves, per agent, from the usage ledger. A swap changes the
// prompt once, so the cache is written again once; after that it should be
// read as before, from a smaller prompt. The report puts each conversation's
// requests before its first swap beside those from it on, and adds up the
// tokens the swaps took out.

import type { WireUsageLedgerRecord } from '../metrics/usage-ledger.js';
import { ENDLESS_MODE_STAGE_NAME } from './endless-mode-stage.js';

export interface EndlessCacheTotals {
  requests: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / cacheWrite; null when nothing was written. */
  readWriteRatio: number | null;
}

export interface EndlessAgentReport {
  agentId: string;
  /** Conversations with at least one swap. */
  conversationsSwapped: number;
  /** Requests that went with swaps in them. */
  requestsSwapped: number;
  /** Requests of those conversations before their first swap, and from it on. */
  beforeFirstSwap: EndlessCacheTotals;
  afterFirstSwap: EndlessCacheTotals;
  /** What the swaps took out of every request they were in (estimated tokens). */
  tokensSaved: number;
}

interface CacheSums {
  requests: number;
  cacheRead: number;
  cacheWrite: number;
}

function totalsOf(sums: CacheSums): EndlessCacheTotals {
  return { ...sums, readWriteRatio: sums.cacheWrite > 0 ? sums.cacheRead / sums.cacheWrite : null };
}

function recordHasSwaps(record: WireUsageLedgerRecord): boolean {
  return record.stages.includes(ENDLESS_MODE_STAGE_NAME) && record.swappedTokensEst > 0;
}

/** One line per agent that has a conversation with a swap; in agent order. */
export function buildEndlessModeReport(records: WireUsageLedgerRecord[]): EndlessAgentReport[] {
  const recordsByConversation = new Map<string, WireUsageLedgerRecord[]>();
  for (const record of records) {
    const conversationKey = `${record.agent}\u0000${record.session}`;
    const conversationRecords = recordsByConversation.get(conversationKey);
    if (conversationRecords) conversationRecords.push(record);
    else recordsByConversation.set(conversationKey, [record]);
  }
  const reportsByAgent = new Map<string, { conversationsSwapped: number; requestsSwapped: number; before: CacheSums; after: CacheSums; tokensSaved: number }>();
  for (const conversationRecords of recordsByConversation.values()) {
    conversationRecords.sort((first, second) => first.t.localeCompare(second.t));
    const firstSwapIndex = conversationRecords.findIndex(recordHasSwaps);
    if (firstSwapIndex < 0) continue;
    const agentId = conversationRecords[0].agent;
    let agent = reportsByAgent.get(agentId);
    if (!agent) {
      agent = { conversationsSwapped: 0, requestsSwapped: 0, before: { requests: 0, cacheRead: 0, cacheWrite: 0 }, after: { requests: 0, cacheRead: 0, cacheWrite: 0 }, tokensSaved: 0 };
      reportsByAgent.set(agentId, agent);
    }
    agent.conversationsSwapped++;
    for (const [index, record] of conversationRecords.entries()) {
      const sums = index < firstSwapIndex ? agent.before : agent.after;
      sums.requests++;
      sums.cacheRead += record.cacheRead;
      sums.cacheWrite += record.cacheWrite;
      if (recordHasSwaps(record)) {
        agent.requestsSwapped++;
        agent.tokensSaved += record.swappedTokensEst;
      }
    }
  }
  return [...reportsByAgent.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([agentId, agent]) => ({
      agentId,
      conversationsSwapped: agent.conversationsSwapped,
      requestsSwapped: agent.requestsSwapped,
      beforeFirstSwap: totalsOf(agent.before),
      afterFirstSwap: totalsOf(agent.after),
      tokensSaved: agent.tokensSaved,
    }));
}

function ratioText(totals: EndlessCacheTotals): string {
  if (totals.requests === 0) return 'no requests';
  const ratio = totals.readWriteRatio === null ? 'no cache writes' : `${totals.readWriteRatio.toFixed(1)}:1`;
  return `${ratio} read:write (${totals.cacheRead} read, ${totals.cacheWrite} written, ${totals.requests} requests)`;
}

export function formatEndlessModeReport(agents: EndlessAgentReport[], usageDays: number): string[] {
  if (agents.length === 0) {
    return [`Endless Mode: no swaps in the usage ledger's last ${usageDays} days.`,
      'Turn it on with CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE=true and `claude-mem wire restart`, or per route (no restart): claude-mem wire routes endless <routeId> on'];
  }
  const lines = [`Endless Mode, from the usage ledger's last ${usageDays} days:`];
  for (const agent of agents) {
    lines.push(`  ${agent.agentId}: ${agent.conversationsSwapped} conversations, ${agent.requestsSwapped} requests with swaps, ~${agent.tokensSaved} tokens saved`);
    lines.push(`    cache before the first swap: ${ratioText(agent.beforeFirstSwap)}`);
    lines.push(`    cache from the first swap:   ${ratioText(agent.afterFirstSwap)}`);
  }
  return lines;
}
