/**
 * TransformLayer: Endless Mode context compression
 *
 * Responsibility:
 * - Transform transcript messages by replacing tool results with compressed observations
 * - Enable sessions to run indefinitely without hitting context window limits
 * - Maintain immutability - never modify source transcripts, only transform in memory
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { SDKUserMessage } from '../worker-types.js';

export interface TransformLayerConfig {
  enabled: boolean;              // CLAUDE_MEM_ENDLESS_MODE
  fallbackToOriginal: boolean;   // If observation missing, use full content
  maxLookupTime: number;         // Timeout for SQLite queries (ms)
  keepRecentToolUses: number;    // Keep recent N tool uses uncompressed (0 = compress all)
}

export interface TransformStats {
  totalMessages: number;
  transformedMessages: number;
  compressionRatio: number;      // Percentage saved
  lookupTime: number;            // Total time spent looking up observations (ms)
  fallbackCount: number;         // Number of times fallback was used
}

export class TransformLayer {
  private dbManager: DatabaseManager;
  private config: TransformLayerConfig;

  constructor(dbManager: DatabaseManager, config: TransformLayerConfig) {
    this.dbManager = dbManager;
    this.config = config;
  }

  /**
   * Transform messages by replacing tool results with compressed observations
   * This is the main entry point for Endless Mode compression
   */
  async transformMessages(
    messages: SDKUserMessage[],
    toolUseIdsToCompress?: Set<string>
  ): Promise<{ transformed: SDKUserMessage[]; stats: TransformStats }> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      logger.debug('TRANSFORM', 'Endless Mode disabled, skipping transformation');
      return {
        transformed: messages,
        stats: {
          totalMessages: messages.length,
          transformedMessages: 0,
          compressionRatio: 0,
          lookupTime: 0,
          fallbackCount: 0
        }
      };
    }

    const stats: TransformStats = {
      totalMessages: messages.length,
      transformedMessages: 0,
      compressionRatio: 0,
      lookupTime: 0,
      fallbackCount: 0
    };

    let originalSize = 0;
    let compressedSize = 0;

    const transformedMessages: SDKUserMessage[] = [];

    // Process messages with recency-aware compression
    const totalMessages = messages.length;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const messageIndex = i;

      // Calculate if this message is "recent" (within keepRecentToolUses from the end)
      const isRecent = this.config.keepRecentToolUses > 0 &&
        (totalMessages - messageIndex) <= this.config.keepRecentToolUses;

      // Skip transformation for recent messages if configured
      if (isRecent) {
        logger.debug('TRANSFORM', 'Skipping recent message', {
          messageIndex,
          totalMessages,
          keepRecent: this.config.keepRecentToolUses
        });
        transformedMessages.push(message);
        continue;
      }

      // Check if this message should be compressed based on provided tool_use_ids
      if (toolUseIdsToCompress && message.parent_tool_use_id) {
        if (!toolUseIdsToCompress.has(message.parent_tool_use_id)) {
          transformedMessages.push(message);
          continue;
        }
      }

      // Attempt to transform this message
      const lookupStart = Date.now();
      const result = await this.transformSingleMessage(message);
      stats.lookupTime += (Date.now() - lookupStart);

      if (result.transformed) {
        stats.transformedMessages++;
        originalSize += result.originalSize;
        compressedSize += result.compressedSize;
        transformedMessages.push(result.message);
      } else {
        if (result.usedFallback) {
          stats.fallbackCount++;
        }
        transformedMessages.push(message);
      }
    }

    // Calculate compression ratio
    if (originalSize > 0) {
      stats.compressionRatio = Math.round(((originalSize - compressedSize) / originalSize) * 100);
    }

    const totalTime = Date.now() - startTime;

    logger.info('TRANSFORM', 'Message transformation complete', {
      totalMessages: stats.totalMessages,
      transformed: stats.transformedMessages,
      compressionRatio: `${stats.compressionRatio}%`,
      lookupTime: `${stats.lookupTime}ms`,
      totalTime: `${totalTime}ms`,
      fallbacks: stats.fallbackCount
    });

    return { transformed: transformedMessages, stats };
  }

  /**
   * Transform a single message (if it contains tool result content)
   */
  private async transformSingleMessage(
    message: SDKUserMessage
  ): Promise<{
    transformed: boolean;
    message: SDKUserMessage;
    originalSize: number;
    compressedSize: number;
    usedFallback: boolean;
  }> {
    // Only transform user messages that are NOT synthetic (real tool results)
    // Synthetic messages are already compressed (buildObservationPrompt)
    if (message.type !== 'user' || message.isSynthetic) {
      return {
        transformed: false,
        message,
        originalSize: 0,
        compressedSize: 0,
        usedFallback: false
      };
    }

    // Check if message content looks like a tool result (needs better heuristic)
    const content = message.message.content;
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);

    // Heuristic: If content is very short, it's probably not a tool result
    if (contentStr.length < 100) {
      return {
        transformed: false,
        message,
        originalSize: 0,
        compressedSize: 0,
        usedFallback: false
      };
    }

    // Look up observation by parent_tool_use_id
    if (!message.parent_tool_use_id) {
      return {
        transformed: false,
        message,
        originalSize: 0,
        compressedSize: 0,
        usedFallback: false
      };
    }

    const observation = await this.lookupObservation(message.parent_tool_use_id);

    if (!observation) {
      logger.debug('TRANSFORM', 'No observation found for tool_use_id', {
        toolUseId: message.parent_tool_use_id
      });

      if (this.config.fallbackToOriginal) {
        return {
          transformed: false,
          message,
          originalSize: 0,
          compressedSize: 0,
          usedFallback: true
        };
      } else {
        // No fallback - use empty placeholder
        const compressed = this.createCompressedMessage(message, null);
        return {
          transformed: true,
          message: compressed,
          originalSize: contentStr.length,
          compressedSize: JSON.stringify(compressed.message.content).length,
          usedFallback: false
        };
      }
    }

    // Transform message with observation
    const compressed = this.createCompressedMessage(message, observation);

    return {
      transformed: true,
      message: compressed,
      originalSize: contentStr.length,
      compressedSize: JSON.stringify(compressed.message.content).length,
      usedFallback: false
    };
  }

  /**
   * Look up observation by tool_use_id
   */
  private async lookupObservation(toolUseId: string): Promise<any | null> {
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Observation lookup timeout')), this.config.maxLookupTime)
      );

      const lookup = Promise.resolve(
        this.dbManager.getSessionStore().getObservationByToolUseId(toolUseId)
      );

      const observation = await Promise.race([lookup, timeout]) as any;
      return observation || null;
    } catch (error: any) {
      logger.warn('TRANSFORM', 'Observation lookup failed', { toolUseId }, error);
      return null;
    }
  }

  /**
   * Create a compressed message with observation content
   */
  private createCompressedMessage(
    original: SDKUserMessage,
    observation: any | null
  ): SDKUserMessage {
    if (!observation) {
      // No observation available - use minimal placeholder
      return {
        ...original,
        message: {
          ...original.message,
          content: '[Tool result compressed - observation unavailable]'
        }
      };
    }

    // Build compressed content from observation
    const parts: string[] = [];

    if (observation.title) {
      parts.push(`# ${observation.title}`);
    }

    if (observation.subtitle) {
      parts.push(`${observation.subtitle}`);
    }

    if (observation.narrative) {
      parts.push(`\n${observation.narrative}`);
    }

    // Add facts if available
    if (observation.facts) {
      try {
        const facts = JSON.parse(observation.facts);
        if (Array.isArray(facts) && facts.length > 0) {
          parts.push(`\n**Facts:**`);
          facts.forEach((fact: string) => {
            parts.push(`- ${fact}`);
          });
        }
      } catch {
        // Ignore malformed facts
      }
    }

    // Add concepts if available
    if (observation.concepts) {
      try {
        const concepts = JSON.parse(observation.concepts);
        if (Array.isArray(concepts) && concepts.length > 0) {
          parts.push(`\n**Tags:** ${concepts.join(', ')}`);
        }
      } catch {
        // Ignore malformed concepts
      }
    }

    // Add metadata footer
    parts.push(`\n---`);
    parts.push(`*[Compressed via Endless Mode - Original tool result replaced with observation #${observation.id}]*`);

    const compressedContent = parts.join('\n');

    return {
      ...original,
      message: {
        ...original.message,
        content: compressedContent
      }
    };
  }
}
