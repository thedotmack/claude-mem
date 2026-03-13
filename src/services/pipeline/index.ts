/**
 * Pipeline Executor for claude-mem
 *
 * Implements the five-stage observation processing pipeline:
 *   Acquire → Prepare → Process → Parse → Render
 *
 * Features:
 * - Stage isolation for independent testing
 * - Retry from Parse stage without re-running LLM
 * - Intermediate output storage for debugging
 * - Metrics tracking per stage
 */

import { logger } from '../../utils/logger.js';
import {
  type PipelineStage,
  type PipelineStatus,
  type PipelineExecution,
  type PipelineConfig,
  type AcquireInput,
  type AcquireOutput,
  type PrepareInput,
  type PrepareOutput,
  type ProcessInput,
  type ProcessOutput,
  type ParseInput,
  type ParseOutput,
  type RenderInput,
  type RenderOutput,
  type StageResult,
  DEFAULT_PIPELINE_CONFIG
} from '../../types/pipeline.js';
import { AcquireStage } from './stages/acquire.js';
import { PrepareStage } from './stages/prepare.js';
import { ProcessStage } from './stages/process.js';
import { ParseStage } from './stages/parse.js';
import { RenderStage } from './stages/render.js';

// ============================================================================
// Pipeline Executor
// ============================================================================

export class ObservationPipeline {
  private config: PipelineConfig;
  private executions: Map<string, PipelineExecution> = new Map();

  // Stage executors (lazy initialized)
  private acquireStage?: AcquireStage;
  private prepareStage?: PrepareStage;
  private processStage?: ProcessStage;
  private parseStage?: ParseStage;
  private renderStage?: RenderStage;

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
  }

  /**
   * Initialize stage executors with dependencies
   */
  initialize(dependencies: {
    dbManager: unknown;
    sessionManager: unknown;
    modeManager: unknown;
  }): void {
    this.acquireStage = new AcquireStage(this.config.stages.acquire);
    this.prepareStage = new PrepareStage(this.config.stages.prepare, dependencies.modeManager);
    this.processStage = new ProcessStage(this.config.stages.process);
    this.parseStage = new ParseStage(this.config.stages.parse);
    this.renderStage = new RenderStage(this.config.stages.render, dependencies.dbManager);

    logger.info('PIPELINE', 'Pipeline initialized', {
      storeIntermediates: this.config.storeIntermediates,
      retryFromStage: this.config.retry.retryFromStage
    });
  }

  /**
   * Execute full pipeline from Acquire to Render
   */
  async execute(input: AcquireInput): Promise<PipelineExecution> {
    const executionId = `pipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const execution: PipelineExecution = {
      id: executionId,
      sessionId: input.sessionId,
      promptNumber: input.promptNumber,
      startTime: Date.now(),
      status: 'in_progress',
      stages: {},
      retryCount: 0
    };

    this.executions.set(executionId, execution);

    try {
      // Stage 1: Acquire
      if (!this.acquireStage) throw new Error('Acquire stage not initialized');
      const acquireStartTime = Date.now();
      let acquireResult: StageResult<AcquireOutput>;
      try {
        const acquireOutput = await this.acquireStage.execute(input);
        acquireResult = acquireOutput
          ? { stage: 'acquire', status: 'completed', data: acquireOutput, startTime: acquireStartTime, endTime: Date.now() }
          : { stage: 'acquire', status: 'skipped', data: null, startTime: acquireStartTime, endTime: Date.now() };
      } catch (error) {
        acquireResult = {
          stage: 'acquire',
          status: 'failed',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          startTime: acquireStartTime,
          endTime: Date.now()
        };
      }
      execution.stages.acquire = acquireResult;

      if (acquireResult.status !== 'completed' || !acquireResult.data) {
        execution.status = acquireResult.status === 'skipped' ? 'skipped' : 'failed';
        execution.endTime = Date.now();
        return execution;
      }

      // Stage 2: Prepare
      if (!this.prepareStage) throw new Error('Prepare stage not initialized');
      const prepareStartTime = Date.now();
      let prepareResult: StageResult<PrepareOutput>;
      const prepareInput: PrepareInput = {
        rawObservation: acquireResult.data.rawObservation,
        context: {
          project: 'default',
          modeConfig: null
        }
      };
      try {
        const prepareOutput = await this.prepareStage.execute(prepareInput);
        prepareResult = { stage: 'prepare', status: 'completed', data: prepareOutput, startTime: prepareStartTime, endTime: Date.now() };
      } catch (error) {
        prepareResult = {
          stage: 'prepare',
          status: 'failed',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          startTime: prepareStartTime,
          endTime: Date.now()
        };
      }
      execution.stages.prepare = prepareResult;

      if (prepareResult.status !== 'completed' || !prepareResult.data) {
        execution.status = 'failed';
        execution.endTime = Date.now();
        return execution;
      }

      // Stage 3: Process (LLM call)
      if (!this.processStage) throw new Error('Process stage not initialized');
      const processStartTime = Date.now();
      let processResult: StageResult<ProcessOutput>;
      const processInput: ProcessInput = {
        prompt: prepareResult.data.prompt,
        systemPrompt: prepareResult.data.systemPrompt,
        sessionId: input.sessionId
      };
      try {
        const processOutput = await this.processStage.execute(processInput);
        processResult = { stage: 'process', status: 'completed', data: processOutput, startTime: processStartTime, endTime: Date.now() };
      } catch (error) {
        processResult = {
          stage: 'process',
          status: 'failed',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          startTime: processStartTime,
          endTime: Date.now()
        };
      }
      execution.stages.process = processResult;

      if (processResult.status !== 'completed' || !processResult.data) {
        execution.status = 'failed';
        execution.endTime = Date.now();
        return execution;
      }

      // Stage 4: Parse
      if (!this.parseStage) throw new Error('Parse stage not initialized');
      const parseStartTime = Date.now();
      let parseResult: StageResult<ParseOutput>;
      const parseInput: ParseInput = {
        responseText: processResult.data.responseText,
        expectedFormat: 'both',
        validationConfig: {
          validTypes: ['discovery', 'change', 'decision', 'bugfix', 'feature'],
          fallbackType: 'discovery'
        }
      };
      try {
        const parseOutput = await this.parseStage.execute(parseInput);
        parseResult = { stage: 'parse', status: 'completed', data: parseOutput, startTime: parseStartTime, endTime: Date.now() };
      } catch (error) {
        parseResult = {
          stage: 'parse',
          status: 'failed',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          startTime: parseStartTime,
          endTime: Date.now()
        };
      }
      execution.stages.parse = parseResult;

      if (parseResult.status !== 'completed' || !parseResult.data) {
        // Retry from parse if configured
        if (execution.retryCount < this.config.retry.maxRetries) {
          return this.retryFrom(execution, 'parse');
        }
        execution.status = 'failed';
        execution.endTime = Date.now();
        return execution;
      }

      // Stage 5: Render
      if (!this.renderStage) throw new Error('Render stage not initialized');
      const renderStartTime = Date.now();
      let renderResult: StageResult<RenderOutput>;
      const renderInput: RenderInput = {
        observations: parseResult.data.observations,
        summary: parseResult.data.summary,
        sessionId: input.sessionId,
        project: 'default',
        promptNumber: input.promptNumber,
        discoveryTokens: processResult.data.usage.totalTokens
      };
      try {
        const renderOutput = await this.renderStage.execute(renderInput);
        renderResult = { stage: 'render', status: 'completed', data: renderOutput, startTime: renderStartTime, endTime: Date.now() };
      } catch (error) {
        renderResult = {
          stage: 'render',
          status: 'failed',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          startTime: renderStartTime,
          endTime: Date.now()
        };
      }
      execution.stages.render = renderResult;

      execution.status = renderResult.status === 'completed' ? 'completed' : 'failed';
      execution.endTime = Date.now();

      logger.info('PIPELINE', 'Pipeline execution completed', {
        executionId,
        status: execution.status,
        durationMs: execution.endTime - execution.startTime,
        observationsCount: parseResult.data.observations.length
      });

      return execution;

    } catch (error) {
      execution.status = 'failed';
      execution.endTime = Date.now();

      logger.error('PIPELINE', 'Pipeline execution failed', {
        executionId,
        error: error instanceof Error ? error.message : String(error)
      });

      return execution;
    }
  }

  /**
   * Retry pipeline from a specific stage
   * Useful for retrying Parse without re-running Process
   */
  async retryFrom(execution: PipelineExecution, stage: PipelineStage): Promise<PipelineExecution> {
    execution.retryCount++;
    execution.lastRetryStage = stage;

    logger.info('PIPELINE', 'Retrying from stage', {
      executionId: execution.id,
      stage,
      retryCount: execution.retryCount
    });

    // Wait for backoff
    await new Promise(resolve => setTimeout(resolve, this.config.retry.backoffMs));

    // Re-execute from specified stage
    if (stage === 'parse' && execution.stages.process?.data) {
      if (!this.parseStage) throw new Error('Parse stage not initialized');

      const parseInput: ParseInput = {
        responseText: execution.stages.process.data.responseText,
        expectedFormat: 'both',
        validationConfig: {
          validTypes: ['discovery', 'change', 'decision', 'bugfix', 'feature'],
          fallbackType: 'discovery'
        }
      };

      const parseStartTime = Date.now();
      let parseResult: StageResult<ParseOutput>;
      try {
        const parseOutput = await this.parseStage.execute(parseInput);
        parseResult = { stage: 'parse', status: 'completed', data: parseOutput, startTime: parseStartTime, endTime: Date.now() };
      } catch (error) {
        parseResult = {
          stage: 'parse',
          status: 'failed',
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          startTime: parseStartTime,
          endTime: Date.now()
        };
      }
      execution.stages.parse = parseResult;

      if (parseResult.status === 'completed' && parseResult.data && execution.stages.acquire?.data) {
        if (!this.renderStage) throw new Error('Render stage not initialized');

        const renderInput: RenderInput = {
          observations: parseResult.data.observations,
          summary: parseResult.data.summary,
          sessionId: execution.sessionId,
          project: 'default',
          promptNumber: execution.promptNumber,
          discoveryTokens: execution.stages.process.data.usage.totalTokens
        };

        const renderStartTime = Date.now();
        let renderResult: StageResult<RenderOutput>;
        try {
          const renderOutput = await this.renderStage.execute(renderInput);
          renderResult = { stage: 'render', status: 'completed', data: renderOutput, startTime: renderStartTime, endTime: Date.now() };
        } catch (error) {
          renderResult = {
            stage: 'render',
            status: 'failed',
            data: null,
            error: error instanceof Error ? error : new Error(String(error)),
            startTime: renderStartTime,
            endTime: Date.now()
          };
        }
        execution.stages.render = renderResult;
        execution.status = renderResult.status === 'completed' ? 'completed' : 'failed';
      } else {
        execution.status = 'failed';
      }
    }

    execution.endTime = Date.now();
    return execution;
  }

  /**
   * Get execution by ID
   */
  getExecution(id: string): PipelineExecution | null {
    return this.executions.get(id) || null;
  }

  /**
   * List recent executions for a session
   */
  listExecutions(sessionId: string, limit: number = 10): PipelineExecution[] {
    return Array.from(this.executions.values())
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  /**
   * Get pipeline metrics
   */
  getMetrics(): {
    totalExecutions: number;
    successRate: number;
    avgDurationMs: number;
    stageMetrics: Record<PipelineStage, { avgMs: number; successRate: number }>;
  } {
    const executions = Array.from(this.executions.values());
    const completed = executions.filter(e => e.status === 'completed');

    const stageMetrics: Record<PipelineStage, { totalMs: number; count: number; successes: number }> = {
      acquire: { totalMs: 0, count: 0, successes: 0 },
      prepare: { totalMs: 0, count: 0, successes: 0 },
      process: { totalMs: 0, count: 0, successes: 0 },
      parse: { totalMs: 0, count: 0, successes: 0 },
      render: { totalMs: 0, count: 0, successes: 0 }
    };

    for (const exec of executions) {
      for (const [stage, result] of Object.entries(exec.stages)) {
        if (result) {
          const s = stage as PipelineStage;
          stageMetrics[s].totalMs += result.endTime - result.startTime;
          stageMetrics[s].count++;
          if (result.status === 'completed') stageMetrics[s].successes++;
        }
      }
    }

    return {
      totalExecutions: executions.length,
      successRate: executions.length > 0 ? (completed.length / executions.length) * 100 : 0,
      avgDurationMs: completed.length > 0
        ? completed.reduce((sum, e) => sum + ((e.endTime || 0) - e.startTime), 0) / completed.length
        : 0,
      stageMetrics: Object.fromEntries(
        Object.entries(stageMetrics).map(([stage, m]) => [
          stage,
          {
            avgMs: m.count > 0 ? m.totalMs / m.count : 0,
            successRate: m.count > 0 ? (m.successes / m.count) * 100 : 0
          }
        ])
      ) as Record<PipelineStage, { avgMs: number; successRate: number }>
    };
  }
}

// Export singleton instance
export const observationPipeline = new ObservationPipeline();

// Re-export types
export * from '../../types/pipeline.js';

// Re-export hybrid orchestrator for gradual migration
export {
  HybridPipelineOrchestrator,
  getHybridOrchestrator,
  resetOrchestrator,
  type RawObservationInput,
  type AcquireResult
} from './orchestrator.js';
