/**
 * Platform-aware error message generator for worker connection failures
 */

import type { ConversationMessage } from '../services/worker/worker-types.js';
import { logger } from './logger.js';

export interface WorkerErrorMessageOptions {
  port?: number;
  includeSkillFallback?: boolean;
  customPrefix?: string;
  actualError?: string;
}

/**
 * Custom error for provider configuration issues
 * Provides structured validation feedback for programmatic error handling
 */
export class ProviderConfigurationError extends Error {
  public readonly provider: string;
  public readonly missingField: string;

  constructor(provider: string, missingField: string) {
    super(`${provider} provider: ${missingField} is not configured.`);
    this.name = 'ProviderConfigurationError';
    this.provider = provider;
    this.missingField = missingField;
  }
}

/**
 * Options for truncating conversation history
 */
export interface TruncateHistoryOptions {
  /** Maximum number of messages to keep */
  maxMessages: number;
  /** Maximum estimated tokens allowed */
  maxTokens: number;
  /** Characters per token estimate (default: 4) */
  charsPerToken?: number;
  /** Provider name for logging */
  providerName?: string;
}

/**
 * Estimate token count from text
 * Simple heuristic: ~4 characters per token
 */
export function estimateTokens(text: string, charsPerToken: number = 4): number {
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Truncate conversation history efficiently (O(n) complexity)
 * Keeps the most recent messages within token and count limits
 */
export function truncateConversationHistory(
  history: ConversationMessage[],
  options: TruncateHistoryOptions
): ConversationMessage[] {
  const { maxMessages, maxTokens, charsPerToken = 4, providerName = 'SDK' } = options;

  // Early return if within limits
  if (history.length <= maxMessages) {
    const totalTokens = history.reduce(
      (sum, m) => sum + estimateTokens(m.content, charsPerToken),
      0
    );
    if (totalTokens <= maxTokens) {
      return history;
    }
  }

  // Efficient truncation: count backwards from most recent messages
  let tokenCount = 0;
  let endIndex = history.length;

  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content, charsPerToken);

    if (history.length - i > maxMessages || tokenCount + msgTokens > maxTokens) {
      endIndex = i + 1;
      break;
    }

    tokenCount += msgTokens;
  }

  const truncated = history.slice(endIndex);

  if (truncated.length < history.length) {
    logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
      originalMessages: history.length,
      keptMessages: truncated.length,
      droppedMessages: history.length - truncated.length,
      estimatedTokens: tokenCount,
      tokenLimit: maxTokens,
      provider: providerName
    });
  }

  return truncated;
}

/**
 * Generate platform-specific worker restart instructions
 * @param options Configuration for error message generation
 * @returns Formatted error message with platform-specific paths and commands
 */
export function getWorkerRestartInstructions(
  options: WorkerErrorMessageOptions = {}
): string {
  const {
    port,
    includeSkillFallback = false,
    customPrefix,
    actualError
  } = options;

  // Build error message
  const prefix = customPrefix || 'Worker service connection failed.';
  const portInfo = port ? ` (port ${port})` : '';

  let message = `${prefix}${portInfo}\n\n`;
  message += `To restart the worker:\n`;
  message += `1. Exit Claude Code completely\n`;
  message += `2. Run: npm run worker:restart\n`;
  message += `3. Restart Claude Code`;

  if (includeSkillFallback) {
    message += `\n\nIf that doesn't work, try: /troubleshoot`;
  }

  // Prepend actual error if provided
  if (actualError) {
    message = `Worker Error: ${actualError}\n\n${message}`;
  }

  return message;
}
