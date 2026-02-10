/**
 * User Message Handler - SessionStart (parallel)
 *
 * Displays context info to user via stderr.
 * Uses exit code 0 (SUCCESS) - stderr is not shown to Claude with exit 0.
 */

import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, buildWorkerUrl } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { stripInternalAgentMarkers } from '../../utils/tag-stripping.js';

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running
    await ensureWorkerRunning();

    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());

    try {
      // Fetch formatted context directly from worker API
      // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
      const response = await fetch(
        buildWorkerUrl(`/api/context/inject?project=${encodeURIComponent(project)}&colors=true`),
        { method: 'GET' }
      );

      if (!response.ok) {
        // Don't throw - context fetch failure should not block the user's prompt
        return { exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      // Strip any internal agent markers that might leak into user-visible output (#784)
      const output = stripInternalAgentMarkers(await response.text());

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
    } catch {
      // Network error - skip context display gracefully (Issue #897)
    }

    return { exitCode: HOOK_EXIT_CODES.SUCCESS };
  }
};
