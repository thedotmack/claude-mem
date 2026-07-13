export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
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
  platform_source: string;
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
  platform_source: string;
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

export interface ProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export interface Settings {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;
  CLAUDE_MEM_ALLOW_DISMISS?: string;
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS?: string;
  CLAUDE_MEM_SKIP_AGENT_TYPES?: string;

  CLAUDE_MEM_PROVIDER?: string;  
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_MODEL?: string;  
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;  
  CLAUDE_MEM_AGY_CLI_MODEL?: string;
  CLAUDE_MEM_AGY_CLI_PATH?: string;
  CLAUDE_MEM_AGY_CLI_TIMEOUT_MS?: string;
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_BASE_URL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;
  CLAUDE_MEM_OPENROUTER_REASONING_EFFORT?: string;
  CLAUDE_MEM_OPENROUTER_EXTRA_BODY?: string;
  CLAUDE_MEM_CODEX_MODEL?: string;
  CLAUDE_MEM_CODEX_PATH?: string;
  CLAUDE_MEM_CODEX_REASONING_EFFORT?: string;
  CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES?: string;
  CLAUDE_MEM_CODEX_MAX_TOKENS?: string;
  CLAUDE_MEM_CODEX_TIMEOUT_MS?: string;
  CLAUDE_MEM_KIRO_MODEL?: string;
  CLAUDE_MEM_KIRO_CLI_PATH?: string;

  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}
