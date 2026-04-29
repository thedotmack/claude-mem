
import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

export interface RecentUserPromptResult {
  id: number;
  content_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export interface PromptWithProject {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  project: string;
  created_at: string;
  created_at_epoch: number;
}

export interface GetPromptsByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
}
