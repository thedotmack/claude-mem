/**
 * User Message Hook - SessionStart
 * Displays context information to the user via JSON systemMessage
 *
 * This hook runs in parallel with context-hook to show users what context
 * has been loaded into their session. Uses JSON output with systemMessage
 * for clean user communication without stderr confusion.
 */
import { basename } from "path";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";
import { HOOK_EXIT_CODES } from "../shared/hook-constants.js";
import { getWorkerRestartInstructions } from "../utils/error-messages.js";

try {
  // Ensure worker is running
  await ensureWorkerRunning();

  const port = getWorkerPort();
  const project = basename(process.cwd());

  // Fetch formatted context directly from worker API
  const response = await fetch(
    `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
    { method: 'GET', signal: AbortSignal.timeout(5000) }
  );

  if (!response.ok) {
    throw new Error(getWorkerRestartInstructions({ includeSkillFallback: true }));
  }

  const output = await response.text();

  const systemMessage =
    "\n\n📝 Claude-Mem Context Loaded\n" +
    output +
    "\n\n💡 New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n" +
    "\n💬 Community https://discord.gg/J4wttp9vDu" +
    `\n📺 Watch live in browser http://localhost:${port}/\n`;

  console.log(JSON.stringify({ systemMessage }));

} catch (error) {
  // Context not available yet - likely first run or worker starting up
  const systemMessage = `⚠️  Claude-Mem: First-Time Setup

Dependencies are installing in the background. This only happens once.

💡 TIPS:
   • Memories will start generating while you work
   • Use /init to write or update your CLAUDE.md for better project context
   • Try /clear after one session to see what context looks like

Thank you for installing Claude-Mem!

This message was not added to your startup context, so you can continue working as normal.`;

  console.log(JSON.stringify({ systemMessage }));
}

process.exit(HOOK_EXIT_CODES.SUCCESS);