/**
 * Type definitions for summary-related database operations
 */
import { logger } from '../../../utils/logger.js';

/**
 * Summary input for storage (from SDK parsing)
 */
export interface SummaryInput {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

/**
 * Result from storing a summary
 */
export interface StoreSummaryResult {
  id: number;
  createdAtEpoch: number;
}

/**
 * Summary for a specific session (minimal fields)
 */
export interface SessionSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Summary with session info for context display
 */
export interface SummaryWithSessionInfo {
  memory_session_id: string;
  request: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  prompt_number: number | null;
  created_at: string;
}

/**
 * Recent summary (for project-scoped queries)
 */
export interface RecentSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  created_at: string;
}

/**
 * Full summary with all fields (for web UI)
 */
export interface FullSummary {
  id: number;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  project: string;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Options for getByIds query
 */
export interface GetByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
}
