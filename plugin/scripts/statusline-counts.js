#!/usr/bin/env bun
/**
 * Statusline Counts — lightweight project-scoped observation counter
 *
 * Returns JSON with observation and prompt counts for the given project,
 * suitable for integration into Claude Code's statusLineCommand.
 *
 * Usage:
 *   bun statusline-counts.js <cwd>
 *   bun statusline-counts.js /home/user/my-project
 *
 * Output (JSON, stdout):
 *   {"observations": 42, "prompts": 15, "project": "my-project"}
 *
 * The project name is derived from basename(cwd). Observations are counted
 * with a WHERE project = ? filter so only the current project's data is
 * returned — preventing inflated counts from cross-project observations.
 *
 * Performance: ~10ms typical (direct SQLite read, no HTTP, no worker dependency)
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";

try {
  // Resolve data directory from settings (supports CLAUDE_MEM_DATA_DIR override)
  let dataDir = join(homedir(), ".claude-mem");
  const settingsPath = join(dataDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.CLAUDE_MEM_DATA_DIR) dataDir = settings.CLAUDE_MEM_DATA_DIR;
    } catch { /* use default */ }
  }

  const dbPath = join(dataDir, "claude-mem.db");
  if (!existsSync(dbPath)) {
    console.log(JSON.stringify({ observations: 0, prompts: 0, project: "" }));
    process.exit(0);
  }

  const db = new Database(dbPath, { readonly: true });

  const cwd = process.argv[2] || process.env.CLAUDE_CWD || process.cwd();
  const project = basename(cwd);

  const obs = db.query("SELECT COUNT(*) as c FROM observations WHERE project = ?").get(project);
  // user_prompts links to projects through sdk_sessions.content_session_id
  const prompts = db.query(
    `SELECT COUNT(*) as c FROM user_prompts up
     JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
     WHERE s.project = ?`
  ).get(project);
  console.log(JSON.stringify({ observations: obs.c, prompts: prompts.c, project }));
  db.close();
} catch (e) {
  console.log(JSON.stringify({ observations: 0, prompts: 0, error: e.message }));
}
