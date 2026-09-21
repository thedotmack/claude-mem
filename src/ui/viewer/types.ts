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

export interface GeminiModelInfo {
  id: string;
  displayName: string;
  category: 'pro' | 'flash' | 'gemma' | 'omni' | 'lite';
  rank: number;
  rpmLimit: number;
  tpmLimit: number;
  rpdLimit: number;
  contextWindow: number;
  outputLimit: number;
  description?: string;
  isPerpetualAlias?: boolean;
  isPreview?: boolean;
}

export interface ModelUsageState {
  rpmUsed: number;
  rpmLimit: number;
  tpmUsed: number;
  tpmLimit: number;
  rpdUsed: number;
  rpdLimit: number;
  status: 'active' | 'ready' | 'cooldown' | 'exhausted' | 'unsupported';
  cooldownUntilMs?: number;
  cooldownReason?: string;
  totalRequestsServed: number;
}

export interface GeminiRateLimitsStatus {
  provider: 'gemini';
  activeModel: string;
  autoFallback: boolean;
  models: Record<string, ModelUsageState>;
  cascade: GeminiModelInfo[];
  queue: {
    depth: number;
    isProcessing: boolean;
    isWaitingForQuota: boolean;
    quotaWaitRemainingMs: number;
    lastEvent?: string;
  };
  lastUpdated: number;
  lastSwitchEvent?: {
    fromModel: string;
    toModel: string;
    reason: string;
    timestamp: number;
  };
}

export interface StreamEvent {
  type:
    | 'initial_load'
    | 'new_observation'
    | 'new_summary'
    | 'new_prompt'
    | 'processing_status'
    | 'gemini_status_update'
    | 'gemini_model_switched'
    | 'gemini_queue_paused'
    | 'gemini_queue_resumed';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
  data?: any;
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

  CLAUDE_MEM_PROVIDER?: string;  
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_MODEL?: string;  
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;  
  CLAUDE_MEM_GEMINI_AUTO_FALLBACK?: string;  
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;

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
