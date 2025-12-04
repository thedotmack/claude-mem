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
    encoding: 'utf8',
    windowsHide: true
  });

  const port = getWorkerPort();

  // If it's after Dec 5, 2025 7pm EST, patch this out
  const now = new Date();
  const amaEndDate = new Date('2025-12-06T00:00:00Z'); // Dec 5, 2025 7pm EST

  // Product Hunt launch announcement - expires Dec 5, 2025 12am EST (05:00 UTC)
  const phLaunchEndDate = new Date('2025-12-05T05:00:00Z');
  let productHuntAnnouncement = "";
  if (now < phLaunchEndDate) {
    productHuntAnnouncement = `

🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 🚀

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   ⭐ Your upvote means the world - thank you!

🚀 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 🚀
`;
  }

  let amaAnnouncement = "";
  if (now < amaEndDate) {
    // Check if we're during the live event (Dec 1-5, 5pm-7pm EST daily)
    const estOffset = 5 * 60; // EST is UTC-5
    const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const estHour = Math.floor((nowUtcMinutes - estOffset + 1440) % 1440 / 60);
    const day = now.getUTCDate();
    const month = now.getUTCMonth();
    const year = now.getUTCFullYear();

    const isDec1to5 = year === 2025 && month === 11 && day >= 1 && day <= 5;
    const isDuringLiveHours = estHour >= 17 && estHour < 19; // 5pm-7pm EST

    if (isDec1to5 && isDuringLiveHours) {
      amaAnnouncement = "\n   🔴 LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST\n";
    } else {
      amaAnnouncement = "\n   – LIVE AMA w/ Dev (@thedotmack) Dec 1st–5th, 5pm to 7pm EST\n";
    }
  }

  console.error(
    "\n\n📝 Claude-Mem Context Loaded\n" +
    "   ℹ️  Note: This appears as stderr but is informational only\n\n" +
    output +
    "\n\n💡 New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n" +
    "\n💬 Community https://discord.gg/J4wttp9vDu" +
    productHuntAnnouncement +
    amaAnnouncement +
    `\n📺 Watch live in browser http://localhost:${port}/\n`
  );

} catch (error) {
  console.error(`❌ Failed to load context display: ${error}`);
}

process.exit(3);