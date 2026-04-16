#!/usr/bin/env bun
/**
 * worktree-remap — Retroactively reattribute past sessions that were written
 * with a plain project name (e.g. `claude-mem`) to the `parent/worktree`
 * composite name when the original worktree can be inferred from the paths
 * in the session's observations or user prompt.
 *
 * Only sessions with HIGH-CONFIDENCE worktree path signatures are remapped.
 * Everything else is left alone.
 *
 * Usage:
 *   bun scripts/worktree-remap.ts           # dry-run (default)
 *   bun scripts/worktree-remap.ts --apply   # write changes in a transaction
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, copyFileSync } from 'fs';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const APPLY = process.argv.includes('--apply');

const WORKTREE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'conductor', regex: /\/conductor\/workspaces\/([^/]+)\/([^/"'\s)]+)/ },
  { name: 'superset',  regex: /\/\.superset\/worktrees\/([^/]+)\/([^/"'\s)]+)/ },
];

interface SessionRow {
  id: number;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
}

function allMatches(text: string | null | undefined): Array<{ parent: string; worktree: string }> {
  if (!text) return [];
  const results: Array<{ parent: string; worktree: string }> = [];
  for (const p of WORKTREE_PATTERNS) {
    const global = new RegExp(p.regex.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      results.push({ parent: m[1], worktree: m[2] });
    }
  }
  return results;
}

/**
 * Collects every worktree path match across the session's observations + user prompt,
 * then picks the inference using this priority:
 *   1. A match whose worktree basename === the session's current plain project name.
 *      (Pre-#1820 sessions stored the worktree basename as `project` — these are trusted.)
 *   2. If none match the current project, and there's a single unambiguous (parent, worktree)
 *      across ALL signals, use it.
 *   3. Otherwise skip (ambiguous — likely cross-worktree reads).
 */
function inferWorktree(
  db: Database,
  memorySessionId: string | null,
  userPrompt: string | null,
  currentProject: string
): { parent: string; worktree: string } | null {
  const matches: Array<{ parent: string; worktree: string }> = [];

  if (memorySessionId) {
    const rows = db.prepare(`
      SELECT files_read, files_modified, source_input_summary, metadata
      FROM observations
      WHERE memory_session_id = ?
        AND (files_read LIKE '%/conductor/workspaces/%' OR files_modified LIKE '%/conductor/workspaces/%'
             OR source_input_summary LIKE '%/conductor/workspaces/%' OR metadata LIKE '%/conductor/workspaces/%'
             OR files_read LIKE '%.superset/worktrees/%' OR files_modified LIKE '%.superset/worktrees/%'
             OR source_input_summary LIKE '%.superset/worktrees/%' OR metadata LIKE '%.superset/worktrees/%')
    `).all(memorySessionId) as Array<{ files_read: string | null; files_modified: string | null; source_input_summary: string | null; metadata: string | null }>;

    for (const r of rows) {
      matches.push(...allMatches(r.files_read));
      matches.push(...allMatches(r.files_modified));
      matches.push(...allMatches(r.source_input_summary));
      matches.push(...allMatches(r.metadata));
    }
  }

  matches.push(...allMatches(userPrompt));
  if (matches.length === 0) return null;

  const wtMatch = matches.find(m => m.worktree === currentProject);
  if (wtMatch) return wtMatch;

  const signatures = new Set(matches.map(m => `${m.parent}/${m.worktree}`));
  if (signatures.size === 1) return matches[0];

  return null;
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  if (APPLY) {
    const backup = `${DB_PATH}.bak-worktree-remap-${Date.now()}`;
    copyFileSync(DB_PATH, backup);
    console.log(`Backup created: ${backup}`);
  }

  const db = new Database(DB_PATH);

  const sessions = db.prepare(`
    SELECT id, memory_session_id, project, user_prompt
    FROM sdk_sessions
    WHERE project NOT LIKE '%/%' AND project != ''
  `).all() as SessionRow[];

  console.log(`Scanning ${sessions.length} plain-project sessions...`);

  type Remap = { sessionId: number; memorySessionId: string | null; oldProject: string; newProject: string };
  const remaps: Remap[] = [];
  const summary = new Map<string, { count: number; firstExample: number }>();

  for (const s of sessions) {
    const hit = inferWorktree(db, s.memory_session_id, s.user_prompt, s.project);
    if (!hit) continue;

    const newProject = `${hit.parent}/${hit.worktree}`;
    if (newProject === s.project) continue;

    remaps.push({ sessionId: s.id, memorySessionId: s.memory_session_id, oldProject: s.project, newProject });
    const key = `${s.project} → ${newProject}`;
    const entry = summary.get(key);
    if (entry) entry.count++;
    else summary.set(key, { count: 1, firstExample: s.id });
  }

  const rows = Array.from(summary.entries())
    .map(([mapping, v]) => ({ mapping, sessions: v.count, exampleSessionId: v.firstExample }))
    .sort((a, b) => b.sessions - a.sessions);

  console.log('\nRemap summary:');
  console.table(rows);
  console.log(`\nTotal sessions to remap: ${remaps.length}`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to perform UPDATEs.');
    return;
  }

  console.log('\nApplying updates in a single transaction...');
  const updateSession = db.prepare('UPDATE sdk_sessions      SET project=? WHERE id=?');
  const updateObs     = db.prepare('UPDATE observations      SET project=? WHERE memory_session_id=?');
  const updateSum     = db.prepare('UPDATE session_summaries SET project=? WHERE memory_session_id=?');

  let sessionUpdates = 0, obsUpdates = 0, sumUpdates = 0;
  const tx = db.transaction(() => {
    for (const r of remaps) {
      sessionUpdates += updateSession.run(r.newProject, r.sessionId).changes;
      if (r.memorySessionId) {
        obsUpdates += updateObs.run(r.newProject, r.memorySessionId).changes;
        sumUpdates += updateSum.run(r.newProject, r.memorySessionId).changes;
      }
    }
  });
  tx();

  console.log(`Done. sessions=${sessionUpdates} observations=${obsUpdates} session_summaries=${sumUpdates}`);
}

main();
