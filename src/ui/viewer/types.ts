// Base interfaces
interface BaseEntity {
  id: number;
  project: string;
  created_at_epoch: number;
}

export interface Observation extends BaseEntity {
  memory_session_id: string;
  type: string;
  title?: string;
  subtitle?: string;
  narrative?: string;
  text?: string;
  facts?: string;
  concepts?: string;
  files_read?: string;
  files_modified?: string;
  prompt_number?: number;
  created_at: string;
}

export interface Summary extends BaseEntity {
  session_id: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
}

export interface UserPrompt extends BaseEntity {
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
}

// Union type for feed items
export type FeedItem = 
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

// Stream events interface (keeping original structure for compatibility)
export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
}

// Configuration types
export interface ProviderConfig {
  CLAUDE_MEM_PROVIDER?: 'claude' | 'gemini' | 'openrouter';
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_MODEL?: 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash';
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: 'true' | 'false';
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;
}

export interface DisplayConfig {
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;
  CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES?: string;
  CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS?: string;
  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}

export interface Settings extends ProviderConfig, DisplayConfig {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;
}

// Stats interfaces
export interface WorkerStats {
  version?: string;
  uptime?: number;
  activeSessions?: number;
  sseClients?: number;
}

export interface DatabaseStats {
  size?: number;
  observations?: number;
  sessions?: number;
  summaries?: number;
}

export interface Stats {
  worker?: WorkerStats;
  database?: DatabaseStats;
}