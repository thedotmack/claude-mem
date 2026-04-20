/**
 * User Message Handler - SessionStart (parallel)
 *
 * Displays context info to user via stderr.
 * Uses exit code 0 (SUCCESS) - stderr is not shown to Claude with exit 0.
 */

import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, workerHttpRequest } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

async function fetchAndDisplayContext(project: string, colorsParam: string, port: number): Promise<void> {
  const response = await workerHttpRequest(
    `/api/context/inject?project=${encodeURIComponent(project)}${colorsParam}`
  );

  if (!response.ok) {
    return;
  }

  const output = await response.text();
  process.stderr.write(
    "\n\n" + String.fromCodePoint(0x1F4DD) + " Claude-Mem Context Loaded\n\n" +
    output +
    "\n\n" + String.fromCodePoint(0x1F4A1) + " Wrap any message with <private> ... </private> to prevent storing sensitive information.\n" +
    "\n" + String.fromCodePoint(0x1F4AC) + " Community https://discord.gg/J4wttp9vDu" +
    `\n` + String.fromCodePoint(0x1F4FA) + ` Watch live in browser http://localhost:${port}/\n`
  );
}

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
    const colorsParam = input.platform === 'claude-code' ? '&colors=true' : '';

    try {
      await fetchAndDisplayContext(project, colorsParam, port);
    } catch {
      // Worker unreachable — skip user message gracefully
    }

    return { exitCode: HOOK_EXIT_CODES.SUCCESS };
  }
};
