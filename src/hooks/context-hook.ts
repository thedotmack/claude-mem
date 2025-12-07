/**
 * Context Hook - SessionStart
 *
 * Pure HTTP client - calls worker to generate context.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import path from "path";
import { stdin } from "process";
import { execSync } from "child_process";
import { getWorkerPort } from "../shared/worker-utils.js";

export interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

async function waitForPort(port: number, maxWaitMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      execSync(`curl -s -f -m 1 "http://localhost:${port}/api/health" > /dev/null 2>&1`, {
        timeout: 1000,
      });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
  return false;
}

async function contextHook(input?: SessionStartInput): Promise<string> {
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : "unknown-project";
  const port = getWorkerPort();

  // Wait for worker to be available
  const isAvailable = await waitForPort(port);
  if (!isAvailable) {
    throw new Error(
      `Worker service not available on port ${port} after 10s. Try: npm run worker:restart`
    );
  }

  const url = `http://localhost:${port}/api/context/inject?project=${encodeURIComponent(project)}`;
  const result = execSync(`curl -s "${url}"`, { encoding: "utf-8", timeout: 5000 });
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
