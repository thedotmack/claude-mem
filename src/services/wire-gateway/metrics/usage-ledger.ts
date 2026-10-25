// SPDX-License-Identifier: Apache-2.0
//
// The usage ledger (plan Phase 10 task 6): one line per relayed model call
// in `usage/<UTC date>.jsonl`, with the vendor's token counts (cache reads
// and writes included), timings, the rewrite stages applied, what they
// estimate they added or culled, and the prompt's context buckets. It is a
// consumer of the shared reply collection, so it sees the client-facing
// reply after it went out and costs the client nothing. The record follows
// magpie's usage record (internal/usage/usage.go:23-206, MIT, Copyright (c)
// 2026 yetone): cache_write is written even when 0 (magpie #1839). Only
// counts, names and ids are kept; never text, headers or URLs. Day files
// are kept as long as recordings (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS):
// pruned when the gateway starts and when a new UTC day's file is begun.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { open, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
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
  /**
   * What the Endless Mode culls this request recorded took out (estimated
   * tokens): each cull counted once, on the request that recorded or extended
   * it, never on the requests that replay it.
   */
  culledTokensEst: number;
  /** The prompt as forwarded, part by part (estimated tokens); absent when the body could not be read. */
  buckets?: WireContextBuckets;
}

const finiteNumber = z.number().finite();

/**
 * One ledger line as this file writes it. A line is JSON another writer (or a
 * crash mid-line, or a hand edit) can still have made wrong: `null`, a number,
 * a record missing a count. Such a line is not a record and is never counted.
 */
const usageLedgerRecordFields = {
  t: z.string(),
  agent: z.string(),
  session: z.string(),
  routeId: z.string(),
  model: z.string(),
  status: finiteNumber,
  in: finiteNumber,
  out: finiteNumber,
  cacheRead: finiteNumber,
  cacheWrite: finiteNumber,
  cacheWrite1h: finiteNumber,
  reasoning: finiteNumber,
  ms: finiteNumber,
  ttftMs: finiteNumber.nullable(),
  kind: z.string(),
  stages: z.array(z.string()),
  injectedTokensEst: finiteNumber,
  buckets: z.object({
    system: finiteNumber, tools: finiteNumber, memory: finiteNumber, files: finiteNumber, results: finiteNumber, chat: finiteNumber,
  }).optional(),
};

/**
 * A line written before Endless Mode v2 carries `swappedTokensEst`: the v1
 * swaps' tokens counted again on every request that replayed them. It stays a
 * record (its tokens, timings and buckets count), but that number is not
 * tokens newly taken out, so it reads as 0 culled tokens.
 */
const usageLedgerRecordSchema = z.union([
  z.object({ ...usageLedgerRecordFields, culledTokensEst: finiteNumber }),
  z.object({ ...usageLedgerRecordFields, swappedTokensEst: finiteNumber })
    .transform(({ swappedTokensEst: _legacySwappedTokensEst, ...record }) => ({ ...record, culledTokensEst: 0 })),
]);

/** A ledger line as a record; null for a line that is not JSON or not a record's shape. */
export function parseUsageLedgerLine(line: string): WireUsageLedgerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // Not JSON (a line cut by a crash): the caller counts it as unreadable.
    return null;
  }
  const parsed = usageLedgerRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Records read, and the lines that were not records (counted, never dropped silently). */
export interface WireUsageLedgerReadResult {
  records: WireUsageLedgerRecord[];
  unreadableLines: number;
}

/** Records and unreadable lines of the complete lines (each ending in \n) in `text`. */
function parseUsageLedgerLines(text: string): WireUsageLedgerReadResult {
  const records: WireUsageLedgerRecord[] = [];
  let unreadableLines = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const record = parseUsageLedgerLine(line);
    if (record) records.push(record);
    else unreadableLines++;
  }
  return { records, unreadableLines };
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
  recordOf({ exchange, result, collected }: CompletedRelayExchange): WireUsageLedgerRecord | null {
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
      ttftMs: result.firstResponseChunkAt === null ? null : result.firstResponseChunkAt - exchange.startedAt,
      kind: exchange.identity.kind,
      stages: [...exchange.rewrite.appliedStageNames],
      injectedTokensEst: exchange.rewrite.injectedTokensEst,
      culledTokensEst: exchange.rewrite.culledTokensEst,
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

  /**
   * Every record of the given UTC dates (YYYY-MM-DD), or of every day when
   * none are given. A line that is not a record is skipped and logged with
   * its file's count.
   */
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
      const parsed = parseUsageLedgerLines(readFileSync(join(this.directory, name), 'utf8'));
      records.push(...parsed.records);
      if (parsed.unreadableLines > 0) {
        logger.warn('WIRE', 'Skipped usage ledger lines that are not records', { file: name, unreadableLines: parsed.unreadableLines });
      }
    }
    return records;
  }
}

/** The UTC days (YYYY-MM-DD) a retention of `retentionDays` keeps at `nowMs`: the days pruneExpired would not delete. */
export function retainedUsageLedgerDays(retentionDays: number, nowMs: number): Set<string> {
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  const days = new Set<string>();
  // A day is kept while any of it is newer than the cutoff (pruneExpired's rule).
  for (let dayStartMs = Date.parse(`${utcDateOf(cutoffMs)}T00:00:00Z`); dayStartMs <= nowMs; dayStartMs += DAY_MS) {
    if (dayStartMs + DAY_MS > cutoffMs) days.add(utcDateOf(dayStartMs));
  }
  return days;
}

interface CachedUsageDay {
  /** The file's inode: a day file deleted and written again is another file, read whole. */
  ino: number;
  size: number;
  mtimeMs: number;
  /** Bytes up to the end of the last complete line read; a line still being appended waits for the next read. */
  consumedBytes: number;
  records: WireUsageLedgerRecord[];
  unreadableLines: number;
}

/**
 * The ledger as the viewer's Wire page reads it (plan Phase 15), every
 * refresh of every open tab. How much it reads is bounded by the retention
 * (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS, the user's setting): only those
 * days count, even while the gateway (which prunes) is down. A day file is
 * read once; after that only the bytes appended since (the ledger only
 * appends), and an unchanged file (same size and mtime) not at all. Reads go
 * through fs/promises, off the event loop. Concurrent callers share one read.
 */
export class WireUsageLedgerReader {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly cachedDays = new Map<string, CachedUsageDay>();
  private readInFlight: Promise<WireUsageLedgerReadResult> | null = null;

  constructor(options: { directory?: string; now?: () => number } = {}) {
    this.directory = options.directory ?? wireGatewaySubdirPath('usage');
    this.now = options.now ?? Date.now;
  }

  /** Every record of the days the retention keeps, and how many lines were not records. */
  readRetained(retentionDays: number): Promise<WireUsageLedgerReadResult> {
    if (!this.readInFlight) {
      this.readInFlight = this.readRetainedNow(retentionDays).finally(() => {
        this.readInFlight = null;
      });
    }
    return this.readInFlight;
  }

  private async readRetainedNow(retentionDays: number): Promise<WireUsageLedgerReadResult> {
    const retainedDays = retainedUsageLedgerDays(retentionDays, this.now());
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    const retainedNames = names
      .filter(name => name.endsWith(USAGE_FILE_SUFFIX) && retainedDays.has(name.slice(0, -USAGE_FILE_SUFFIX.length)))
      .sort();
    for (const name of [...this.cachedDays.keys()]) {
      if (!retainedNames.includes(name)) this.cachedDays.delete(name);
    }
    const records: WireUsageLedgerRecord[] = [];
    let unreadableLines = 0;
    for (const name of retainedNames) {
      const day = await this.readDay(name);
      records.push(...day.records);
      unreadableLines += day.unreadableLines;
    }
    return { records, unreadableLines };
  }

  private async readDay(name: string): Promise<CachedUsageDay> {
    const filePath = join(this.directory, name);
    const { ino, size, mtimeMs } = await stat(filePath);
    const cached = this.cachedDays.get(name);
    if (cached && cached.ino === ino && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
    // The same file, grown since the last read: only the appended bytes. Anything else (another file, shorter): all of it.
    const appended = cached !== undefined && cached.ino === ino && size > cached.size;
    const startByte = appended ? cached.consumedBytes : 0;
    const bytes = await readFileRange(filePath, startByte, size);
    // Counted in bytes, not characters: a line with bytes that are not UTF-8 still ends where its \n is.
    const completeLength = bytes.lastIndexOf(0x0a) + 1;
    const parsed = parseUsageLedgerLines(bytes.subarray(0, completeLength).toString('utf8'));
    const day: CachedUsageDay = {
      ino,
      size,
      mtimeMs,
      consumedBytes: startByte + completeLength,
      records: appended ? [...cached.records, ...parsed.records] : parsed.records,
      unreadableLines: (appended ? cached.unreadableLines : 0) + parsed.unreadableLines,
    };
    if (parsed.unreadableLines > 0) {
      logger.warn('WIRE', 'Skipped usage ledger lines that are not records', { file: name, unreadableLines: parsed.unreadableLines });
    }
    this.cachedDays.set(name, day);
    return day;
  }
}

/** Bytes [start, end) of a file (fewer when it is shorter now). */
async function readFileRange(filePath: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
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
