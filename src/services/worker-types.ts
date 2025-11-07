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
}

export interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt_number?: number;
}

export interface ObservationData {
  tool_name: string;
  tool_input: any;
  tool_response: any;
  prompt_number: number;
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
  session_db_id: number;
  claude_session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle: string | null;
  text: string;
  concepts: string | null;
  files: string | null;
  prompt_number: number;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_db_id: number;
  claude_session_id: string;
  project: string;
  request: string | null;
  completion: string | null;
  summary: string;
  learnings: string | null;
  notes: string | null;
  created_at: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  session_db_id: number;
  claude_session_id: string;
  project: string;
  prompt: string;
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
}

export interface ParsedSummary {
  request: string | null;
  completion: string | null;
  summary: string;
  learnings: string | null;
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
