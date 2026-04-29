import { logger } from '../../../utils/logger.js';

export interface ObservationInput {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  agent_type?: string | null;
  agent_id?: string | null;
}

export interface StoreObservationResult {
  id: number;
  createdAtEpoch: number;
}

export interface GetObservationsByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
  type?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
}

export interface SessionFilesResult {
  filesRead: string[];
  filesModified: string[];
}

export interface ObservationSessionRow {
  title: string;
  subtitle: string;
  type: string;
  prompt_number: number | null;
}

export interface RecentObservationRow {
  type: string;
  text: string;
  prompt_number: number | null;
  created_at: string;
}

export interface AllRecentObservationRow {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string;
  project: string;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}
