/**
 * User Message Handler - SessionStart (parallel)
 *
 * Displays context info to user via stderr.
 * Uses exit code 0 (SUCCESS) - stderr is not shown to Claude with exit 0.
 */

import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, fetchWithTimeout } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available — skip user message gracefully
      return { exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());

    // Fetch formatted context directly from worker API
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
        { method: 'GET' },
        10000
      );

      if (!response.ok) {
        // Don't throw - context fetch failure should not block the user's prompt
        return { exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      const output = await response.text();

      // Write to stderr for user visibility
      // Note: Using process.stderr.write instead of console.error to avoid
      // Claude Code treating this as a hook error. The actual hook output
      // goes to stdout via hook-command.ts JSON serialization.
      process.stderr.write(
        "\n\n" + String.fromCodePoint(0x1F4DD) + " Claude-Mem Context Loaded\n\n" +
        output +
        "\n\n" + String.fromCodePoint(0x1F4A1) + " Wrap any message with <private> ... </private> to prevent storing sensitive information.\n" +
        "\n" + String.fromCodePoint(0x1F4AC) + " Community https://discord.gg/J4wttp9vDu" +
        `\n` + String.fromCodePoint(0x1F4FA) + ` Watch live in browser http://localhost:${port}/\n`
      );
    } catch (error) {
      // Worker unreachable — skip user message gracefully
      // User message context error is non-critical — skip gracefully
    }

    return { exitCode: HOOK_EXIT_CODES.SUCCESS };
  }
};
