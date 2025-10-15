#!/usr/bin/env bun

/**
 * Session Start Hook (SDK Version)
 *
 * Calls the CLI to load relevant context from ChromaDB at session start.
 */

import { createHookResponse, debugLog } from './shared/hook-helpers.js';

// Read stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', async () => {
  const payload = input ? JSON.parse(input) : {};

  debugLog('SessionStart hook invoked (SDK version)', { cwd: payload.cwd });

  const { cwd, source } = payload;

  // Run on startup or /clear
  if (source !== 'startup' && source !== 'clear') {
    const response = createHookResponse('SessionStart', true);
    console.log(JSON.stringify(response));
    process.exit(0);
  }

  try {
    // Call the CLI to load context
    const { executeCliCommand } = await import('./shared/hook-helpers.js');

    const result = await executeCliCommand('claude-mem', ['load-context', '--format', 'session-start']);

    if (result.success && result.stdout) {
      // Per Claude Code docs: for SessionStart, stdout with exit code 0 is added to context
      // Use plain stdout instead of JSON to ensure it appears in Claude's context
      console.log(result.stdout);
      process.exit(0);
    } else {
      // Return without context - use JSON with suppressOutput to avoid empty context
      const response = createHookResponse('SessionStart', true);
      console.log(JSON.stringify(response));
      process.exit(0);
    }
  } catch (error) {
    // Continue without context on error
    const response = createHookResponse('SessionStart', true);
    console.log(JSON.stringify(response));
    process.exit(0);
  }
});