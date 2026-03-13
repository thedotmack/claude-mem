/**
 * Process Stage - Execute LLM call for observation compression
 *
 * This is the only non-deterministic, expensive stage.
 *
 * Responsibilities:
 * - Execute LLM API call
 * - Track token usage and cost
 * - Handle timeouts and errors
 */

import { logger } from '../../../utils/logger.js';
import type {
  ProcessInput,
  ProcessOutput,
  PipelineConfig
} from '../../../types/pipeline.js';

type ProcessConfig = PipelineConfig['stages']['process'];

export class ProcessStage {
  private config: ProcessConfig;

  constructor(config: ProcessConfig) {
    this.config = config;
  }

  async execute(input: ProcessInput): Promise<ProcessOutput> {
    const startTime = Date.now();

    // For now, this is a placeholder that returns the input as-is
    // In the actual implementation, this would call the SDK agent
    // The real implementation is in SDKAgent.ts

    logger.debug('PIPELINE', 'Processing observation', {
      promptLength: input.prompt.length
    });

    // Placeholder response - actual implementation would use SDK
    const responseText = input.prompt; // Echo for now

    const latencyMs = Date.now() - startTime;

    // Estimate tokens from content length
    const inputTokens = Math.ceil(input.prompt.length / 4);
    const outputTokens = Math.ceil(responseText.length / 4);

    const output: ProcessOutput = {
      responseText,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cost: this.estimateCost(inputTokens, outputTokens)
      },
      metadata: {
        model: this.config.model || 'claude-3-haiku-20240307',
        latencyMs,
        cached: false
      }
    };

    logger.debug('PIPELINE', 'Processing complete', {
      inputTokens,
      outputTokens,
      latencyMs,
      cost: output.usage.cost
    });

    return output;
  }

  private estimateCost(inputTokens: number, outputTokens: number): number {
    // Haiku pricing: $0.25/MTok input, $1.25/MTok output
    const inputCost = (inputTokens / 1_000_000) * 0.25;
    const outputCost = (outputTokens / 1_000_000) * 1.25;
    return inputCost + outputCost;
  }
}
