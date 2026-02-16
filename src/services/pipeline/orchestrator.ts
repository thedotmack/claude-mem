/**
 * Pipeline Orchestrator - Hybrid Mode
 *
 * Wraps the existing SDKAgent flow with pipeline stages for:
 * - Acquire: Capture and validate raw observations
 * - Prepare: Format prompts (future)
 *
 * The Process, Parse, and Render stages remain in SDKAgent for now.
 * This enables gradual migration to full pipeline architecture.
 */

import { logger } from '../../utils/logger.js';
import { pipelineMetrics } from './metrics.js';
import { AcquireStage } from './stages/acquire.js';
import type { AcquireInput, AcquireOutput, PipelineConfig } from '../../types/pipeline.js';

// Re-export for convenience
export { AcquireStage } from './stages/acquire.js';

/**
 * Observation data as received from hooks
 */
export interface RawObservationInput {
  claudeSessionId: string;
  sessionDbId: number;
  toolName: string;
  toolInput: string;  // Already cleaned/stringified
  toolOutput: string; // Already cleaned/stringified
  cwd: string;
  promptNumber: number;
}

/**
 * Result of pipeline acquire stage
 */
export interface AcquireResult {
  success: boolean;
  skipped: boolean;
  skipReason?: string;
  output?: AcquireOutput;
  durationMs: number;
}

/**
 * Hybrid Pipeline Orchestrator
 *
 * In hybrid mode:
 * - Acquire stage runs before queuing
 * - SDKAgent handles Process + Parse + Render
 */
export class HybridPipelineOrchestrator {
  private acquireStage: AcquireStage;

  constructor(config?: Partial<PipelineConfig['stages']['acquire']>) {
    const acquireConfig = {
      skipDuplicates: config?.skipDuplicates ?? true,
      duplicateWindowMs: config?.duplicateWindowMs ?? 5000,
    };
    this.acquireStage = new AcquireStage(acquireConfig);
  }

  /**
   * Run the acquire stage on raw observation input
   *
   * Returns structured output ready for queuing, or null if skipped
   */
  async acquire(input: RawObservationInput): Promise<AcquireResult> {
    const startTime = Date.now();

    try {
      // Convert to AcquireInput format
      const acquireInput: AcquireInput = {
        toolName: input.toolName,
        toolInput: input.toolInput,
        toolOutput: input.toolOutput,
        cwd: input.cwd,
        timestamp: Date.now(),
        sessionId: input.claudeSessionId,
        promptNumber: input.promptNumber,
      };

      // Execute acquire stage
      const output = await this.acquireStage.execute(acquireInput);
      const durationMs = Date.now() - startTime;

      if (output === null) {
        // Duplicate detected
        pipelineMetrics.recordStage('acquire', durationMs, true, {
          skipped: true,
          reason: 'duplicate',
          toolName: input.toolName,
        });

        return {
          success: true,
          skipped: true,
          skipReason: 'duplicate',
          durationMs,
        };
      }

      // Success
      pipelineMetrics.recordStage('acquire', durationMs, true, {
        toolName: input.toolName,
        category: output.metadata.toolCategory,
        inputTokens: output.metadata.inputTokenEstimate,
        outputTokens: output.metadata.outputTokenEstimate,
      });

      logger.debug('PIPELINE', 'Acquire stage completed', {
        sessionId: input.sessionDbId,
        toolName: input.toolName,
        category: output.metadata.toolCategory,
        durationMs,
      });

      return {
        success: true,
        skipped: false,
        output,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      pipelineMetrics.recordStage('acquire', durationMs, false, {
        toolName: input.toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      logger.error('PIPELINE', 'Acquire stage failed', {
        sessionId: input.sessionDbId,
        toolName: input.toolName,
      }, error as Error);

      return {
        success: false,
        skipped: false,
        durationMs,
      };
    }
  }

  /**
   * Get token estimates from acquire output
   */
  getTokenEstimates(output: AcquireOutput): { input: number; output: number; total: number } {
    return {
      input: output.metadata.inputTokenEstimate,
      output: output.metadata.outputTokenEstimate,
      total: output.metadata.inputTokenEstimate + output.metadata.outputTokenEstimate,
    };
  }

  /**
   * Get tool category from acquire output
   */
  getToolCategory(output: AcquireOutput): string {
    return output.metadata.toolCategory;
  }
}

// Singleton instance
let orchestratorInstance: HybridPipelineOrchestrator | null = null;

/**
 * Get or create the hybrid pipeline orchestrator
 */
export function getHybridOrchestrator(config?: Partial<PipelineConfig['stages']['acquire']>): HybridPipelineOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new HybridPipelineOrchestrator(config);
  }
  return orchestratorInstance;
}

/**
 * Reset the orchestrator (for testing)
 */
export function resetOrchestrator(): void {
  orchestratorInstance = null;
}
