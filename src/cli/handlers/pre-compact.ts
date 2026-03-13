/**
 * Pre-Compact Handler - Droid PreCompact event
 *
 * Fires before a compact operation (manual or auto).
 * Triggers a summarize to preserve context before the conversation is compacted.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { summarizeHandler } from './summarize.js';

export const preCompactHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    return summarizeHandler.execute(input);
  }
};
