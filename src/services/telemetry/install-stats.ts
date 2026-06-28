import { statSync } from 'fs';
import type { Database } from 'bun:sqlite';

/**
 * Aggregate, content-free snapshot of an install's memory database, attached
 * to the worker_started lifecycle event (start + daily heartbeat) and set as
 * person properties on the anonymous install UUID. This is what tells us the
 * real state of the installed base: how big installs are, how long people
 * have had claude-mem, and whether they are still actively using it.
 *
 * Privacy: counts, a file size, and day-granularity deltas ONLY — never
 * project names, observation text, or anything derived from content. Every
 * key emitted here must also be in the scrub whitelist and documented in
 * docs/public/telemetry.mdx.
 */

/**
 * Epoch columns hold mixed units historically: a few hundred legacy rows were
 * written in seconds, everything since in milliseconds. Normalize to ms in
 * SQL before any date math (10^12 ms ≈ 2001, 10^12 s ≈ year 33658 — no
 * plausible value is ambiguous).
 */
function asMs(col: string): string {
  return `CASE WHEN ${col} < 1000000000000 THEN ${col} * 1000 ELSE ${col} END`;
}

const DAY_MS = 86_400_000;

export function collectInstallStats(db: Database): Record<string, number> {
  const stats: Record<string, number> = {};
  const now = Date.now();

  // Each block is independently best-effort: a missing table on a fresh or
  // partially-migrated install drops that block's keys, never the event.
  try {
    const counts = db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM observations) AS observations,
           (SELECT COUNT(*) FROM session_summaries) AS summaries,
           (SELECT COUNT(*) FROM sdk_sessions) AS sessions,
           (SELECT COUNT(DISTINCT project) FROM sdk_sessions) AS projects`
      )
      .get() as { observations: number; summaries: number; sessions: number; projects: number } | null;
    if (counts) {
      stats.db_observation_count = counts.observations;
      stats.db_summary_count = counts.summaries;
      stats.db_session_count = counts.sessions;
      stats.db_project_count = counts.projects;
    }
  } catch {
    // Table not created yet — counts arrive once the schema exists.
  }

  try {
    const firstSession = db
      .query(`SELECT MIN(${asMs('started_at_epoch')}) AS epoch FROM sdk_sessions`)
      .get() as { epoch: number | null } | null;
    if (firstSession?.epoch) {
      stats.install_age_days = Math.max(0, Math.floor((now - firstSession.epoch) / DAY_MS));
    }
  } catch {
    // No sessions table yet.
  }

  try {
    const obsEpochMs = asMs('created_at_epoch');
    const activity = db
      .query(
        `SELECT
           MAX(${obsEpochMs}) AS latest,
           COUNT(CASE WHEN ${obsEpochMs} >= ?1 THEN 1 END) AS last_7d,
           COUNT(CASE WHEN ${obsEpochMs} >= ?2 THEN 1 END) AS last_30d
         FROM observations`
      )
      .get(now - 7 * DAY_MS, now - 30 * DAY_MS) as
      | { latest: number | null; last_7d: number; last_30d: number }
      | null;
    if (activity) {
      stats.obs_count_7d = activity.last_7d;
      stats.obs_count_30d = activity.last_30d;
      if (activity.latest) {
        stats.days_since_last_obs = Math.max(0, Math.floor((now - activity.latest) / DAY_MS));
      }
    }
  } catch {
    // No observations table yet.
  }

  try {
    // db.filename is the path the connection actually opened (':memory:' in
    // tests, where statSync throws and the key is simply omitted).
    stats.db_size_mb = Math.round((statSync(db.filename).size / (1024 * 1024)) * 10) / 10;
  } catch {
    // In-memory or unreadable database file.
  }

  return stats;
}
