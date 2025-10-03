#!/usr/bin/env node

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
      // Use the CLI output directly as context (it's already formatted)
      const response = createHookResponse('SessionStart', true, {
        context: result.stdout
      });
      console.log(JSON.stringify(response));
      process.exit(0);
    } else {
      // Return without context
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