import { logger } from '../../../utils/logger.js';

export interface SummaryInput {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

export interface StoreSummaryResult {
  id: number;
  createdAtEpoch: number;
}

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

export interface SummaryWithSessionInfo {
  memory_session_id: string;
  request: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  prompt_number: number | null;
  created_at: string;
}

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

export interface GetByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
}
