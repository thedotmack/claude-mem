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
 * case-insensitively, Chroma's metadata filters exactly; #3531), plus every
 * project whose rows were merged into one of them, so the read also follows one
 * hop of a merge chain (`repo/wt` merged into `repo`, `repo` merged into
 * `work`: gate P2-4).
 */
export function projectReadKeys(db: Database, projects: string[]): string[] {
  const requested = scopedProjects({ projects });
  if (requested.length === 0) return [];
  const placeholders = requested.map(() => '?').join(',');
  const lookups = [
    `SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM observations WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
    // One hop: the projects merged into the requested ones.
    `SELECT project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
  ];
  const rows = db.prepare(lookups.join(' UNION ')).all(
    ...lookups.flatMap(() => requested)
  ) as Array<{ key: string }>;
  return [...new Set([...requested, ...rows.map(row => row.key)])];
}
