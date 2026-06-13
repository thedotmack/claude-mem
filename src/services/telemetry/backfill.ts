import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { PostHog } from 'posthog-node';
import type { Database } from 'bun:sqlite';
import { resolveDataDir } from '../../shared/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { logger } from '../../utils/logger.js';
import {
  resolveTelemetryConsent,
  loadTelemetryConfig,
  getOrCreateInstallId,
} from './consent.js';
import { scrubProperties } from './scrub.js';
import {
  getTelemetryApiKey,
  getTelemetryHost,
  buildBaseProperties,
  buildPersonSet,
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

/**
 * Mirror of the private STAT_TYPE_BUCKETS set in
 * src/services/context/ContextBuilder.ts — the closed observation-type
 * vocabulary live `context_injected` events use. Everything else buckets to
 * 'other' so the backfill vocabulary is identical to live telemetry.
 */
const STAT_TYPE_BUCKETS = new Set(['bugfix', 'discovery', 'decision', 'refactor']);

/**
 * Epoch columns hold mixed units historically: a few hundred legacy rows were
 * written in seconds, everything since in milliseconds. Normalize to ms in
 * SQL before any date math (same rule as install-stats.ts — and note it must
 * be applied INSIDE aggregate functions like MIN, never outside).
 */
function asMs(col: string): string {
  return `CASE WHEN ${col} < 1000000000000 THEN ${col} * 1000 ELSE ${col} END`;
}

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
}

function getBackfillMarkerPath(): string {
  return join(resolveDataDir(), BACKFILL_MARKER_FILENAME);
}

/**
 * True when a completion marker exists. A corrupt marker file still counts as
 * complete: a marker was written at some point, and duplicate sends are worse
 * than a gap (PostHog data cannot be selectively deleted).
 */
function isBackfillComplete(): boolean {
  try {
    return readJsonSafe<Partial<BackfillMarker> | null>(getBackfillMarkerPath(), null) !== null;
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
  return Bun.randomUUIDv5(`${installId}|${event}|${day}`, BACKFILL_NAMESPACE);
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
      error instanceof Error ? error : new Error(String(error))
    );
  }
}
