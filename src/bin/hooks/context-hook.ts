
/**
 * Context Hook Entry Point - SessionStart
 * Standalone executable for plugin hooks
 */

import { contextHook } from '../../hooks/context.js';
import { stdin } from 'process';

// Check for --index flag
const useIndexView = process.argv.includes('--index');

if (stdin.isTTY) {
  // Running manually from terminal - print formatted output with colors
  try {
    const contextOutput = contextHook(undefined, true, useIndexView);
    console.log(contextOutput);
    process.exit(0);
  } catch (error: any) {
    console.error(`[claude-mem context-hook error: ${error.message}]`);
    console.error(error.stack);
    process.exit(1);
  }
} else {
  // Running from hook - output plain text to stdout (for SessionStart hooks)
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', () => {
    try {
      const parsed = input.trim() ? JSON.parse(input) : undefined;
      const contextOutput = contextHook(parsed, false, useIndexView);
      // SessionStart hooks add stdout directly to context
      console.log(contextOutput);
      process.exit(0);
    } catch (error: any) {
      // Output error to stdout so Claude sees it
      console.log(`[claude-mem context-hook ERROR: ${error.message}]`);
      console.log(`Input received: ${input.substring(0, 200)}...`);
      console.log(error.stack);
      process.exit(1);
    }
  });
}
