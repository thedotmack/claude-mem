/**
 * Prepare Stage - Transform raw data into LLM prompt
 *
 * Responsibilities:
 * - Build prompt from raw observation
 * - Include context from recent observations if configured
 * - Estimate token usage
 */

import { logger } from '../../../utils/logger.js';
import type {
  PrepareInput,
  PrepareOutput,
  PipelineConfig
} from '../../../types/pipeline.js';
import { buildObservationPrompt } from '../../../sdk/prompts.js';

type PrepareConfig = PipelineConfig['stages']['prepare'];

export class PrepareStage {
  private config: PrepareConfig;
  private modeManager: unknown;

  constructor(config: PrepareConfig, modeManager: unknown) {
    this.config = config;
    this.modeManager = modeManager;
  }

  async execute(input: PrepareInput): Promise<PrepareOutput> {
    const { rawObservation, context } = input;

    // Build the observation prompt
    const observationData = {
      id: 0, // Placeholder - not used in prompt building
      tool_name: rawObservation.tool_name,
      tool_input: rawObservation.tool_input,
      tool_output: rawObservation.tool_output,
      cwd: rawObservation.cwd || undefined,
      created_at_epoch: rawObservation.created_at_epoch
    };

    const prompt = buildObservationPrompt(observationData);

    // Add context from recent observations if configured
    let fullPrompt = prompt;
    if (this.config.includeContext && context.recentObservations?.length) {
      const contextSection = context.recentObservations
        .slice(0, this.config.maxContextObservations)
        .join('\n\n');
      fullPrompt = `${contextSection}\n\n---\n\n${prompt}`;
    }

    // Estimate tokens (rough approximation)
    const inputTokens = Math.ceil(fullPrompt.length / 4);
    const expectedOutputTokens = Math.ceil(inputTokens * 0.3); // Estimate 30% compression

    const output: PrepareOutput = {
      prompt: fullPrompt,
      tokenEstimate: {
        input: inputTokens,
        expectedOutput: expectedOutputTokens
      },
      metadata: {
        promptVersion: '2.0',
        modeId: 'default',
        contextIncluded: this.config.includeContext && (context.recentObservations?.length ?? 0) > 0
      }
    };

    logger.debug('PIPELINE', 'Prompt prepared', {
      inputTokens,
      contextIncluded: output.metadata.contextIncluded
    });

    return output;
  }
}
