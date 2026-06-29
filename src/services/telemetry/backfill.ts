import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { PostHog } from 'posthog-node';
import type { Database } from 'bun:sqlite';
import { resolveDataDir } from '../../shared/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { logger } from '../../utils/logger.js';
import { toError } from '../../utils/to-error.js';
import {
  resolveTelemetryConsent,
  loadTelemetryConfig,
  getOrCreateInstallId,
} from './consent.js';
import { scrubProperties } from './scrub.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../context/types.js';
import {
  getTelemetryApiKey,
  getTelemetryHost,
  buildBaseProperties,
  buildPersonSet,
  asMs,
} from './common.js';

/**
 * One-time historical backfill of anonymized daily activity rollups into
 * PostHog (historical-migration ingestion mode), so growth metrics cover
 * activity that predates telemetry shipping.
 *
 * What ships (counts/sums only — never titles, text, prompts, project names,
 * or any raw string column):
 *  - one profile-less `historical_activity` event per active UTC day, and
 *  - one `install_inferred` person event at noon UTC of the inferred
 *    install day.
 *
 * Idempotency: a completion marker (~/.claude-mem/backfill.json) is the
 * primary gate; deterministic per-event UUIDs minimize damage in the
 * crash-retry window (PostHog dedupe is best-effort, merge-time).
 */

/**
 * PostHog's historical-migration contract requires event timestamps at least
 * 48 hours in the past. Events are stamped at noon UTC of their day, so the
 * newest includable day is the UTC day of (now - 60h): 48h contract + 12h
 * noon offset. Noon of any included day is then guaranteed >= 48h old.
 */
const BACKFILL_LAG_MS = 60 * 3_600_000;

/**
 * Predates claude-mem's first release. Rows whose normalized epoch falls
 * below this are corrupt (e.g. backdated artifacts) and are ignored
 * everywhere — rollups AND the first-activity MIN.
 */
export const PROJECT_EPOCH_FLOOR = Date.parse('2024-01-01T00:00:00Z');

/**
 * Fixed namespace for deterministic (UUIDv5) backfill event ids. Never change
 * this value: retried events must carry byte-identical uuids for PostHog's
 * dedupe key to match.
 */
const BACKFILL_NAMESPACE = '8a9c2f4e-31b7-5d68-9c4a-f02e6d5b8a17';

const BACKFILL_MARKER_FILENAME = 'backfill.json';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function uuidV5(name: string, namespace: string): string {
  const bytes = createHash('sha1')
    .update(uuidBytes(namespace))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/**
 * Schema version of the backfill payload. Bump this whenever the rollup gains
 * keys that already-backfilled installs must receive (a marker written by an
 * older version re-runs so the enriched series reaches the existing base — not
 * just fresh installs).
 *
 *   1 — original anonymized daily rollups (#2912).
 *   2 — adds read_tokens / tokens_saved_vs_naive economics.
 *
 * A re-run is safe and does NOT double count: every event keeps its
 * deterministic per-(installId, event, day) uuid, so PostHog's
 * historical-migration dedup replaces each event in place with the enriched
 * copy rather than appending a second row. Markers predating this field are
 * treated as version 1.
 */
export const BACKFILL_VERSION = 2;

/**
 * Mirror of the private STAT_TYPE_BUCKETS set in
 * src/services/context/ContextBuilder.ts — the closed observation-type
 * vocabulary live `context_injected` events use. Everything else buckets to
 * 'other' so the backfill vocabulary is identical to live telemetry.
 */
const STAT_TYPE_BUCKETS = new Set(['bugfix', 'discovery', 'decision', 'refactor']);

/** YYYY-MM-DD (UTC) for an epoch-milliseconds instant. */
export function utcDayString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export interface DailyRollup {
  day: string;
  counters: Record<string, number>;
}

export interface BackfillEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: Date;
  uuid: string;
}

interface BackfillMarker {
  completedAt: string;
  throughDay: string;
  eventCount: number;
  installId: string;
  /** Schema version the marker was written at. Absent ⇒ legacy version 1. */
  version: number;
}

function getBackfillMarkerPath(): string {
  return join(resolveDataDir(), BACKFILL_MARKER_FILENAME);
}

/**
 * True when a completion marker for the CURRENT schema version exists. A marker
 * written by an older BACKFILL_VERSION counts as incomplete so already-
 * backfilled installs re-run and pick up the enriched rollup keys — without it,
 * the one-shot marker would pin them forever to whatever shipped when they
 * first backfilled (the read_tokens / tokens_saved_vs_naive series would only
 * ever reach fresh installs).
 *
 * A corrupt marker file still counts as complete: a marker was written at some
 * point, and duplicate sends are worse than a gap (PostHog data cannot be
 * selectively deleted). A marker missing the `version` field is a legacy
 * version-1 marker.
 */
function isBackfillComplete(): boolean {
  try {
    const marker = readJsonSafe<Partial<BackfillMarker> | null>(getBackfillMarkerPath(), null);
    if (marker === null) return false;
    const version = typeof marker.version === 'number' ? marker.version : 1;
    return version >= BACKFILL_VERSION;
  } catch {
    return true;
  }
}

function writeBackfillMarker(marker: BackfillMarker): void {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(getBackfillMarkerPath(), JSON.stringify(marker, null, 2) + '\n');
}

/**
 * Per-day anonymous activity rollups, bucketed by UTC day. Only whole UTC
 * days inside `installDay <= day <= lastFullDay` are included, comparing
 * day strings (YYYY-MM-DD compares lexicographically) — never raw epochs, so
 * no partial day can ever ship. Rows below PROJECT_EPOCH_FLOOR are ignored.
 *
 * Each query block is independently best-effort (a missing table/column on an
 * older install skips that block's keys, never throws) — same pattern as
 * collectInstallStats.
 */
export function collectDailyRollups(
  db: Database,
  lastFullDay: string,
  installDay: string
): DailyRollup[] {
  const byDay = new Map<string, Record<string, number>>();

  const add = (day: string | null | undefined, key: string, value: number): void => {
    if (!day) return;
    let counters = byDay.get(day);
    if (!counters) {
      counters = {};
      byDay.set(day, counters);
    }
    counters[key] = (counters[key] ?? 0) + value;
  };

  /** Shared per-table SQL fragments: day bucket + window/floor filter. */
  const frag = (epochCol: string): { day: string; where: string } => {
    const ms = asMs(epochCol);
    const day = `date((${ms})/1000, 'unixepoch')`;
    return {
      day,
      where: `${ms} >= ?1 AND ${day} >= ?2 AND ${day} <= ?3`,
    };
  };
  const params = [PROJECT_EPOCH_FLOOR, installDay, lastFullDay] as const;

  // observation_count
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, COUNT(*) AS c FROM observations WHERE ${f.where} GROUP BY day`
      )
      .all(...params) as Array<{ day: string; c: number }>;
    for (const row of rows) add(row.day, 'observation_count', row.c);
  } catch {
    // Table not created yet on this install — skip this block's keys.
  }

  // obs_type_* — closed vocabulary via STAT_TYPE_BUCKETS, zero-filled for any
  // day that has observations (matches live context_injected event shape).
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, type, COUNT(*) AS c FROM observations WHERE ${f.where} GROUP BY day, type`
      )
      .all(...params) as Array<{ day: string; type: string | null; c: number }>;
    for (const row of rows) {
      for (const bucket of ['bugfix', 'discovery', 'decision', 'refactor', 'other']) {
        add(row.day, `obs_type_${bucket}`, 0);
      }
      const bucket = row.type && STAT_TYPE_BUCKETS.has(row.type) ? row.type : 'other';
      add(row.day, `obs_type_${bucket}`, row.c);
    }
  } catch {
    // Missing table/column — skip.
  }

  // subagent_obs_count
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, COUNT(*) AS c FROM observations WHERE ${f.where} AND agent_type IS NOT NULL GROUP BY day`
      )
      .all(...params) as Array<{ day: string; c: number }>;
    for (const row of rows) add(row.day, 'subagent_obs_count', row.c);
  } catch {
    // agent_type arrives via migration — older installs skip this key.
  }

  // session_count — sdk_sessions ONLY (observations' memory_session_id covers
  // the same sessions; adding it would double count).
  try {
    const f = frag('started_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, COUNT(*) AS c FROM sdk_sessions WHERE ${f.where} GROUP BY day`
      )
      .all(...params) as Array<{ day: string; c: number }>;
    for (const row of rows) add(row.day, 'session_count', row.c);
  } catch {
    // No sessions table yet.
  }

  // session_completed_count / session_failed_count — closed status enum;
  // 'active' rows are counted by session_count only.
  try {
    const f = frag('started_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, status, COUNT(*) AS c FROM sdk_sessions WHERE ${f.where} GROUP BY day, status`
      )
      .all(...params) as Array<{ day: string; status: string | null; c: number }>;
    for (const row of rows) {
      if (row.status === 'completed') add(row.day, 'session_completed_count', row.c);
      else if (row.status === 'failed') add(row.day, 'session_failed_count', row.c);
    }
  } catch {
    // Missing table/column — skip.
  }

  // sessions_{claude,codex,gemini,other_platform}_count — platform_source is
  // user-influenceable; bucket in JS to the closed enum, never ship raw.
  try {
    const f = frag('started_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, platform_source, COUNT(*) AS c FROM sdk_sessions WHERE ${f.where} GROUP BY day, platform_source`
      )
      .all(...params) as Array<{ day: string; platform_source: string | null; c: number }>;
    for (const row of rows) {
      const platform =
        row.platform_source === 'claude' || row.platform_source === 'codex' || row.platform_source === 'gemini'
          ? row.platform_source
          : 'other_platform';
      add(row.day, `sessions_${platform}_count`, row.c);
    }
  } catch {
    // platform_source arrives via migration — skip.
  }

  // summary_count
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, COUNT(*) AS c FROM session_summaries WHERE ${f.where} GROUP BY day`
      )
      .all(...params) as Array<{ day: string; c: number }>;
    for (const row of rows) add(row.day, 'summary_count', row.c);
  } catch {
    // No summaries table yet.
  }

  // discovery_tokens — session_summaries ONLY. The same per-turn value is
  // written to every observation row of the turn AND the turn's summary row;
  // summing across observations multi-counts by the obs-per-turn factor.
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, COALESCE(SUM(discovery_tokens), 0) AS total FROM session_summaries WHERE ${f.where} GROUP BY day`
      )
      .all(...params) as Array<{ day: string; total: number }>;
    for (const row of rows) add(row.day, 'discovery_tokens', row.total);
  } catch {
    // discovery_tokens arrives via migration — skip.
  }

  // read_tokens / tokens_saved_vs_naive — the historical counterpart to live
  // context_injected economics. Live telemetry derives savings as
  // (discovery_tokens - read_tokens) where read_tokens is the size of the
  // injected observation rendered into context. We cannot replay an actual
  // injection for a past day, so we approximate per-day READ COST as the cost
  // of reading every observation that day exactly once, using the SAME formula
  // live uses (calculateObservationTokens / CHARS_PER_TOKEN_ESTIMATE) so the
  // historical series is consistent with live numbers rather than a new metric.
  //
  // read_tokens         := ceil(len(text) / CHARS_PER_TOKEN_ESTIMATE) summed
  // tokens_saved_vs_naive := discovery_tokens (rolled up above) - read_tokens,
  //                          floored at 0 per day (a day can't have negative
  //                          savings; clamping avoids a handful of summary-less
  //                          legacy days dragging the series below zero).
  //
  // Caveat shipped to PostHog via backfilled:true: this is a once-per-observation
  // lower bound on read cost, not a replay of real injections, so the historical
  // savings curve is conservative relative to live (which re-injects context
  // across many sessions). Generation-side cost (cost_usd / tokens_input /
  // tokens_output from session_compressed) is NOT recoverable here — it was
  // never persisted to SQLite — and is intentionally absent from the backfill.
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day,
                COALESCE(SUM(CAST((LENGTH(text) + ${CHARS_PER_TOKEN_ESTIMATE} - 1) / ${CHARS_PER_TOKEN_ESTIMATE} AS INTEGER)), 0) AS read_tokens
           FROM observations WHERE ${f.where} GROUP BY day`
      )
      .all(...params) as Array<{ day: string; read_tokens: number }>;
    for (const row of rows) add(row.day, 'read_tokens', row.read_tokens);
  } catch {
    // observations.text missing on a partially-migrated install — skip; the
    // savings derivation below simply won't fire for these days.
  }

  // prompt_count — COUNT only; prompt_text is never selected.
  try {
    const f = frag('created_at_epoch');
    const rows = db
      .query(
        `SELECT ${f.day} AS day, COUNT(*) AS c FROM user_prompts WHERE ${f.where} GROUP BY day`
      )
      .all(...params) as Array<{ day: string; c: number }>;
    for (const row of rows) add(row.day, 'prompt_count', row.c);
  } catch {
    // No user_prompts table yet.
  }

  // project_count — cross-table distinct in ONE query (UNION dedupes the
  // same project appearing in both tables on the same day; summing per-table
  // distincts would multi-count).
  try {
    const fo = frag('created_at_epoch');
    const fs = frag('started_at_epoch');
    const rows = db
      .query(
        `SELECT day, COUNT(DISTINCT project) AS c FROM (
           SELECT ${fo.day} AS day, project FROM observations WHERE ${fo.where}
           UNION
           SELECT ${fs.day} AS day, project FROM sdk_sessions WHERE ${fs.where}
         ) GROUP BY day`
      )
      .all(...params) as Array<{ day: string; c: number }>;
    for (const row of rows) add(row.day, 'project_count', row.c);
  } catch {
    // Either table missing — skip.
  }

  // Derive tokens_saved_vs_naive per day from the two rollups collected above,
  // mirroring live's savings = discovery_tokens - read_tokens. Floored at 0:
  // days with read activity but no summary rows (so discovery_tokens absent)
  // would otherwise emit a negative, which is meaningless for a savings series.
  // Only emitted when the day actually has a read_tokens figure, so days with
  // no observations stay clean rather than reporting a spurious 0.
  for (const counters of byDay.values()) {
    if (counters.read_tokens === undefined) continue;
    const discovery = counters.discovery_tokens ?? 0;
    counters.tokens_saved_vs_naive = Math.max(0, discovery - counters.read_tokens);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, counters]) => ({ day, counters }));
}

/**
 * Earliest trustworthy activity epoch (ms). Sessions-first: session start
 * timestamps are write-time and trustworthy, while observation epochs can be
 * backdated artifacts. The observations MIN is consulted only when
 * sdk_sessions has no usable rows at all.
 */
export function findFirstActivityEpochMs(db: Database): number | null {
  try {
    const ms = asMs('started_at_epoch');
    const row = db
      .query(`SELECT MIN(${ms}) AS epoch FROM sdk_sessions WHERE ${ms} >= ?1`)
      .get(PROJECT_EPOCH_FLOOR) as { epoch: number | null } | null;
    if (row?.epoch) return row.epoch;
  } catch {
    // No sessions table yet — fall through to observations.
  }

  try {
    const ms = asMs('created_at_epoch');
    const row = db
      .query(`SELECT MIN(${ms}) AS epoch FROM observations WHERE ${ms} >= ?1`)
      .get(PROJECT_EPOCH_FLOOR) as { epoch: number | null } | null;
    if (row?.epoch) return row.epoch;
  } catch {
    // No observations table either.
  }

  return null;
}

/**
 * Deterministic (UUIDv5) event id so a crash-window retry carries a
 * byte-identical uuid — PostHog's dedupe key is
 * (toDate(timestamp), event, distinct_id, uuid).
 */
export function deterministicEventUuid(installId: string, event: string, day: string): string {
  return uuidV5(`${installId}|${event}|${day}`, BACKFILL_NAMESPACE);
}

/**
 * Pure assembly of the full backfill payload:
 *  - one `historical_activity` per active day — rollup counters +
 *    backfilled:true, scrubbed, profile-less. NO buildBaseProperties():
 *    stamping the CURRENT version/os onto historical days would permanently
 *    poison version-over-time charts.
 *  - one `install_inferred` at noon UTC of the install day — base props +
 *    first_active_date, scrubbed, with $set person traits ($set = current
 *    person state, so base props are correct here).
 *
 * Noon UTC is load-bearing twice: it keeps each event inside its UTC day for
 * dashboards in UTC-12..+11, and it is retry-stable (the dedupe key needs a
 * byte-identical timestamp).
 *
 * Installs younger than the lag window (installDay > lastFullDay) return []:
 * live telemetry covers their entire life, and shipping a <48h timestamp
 * would violate the historical-migration contract.
 */
export function buildBackfillEvents(
  db: Database,
  installId: string,
  nowMs: number
): BackfillEvent[] {
  const lastFullDay = utcDayString(nowMs - BACKFILL_LAG_MS);

  const firstActivityEpochMs = findFirstActivityEpochMs(db);
  if (firstActivityEpochMs === null) return [];

  const installDay = utcDayString(firstActivityEpochMs);
  if (installDay > lastFullDay) return [];

  const events: BackfillEvent[] = [];

  for (const rollup of collectDailyRollups(db, lastFullDay, installDay)) {
    const properties: Record<string, unknown> = scrubProperties({
      ...rollup.counters,
      backfilled: true,
    });
    // $-prefixed PostHog directives are not user data and bypass the
    // whitelist; added AFTER scrubbing (same as captureEvent).
    properties.$process_person_profile = false;
    events.push({
      event: 'historical_activity',
      properties,
      timestamp: new Date(rollup.day + 'T12:00:00Z'),
      uuid: deterministicEventUuid(installId, 'historical_activity', rollup.day),
    });
  }

  const installProps: Record<string, unknown> = scrubProperties({
    ...buildBaseProperties(),
    // Explicit assignment is load-bearing: buildPersonSet only copies keys
    // PRESENT on the event's properties.
    first_active_date: installDay,
    backfilled: true,
  });
  installProps.$set = buildPersonSet(installProps);
  events.push({
    event: 'install_inferred',
    properties: installProps,
    timestamp: new Date(installDay + 'T12:00:00Z'),
    uuid: deterministicEventUuid(installId, 'install_inferred', 'install'),
  });

  return events;
}

/**
 * One-shot historical backfill. Fire-and-forget from worker startup; never
 * throws (telemetry must never break the worker).
 *
 * Gate sequence (ORDER MATTERS — the debug dry-run must precede every marker
 * write so debug mode can never latch the marker):
 *  1. completion marker exists       -> return
 *  2. no telemetry consent           -> return (no marker — later opt-in still backfills)
 *  3. build events
 *  4. CLAUDE_MEM_TELEMETRY_DEBUG=1   -> stderr dry-run, NO send, NO marker
 *  5. zero events                    -> write marker, return
 *  6. no API key                     -> return (vestigial: the embedded key is never falsy)
 *  7. dedicated historicalMigration client, single-batch sizing
 *  8. on('error') latch + capture all + await shutdown() (the ONLY delivery barrier)
 *  9. marker ONLY on clean shutdown with zero emitted errors
 */
export async function runHistoricalBackfill(db: Database): Promise<void> {
  try {
    if (isBackfillComplete()) return;

    if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) return;

    const nowMs = Date.now();
    const lastFullDay = utcDayString(nowMs - BACKFILL_LAG_MS);
    const installId = getOrCreateInstallId();
    const events = buildBackfillEvents(db, installId, nowMs);

    if (process.env.CLAUDE_MEM_TELEMETRY_DEBUG === '1') {
      // Dry-run: print the exact payload to stderr (debug mode is a human in
      // the foreground — same convention as captureEvent), send nothing,
      // write no marker. Intentionally re-runs on every debug worker start.
      const days = events
        .filter(e => e.event === 'historical_activity')
        .map(e => e.timestamp.toISOString().slice(0, 10));
      const dayRange = days.length > 0 ? `${days[0]}..${days[days.length - 1]}` : '(none)';
      process.stderr.write(
        `[telemetry-backfill] dry-run: ${events.length} events, days ${dayRange}, lastFullDay ${lastFullDay}\n`
      );
      for (const e of events) {
        process.stderr.write(
          '[telemetry-backfill] ' +
            JSON.stringify({
              event: e.event,
              timestamp: e.timestamp.toISOString(),
              uuid: e.uuid,
              properties: e.properties,
            }) +
            '\n'
        );
      }
      return;
    }

    if (events.length === 0) {
      // Fresh installs land here: nothing pre-telemetry exists, and live
      // telemetry covers them from day 0 — latch so we never rescan.
      writeBackfillMarker({
        completedAt: new Date().toISOString(),
        throughDay: lastFullDay,
        eventCount: 0,
        installId,
        version: BACKFILL_VERSION,
      });
      return;
    }

    if (!getTelemetryApiKey()) return;

    // Dedicated short-lived client — the live singleton lacks
    // historicalMigration and its shutdown latch must stay untouched. The
    // 5000s make flushAt unreachable (no swallowed background flushes) and
    // keep the whole backfill in ONE request at shutdown, with no silent
    // queue-cap drops for multi-year installs.
    const client = new PostHog(getTelemetryApiKey(), {
      host: getTelemetryHost(),
      historicalMigration: true,
      flushAt: 5000,
      maxBatchSize: 5000,
      maxQueueSize: 5000,
      disableGeoip: false,
    });

    // shutdown() swallows fetch errors internally; the public error emitter
    // is the only delivery-failure signal.
    const errors: unknown[] = [];
    client.on('error', (err: unknown) => {
      errors.push(err);
    });

    for (const e of events) {
      client.capture({
        distinctId: installId,
        event: e.event,
        properties: e.properties,
        timestamp: e.timestamp,
        uuid: e.uuid,
      });
    }

    // shutdown() is the only delivery barrier: it joins pending capture
    // promises, then loops flush until the queue drains. A bare flush() can
    // resolve while captures are still un-enqueued.
    await client.shutdown();

    if (errors.length === 0) {
      writeBackfillMarker({
        completedAt: new Date().toISOString(),
        throughDay: lastFullDay,
        eventCount: events.length,
        installId,
        version: BACKFILL_VERSION,
      });
      logger.info('SYSTEM', 'Telemetry historical backfill complete', {
        eventCount: events.length,
        throughDay: lastFullDay,
      });
    } else {
      // No marker: the next worker start retries with byte-identical events
      // (deterministic uuid + noon-UTC timestamps make the retry dedupable).
      logger.warn('SYSTEM', 'Telemetry historical backfill delivery errored; will retry on next worker start', {
        eventCount: events.length,
        errorCount: errors.length,
      });
    }
  } catch (error) {
    logger.error(
      'SYSTEM',
      'Telemetry historical backfill failed (non-blocking)',
      {},
      toError(error)
    );
  }
}
