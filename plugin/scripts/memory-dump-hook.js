#!/usr/bin/env node

// src/hooks/memory-dump-hook.ts
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, writeFileSync } from "fs";
try {
  const contextHookPath = join(homedir(), ".claude", "plugins", "marketplaces", "thedotmack", "plugin", "scripts", "context-hook.js");
  const contextOutput = execSync(`node "${contextHookPath}"`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const parsed = JSON.parse(contextOutput);
  const contextReport = parsed.hookSpecificOutput?.additionalContext || contextOutput;
  const memoryDir = join("/workspace", ".claude", "memory");
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
  const memoryFile = join(memoryDir, "session-memory.md");
  writeFileSync(memoryFile, contextReport, "utf-8");
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Session memory dumped to ${memoryFile}`
    }
  }));
} catch (error) {
  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Failed to dump session memory: ${error instanceof Error ? error.message : String(error)}`
    }
  }));
}
process.exit(0);
