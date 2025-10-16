#!/usr/bin/env bun

/**
 * New Hook Entry Point - UserPromptSubmit
 * Standalone executable for plugin hooks
 */

import { newHook } from '../../hooks/new.js';

// Read input from stdin
const input = await Bun.stdin.text();

try {
  const parsed = input.trim() ? JSON.parse(input) : undefined;
  newHook(parsed);
} catch (error: any) {
  console.error(`[claude-mem new-hook error: ${error.message}]`);
  console.log('{"continue": true, "suppressOutput": true}');
  process.exit(0);
}
