/**
 * Agent Consolidation Module
 *
 * This module provides shared utilities for SDK, Gemini, and OpenRouter agents.
 * It extracts common patterns to reduce code duplication and ensure consistent behavior.
 *
 * Usage:
 * ```typescript
 * import { processAgentResponse, shouldFallbackToClaude } from './agents/index.js';
 * ```
 */

// Types
export type {
  WorkerRef,
  ObservationSSEPayload,
  SummarySSEPayload,
  SSEEventPayload,
  StorageResult,
  ResponseProcessingContext,
  ParsedResponse,
  FallbackAgent,
  BaseAgentConfig,
} from './types.js';

export { FALLBACK_ERROR_PATTERNS } from './types.js';

// Response Processing
export { processAgentResponse } from './ResponseProcessor.js';

// SSE Broadcasting
export { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';

// Session Cleanup
export { cleanupProcessedMessages } from './SessionCleanupHelper.js';

// Error Handling
export { shouldFallbackToClaude, isAbortError } from './FallbackErrorHandler.js';
