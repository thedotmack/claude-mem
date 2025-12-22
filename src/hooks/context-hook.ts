/**
 * Context Hook - SessionStart
 *
 * Pure HTTP client - calls worker to generate context.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import { stdin } from "process";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";
import { HOOK_TIMEOUTS } from "../shared/hook-constants.js";
import { getProjectName } from "../utils/project-name.js";

export interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
}

async function contextHook(input?: SessionStartInput): Promise<string> {
  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  const cwd = input?.cwd ?? process.cwd();
  const project = getProjectName(cwd);
  const port = getWorkerPort();

  const url = `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT) });

  if (!response.ok) {
    throw new Error(`Context generation failed: ${response.status}`);
  }

  const result = await response.text();
  return result.trim();
}

// Entry Point - handle stdin/stdout
const forceColors = process.argv.includes("--colors");

if (stdin.isTTY || forceColors) {
  contextHook(undefined).then((text) => {
    console.log(text);
    process.exit(0);
  });
} else {
  let input = "";
  stdin.on("data", (chunk) => (input += chunk));
  stdin.on("end", async () => {
    let parsed: SessionStartInput | undefined;
    try {
      parsed = input.trim() ? JSON.parse(input) : undefined;
    } catch (error) {
      throw new Error(`Failed to parse hook input: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await contextHook(parsed);

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      })
    );
    process.exit(0);
  });
}
