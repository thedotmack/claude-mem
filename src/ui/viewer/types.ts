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
}

export interface Settings {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;

  // AI Provider Configuration
  CLAUDE_MEM_PROVIDER?: string;  // 'claude' | 'gemini' | 'openrouter'
  CLAUDE_MEM_GEMINI_API_KEY?: string;
  CLAUDE_MEM_GEMINI_MODEL?: string;  // 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-3-flash-preview'
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED?: string;  // 'true' | 'false'
  CLAUDE_MEM_OPENROUTER_API_KEY?: string;
  CLAUDE_MEM_OPENROUTER_MODEL?: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL?: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME?: string;

  // Token Economics Display
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  // Display Configuration
  CLAUDE_MEM_CONTEXT_FULL_COUNT?: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD?: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT?: string;

  // Feature Toggles
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}

// Collaboration types
export interface AgentMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string;
  urgent: number;
  read: number;
  created_at: string;
  created_at_epoch: number;
  read_at?: string;
  read_at_epoch?: number;
}

export interface FileLock {
  id: number;
  file_path: string;
  locked_by: string;
  locked_at: string;
  locked_at_epoch: number;
  expires_at_epoch: number;
}

export interface Plan {
  id: string;
  title: string;
  description?: string;
  status: 'drafting' | 'active' | 'completed' | 'archived';
  goals?: string;
  phases?: string;
  notes?: string;
  project?: string;
  created_by?: string;
  created_at: string;
  created_at_epoch: number;
  updated_at?: string;
  updated_at_epoch?: number;
}

export interface AgentConfig {
  listening: boolean;
  polling_interval?: number;
  model: string;
  reasoning: string;
  permissions: string;
  status?: string;
}

export interface AgentControls {
  leader: string;
  leader_mode: string;
  active_project: string | null;
  projects: { path: string; name: string }[];
  agents: Record<string, AgentConfig>;
}

export interface CollabStatus {
  controls: AgentControls;
  locks: FileLock[];
  unread_messages: AgentMessage[];
  pending_tasks: Observation[];
  recent_observations: Observation[];
  timestamp: number;
}

export type ViewerTab = 'feed' | 'chat' | 'live' | 'status' | 'timeline' | 'plans' | 'conflicts' | 'metrics';

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

// Live coding view types
export interface TokenUsageEvent {
  sessionDbId: number;
  provider: string;
  model: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  estimatedCostUsd: number;
  timestamp: number;
}

export interface AgentErrorEvent {
  sessionDbId: number;
  provider: string;
  model: string;
  project: string;
  errorMessage: string;
  errorCode?: string;
  promptSnippet?: string;
  timestamp: number;
}

export interface AgentActivityEvent {
  sessionDbId: number;
  provider: string;
  model: string;
  project: string;
  status: 'calling_api' | 'processing_response' | 'idle' | 'error';
  timestamp: number;
}
