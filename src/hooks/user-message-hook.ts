/**
 * User Message Hook - SessionStart
 * Displays context information to the user via stderr
 *
 * This hook runs in parallel with context-hook to show users what context
 * has been loaded into their session. Uses stderr as the communication channel
 * since it's currently the only way to display messages in Claude Code UI.
 */
import { basename } from "path";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";
import { HOOK_EXIT_CODES } from "../shared/hook-constants.js";

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
    throw new Error(`Worker error ${response.status}`);
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

} catch (error) {
  // Context not available yet - likely first run or worker starting up
  console.error(`
---
🎉  Note: This appears under Plugin Hook Error, but it's not an error. That's the only option for
   user messages in Claude Code UI until a better method is provided.
---

⚠️  Claude-Mem: First-Time Setup

Dependencies are installing in the background. This only happens once.

💡 TIPS:
   • Memories will start generating while you work
   • Use /init to write or update your CLAUDE.md for better project context
   • Try /clear after one session to see what context looks like

Thank you for installing Claude-Mem!

This message was not added to your startup context, so you can continue working as normal.
`);
}

process.exit(HOOK_EXIT_CODES.USER_MESSAGE_ONLY);