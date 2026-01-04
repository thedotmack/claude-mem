/**
 * Type definitions for user prompts module
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';

/**
 * Result type for getAllRecentUserPrompts
 */
export interface RecentUserPromptResult {
  id: number;
  content_session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Result type for getPromptById and getPromptsByIds
 */
export interface PromptWithProject {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  project: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Options for getUserPromptsByIds
 */
export interface GetPromptsByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
}
