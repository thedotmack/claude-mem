
/**
 * Cleanup Hook Entry Point - SessionEnd
 * Standalone executable for plugin hooks
 */

import { cleanupHook } from '../../hooks/cleanup.js';
import { stdin } from 'process';

// Read input from stdin
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  try {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    await cleanupHook(parsed);
  } catch (error: any) {
    console.error(`[claude-mem cleanup-hook error: ${error.message}]`);
    console.log('{"continue": true, "suppressOutput": true}');
    process.exit(0);
  }
});
