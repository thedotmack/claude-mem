
export interface TableColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

export interface IndexInfo {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

export interface TableNameRow {
  name: string;
}

export interface SchemaVersion {
  version: number;
}

export interface ObservationRecord {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  created_at: string;
  created_at_epoch: number;
  title?: string;
  concept?: string;
  prompt_number?: number;
  discovery_tokens?: number;
}

export interface SessionSummaryRecord {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
  prompt_number?: number;
  discovery_tokens?: number;
}

export interface UserPromptRecord {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  project?: string;  
  platform_source?: string;
  created_at: string;
  created_at_epoch: number;
}

export interface AdvisorCallRecord {
  id: number;
  session_db_id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  cwd: string | null;
  last_user_message: string | null;
  transcript_path: string | null;
  transcript_line_count: number | null;
  advice: string;
  occurred_at_epoch: number;
  created_at: string;
  created_at_epoch: number;
}

export interface LatestPromptResult {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}
