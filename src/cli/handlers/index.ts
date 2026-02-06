/**
 * Event Handler Factory
 *
 * Returns the appropriate handler for a given event type.
 */

import type { EventHandler } from '../types.js';
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
 * @param eventType The type of event to handle
 * @returns The appropriate EventHandler
 * @throws Error if event type is not recognized
 */
export function getEventHandler(eventType: EventType): EventHandler {
  const handler = handlers[eventType];
  if (!handler) {
    throw new Error(`Unknown event type: ${eventType}`);
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
