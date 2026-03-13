/**
 * Acquire Stage - Raw data capture from tool execution
 *
 * Responsibilities:
 * - Capture raw tool output from Claude session
 * - Estimate token counts
 * - Detect and skip duplicates
 * - Categorize tool types
 */

import { logger } from '../../../utils/logger.js';
import type {
  AcquireInput,
  AcquireOutput,
  PipelineConfig
} from '../../../types/pipeline.js';

type AcquireConfig = PipelineConfig['stages']['acquire'];

export class AcquireStage {
  private config: AcquireConfig;
  private recentHashes: Map<string, number> = new Map();

  constructor(config: AcquireConfig) {
    this.config = config;
  }

  async execute(input: AcquireInput): Promise<AcquireOutput | null> {
    // Generate hash for duplicate detection
    const hash = this.generateHash(input);

    if (this.config.skipDuplicates && this.isDuplicate(hash)) {
      logger.debug('PIPELINE', 'Skipping duplicate observation', {
        toolName: input.toolName,
        hash
      });
      return null;
    }

    // Record hash for future duplicate detection
    this.recentHashes.set(hash, Date.now());
    this.cleanupOldHashes();

    // Stringify inputs/outputs
    const toolInputStr = typeof input.toolInput === 'string'
      ? input.toolInput
      : JSON.stringify(input.toolInput, null, 2);

    const toolOutputStr = typeof input.toolOutput === 'string'
      ? input.toolOutput
      : JSON.stringify(input.toolOutput, null, 2);

    // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
    const inputTokenEstimate = Math.ceil(toolInputStr.length / 4);
    const outputTokenEstimate = Math.ceil(toolOutputStr.length / 4);

    // Categorize tool
    const toolCategory = this.categorizeTool(input.toolName);

    const output: AcquireOutput = {
      rawObservation: {
        tool_name: input.toolName,
        tool_input: toolInputStr,
        tool_output: toolOutputStr,
        cwd: input.cwd || null,
        created_at_epoch: input.timestamp,
        session_id: input.sessionId,
        prompt_number: input.promptNumber
      },
      metadata: {
        inputTokenEstimate,
        outputTokenEstimate,
        toolCategory
      }
    };

    logger.debug('PIPELINE', 'Observation acquired', {
      toolName: input.toolName,
      category: toolCategory,
      tokens: inputTokenEstimate + outputTokenEstimate
    });

    return output;
  }

  private generateHash(input: AcquireInput): string {
    const content = `${input.toolName}:${JSON.stringify(input.toolInput)}:${JSON.stringify(input.toolOutput)}`;
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private isDuplicate(hash: string): boolean {
    const lastSeen = this.recentHashes.get(hash);
    if (!lastSeen) return false;
    return Date.now() - lastSeen < this.config.duplicateWindowMs;
  }

  private cleanupOldHashes(): void {
    const now = Date.now();
    for (const [hash, timestamp] of this.recentHashes.entries()) {
      if (now - timestamp > this.config.duplicateWindowMs * 2) {
        this.recentHashes.delete(hash);
      }
    }
  }

  private categorizeTool(toolName: string): string {
    const readTools = ['Read', 'WebFetch'];
    const writeTools = ['Write', 'Edit', 'NotebookEdit'];
    const searchTools = ['Grep', 'Glob', 'WebSearch'];
    const bashTools = ['Bash', 'Task'];

    if (searchTools.includes(toolName)) return 'search';  // Check search first
    if (readTools.includes(toolName)) return 'read';
    if (writeTools.includes(toolName)) return 'write';
    if (bashTools.includes(toolName)) return 'bash';
    return 'other';
  }
}
