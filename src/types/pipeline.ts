/**
 * Pipeline Architecture Types for claude-mem
 *
 * Implements a five-stage pipeline for observation processing:
 *   Acquire → Prepare → Process → Parse → Render
 *
 * Design principles:
 * - Only Process stage involves LLM calls (expensive, non-deterministic)
 * - All other stages are deterministic transformations
 * - Each stage can be debugged and tested independently
 * - Parse failures can retry without re-running Process
 * - Intermediate outputs are storable for debugging/recovery
 *
 * Based on pipeline architecture analysis recommendations.
 */

// ============================================================================
// Core Pipeline Types
// ============================================================================

/**
 * Pipeline stage identifiers
 */
export type PipelineStage = 'acquire' | 'prepare' | 'process' | 'parse' | 'render';

/**
 * Pipeline execution status
 */
export type PipelineStatus =
  | 'pending'      // Not yet started
  | 'in_progress'  // Currently executing
  | 'completed'    // Successfully finished
  | 'failed'       // Failed with error
  | 'skipped';     // Skipped (e.g., duplicate detection)

/**
 * Result of a pipeline stage execution
 */
export interface StageResult<T> {
  stage: PipelineStage;
  status: PipelineStatus;
  data: T | null;
  error?: Error;
  startTime: number;
  endTime: number;
  metadata?: Record<string, unknown>;
}

/**
 * Complete pipeline execution record
 */
export interface PipelineExecution {
  id: string;
  sessionId: string;
  messageId?: string;
  promptNumber: number;  // Original prompt number for retry
  startTime: number;
  endTime?: number;
  status: PipelineStatus;
  stages: {
    acquire?: StageResult<AcquireOutput>;
    prepare?: StageResult<PrepareOutput>;
    process?: StageResult<ProcessOutput>;
    parse?: StageResult<ParseOutput>;
    render?: StageResult<RenderOutput>;
  };
  retryCount: number;
  lastRetryStage?: PipelineStage;
}

// ============================================================================
// Stage-Specific Input/Output Types
// ============================================================================

/**
 * ACQUIRE Stage: Raw data capture from tool execution
 *
 * Input: Raw tool output from Claude session
 * Output: Structured raw observation data ready for processing
 */
export interface AcquireInput {
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  cwd?: string;
  timestamp: number;
  sessionId: string;
  promptNumber: number;
}

export interface AcquireOutput {
  rawObservation: {
    tool_name: string;
    tool_input: string;  // JSON stringified
    tool_output: string; // JSON stringified
    cwd: string | null;
    created_at_epoch: number;
    session_id: string;
    prompt_number: number;
  };
  metadata: {
    inputTokenEstimate: number;
    outputTokenEstimate: number;
    toolCategory: string; // 'read', 'write', 'search', 'bash', etc.
  };
}

/**
 * PREPARE Stage: Transform raw data into LLM prompt
 *
 * Input: Raw observation from Acquire
 * Output: Formatted prompt ready for LLM processing
 */
export interface PrepareInput {
  rawObservation: AcquireOutput['rawObservation'];
  context: {
    project: string;
    modeConfig: unknown;  // ModeConfig from domain
    recentObservations?: string[];  // For context
  };
}

export interface PrepareOutput {
  prompt: string;
  systemPrompt?: string;
  tokenEstimate: {
    input: number;
    expectedOutput: number;
  };
  metadata: {
    promptVersion: string;
    modeId: string;
    contextIncluded: boolean;
  };
}

/**
 * PROCESS Stage: Execute LLM call for observation compression
 *
 * Input: Formatted prompt from Prepare
 * Output: Raw LLM response text
 *
 * This is the only non-deterministic, expensive stage.
 */
export interface ProcessInput {
  prompt: string;
  systemPrompt?: string;
  sessionId: string;
  modelConfig?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  };
}

export interface ProcessOutput {
  responseText: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost?: number;  // Estimated cost in USD
  };
  metadata: {
    model: string;
    latencyMs: number;
    cached: boolean;
  };
}

/**
 * PARSE Stage: Extract structured data from LLM response
 *
 * Input: Raw LLM response from Process
 * Output: Structured observation/summary data
 *
 * Uses fault-tolerant parsing with fallbacks.
 */
export interface ParseInput {
  responseText: string;
  expectedFormat: 'observation' | 'summary' | 'both';
  validationConfig: {
    validTypes: string[];
    fallbackType: string;
  };
}

export interface ParseOutput {
  observations: ParsedObservationData[];
  summary?: ParsedSummaryData;
  parseMetrics: {
    successRate: number;
    fallbacksUsed: number;
    fieldsExtracted: number;
  };
}

export interface ParsedObservationData {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummaryData {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}

/**
 * RENDER Stage: Persist parsed data to storage
 *
 * Input: Parsed observations/summaries from Parse
 * Output: Storage confirmation with IDs
 */
export interface RenderInput {
  observations: ParsedObservationData[];
  summary?: ParsedSummaryData;
  sessionId: string;
  project: string;
  promptNumber: number;
  discoveryTokens: number;
}

export interface RenderOutput {
  savedObservations: {
    id: number;
    createdAtEpoch: number;
  }[];
  savedSummary?: {
    id: number;
    createdAtEpoch: number;
  };
  chromaSyncStatus: 'success' | 'partial' | 'failed';
  metadata: {
    dbWriteLatencyMs: number;
    chromaSyncLatencyMs: number;
  };
}

// ============================================================================
// Pipeline Configuration
// ============================================================================

export interface PipelineConfig {
  /** Enable intermediate output storage for debugging */
  storeIntermediates: boolean;

  /** Retry configuration */
  retry: {
    maxRetries: number;
    retryFromStage: PipelineStage;  // Which stage to retry from on failure
    backoffMs: number;
  };

  /** Stage-specific configuration */
  stages: {
    acquire: {
      skipDuplicates: boolean;
      duplicateWindowMs: number;
    };
    prepare: {
      includeContext: boolean;
      maxContextObservations: number;
    };
    process: {
      timeoutMs: number;
      model?: string;
    };
    parse: {
      strictMode: boolean;  // Fail on parse errors vs use fallbacks
      logMetrics: boolean;
    };
    render: {
      syncToChroma: boolean;
      broadcastToSSE: boolean;
    };
  };
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  storeIntermediates: false,
  retry: {
    maxRetries: 2,
    retryFromStage: 'parse',  // Retry from Parse to avoid re-running LLM
    backoffMs: 1000,
  },
  stages: {
    acquire: {
      skipDuplicates: true,
      duplicateWindowMs: 5000,
    },
    prepare: {
      includeContext: false,
      maxContextObservations: 5,
    },
    process: {
      timeoutMs: 60000,
      model: undefined,  // Use default
    },
    parse: {
      strictMode: false,  // Use fallbacks
      logMetrics: true,
    },
    render: {
      syncToChroma: true,
      broadcastToSSE: true,
    },
  },
};

// ============================================================================
// Pipeline Executor Interface
// ============================================================================

/**
 * Interface for pipeline stage executors
 */
export interface PipelineStageExecutor<TInput, TOutput> {
  stage: PipelineStage;
  execute(input: TInput): Promise<StageResult<TOutput>>;
  validate?(input: TInput): boolean;
  rollback?(input: TInput): Promise<void>;
}

/**
 * Full pipeline executor interface
 */
export interface PipelineExecutor {
  execute(input: AcquireInput): Promise<PipelineExecution>;
  retryFrom(execution: PipelineExecution, stage: PipelineStage): Promise<PipelineExecution>;
  getExecution(id: string): Promise<PipelineExecution | null>;
  listExecutions(sessionId: string, limit?: number): Promise<PipelineExecution[]>;
}
