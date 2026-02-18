/**
 * Conversation History Manager
 *
 * Keeps provider-shared conversation history bounded to prevent unbounded
 * in-memory growth on long-running sessions.
 */

import { logger } from '../../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../../worker-types.js';

// Keep enough context for provider switching while preventing runaway memory use.
const MAX_HISTORY_MESSAGES = 80;
const MAX_HISTORY_CHARS = 200_000;

/**
 * Append a conversation message and enforce bounded history limits.
 */
export function appendConversationMessage(
  session: ActiveSession,
  message: ConversationMessage
): void {
  session.conversationHistory.push(message);

  let trimmedByCount = 0;
  if (session.conversationHistory.length > MAX_HISTORY_MESSAGES) {
    trimmedByCount = session.conversationHistory.length - MAX_HISTORY_MESSAGES;
    session.conversationHistory.splice(0, trimmedByCount);
  }

  let totalChars = session.conversationHistory.reduce((sum, m) => sum + m.content.length, 0);
  let trimmedByChars = 0;

  while (totalChars > MAX_HISTORY_CHARS && session.conversationHistory.length > 1) {
    const removed = session.conversationHistory.shift();
    if (!removed) break;
    totalChars -= removed.content.length;
    trimmedByChars += 1;
  }

  if (trimmedByCount > 0 || trimmedByChars > 0) {
    logger.debug('SESSION', 'Trimmed conversation history', {
      sessionId: session.sessionDbId,
      trimmedByCount,
      trimmedByChars,
      historyLength: session.conversationHistory.length,
      totalChars
    });
  }
}
