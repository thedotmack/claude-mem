/**
 * Context Hook - SessionStart
 *
 * Pure HTTP client - calls worker to generate context.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import path from "path";
import { stdin } from "process";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";
import { HOOK_TIMEOUTS } from "../shared/hook-constants.js";
import { handleWorkerError } from "../shared/hook-error-handler.js";

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
  const project = cwd ? path.basename(cwd) : "unknown-project";
  const port = getWorkerPort();

  const url = `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT) });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch context: ${response.status} ${errorText}`);
    }

    const result = await response.text();
    return result.trim();
  } catch (error: any) {
    handleWorkerError(error);
  }
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
    const parsed = input.trim() ? JSON.parse(input) : undefined;
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
