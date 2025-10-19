
/**
 * Summary Hook Entry Point - Stop
 * Standalone executable for plugin hooks
 */

import { summaryHook } from '../../hooks/summary.js';
import { stdin } from 'process';

// Read input from stdin
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  await summaryHook(parsed);
  process.exit(0);
});
