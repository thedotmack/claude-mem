#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";

const cwd = process.argv[2] || process.env.CLAUDE_CWD || process.cwd();
const project = basename(cwd);

try {
  let dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
  if (!process.env.CLAUDE_MEM_DATA_DIR) {
    const settingsPath = join(dataDir, "settings.json");
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (settings.CLAUDE_MEM_DATA_DIR) dataDir = settings.CLAUDE_MEM_DATA_DIR;
      } catch { /* use default */ }
    }
  }

  const dbPath = join(dataDir, "claude-mem.db");
  if (!existsSync(dbPath)) {
    console.log(JSON.stringify({ observations: 0, prompts: 0, project }));
    process.exit(0);
  }

  const db = new Database(dbPath, { readonly: true });

  const obs = db.query("SELECT COUNT(*) as c FROM observations WHERE project = ?").get(project);
  const prompts = db.query(
    `SELECT COUNT(*) as c FROM user_prompts up
     JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
     WHERE s.project = ?`
  ).get(project);
  console.log(JSON.stringify({ observations: obs.c, prompts: prompts.c, project }));
  db.close();
} catch (e) {
  console.log(JSON.stringify({ observations: 0, prompts: 0, project, error: e.message }));
}
