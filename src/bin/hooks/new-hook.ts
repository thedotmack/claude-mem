
/**
 * New Hook Entry Point - UserPromptSubmit
 * Standalone executable for plugin hooks
 */

import { newHook } from '../../hooks/new.js';
import { stdin } from 'process';

// Read input from stdin
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    await newHook(parsed);
    process.exit(0);
  } catch (error: any) {
    console.error(`[claude-mem new-hook error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
});
