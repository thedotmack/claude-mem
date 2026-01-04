/**
 * Session-related type definitions
 * Standalone types for session query results
 */
import { logger } from '../../../utils/logger.js';

/**
 * Basic session info (minimal fields)
 */
export interface SessionBasic {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
}

/**
 * Full session record with timestamps
 */
export interface SessionFull {
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
 * Session with summary info for status display
 */
export interface SessionWithStatus {
  memory_session_id: string | null;
  status: string;
  started_at: string;
  user_prompt: string | null;
  has_summary: boolean;
}

/**
 * Session summary with all detail fields
 */
export interface SessionSummaryDetail {
  id: number;
  memory_session_id: string | null;
  content_session_id: string;
  project: string;
  user_prompt: string;
  request_summary: string | null;
  learned_summary: string | null;
  status: string;
  created_at: string;
  created_at_epoch: number;
}
