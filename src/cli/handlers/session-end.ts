/**
 * Session End Handler - Droid SessionEnd event
 *
 * Maps Droid's SessionEnd hook event to session-complete logic.
 * SessionEnd fires when a Droid session ends (clear, logout, exit).
 * Delegates to session-complete to remove the session from active map.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { sessionCompleteHandler } from './session-complete.js';

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    return sessionCompleteHandler.execute(input);
  }
};
