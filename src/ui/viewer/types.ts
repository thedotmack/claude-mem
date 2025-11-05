export interface Observation {
  id: number;
  session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle?: string;
  content?: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  request?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  claude_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  processing?: {
    session_id: string;
    is_processing: boolean;
  };
}

export interface Settings {
  CLAUDE_MEM_MODEL?: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS?: string;
  CLAUDE_MEM_WORKER_PORT?: string;
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
