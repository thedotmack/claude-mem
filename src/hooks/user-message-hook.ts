/**
 * User Message Hook - SessionStart
 * Displays context information to the user via stderr
 *
 * This hook runs in parallel with context-hook to show users what context
 * has been loaded into their session. Uses stderr as the communication channel
 * since it's currently the only way to display messages in Claude Code UI.
 */
import { execSync } from "child_process";

try {
  const output = execSync("node ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/context-hook.js --colors", {
    encoding: 'utf8'
  });

  console.error(
    "\n\n📝 Claude-Mem Context Loaded\n" +
    "   ℹ️  Note: This appears as stderr but is informational only\n\n" +
    output
  );

} catch (error) {
  console.error(`❌ Failed to load context display: ${error}`);
}

process.exit(3);