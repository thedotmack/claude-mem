/**
 * User Message Handler - SessionStart (parallel)
 *
 * Extracted from user-message-hook.ts - displays context info to user via stderr.
 * Uses exit code 3 to show user message without injecting into Claude's context.
 */

import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running
    await ensureWorkerRunning();

    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());

    // Fetch formatted context directly from worker API
    // Note: Removed AbortSignal.timeout to avoid Windows Bun cleanup issue (libuv assertion)
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
      { method: 'GET' }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch context: ${response.status}`);
    }

    const output = await response.text();

    // Write to stderr for user visibility (Claude Code UI shows stderr)
    console.error(
      "\n\n" + String.fromCodePoint(0x1F4DD) + " Claude-Mem Context Loaded\n" +
      "   " + String.fromCodePoint(0x2139, 0xFE0F) + "  Note: This appears as stderr but is informational only\n\n" +
      output +
      "\n\n" + String.fromCodePoint(0x1F4A1) + " New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n" +
      "\n" + String.fromCodePoint(0x1F4AC) + " Community https://discord.gg/J4wttp9vDu" +
      `\n` + String.fromCodePoint(0x1F4FA) + ` Watch live in browser http://localhost:${port}/\n`
    );

    return { exitCode: HOOK_EXIT_CODES.USER_MESSAGE_ONLY };
  }
};
