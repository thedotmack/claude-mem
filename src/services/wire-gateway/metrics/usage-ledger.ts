// SPDX-License-Identifier: Apache-2.0
//
// The usage ledger (plan Phase 10 task 6): one line per relayed model call
// in `usage/<UTC date>.jsonl`, with the vendor's token counts (cache reads
// and writes included), timings, the rewrite stages applied, what they
// estimate they added or swapped, and the prompt's context buckets. It is a
// consumer of the shared reply collection, so it sees the client-facing
// reply after it went out and costs the client nothing. The record follows
// magpie's usage record (internal/usage/usage.go:23-206, MIT, Copyright (c)
// 2026 yetone): cache_write is written even when 0 (magpie #1839). Only
// counts, names and ids are kept; never text, headers or URLs. Day files
// are kept as long as recordings (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS):
// pruned when the gateway starts and when a new UTC day's file is begun.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, wireGatewaySubdirPath } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import type { CompletedRelayExchange, RelayReplyConsumer } from '../ir/relay-reply-collection.js';
import { contextBreakdownOfRequest, contextBucketsOf, type WireContextBuckets } from './context-buckets.js';

export interface WireUsageLedgerRecord {
  /** When the request began (ISO). */
  t: string;
  agent: string;
  session: string;
  routeId: string;
  model: string;
  status: number;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  /** From the request's start to the reply's end. */
  ms: number;
  /** From the request's start to the reply's first byte; null when none came. */
  ttftMs: number | null;
  kind: string;
  /** The rewrite stages whose bytes went upstream, in order. */
  stages: string[];
  injectedTokensEst: number;
  swappedTokensEst: number;
  /** The prompt as forwarded, part by part (estimated tokens); absent when the body could not be read. */
  buckets?: WireContextBuckets;
}

const USAGE_FILE_SUFFIX = '.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of usage kept when no retention is given: the recordings' default. */
export const DEFAULT_USAGE_LEDGER_RETENTION_DAYS = 7;

function utcDateOf(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

export interface WireUsageLedgerOptions {
  /** Defaults to <DATA_DIR>/wire-gateway/usage. */
  directory?: string;
  /** Whole UTC days kept; defaults to DEFAULT_USAGE_LEDGER_RETENTION_DAYS. */
  retentionDays?: number;
  now?: () => number;
}

export class WireUsageLedger {
  readonly directory: string;
  private readonly retentionDays: number;
  private readonly now: () => number;
  /** The UTC day last appended to; a new one prunes expired days first. */
  private lastAppendedUtcDate: string | null = null;

  constructor(options: WireUsageLedgerOptions = {}) {
    this.directory = options.directory ?? wireGatewaySubdirPath('usage');
    this.retentionDays = options.retentionDays ?? DEFAULT_USAGE_LEDGER_RETENTION_DAYS;
    this.now = options.now ?? Date.now;
  }

  /** Delete the day files wholly older than the retention. Returns how many went. */
  pruneExpired(): number {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    const cutoffMs = this.now() - this.retentionDays * DAY_MS;
    let deleted = 0;
    for (const name of names) {
      if (!name.endsWith(USAGE_FILE_SUFFIX)) continue;
      const dayStartMs = Date.parse(`${name.slice(0, -USAGE_FILE_SUFFIX.length)}T00:00:00Z`);
      // A day is expired once all of it is older than the cutoff (as recordings are).
      if (!Number.isFinite(dayStartMs) || dayStartMs + DAY_MS > cutoffMs) continue;
      unlinkSync(join(this.directory, name));
      deleted++;
    }
    return deleted;
  }

  /** The record of one completed exchange; null for an exchange that is not a metered model call. */
  recordOf({ exchange, result, collected, firstResponseChunkAt }: CompletedRelayExchange): WireUsageLedgerRecord | null {
    if (!exchange.metered || !exchange.protocol) return null;
    const reply = collected?.reply ?? null;
    const usage = reply?.usage;
    const record: WireUsageLedgerRecord = {
      t: new Date(exchange.startedAt).toISOString(),
      agent: exchange.identity.agentId,
      session: exchange.identity.sessionId,
      routeId: exchange.routeId,
      model: reply?.model || exchange.request?.model || '',
      status: result.recordedStatus,
      in: usage?.inputTokens ?? 0,
      out: usage?.outputTokens ?? 0,
      cacheRead: usage?.cacheReadTokens ?? 0,
      cacheWrite: usage?.cacheWriteTokens ?? 0,
      cacheWrite1h: usage?.cacheWrite1hTokens ?? 0,
      reasoning: usage?.reasoningTokens ?? 0,
      ms: result.durationMs,
      ttftMs: firstResponseChunkAt === null ? null : Math.max(0, firstResponseChunkAt - exchange.startedAt),
      kind: exchange.identity.kind,
      stages: [...exchange.rewrite.appliedStageNames],
      injectedTokensEst: exchange.rewrite.injectedTokensEst,
      swappedTokensEst: exchange.rewrite.swappedTokensEst,
    };
    const forwardedRequest = exchange.rewrite.forwardedRequest ?? exchange.request;
    if (forwardedRequest) {
      const breakdown = contextBreakdownOfRequest(exchange.protocol, forwardedRequest.body);
      if (breakdown) record.buckets = contextBucketsOf(breakdown);
    }
    return record;
  }

  append(record: WireUsageLedgerRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    const utcDate = utcDateOf(Date.parse(record.t));
    if (utcDate !== this.lastAppendedUtcDate) {
      this.lastAppendedUtcDate = utcDate;
      // A failed cleanup must not cost this line.
      try {
        this.pruneExpired();
      } catch (error) {
        logger.warn('WIRE', 'Usage ledger cleanup failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const filePath = join(this.directory, `${utcDate}${USAGE_FILE_SUFFIX}`);
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: WIRE_GATEWAY_FILE_MODE });
  }

  /** Every record of the given UTC dates (YYYY-MM-DD), or of every day when none are given. A line that does not parse is skipped. */
  read(utcDates?: string[]): WireUsageLedgerRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.directory).filter(name => name.endsWith(USAGE_FILE_SUFFIX)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (utcDates) names = names.filter(name => utcDates.includes(name.slice(0, -USAGE_FILE_SUFFIX.length)));
    const records: WireUsageLedgerRecord[] = [];
    for (const name of names) {
      for (const line of readFileSync(join(this.directory, name), 'utf8').split('\n')) {
        if (line === '') continue;
        try {
          records.push(JSON.parse(line) as WireUsageLedgerRecord);
        } catch {
          logger.debug('WIRE', 'Skipped a usage ledger line that does not parse', { file: name });
        }
      }
    }
    return records;
  }
}

/** The reply consumer that writes a usage line per metered exchange. A failed write is logged, never thrown at the relay. */
export function createUsageLedgerConsumer(usageLedger: WireUsageLedger): RelayReplyConsumer {
  return {
    onExchangeCompleted(completed: CompletedRelayExchange) {
      const record = usageLedger.recordOf(completed);
      if (!record) return;
      try {
        usageLedger.append(record);
      } catch (error) {
        logger.warn('WIRE', 'Could not write a usage ledger line', {
          routeId: record.routeId, error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
