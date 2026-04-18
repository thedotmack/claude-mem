#!/usr/bin/env bun
/**
 * cwd-remap — Rewrite sdk_sessions.project (+ observations.project,
 * session_summaries.project) using the cwd captured per-message in
 * pending_messages.cwd as the single source of truth.
 *
 * For each distinct cwd:
 *   - git -C <cwd> rev-parse --git-dir  AND  --git-common-dir
 *     If they differ → worktree. parent = basename(dirname(common-dir)),
 *     project = parent/<basename(cwd)>.
 *     Else → project = basename(cwd).
 *   - If the directory doesn't exist, or git errors, skip that cwd.
 *
 * Usage:
 *   bun scripts/cwd-remap.ts          # dry-run (default)
 *   bun scripts/cwd-remap.ts --apply  # write updates in a single transaction
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { existsSync, copyFileSync } from 'fs';
import { spawnSync } from 'child_process';

const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');
const APPLY = process.argv.includes('--apply');

type Classification =
  | { kind: 'main'; project: string }
  | { kind: 'worktree'; project: string; parent: string }
  | { kind: 'skip'; reason: string };

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    const stderr = (r.stderr ?? '').trim();
    if (stderr && !/not a git repository/i.test(stderr)) {
      console.error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
    }
    return null;
  }
  return r.stdout.trim();
}

function classify(cwd: string): Classification {
  if (!existsSync(cwd)) return { kind: 'skip', reason: 'cwd-missing' };

  const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return { kind: 'skip', reason: 'not-a-git-repo' };

  const commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return { kind: 'skip', reason: 'no-common-dir' };

  // Use the worktree root, not the cwd — a session may be in a subdir.
  const toplevel = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return { kind: 'skip', reason: 'no-toplevel' };
  const leaf = basename(toplevel);

  if (gitDir === commonDir) {
    return { kind: 'main', project: leaf };
  }

  // worktree: common-dir = <parent-repo>/.git (normal) or <parent>.git (bare).
  // Normal: dirname strips the trailing /.git. Bare: strip the .git suffix.
  const parentRepoDir = commonDir.endsWith('/.git')
    ? dirname(commonDir)
    : commonDir.replace(/\.git$/, '');
  const parent = basename(parentRepoDir);
  return { kind: 'worktree', project: `${parent}/${leaf}`, parent };
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  if (APPLY) {
    const backup = `${DB_PATH}.bak-cwd-remap-${Date.now()}`;
    copyFileSync(DB_PATH, backup);
    console.log(`Backup created: ${backup}`);
  }

  const db = new Database(DB_PATH);

  const cwdRows = db.prepare(`
    SELECT cwd, COUNT(*) AS messages
    FROM pending_messages
    WHERE cwd IS NOT NULL AND cwd != ''
    GROUP BY cwd
  `).all() as Array<{ cwd: string; messages: number }>;

  console.log(`Classifying ${cwdRows.length} distinct cwds via git...`);

  const byCwd = new Map<string, Classification>();
  const counts = { main: 0, worktree: 0, skip: 0 };
  for (const { cwd } of cwdRows) {
    const c = classify(cwd);
    byCwd.set(cwd, c);
    counts[c.kind]++;
  }
  console.log(`  main=${counts.main}  worktree=${counts.worktree}  skip=${counts.skip}`);

  // Skipped cwds (so user sees what's missing)
  const skipped = [...byCwd.entries()].filter(([, c]) => c.kind === 'skip') as Array<[string, Extract<Classification, { kind: 'skip' }>]>;
  if (skipped.length) {
    console.log('\nSkipped cwds:');
    for (const [cwd, c] of skipped) console.log(`  [${c.reason}] ${cwd}`);
  }

  // Per-session target: use the EARLIEST pending_messages.cwd for each session.
  // (Dominant-cwd is wrong: claude-mem's own hooks run from nested dirs like
  //  `.context/claude-mem/` and dominate the count, misattributing the session.)
  const sessionRows = db.prepare(`
    SELECT s.id AS session_id, s.memory_session_id, s.content_session_id, s.project AS old_project, p.cwd
    FROM sdk_sessions s
    JOIN pending_messages p ON p.content_session_id = s.content_session_id
    WHERE p.cwd IS NOT NULL AND p.cwd != ''
      AND p.id = (
        SELECT MIN(p2.id) FROM pending_messages p2
        WHERE p2.content_session_id = s.content_session_id
          AND p2.cwd IS NOT NULL AND p2.cwd != ''
      )
  `).all() as Array<{ session_id: number; memory_session_id: string | null; content_session_id: string; old_project: string; cwd: string }>;

  type Target = { sessionId: number; memorySessionId: string | null; contentSessionId: string; oldProject: string; newProject: string; cwd: string };
  const perSession = new Map<number, Target>();

  for (const r of sessionRows) {
    const c = byCwd.get(r.cwd);
    if (!c || c.kind === 'skip') continue;
    perSession.set(r.session_id, {
      sessionId: r.session_id,
      memorySessionId: r.memory_session_id,
      contentSessionId: r.content_session_id,
      oldProject: r.old_project,
      newProject: c.project,
      cwd: r.cwd,
    });
  }

  const targets = [...perSession.values()].filter(t => t.oldProject !== t.newProject);

  console.log(`\nSessions linked to a classified cwd: ${perSession.size}`);
  console.log(`Sessions whose project would change: ${targets.length}`);

  const summary = new Map<string, number>();
  for (const t of targets) {
    const key = `${t.oldProject}  →  ${t.newProject}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }
  const rows = [...summary.entries()]
    .map(([mapping, n]) => ({ mapping, sessions: n }))
    .sort((a, b) => b.sessions - a.sessions);
  console.log('\nTop mappings:');
  console.table(rows.slice(0, 30));
  if (rows.length > 30) console.log(`  …and ${rows.length - 30} more mappings`);

  if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to perform UPDATEs.');
    db.close();
    return;
  }

  const updSession = db.prepare('UPDATE sdk_sessions      SET project = ? WHERE id = ?');
  const updObs     = db.prepare('UPDATE observations      SET project = ? WHERE memory_session_id = ?');
  const updSum     = db.prepare('UPDATE session_summaries SET project = ? WHERE memory_session_id = ?');

  let sessionN = 0, obsN = 0, sumN = 0;
  const tx = db.transaction(() => {
    for (const t of targets) {
      sessionN += updSession.run(t.newProject, t.sessionId).changes;
      if (t.memorySessionId) {
        obsN += updObs.run(t.newProject, t.memorySessionId).changes;
        sumN += updSum.run(t.newProject, t.memorySessionId).changes;
      }
    }
  });
  tx();

  console.log(`\nApplied. sessions=${sessionN} observations=${obsN} session_summaries=${sumN}`);
  db.close();
}

main();
