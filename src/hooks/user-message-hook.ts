/**
 * User Message Hook - SessionStart
 * Displays context information to the user via stderr
 *
 * This hook runs in parallel with context-hook to show users what context
 * has been loaded into their session. Uses stderr + exit code 1, which for
 * SessionStart hooks displays to user only without adding to Claude's context.
 */
import { basename } from "path";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";

// Ensure worker is running
await ensureWorkerRunning();

const port = getWorkerPort();
const project = basename(process.cwd());

// Fetch formatted context directly from worker API
// Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
const response = await fetch(
  `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
  { method: 'GET' }
);

if (!response.ok) {
  throw new Error(`Failed to fetch context: ${response.status}`);
}

const output = await response.text();

console.error(
  "\n\n📝 Claude-Mem Context Loaded\n" +
  "   ℹ️  Note: This appears as stderr but is informational only\n\n" +
  output +
  "\n\n💡 New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n" +
  "\n💬 Community https://discord.gg/J4wttp9vDu" +
  `\n📺 Watch live in browser http://localhost:${port}/\n`
);

process.exit(1); // Exit code 1 for SessionStart = show stderr to user only