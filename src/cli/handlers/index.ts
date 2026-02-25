/**
 * Event Handler Factory
 *
 * Returns the appropriate handler for a given event type.
 */

import type { EventHandler } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { contextHandler } from './context.js';
import { sessionInitHandler } from './session-init.js';
import { observationHandler } from './observation.js';
import { summarizeHandler } from './summarize.js';
import { userMessageHandler } from './user-message.js';
import { fileEditHandler } from './file-edit.js';
import { sessionCompleteHandler } from './session-complete.js';

export type EventType =
  | 'context'           // SessionStart - inject context
  | 'session-init'      // UserPromptSubmit - initialize session
  | 'observation'       // PostToolUse - save observation
  | 'summarize'         // Stop - generate summary (phase 1)
  | 'session-complete'  // Stop - complete session (phase 2) - fixes #842
  | 'user-message'      // SessionStart (parallel) - display to user
  | 'file-edit';        // Cursor afterFileEdit

const handlers: Record<EventType, EventHandler> = {
  'context': contextHandler,
  'session-init': sessionInitHandler,
  'observation': observationHandler,
  'summarize': summarizeHandler,
  'session-complete': sessionCompleteHandler,
  'user-message': userMessageHandler,
  'file-edit': fileEditHandler
};

/**
 * Get the event handler for a given event type.
 *
 * Returns a no-op handler for unknown event types instead of throwing (fix #984).
 * Claude Code may send new event types that the plugin doesn't handle yet —
 * throwing would surface as a BLOCKING_ERROR to the user.
 *
 * @param eventType The type of event to handle
 * @returns The appropriate EventHandler, or a no-op handler for unknown types
 */
export function getEventHandler(eventType: string): EventHandler {
  const handler = handlers[eventType as EventType];
  if (!handler) {
    logger.warn('HOOK', `Unknown event type: ${eventType}, returning no-op`);
    return {
      async execute() {
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    };
  }
  return handler;
}

// Re-export individual handlers for direct access if needed
export { contextHandler } from './context.js';
export { sessionInitHandler } from './session-init.js';
export { observationHandler } from './observation.js';
export { summarizeHandler } from './summarize.js';
export { userMessageHandler } from './user-message.js';
export { fileEditHandler } from './file-edit.js';
export { sessionCompleteHandler } from './session-complete.js';
