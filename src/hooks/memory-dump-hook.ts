/**
 * Memory Dump Hook - SessionStart
 * Calls context-hook and dumps output to /workspace/.claude/memory/session-memory.md
 *
 * This hook runs the context-hook to get the full context report and writes it
 * to a file in the workspace for persistent access across sessions.
 */
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, writeFileSync } from "fs";

try {
  // Get context from the context-hook
  const contextHookPath = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin', 'scripts', 'context-hook.js');

  const contextOutput = execSync(`node "${contextHookPath}"`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Parse the JSON response from context-hook
  const parsed = JSON.parse(contextOutput);
  const contextReport = parsed.hookSpecificOutput?.additionalContext || contextOutput;

  // Ensure the memory directory exists
  const memoryDir = join('/workspace', '.claude', 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Write the memory dump
  const memoryFile = join(memoryDir, 'session-memory.md');
  writeFileSync(memoryFile, contextReport, 'utf-8');

  // Output as hookSpecificOutput
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Session memory dumped to ${memoryFile}`
    }
  }));

} catch (error) {
  // On error, just continue without failing
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Failed to dump session memory: ${error instanceof Error ? error.message : String(error)}`
    }
  }));
}

process.exit(0);
