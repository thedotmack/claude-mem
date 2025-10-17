#!/usr/bin/env bun

/**
 * Context Hook Entry Point - SessionStart
 * Standalone executable for plugin hooks
 */

import { contextHook } from '../../hooks/context.js';

try {
  if (process.stdin.isTTY) {
    contextHook();
  } else {
    const input = await Bun.stdin.text();
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    contextHook(parsed);
  }
} catch (error: any) {
  console.error(`[claude-mem context-hook error: ${error.message}]`);
  process.exit(0);
}
