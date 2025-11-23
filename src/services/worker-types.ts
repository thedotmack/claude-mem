/**
 * Shared types for Worker Service architecture
 */

import type { Response } from 'express';

// ============================================================================
// Active Session Types
// ============================================================================

export interface ActiveSession {
  sessionDbId: number;
  claudeSessionId: string;
  sdkSessionId: string | null;
  project: string;
  userPrompt: string;
  pendingMessages: PendingMessage[];
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number;
  startTime: number;
  cumulativeInputTokens: number;   // Track input tokens for discovery cost
  cumulativeOutputTokens: number;  // Track output tokens for discovery cost
  currentToolUseId: string | null; // Endless Mode: currently processing tool_use_id
  pendingObservationResolvers: Map<string, (observation: any) => void>; // Endless Mode: wait for observations
  lastObservationToolUseId: string | null; // Rolling replacement: tool_use_id of most recent observation
  toolUsesInCurrentCycle: string[]; // Rolling replacement: tool_use_ids since last observation
}

export interface PendingMessage {
  type: 'observation' | 'summarize' | 'continuation';
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt_number?: number;
  cwd?: string;
  tool_use_id?: string; // Endless Mode: link observation to transcript tool use
  last_user_message?: string;
  last_assistant_message?: string;
  user_prompt?: string; // For continuation messages
}

export interface ObservationData {
  tool_name: string;
  tool_input: any;
  tool_response: any;
  prompt_number: number;
  cwd?: string;
  tool_use_id?: string; // Endless Mode: link observation to transcript tool use
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

export interface DBSession {
  id: number;
  claude_session_id: string;
  project: string;
  user_prompt: string;
  sdk_session_id: string | null;
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
  tool_use_id?: string | null; // Endless Mode: link observation to transcript tool use
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
