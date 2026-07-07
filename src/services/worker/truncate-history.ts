import type { ConversationMessage } from '../worker-types.js';
import { estimateTokens as defaultEstimateTokens } from '../../shared/timeline-formatting.js';
import { logger } from '../../utils/logger.js';

function logInitOnlyTruncation(details: {
  originalMessages: number;
  estimatedTokens: number;
  tokenLimit: number;
  messageLimit: number;
  reason: 'message_limit' | 'token_limit';
}): void {
  logger.warn('SDK', 'Context window truncated to init prompt only', {
    originalMessages: details.originalMessages,
    keptMessages: 1,
    droppedMessages: details.originalMessages - 1,
    estimatedTokens: details.estimatedTokens,
    tokenLimit: details.tokenLimit,
    messageLimit: details.messageLimit,
    reason: details.reason,
  });
}

export function truncateConversationHistory(
  history: ConversationMessage[],
  options: {
    maxContextMessages: number;
    maxEstimatedTokens: number;
    estimateTokens?: (text: string | null) => number;
  }
): ConversationMessage[] {
  const estimateTokens = options.estimateTokens ?? defaultEstimateTokens;
  const { maxContextMessages, maxEstimatedTokens } = options;

  if (history.length <= 1) return history;

  if (history.length <= maxContextMessages) {
    const totalTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (totalTokens <= maxEstimatedTokens) return history;
  }

  const initPrompt = history[0];
  const initPromptTokens = estimateTokens(initPrompt.content);

  if (initPromptTokens >= maxEstimatedTokens) {
    logInitOnlyTruncation({
      originalMessages: history.length,
      estimatedTokens: initPromptTokens,
      tokenLimit: maxEstimatedTokens,
      messageLimit: maxContextMessages,
      reason: 'token_limit',
    });
    return [initPrompt];
  }

  const maxRecentMessages = Math.max(0, maxContextMessages - 1);
  if (maxRecentMessages === 0) {
    logInitOnlyTruncation({
      originalMessages: history.length,
      estimatedTokens: initPromptTokens,
      tokenLimit: maxEstimatedTokens,
      messageLimit: maxContextMessages,
      reason: 'message_limit',
    });
    return [initPrompt];
  }

  const recent: ConversationMessage[] = [];
  let tokenCount = initPromptTokens;

  for (let i = history.length - 1; i > 0; i--) {
    const msg = history[i];
    const msgTokens = estimateTokens(msg.content);

    if (recent.length >= maxRecentMessages || tokenCount + msgTokens > maxEstimatedTokens) {
      if (recent.length === 0) {
        logInitOnlyTruncation({
          originalMessages: history.length,
          estimatedTokens: tokenCount,
          tokenLimit: maxEstimatedTokens,
          messageLimit: maxContextMessages,
          reason: 'token_limit',
        });
        break;
      }

      logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
        originalMessages: history.length,
        keptMessages: recent.length + 1,
        droppedMessages: i,
        estimatedTokens: tokenCount,
        tokenLimit: maxEstimatedTokens,
        messageLimit: maxContextMessages,
      });
      break;
    }

    recent.unshift(msg);
    tokenCount += msgTokens;
  }

  return [initPrompt, ...recent];
}
