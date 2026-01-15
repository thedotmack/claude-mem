#!/usr/bin/env bun
/**
 * claude-mem-note CLI
 * Add manual notes/observations to claude-mem
 * 
 * Usage: bun run cli.ts <project> <title> <note> [type]
 */

const WORKER_URL = "http://127.0.0.1:37777";

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
}

async function isWorkerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER_URL}/api/health`, { 
      signal: AbortSignal.timeout(2000) 
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function initSession(sessionId: string, project: string, prompt: string): Promise<SessionInitResponse | null> {
  try {
    const res = await fetch(`${WORKER_URL}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        claudeSessionId: sessionId, 
        project, 
        prompt 
      })
    });
    if (!res.ok) return null;
    return await res.json() as SessionInitResponse;
  } catch {
    return null;
  }
}

async function addObservation(
  sessionId: string, 
  project: string,
  title: string, 
  note: string, 
  type: string
): Promise<boolean> {
  try {
    const res = await fetch(`${WORKER_URL}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claudeSessionId: sessionId,
        tool_name: "manual_note",
        tool_input: { 
          title,
          type,
          project
        },
        tool_response: note,
        cwd: `/manual/${project}`
      })
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log(`
claude-mem-note - Add manual notes to claude-mem

Usage: bun run cli.ts <project> <title> <note> [type]

Arguments:
  project  - Project name (e.g., 'frontend')
  title    - Short title for the note
  note     - The note content
  type     - Optional: discovery|decision|bugfix|feature|refactor|change (default: discovery)

Examples:
  bun run cli.ts frontend "Auth complete" "Finished implementing JWT auth"
  bun run cli.ts frontend "Fixed login bug" "Redirect issue was stale cookies" bugfix
`);
    process.exit(1);
  }

  const [project, title, note, type = "discovery"] = args;
  
  const validTypes = ["discovery", "decision", "bugfix", "feature", "refactor", "change"];
  if (!validTypes.includes(type)) {
    console.error(`Error: Invalid type '${type}'`);
    console.error(`Valid types: ${validTypes.join(", ")}`);
    process.exit(1);
  }

  if (!await isWorkerHealthy()) {
    console.error("Error: claude-mem worker is not running at http://localhost:37777");
    console.error("Start it with: npm run worker:start (from claude-mem repo)");
    process.exit(1);
  }

  const sessionId = `manual-notes-${project}`;
  
  const initResult = await initSession(sessionId, project, "Manual notes session");
  if (!initResult) {
    console.error("Error: Failed to initialize session");
    process.exit(1);
  }

  const success = await addObservation(sessionId, project, title, note, type);
  
  if (success) {
    console.log(`✓ Note added to project '${project}'`);
    console.log(`  Title: ${title}`);
    console.log(`  Type: ${type}`);
    console.log(`  Content: ${note}`);
  } else {
    console.error("Error: Failed to add note");
    process.exit(1);
  }
}

main();
