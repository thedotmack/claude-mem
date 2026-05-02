
import type { Response } from 'express';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ActiveSession {
  sessionDbId: number;
  contentSessionId: string;
  memorySessionId: string | null;
  project: string;
  platformSource: string;
  userPrompt: string;
  pendingMessages: PendingMessage[];
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number;
  startTime: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  conversationHistory: ConversationMessage[];
  currentProvider: 'claude' | 'gemini' | 'openrouter' | null;
  forceInit?: boolean;
  modelOverride?: string;
  lastSummaryStored?: boolean;
  pendingAgentId?: string | null;
  pendingAgentType?: string | null;
  abortReason?: 'idle' | 'shutdown' | 'overflow' | 'restart-guard' | null;
}

export interface PendingMessage {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt_number?: number;
  cwd?: string;
  last_assistant_message?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface ObservationData {
  tool_name: string;
  tool_input: any;
  tool_response: any;
  prompt_number: number;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface SSEEvent {
  type: string;
  timestamp?: number;
  [key: string]: any;
}

export type SSEClient = Response;

export interface PaginatedResult<T> {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
}

export interface ViewerSettings {
  sidebarOpen: boolean;
  selectedProject: string | null;
  theme: 'light' | 'dark' | 'system';
}

export interface Observation {
  id: number;
  memory_session_id: string;  
  project: string;
  merged_into_project: string | null;
  platform_source: string;
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
  session_id: string; 
  project: string;
  platform_source: string;
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
  content_session_id: string;  
  project: string; 
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

