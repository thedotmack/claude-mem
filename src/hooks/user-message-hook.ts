/**
 * User Message Hook - SessionStart
 * Builds and injects the context report, displays instructions via system message
 *
 * This hook runs the context-hook to build the full report and injects it into
 * the context window. Users can view it anytime via /mem-status.
 */
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

// Check if node_modules exists - if not, this is first run
const pluginDir = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const nodeModulesPath = join(pluginDir, 'node_modules');

try {
  // Cross-platform path to context-hook.js in the installed plugin
  const contextHookPath = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'scripts', 'context-hook.js');

  const contextReport = execSync(`node "${contextHookPath}" --colors`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Output as hookSpecificOutput to add to context + system message
  console.log(JSON.stringify({
    continue: true,
    systemMessage: "💾 Use /mem-status to view your Claude-Mem context report.",
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `# Claude-Mem Context Report\n\n${contextReport}`
    }
  }));

} catch (error) {
  // On error, just continue without failing
  console.log(JSON.stringify({
    continue: true,
    systemMessage: "💾 Use /mem-status to view your Claude-Mem context (report building in background)."
  }));
}

process.exit(0);
