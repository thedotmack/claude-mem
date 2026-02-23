/**
 * User Message Handler - SessionStart (parallel)
 *
 * Displays context info to user via stderr.
 * Uses exit code 3 to show user message without injecting into Claude's context.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { getProjectName } from '../../utils/project-name.js';

const ICON_MEMO = String.fromCodePoint(0x1F4DD);
const ICON_INFO = String.fromCodePoint(0x2139, 0xFE0F);
const ICON_BULB = String.fromCodePoint(0x1F4A1);
const ICON_CHAT = String.fromCodePoint(0x1F4AC);
const ICON_TV = String.fromCodePoint(0x1F4FA);

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    await ensureWorkerRunning();

    const port = getWorkerPort();
    const project = getProjectName(input.cwd);

    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch context: ${response.status}`);
    }

    const output = await response.text();

    console.error(
      `\n\n${ICON_MEMO} Magic-Claude-Mem Context Loaded\n` +
      `   ${ICON_INFO}  Note: This appears as stderr but is informational only\n\n` +
      output +
      `\n\n${ICON_BULB} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n` +
      `\n${ICON_CHAT} Community https://discord.gg/J4wttp9vDu` +
      `\n${ICON_TV} Watch live in browser http://localhost:${port}/\n`
    );

    return { exitCode: HOOK_EXIT_CODES.USER_MESSAGE_ONLY };
  }
};
