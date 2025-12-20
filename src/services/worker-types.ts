/**
 * Shared types for Worker Service architecture
 */

import type { Response } from 'express';

// ============================================================================
// Active Session Types
// ============================================================================

/**
 * Session ID Naming Convention:
 * - claudeSessionId: External identifier from Claude Code (matches hook's session_id)
 * - sessionDbId: Internal database primary key (sdk_sessions.id)
 * - sdkSessionId: DEPRECATED - legacy field, unused, will be removed
 */
export interface ActiveSession {
  sessionDbId: number;  // Internal DB primary key (sdk_sessions.id)
  claudeSessionId: string;  // External identifier from Claude Code (sdk_sessions.claude_session_id)
  sdkSessionId: string | null;  // DEPRECATED: unused, will be removed
  project: string;
  userPrompt: string;
  pendingMessages: PendingMessage[];  // Deprecated: now using persistent store, kept for compatibility
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number;
  startTime: number;
  cumulativeInputTokens: number;   // Track input tokens for discovery cost
  cumulativeOutputTokens: number;  // Track output tokens for discovery cost
  pendingProcessingIds: Set<number>;  // Track ALL message IDs yielded but not yet processed
}

export interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: string;  // Always string (JSON-serialized)
  tool_response?: string;  // Always string (JSON-serialized)
  prompt_number?: number;
  cwd?: string;
  last_user_message?: string;
  last_assistant_message?: string;
}

/**
 * PendingMessage with database ID for completion tracking.
 * The _persistentId is used to mark the message as processed after SDK success.
 * The _originalTimestamp is the epoch when the message was first queued (for accurate observation timestamps).
 */
export interface PendingMessageWithId extends PendingMessage {
  _persistentId: number;
  _originalTimestamp: number;
}

export interface ObservationData {
  tool_name: string;
  tool_input: string;  // Always string (JSON-serialized)
  tool_response: string;  // Always string (JSON-serialized)
  prompt_number: number;
  cwd?: string;
}

// ============================================================================
// SSE Types
// ============================================================================

export interface SSEEvent {
  type: string;
  timestamp?: number;
  [key: string]: any;
}

export type SSEClient = Response;

// ============================================================================
// Pagination Types
// ============================================================================

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface PaginationParams {
  offset: number;
  limit: number;
  project?: string;
}

// ============================================================================
// Settings Types
// ============================================================================

export interface ViewerSettings {
  sidebarOpen: boolean;
  selectedProject: string | null;
  theme: 'light' | 'dark' | 'system';
}

// ============================================================================
// Database Record Types
// ============================================================================

export interface Observation {
  id: number;
  sdk_session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string; // claude_session_id (from JOIN)
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  claude_session_id: string;
  project: string; // From JOIN with sdk_sessions
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Database session record (sdk_sessions table)
 *
 * Session ID fields:
 * - id: Internal database primary key (sessionDbId)
 * - claude_session_id: External identifier from Claude Code
 * - sdk_session_id: DEPRECATED - unused legacy field
 */
export interface DBSession {
  id: number;  // Internal primary key (sessionDbId)
  claude_session_id: string;  // External identifier from Claude Code
  project: string;
  user_prompt: string;
  sdk_session_id: string | null;  // DEPRECATED: unused
  status: 'active' | 'completed' | 'failed';
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
}

// ============================================================================
// SDK Types
// ============================================================================

// Re-export the actual SDK type to ensure compatibility
export type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

// ============================================================================
// API Error Types
// ============================================================================

/**
 * Standard error response shape for all API endpoints
 * All 4xx/5xx responses should use this format
 */
export interface APIError {
  error: string;  // Human-readable error message
  code?: string;  // Optional error code for programmatic handling
  details?: unknown;  // Optional additional error context
}

// ============================================================================
// Utility Types
// ============================================================================

export interface DatabaseStats {
  totalObservations: number;
  totalSessions: number;
  totalPrompts: number;
  totalSummaries: number;
  projectCounts: Record<string, {
    observations: number;
    sessions: number;
    prompts: number;
    summaries: number;
  }>;
}
