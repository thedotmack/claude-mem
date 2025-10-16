#!/usr/bin/env bun

/**
 * Save Hook Entry Point - PostToolUse
 * Standalone executable for plugin hooks
 */

import { saveHook } from '../../hooks/save.js';

// Read input from stdin
const input = await Bun.stdin.text();

try {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  saveHook(parsed);
} catch (error: any) {
  console.error(`[claude-mem save-hook error: ${error.message}]`);
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}
