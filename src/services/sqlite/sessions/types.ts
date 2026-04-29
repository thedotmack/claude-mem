import { logger } from '../../../utils/logger.js';

export interface SessionBasic {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  platform_source: string;
  user_prompt: string;
  custom_title: string | null;
}

export interface SessionFull {
  id: number;
  content_session_id: string;
  memory_session_id: string;
  project: string;
  platform_source: string;
  user_prompt: string;
  custom_title: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

export interface SessionWithStatus {
  memory_session_id: string | null;
  status: string;
  started_at: string;
  user_prompt: string | null;
  has_summary: boolean;
}

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
