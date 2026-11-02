import type { Database } from 'bun:sqlite';

/**
 * The projects a read is scoped to: the explicit list, else the single project.
 * A checkout reads several keys (its current one, plus the ones it wrote under
 * before a git-remote slug, an environment or a marker re-keyed it), so reads
 * take a list (gate P2-5).
 */
export function scopedProjects(filters: { project?: string; projects?: string[] }): string[] {
  const requested = filters.projects?.length ? filters.projects : filters.project ? [filters.project] : [];
  return [...new Set(requested.map(project => project.trim()).filter(Boolean))];
}

/**
 * SQL matching a row stored under one of `projects`, or (with `includeMerged`)
 * merged into one of them. Case-insensitive, like every project read (#3531).
 */
export function projectScopeSql(
  alias: string,
  projects: string[],
  options: { includeMerged: boolean }
): { sql: string; params: string[] } {
  const placeholders = projects.map(() => '?').join(',');
  if (!options.includeMerged) {
    return { sql: `${alias}.project COLLATE NOCASE IN (${placeholders})`, params: [...projects] };
  }
  return {
    sql: `(${alias}.project COLLATE NOCASE IN (${placeholders}) OR ${alias}.merged_into_project COLLATE NOCASE IN (${placeholders}))`,
    params: [...projects, ...projects],
  };
}

/**
 * Every stored key a read of `projects` has to match: each project and every
 * other spelling of it stored here (SQLite compares project keys
 * case-insensitively, Chroma's metadata filters exactly; #3531), plus the
 * projects merged wholesale into one of them. Only a whole merge promotes its
 * source to a read key: every row stored under the source (observations and
 * session_summaries alike) carries `merged_into_project` = one of the
 * requested keys (gate P2-4: worktrees merged into a repo, the repo merged
 * into a parent — the second hop follows because the repo becomes a key and
 * the per-row merged scope, `projectScopeSql` with `includeMerged`, matches
 * its adopted rows). A partial adoption — a hand-picked subset of a large
 * project stamped into a smaller one — must not promote the source: any
 * stamped row would otherwise expose every row the user did not pick
 * (#4782). One statement, every count answered from the v63/v64 covering
 * indexes; nothing loads rows.
 */
const WHOLE_MERGE_LOOKUPS = 4;

export function projectReadKeys(db: Database, projects: string[]): string[] {
  const requested = scopedProjects({ projects });
  if (requested.length === 0) return [];
  const placeholders = requested.map(() => '?').join(',');
  const lookups: Array<[sql: string, requestedCopies: number]> = [
    [`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${placeholders})`, 1],
    [`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${placeholders})`, 1],
    [`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`, 1],
    [`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${placeholders})`, 1],
    [`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`, 1],
    [
      // Projects whose every stored row is stamped into one of `projects`.
      `SELECT candidates.key FROM (
        SELECT project AS key FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})
        UNION
        SELECT project AS key FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})
      ) candidates
      WHERE (
        (SELECT COUNT(*) FROM observations WHERE project COLLATE NOCASE = candidates.key)
        + (SELECT COUNT(*) FROM session_summaries WHERE project COLLATE NOCASE = candidates.key)
      ) = (
        (SELECT COUNT(*) FROM observations
          WHERE project COLLATE NOCASE = candidates.key AND merged_into_project COLLATE NOCASE IN (${placeholders}))
        + (SELECT COUNT(*) FROM session_summaries
          WHERE project COLLATE NOCASE = candidates.key AND merged_into_project COLLATE NOCASE IN (${placeholders}))
      )`,
      WHOLE_MERGE_LOOKUPS,
    ],
  ];
  const statement = db.prepare(lookups.map(([sql]) => sql).join(' UNION '));
  try {
    const rows = statement.all(
      ...lookups.flatMap(([, requestedCopies]) => Array(requestedCopies).fill(requested).flat())
    ) as Array<{ key: string }>;
    return [...new Set([...requested, ...rows.map(row => row.key)])];
  } finally {
    statement.finalize();
  }
}
