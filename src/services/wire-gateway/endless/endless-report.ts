// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire status --endless` (plan Phase 11 task 6, reworked in
// Endless Mode v2 Phase 5): what Endless Mode costs and saves, per agent,
// from the usage ledger. A cull changes the prompt once, so the cache is
// written again once; after that it should be read as before, from a smaller
// prompt. The report puts each conversation's requests before its first cull
// beside those from it on, and adds up the tokens the culls took out, each
// cull counted once: a usage record's `culledTokensEst` is only what the culls
// that request recorded (or extended) newly took out, never the replays.

import { retainedUsageLedgerDays, WireUsageLedger, type WireUsageLedgerRecord } from '../metrics/usage-ledger.js';
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
  /** Conversations with at least one cull. */
  conversationsCulled: number;
  /** Requests that recorded a new cull or extended one. */
  requestsWithNewCulls: number;
  /** Requests of those conversations before their first cull, and from it on. */
  beforeFirstCull: EndlessCacheTotals;
  afterFirstCull: EndlessCacheTotals;
  /** What the culls took out (estimated tokens), each cull counted once. */
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

function recordHasNewCulls(record: WireUsageLedgerRecord): boolean {
  return record.stages.includes(ENDLESS_MODE_STAGE_NAME) && record.culledTokensEst > 0;
}

/** One line per agent that has a conversation with a cull; in agent order. */
export function buildEndlessModeReport(records: WireUsageLedgerRecord[]): EndlessAgentReport[] {
  const recordsByConversation = new Map<string, WireUsageLedgerRecord[]>();
  for (const record of records) {
    const conversationKey = `${record.agent}\u0000${record.session}`;
    const conversationRecords = recordsByConversation.get(conversationKey);
    if (conversationRecords) conversationRecords.push(record);
    else recordsByConversation.set(conversationKey, [record]);
  }
  const reportsByAgent = new Map<string, { conversationsCulled: number; requestsWithNewCulls: number; before: CacheSums; after: CacheSums; tokensSaved: number }>();
  for (const conversationRecords of recordsByConversation.values()) {
    conversationRecords.sort((first, second) => first.t.localeCompare(second.t));
    const firstCullIndex = conversationRecords.findIndex(recordHasNewCulls);
    if (firstCullIndex < 0) continue;
    const agentId = conversationRecords[0].agent;
    let agent = reportsByAgent.get(agentId);
    if (!agent) {
      agent = { conversationsCulled: 0, requestsWithNewCulls: 0, before: { requests: 0, cacheRead: 0, cacheWrite: 0 }, after: { requests: 0, cacheRead: 0, cacheWrite: 0 }, tokensSaved: 0 };
      reportsByAgent.set(agentId, agent);
    }
    agent.conversationsCulled++;
    for (const [index, record] of conversationRecords.entries()) {
      const sums = index < firstCullIndex ? agent.before : agent.after;
      sums.requests++;
      sums.cacheRead += record.cacheRead;
      sums.cacheWrite += record.cacheWrite;
      if (recordHasNewCulls(record)) {
        agent.requestsWithNewCulls++;
        agent.tokensSaved += record.culledTokensEst;
      }
    }
  }
  return [...reportsByAgent.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([agentId, agent]) => ({
      agentId,
      conversationsCulled: agent.conversationsCulled,
      requestsWithNewCulls: agent.requestsWithNewCulls,
      beforeFirstCull: totalsOf(agent.before),
      afterFirstCull: totalsOf(agent.after),
      tokensSaved: agent.tokensSaved,
    }));
}

/**
 * The report over the usage day files the retention keeps
 * (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS), and no others: a day file the
 * gateway has not pruned yet (it prunes at start and on a new UTC day) is
 * still outside the report's days.
 */
export function readEndlessModeReport(retentionDays: number, options: { directory?: string; nowMs?: number } = {}): EndlessAgentReport[] {
  const retainedDays = retainedUsageLedgerDays(retentionDays, options.nowMs ?? Date.now());
  return buildEndlessModeReport(new WireUsageLedger({ directory: options.directory, retentionDays }).read([...retainedDays]));
}

function ratioText(totals: EndlessCacheTotals): string {
  if (totals.requests === 0) return 'no requests';
  const ratio = totals.readWriteRatio === null ? 'no cache writes' : `${totals.readWriteRatio.toFixed(1)}:1`;
  return `${ratio} read:write (${totals.cacheRead} read, ${totals.cacheWrite} written, ${totals.requests} requests)`;
}

export function formatEndlessModeReport(agents: EndlessAgentReport[], usageDays: number): string[] {
  if (agents.length === 0) {
    return [`Endless Mode: no culls in the usage ledger's last ${usageDays} days.`,
      'Turn it on with CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE=true and `claude-mem wire restart`, or per route (no restart): claude-mem wire routes endless <routeId> on'];
  }
  const lines = [`Endless Mode, from the usage ledger's last ${usageDays} days:`];
  for (const agent of agents) {
    lines.push(`  ${agent.agentId}: ${agent.conversationsCulled} conversations, ${agent.requestsWithNewCulls} requests with new culls, ~${agent.tokensSaved} tokens saved`);
    lines.push(`    cache before the first cull: ${ratioText(agent.beforeFirstCull)}`);
    lines.push(`    cache from the first cull:   ${ratioText(agent.afterFirstCull)}`);
  }
  return lines;
}
