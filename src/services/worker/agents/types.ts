/**
 * Shared agent types for SDK, Gemini, and OpenRouter agents
 *
 * Responsibility:
 * - Define common interfaces used across all agent implementations
 * - Provide type safety for response processing and broadcasting
 */

import type { ActiveSession } from '../../worker-types.js';
import type { ParsedObservation, ParsedSummary } from '../../../sdk/parser.js';

// ============================================================================
// Worker Reference Type
// ============================================================================

/**
 * Worker reference for SSE broadcasting and status updates
 * Both sseBroadcaster and broadcastProcessingStatus are optional
 * to allow agents to run without a full worker context (e.g., testing)
 */
export interface WorkerRef {
  sseBroadcaster?: {
    broadcast(event: SSEEventPayload): void;
  };
  broadcastProcessingStatus?: () => void;
}

// ============================================================================
// SSE Event Payloads
// ============================================================================

export interface ObservationSSEPayload {
  id: number;
  memory_session_id: string | null;
  session_id: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string;  // JSON stringified
  concepts: string;  // JSON stringified
  files_read: string;  // JSON stringified
  files_modified: string;  // JSON stringified
  project: string;
  prompt_number: number;
  created_at_epoch: number;
}

export interface SummarySSEPayload {
  id: number;
  session_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  project: string;
  prompt_number: number;
  created_at_epoch: number;
}

export type SSEEventPayload =
  | { type: 'new_observation'; observation: ObservationSSEPayload }
  | { type: 'new_summary'; summary: SummarySSEPayload };

// ============================================================================
// Response Processing Types
// ============================================================================

/**
 * Result from atomic database transaction for observations/summary storage
 */
export interface StorageResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

/**
 * Context needed for response processing
 */
export interface ResponseProcessingContext {
  session: ActiveSession;
  worker: WorkerRef | undefined;
  discoveryTokens: number;
  originalTimestamp: number | null;
}

/**
 * Parsed response data ready for storage
 */
export interface ParsedResponse {
  observations: ParsedObservation[];
  summary: ParsedSummary | null;
}

// ============================================================================
// Fallback Agent Interface
// ============================================================================

/**
 * Interface for fallback agent (used by Gemini/OpenRouter to fall back to Claude)
 */
export interface FallbackAgent {
  startSession(session: ActiveSession, worker?: WorkerRef): Promise<void>;
}

// ============================================================================
// Agent Configuration Types
// ============================================================================

/**
 * Base configuration shared across all agents
 */
export interface BaseAgentConfig {
  dbManager: import('../DatabaseManager.js').DatabaseManager;
  sessionManager: import('../SessionManager.js').SessionManager;
}

/**
 * Error codes that should trigger fallback to Claude
 */
export const FALLBACK_ERROR_PATTERNS = [
  '429',           // Rate limit
  '500',           // Internal server error
  '502',           // Bad gateway
  '503',           // Service unavailable
  'ECONNREFUSED',  // Connection refused
  'ETIMEDOUT',     // Timeout
  'fetch failed',  // Network failure
] as const;
