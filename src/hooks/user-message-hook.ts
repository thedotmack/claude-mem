/**
 * User Message Hook - SessionStart
 * Displays context information to the user via stderr
 *
 * This hook runs in parallel with context-hook to show users what context
 * has been loaded into their session. Uses stderr as the communication channel
 * since it's currently the only way to display messages in Claude Code UI.
 */
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { getWorkerPort } from "../shared/worker-utils.js";

// Check if node_modules exists - if not, this is first run
const pluginDir = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const nodeModulesPath = join(pluginDir, 'node_modules');

if (!existsSync(nodeModulesPath)) {
  // First-time installation - dependencies not yet installed
  console.error(`
---
🎉  Note: This appears under Plugin Hook Error, but it's not an error. That's the only option for 
   user messages in Claude Code UI until a better method is provided.
---

⚠️  Claude-Mem: First-Time Setup

Dependencies have been installed in the background. This only happens once.

💡 TIPS:
   • Memories will start generating while you work
   • Use /init to write or update your CLAUDE.md for better project context
   • Try /clear after one session to see what context looks like

Thank you for installing Claude-Mem!

This message was not added to your startup context, so you can continue working as normal.
`);
  process.exit(3);
}

try {
  // Cross-platform path to context-hook.js in the installed plugin
  const contextHookPath = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'scripts', 'context-hook.js');
  const output = execSync(`node "${contextHookPath}" --colors`, {
    encoding: 'utf8'
  });

  const port = getWorkerPort();
  console.error(
    "\n\n📝 Claude-Mem Context Loaded\n" +
    "   ℹ️  Note: This appears as stderr but is informational only\n\n" +
    output +
    `\n\n📺 Watch live in browser http://localhost:${port}/ (New! v5.1)\n`
  );

} catch (error) {
  console.error(`❌ Failed to load context display: ${error}`);
}

process.exit(3);