#!/usr/bin/env bun

/**
 * Cleanup Hook Entry Point - SessionEnd
 * Standalone executable for plugin hooks
 */

import { cleanupHook } from '../../hooks/cleanup.js';

// Read input from stdin
const input = await Bun.stdin.text();

try {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  cleanupHook(parsed);
} catch (error: any) {
  console.error(`[claude-mem cleanup-hook error: ${error.message}]`);
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}
