/**
 * Shared SQL fragment that excludes user-dismissed observations from the
 * queries that surface memory PROACTIVELY (file-context banner, SQLite search,
 * session-start / context injection). It activates the reserved
 * `observation_feedback` table by treating a row with
 * `signal_type = 'dismissed'` as "hide this from surfacing".
 *
 * Contract for callers:
 *   - The observations table MUST be aliased `o` in the surrounding query
 *     (every surfacing query already does this). The fragment binds no
 *     parameters, so it can be spliced into any WHERE clause with a leading
 *     `AND` without disturbing positional `?` ordering.
 *   - It is UNCONDITIONAL (no settings gate) but a strict no-op until a
 *     `dismissed` feedback row exists — so behavior is byte-identical to the
 *     prior queries for every existing database.
 *
 * Deliberately NOT applied to id-addressed reads (`getObservationById`,
 * `getObservationsByIds`): dismiss means hide-from-surfacing, never delete, so
 * a dismissed observation stays fully retrievable by id.
 */
export const NOT_DISMISSED_SQL =
  "NOT EXISTS (SELECT 1 FROM observation_feedback f WHERE f.observation_id = o.id AND f.signal_type = 'dismissed')";
