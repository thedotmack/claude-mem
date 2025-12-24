/**
 * TypeScript types for database query results
 * Provides type safety for bun:sqlite query results
 */

/**
 * Schema information from sqlite3 PRAGMA table_info
 */
export interface TableColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/**
 * Index information from sqlite3 PRAGMA index_list
 */
export interface IndexInfo {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

/**
 * Table name from sqlite_master
 */
export interface TableNameRow {
  name: string;
}

/**
 * Schema version record
 */
export interface SchemaVersion {
  version: number;
}

/**
 * SDK Session database record
 */
export interface SdkSessionRecord {
  id: number;
  claude_session_id: string;
  sdk_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: 'active' | 'completed' | 'failed';
  worker_port?: number;
  prompt_counter?: number;
}

/**
 * Observation database record
 */
export interface ObservationRecord {
  id: number;
  sdk_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  created_at: string;
  created_at_epoch: number;
  title?: string;
  concept?: string;
  source_files?: string;
  prompt_number?: number;
  discovery_tokens?: number;
}

/**
 * Session Summary database record
 */
export interface SessionSummaryRecord {
  id: number;
  sdk_session_id: string;
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

/**
 * User Prompt database record
 */
export interface UserPromptRecord {
  id: number;
  claude_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Latest user prompt with session join
 */
export interface LatestPromptResult {
  id: number;
  claude_session_id: string;
  sdk_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

/**
 * Observation with context (for time-based queries)
 */
export interface ObservationWithContext {
  id: number;
  sdk_session_id: string;
  project: string;
  text: string | null;
  type: string;
  created_at: string;
  created_at_epoch: number;
  title?: string;
  concept?: string;
  source_files?: string;
  prompt_number?: number;
  discovery_tokens?: number;
}

/**
 * Response source for waiting sessions
 * - 'slack': Response came from Slack thread reply
 * - 'local': Response came from Claude Code / VS Code extension
 * - 'api': Response came from direct API call
 */
export type ResponseSource = 'slack' | 'local' | 'api';

/**
 * Waiting Session database record
 * Tracks sessions waiting for user response (via Slack, Claude Code, or VS Code)
 */
export interface WaitingSessionRecord {
  id: number;
  claude_session_id: string;
  project: string;
  cwd: string;
  question: string | null;
  full_message: string | null;
  transcript_path: string | null;
  slack_thread_ts: string | null;
  slack_channel_id: string | null;
  status: 'waiting' | 'responded' | 'expired' | 'cancelled';
  created_at: string;
  created_at_epoch: number;
  responded_at: string | null;
  responded_at_epoch: number | null;
  response_text: string | null;
  response_source: ResponseSource | null;
  expires_at_epoch: number;
}

/**
 * Scheduled Continuation database record
 * Tracks scheduled session continuations (e.g., after rate limits)
 */
export interface ScheduledContinuationRecord {
  id: number;
  claude_session_id: string;
  project: string;
  cwd: string;
  scheduled_at: string;
  scheduled_at_epoch: number;
  reason: 'rate_limit' | 'user_scheduled' | 'other';
  prompt: string;
  status: 'pending' | 'executed' | 'cancelled' | 'failed';
  created_at: string;
  created_at_epoch: number;
  executed_at: string | null;
  executed_at_epoch: number | null;
}

/**
 * Log level for system_logs table
 */
export type SystemLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Component identifier for system_logs table
 */
export type SystemLogComponent = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'GRAPH' | 'SLACK' | 'NOTIFICATIONS' | 'HEALTH';

/**
 * System Log database record
 * Stores all application logs for self-awareness and debugging
 */
export interface SystemLogRecord {
  id: number;
  level: SystemLogLevel;
  component: SystemLogComponent;
  message: string;
  context: string | null;  // JSON: sessionId, correlationId, etc.
  data: string | null;     // JSON: additional data
  error_stack: string | null;  // Stack trace for errors
  created_at: string;
  created_at_epoch: number;
}

/**
 * Error Pattern database record
 * Tracks recurring errors for self-healing capabilities
 */
export interface ErrorPatternRecord {
  id: number;
  error_hash: string;       // Hash of error message + component
  error_message: string;    // Original error message
  component: SystemLogComponent;
  first_seen_epoch: number;
  last_seen_epoch: number;
  occurrence_count: number;
  is_resolved: number;      // SQLite boolean (0/1)
  resolution_notes: string | null;
  auto_resolution: string | null;  // JSON: automatic fix that was applied
}
