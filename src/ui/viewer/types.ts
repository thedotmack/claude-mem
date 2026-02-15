export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

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

export interface Settings {
  MAGIC_CLAUDE_MEM_MODEL: string;
  MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  MAGIC_CLAUDE_MEM_WORKER_PORT: string;
  MAGIC_CLAUDE_MEM_WORKER_HOST: string;

  // AI Provider Configuration
  MAGIC_CLAUDE_MEM_PROVIDER?: string;  // 'claude' | 'gemini' | 'openai-compat'
  MAGIC_CLAUDE_MEM_GEMINI_API_KEY?: string;
  MAGIC_CLAUDE_MEM_GEMINI_MODEL?: string;  // 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash'
  MAGIC_CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;  // 'true' | 'false'
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY?: string;
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL?: string;
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL?: string;
  MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME?: string;

  // Token Economics Display
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  // Observation Filtering
  MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS?: string;

  // Display Configuration
  MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  // Feature Toggles
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}

export interface FilterState {
  query: string;
  project: string;
  obsTypes: string[];
  concepts: string[];
  itemKinds: Array<'observations' | 'sessions' | 'prompts'>;
  dateStart: string;
  dateEnd: string;
}

export interface SearchResponse {
  observations: Observation[];
  sessions: Summary[];
  prompts: UserPrompt[];
  totalResults: number;
  query: string;
}

export interface ActivityDay {
  date: string;
  count: number;
  observations: number;
  summaries: number;
  prompts: number;
}

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
