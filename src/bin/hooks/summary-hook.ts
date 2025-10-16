#!/usr/bin/env bun

/**
 * Summary Hook Entry Point - Stop
 * Standalone executable for plugin hooks
 */

import { summaryHook } from '../../hooks/summary.js';

// Read input from stdin
const input = await Bun.stdin.text();

try {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  summaryHook(parsed);
} catch (error: any) {
  console.error(`[claude-mem summary-hook error: ${error.message}]`);
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}
