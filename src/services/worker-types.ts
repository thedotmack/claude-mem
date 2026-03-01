/**
 * Shared types for Worker Service architecture
 */

import type { Response } from 'express';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

// ============================================================================
// Active Session Types
// ============================================================================

/** Available AI providers for observation processing */
export type ProviderType = 'claude' | 'gemini' | 'openai-compat';

/**
 * Provider-agnostic conversation message for shared history
 * Used to maintain context across Claude↔Gemini provider switches
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ActiveSession {
  sessionDbId: number;
  contentSessionId: string;      // User's Claude Code session being observed
  memorySessionId: string | null; // Memory agent's session ID for resume
  project: string;
  userPrompt: string;
  pendingMessages: PendingMessage[];  // Deprecated: now using persistent store, kept for compatibility
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number;
  startTime: number;
  cumulativeInputTokens: number;   // Track input tokens for discovery cost
  cumulativeOutputTokens: number;  // Track output tokens for discovery cost
  earliestPendingTimestamp: number | null;  // Original timestamp of earliest pending message (for accurate observation timestamps)
  conversationHistory: ConversationMessage[];  // Shared conversation history for provider switching
  currentProvider: ProviderType | null;  // Track which provider is currently running
  memorySessionIdCapturedLive: boolean;  // True only when memorySessionId was captured from a live SDK session in this process
  queryRef?: Query;  // SDK Query reference for explicit close() on session cleanup
}

export interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt_number?: number;
  cwd?: string;
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
  tool_input: unknown;
  tool_response: unknown;
  prompt_number: number;
  cwd?: string;
}

// ============================================================================
// SSE Types
// ============================================================================

export interface SSEEvent {
  type: string;
  timestamp?: number;
  [key: string]: unknown;
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
  memory_session_id: string;  // Renamed from sdk_session_id
  project: string;
  type: string;
  priority: string;
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
  session_id: string; // content_session_id (from JOIN)
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at: string;
  created_at_epoch: number;
  observation_count?: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;  // Renamed from claude_session_id
  project: string; // From JOIN with sdk_sessions
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export interface DBSession {
  id: number;
  content_session_id: string;    // Renamed from claude_session_id
  project: string;
  user_prompt: string;
  memory_session_id: string | null;  // Renamed from sdk_session_id
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
  title: string;
  subtitle: string | null;
  text: string;
  concepts: string[];
  files: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
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
