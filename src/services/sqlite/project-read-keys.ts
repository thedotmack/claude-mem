import type { Database } from 'bun:sqlite';

/**
 * The projects a read is scoped to: the explicit list, else the single project.
 * A checkout reads several keys (its current one, plus the ones it wrote under
 * before a git-remote slug, an environment or a marker re-keyed it), so reads
 * take a list (gate P2-5).
 */
export function scopedProjects(filters: { project?: string; projects?: string[] }): string[] {
  const requested = filters.projects?.length ? filters.projects : filters.project ? [filters.project] : [];
  return [...new Set(requested.filter(project => project.trim().length > 0))];
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
 * known keys. Repeat until the whole merge chain is covered: a worktree may
 * have joined a repository before that repository joined an environment
 * which was later merged again. A partial adoption — a hand-picked subset of a large
 * project stamped into a smaller one — must not promote the source: any
 * stamped row would otherwise expose every row the user did not pick
 * (#4782). Each pass uses the v63/v64 covering indexes; nothing loads row
 * bodies. One read transaction keeps every promotion on the same snapshot.
 */
export function projectReadKeys(db: Database, projects: string[]): string[] {
  const requested = scopedProjects({ projects });
  if (requested.length === 0) return [];
  return db.transaction(() => {
    const keys = new Set(requested);
    // SQLite NOCASE folds ASCII only. Keep every literal spelling for Chroma,
    // but another spelling of an already queried key needs no extra pass.
    const fold = (key: string) => key.replace(/[A-Z]/g, letter => letter.toLowerCase());
    const queried = new Set(requested.map(fold));
    for (;;) {
      let expanded = false;
      for (const key of readProjectKeyPass(db, [...keys])) {
        keys.add(key);
        const folded = fold(key);
        if (!queried.has(folded)) {
          queried.add(folded);
          expanded = true;
        }
      }
      if (!expanded) return [...keys];
    }
  })();
}

function readProjectKeyPass(db: Database, requested: string[]): string[] {
  // Every lookup uses the same list; reuse its bind slots across the compound query.
  const placeholders = requested.map((_, i) => `?${i + 1}`).join(',');
  const lookups = [
    `SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM observations WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
    `SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${placeholders})`,
    `SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${placeholders})`,
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
  ];
  const statement = db.prepare(lookups.join(' UNION '));
  try {
    const rows = statement.all(...requested) as Array<{ key: string }>;
    return rows.map(row => row.key);
  } finally {
    statement.finalize();
  }
}
