/**
 * Export/Import types for memory data
 *
 * These types represent the structure of exported memory data.
 * They are aligned with the actual database schema and include all fields
 * needed for complete data export and import operations.
 */

/**
 * Observation record as stored in the database and exported
 */
export interface ObservationRecord {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * SDK Session record as stored in the database and exported
 */
export interface SdkSessionRecord {
  id: number;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  user_prompt: string;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

/**
 * Session Summary record as stored in the database and exported
 */
export interface SessionSummaryRecord {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * User Prompt record as stored in the database and exported
 */
export interface UserPromptRecord {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Complete export data structure
 */
export interface ExportData {
  exportedAt: string;
  exportedAtEpoch: number;
  query: string;
  project?: string;
  totalObservations: number;
  totalSessions: number;
  totalSummaries: number;
  totalPrompts: number;
  observations: ObservationRecord[];
  sessions: SdkSessionRecord[];
  summaries: SessionSummaryRecord[];
  prompts: UserPromptRecord[];
}
