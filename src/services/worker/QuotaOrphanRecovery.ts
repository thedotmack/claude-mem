/**
 * Recovery for observation work orphaned by a quota-cooldown restart (#4580).
 *
 * While the provider breaker withholds the generator, every PostToolUse event
 * still lands in the RAM-only SessionMessageBuffer (SessionRoutes's
 * `tryAdmitQuotaProbe` skip only stops the generator, never the enqueue). When
 * the worker restarts inside that window, `deleteSession` → `buffer.dispose`
 * drops the buffered work silently, and the resume sweep never sees the
 * session again: `getResumableSessionIds` walks the in-RAM session map, which
 * a restart emptied. The durable rows in `tool_uses` stay `observation_id
 * NULL` forever — the loss the issue measured (91 rows across 3 sessions).
 *
 * This scan is the missing recovery path. It re-feeds orphaned sessions
 * through the SAME live machinery ingest uses — `queueObservation` with the
 * ORIGINAL `tool_use_id`, then `ensureGeneratorRunning` — so the generator's
 * late link (`linkToolUsesToObservation`) closes the loop onto the very rows
 * the scan read. The same skip semantics apply: ingest records an explicit
 * memory write's tool I/O in `tool_uses` but deliberately never observes its
 * echo (the `explicit_memory_write` skip in `ingestObservation` — the note is
 * already durable, and observing the echo would duplicate it and buy another
 * provider call), so the re-feed drops those rows too, and a session whose
 * every row is such an echo is not recovered at all. It sources from `tool_uses`, never from buffered fragments:
 * the buffer docblock's lesson (the old durable queue replayed fragments
 * through a lost reducer state and stormed) is honored by replaying each
 * orphaned session AT MOST ONCE, from the durable, deduplicated record.
 *
 * The one-shot marker is what keeps the retry storm from coming back: it is
 * written BEFORE the re-feed and persisted beside the breaker's own ledger, so
 * neither a second scan tick nor a successor process re-schedules a session.
 * A marker written but lost to a crash before the generator ran is a session
 * left unrecovered — visible through the same orphan query — and that trade
 * is deliberate: bounded, one-shot recovery was the shape the issue and the
 * buffer's design doc both point at, not a durable queue in new clothes.
 *
 * Pacing lives with the caller (SessionRoutes.scanOrphanedSessions): nothing
 * is re-fed while a cooldown actively withholds requests, because every kick
 * would only log a skip and a restart would drop the re-fed work again — with
 * the marker already written. The window elapsing or the breaker clearing is
 * what turns the scan on; worker startup and the periodic resume tick are the
 * two callers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { paths } from '../../shared/paths.js';
import {
  findOrphanedToolUseSessions,
  getOrphanedToolUseRows,
} from '../sqlite/tool-uses.js';
import { isExplicitMemoryWrite } from '../../shared/memory-retrieval-tools.js';
import type { ObservationData } from '../worker-types.js';

/** Orphans younger than this are left alone: their generator may simply not have run yet. */
export const ORPHAN_RECOVERY_GRACE_MS = 30 * 60_000;

/** Sessions re-fed per round. Bounded by design — the periodic tick drains the rest. */
export const ORPHAN_RECOVERY_MAX_SESSIONS = 5;

export const ORPHAN_RECOVERY_MARKER_FILENAME = 'orphan-replay-markers.json';

/**
 * Marker entries older than this are pruned on load. The marker only has to
 * outlive a session's relevance (the orphan query stops matching it once its
 * rows are linked); the cap keeps the file from growing forever on installs
 * that run for years.
 */
const MARKER_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * The persisted record of sessions already handed to the generator machinery.
 * Same shape as the breaker's ledger (quota-cooldown.ts): JSON beside
 * observer-health.json, atomic tmp-plus-rename, tolerant of a corrupt file.
 */
export class OrphanReplayMarkerStore {
  private readonly scheduled = new Map<string, number>();
  private loaded = false;

  constructor(private readonly filePath: string = join(paths.dataDir(), ORPHAN_RECOVERY_MARKER_FILENAME)) {}

  has(contentSessionId: string): boolean {
    this.load();
    return this.scheduled.has(contentSessionId);
  }

  /** Record a session as handed off. Written through to disk synchronously. */
  mark(contentSessionId: string, atMs: number = Date.now()): void {
    this.load();
    this.scheduled.set(contentSessionId, atMs);
    this.flush();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const now = Date.now();
      for (const [contentSessionId, atMs] of Object.entries(parsed as Record<string, unknown>)) {
        // An entry older than the retention window no longer guards anything
        // its session would match on; dropping it here keeps the file bounded.
        if (typeof atMs !== 'number' || now - atMs > MARKER_RETENTION_MS) continue;
        this.scheduled.set(contentSessionId, atMs);
      }
    } catch (err) {
      // A corrupt marker must not stop the worker; it only costs one re-feed
      // of a session the orphan query still matches.
      logger.warn('SESSION', 'Failed to read orphan replay marker file', { filePath: this.filePath }, err as Error);
    }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.scheduled), null, 2), 'utf-8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      logger.warn('SESSION', 'Failed to write orphan replay marker file', { filePath: this.filePath }, err as Error);
    }
  }
}

export interface OrphanRecoveryScanDeps {
  db: Database;
  sessionManager: {
    /** Live-session check: sessions of THIS process belong to the normal machinery. */
    getSession(sessionDbId: number): unknown;
    queueObservation(sessionDbId: number, data: ObservationData): void;
  };
  ensureGeneratorRunning(sessionDbId: number, source: string): void | Promise<void>;
}

export interface OrphanRecoveryScanOptions {
  /** Logged with every re-feed, e.g. 'startup' or 'periodic-resume'. */
  source: string;
  nowMs?: number;
  graceMs?: number;
  maxSessions?: number;
  /** Defaults to the shared store; tests inject one over a temp file. */
  marker?: OrphanReplayMarkerStore;
}

export interface OrphanRecoveryScanResult {
  /** Sessions the orphan query returned this round. */
  candidates: number;
  /** Sessions actually re-fed (and marked) this round. */
  scheduled: number;
  skippedAlreadyScheduled: number;
  skippedLive: number;
  /**
   * Sessions whose every row is an explicit-memory echo — nothing to re-feed
   * (ingest itself never observed these), marked only so they stop occupying
   * candidate slots on every later round.
   */
  skippedExplicitMemoryOnly: number;
}

let sharedMarkerStore: OrphanReplayMarkerStore | null = null;

function getSharedMarkerStore(): OrphanReplayMarkerStore {
  if (!sharedMarkerStore) {
    sharedMarkerStore = new OrphanReplayMarkerStore();
  }
  return sharedMarkerStore;
}

/** Tests only: drop the shared store (and point it at a temp file when given). */
export function resetOrphanRecoveryForTesting(markerFilePath?: string): void {
  sharedMarkerStore = markerFilePath ? new OrphanReplayMarkerStore(markerFilePath) : null;
}

/**
 * Run one bounded recovery round. Returns what it found and what it re-fed;
 * every decision is logged so a round that skips or fails stays explainable.
 */
export async function runOrphanRecoveryScan(
  deps: OrphanRecoveryScanDeps,
  options: OrphanRecoveryScanOptions,
): Promise<OrphanRecoveryScanResult> {
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? ORPHAN_RECOVERY_GRACE_MS;
  const maxSessions = options.maxSessions ?? ORPHAN_RECOVERY_MAX_SESSIONS;
  const marker = options.marker ?? getSharedMarkerStore();

  const candidates = findOrphanedToolUseSessions(deps.db, {
    cutoffEpoch: nowMs - graceMs,
    limit: maxSessions,
  });

  const result: OrphanRecoveryScanResult = {
    candidates: candidates.length,
    scheduled: 0,
    skippedAlreadyScheduled: 0,
    skippedLive: 0,
    skippedExplicitMemoryOnly: 0,
  };

  for (const candidate of candidates) {
    if (marker.has(candidate.content_session_id)) {
      result.skippedAlreadyScheduled++;
      continue;
    }
    if (deps.sessionManager.getSession(candidate.session_db_id)) {
      // A live session with unlinked rows is mid-flight work, not an orphan:
      // its generator owns those rows and the resume sweep owns its restarts.
      result.skippedLive++;
      continue;
    }

    // Ingest wrote these rows and then skipped the save_memory ones, so
    // recovery must skip them too: re-feeding an explicit-memory echo would
    // duplicate an already-durable note and buy the provider call ingest
    // deliberately avoided (the `explicit_memory_write` skip).
    const rows = getOrphanedToolUseRows(deps.db, candidate.content_session_id)
      .filter(row => !isExplicitMemoryWrite(row.tool_name));
    if (rows.length === 0) {
      // Nothing to recover — but mark anyway: the rows stay unlinked forever,
      // so without a marker this all-echo session would re-occupy one of the
      // round's few candidate slots on every tick, crowding out real orphans.
      marker.mark(candidate.content_session_id);
      result.skippedExplicitMemoryOnly++;
      continue;
    }

    // The marker lands BEFORE the re-feed: a scan that crashed mid-round must
    // never re-feed a session it already handed off, on this tick or after a
    // restart — that is the retry-storm shape this whole design avoids.
    marker.mark(candidate.content_session_id);

    try {
      for (const row of rows) {
        deps.sessionManager.queueObservation(candidate.session_db_id, {
          tool_name: row.tool_name,
          tool_input: row.tool_input ?? '{}',
          tool_response: row.tool_response ?? '{}',
          prompt_number: row.prompt_number ?? 0,
          cwd: row.cwd ?? '',
          agentId: row.agent_id ?? undefined,
          agentType: row.agent_type ?? undefined,
          // The original identity: the buffer dedups on it within this
          // process, and the generator's late link writes observation_id back
          // onto THESE durable rows through it.
          toolUseId: row.tool_use_id,
        });
      }
      logger.info('SESSION', 'Re-feeding orphaned tool uses after a restart lost their buffer', {
        sessionId: candidate.session_db_id,
        source: options.source,
        contentSessionId: candidate.content_session_id,
        rows: rows.length,
        lastActivityEpoch: candidate.last_activity_epoch,
      });
      await deps.ensureGeneratorRunning(candidate.session_db_id, `orphan-recovery:${options.source}`);
      result.scheduled++;
    } catch (error) {
      // The re-fed work is already in the buffer; only the kick failed. The
      // normal resume machinery owns the session from here, so the round goes
      // on to the next candidate instead of stranding the ones behind it.
      logger.warn('SESSION', 'Orphan recovery kick failed; buffered work stays with the resume sweep', {
        sessionId: candidate.session_db_id,
        source: options.source,
        contentSessionId: candidate.content_session_id,
      }, error instanceof Error ? error : new Error(String(error)));
      result.scheduled++;
    }
  }

  if (result.candidates > 0) {
    logger.info('SESSION', 'Orphan recovery round finished', {
      source: options.source,
      ...result,
    });
  }
  return result;
}
