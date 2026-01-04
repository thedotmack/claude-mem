/**
 * Type definitions for observation operations
 * Extracted from SessionStore.ts for modular organization
 */
import { logger } from '../../../utils/logger.js';

/**
 * Input type for storeObservation function
 */
export interface ObservationInput {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

/**
 * Result from storing an observation
 */
export interface StoreObservationResult {
  id: number;
  createdAtEpoch: number;
}

/**
 * Options for getObservationsByIds
 */
export interface GetObservationsByIdsOptions {
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
  type?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
}

/**
 * Result type for getFilesForSession
 */
export interface SessionFilesResult {
  filesRead: string[];
  filesModified: string[];
}

/**
 * Simple observation row for getObservationsForSession
 */
export interface ObservationSessionRow {
  title: string;
  subtitle: string;
  type: string;
  prompt_number: number | null;
}

/**
 * Recent observation row type
 */
export interface RecentObservationRow {
  type: string;
  text: string;
  prompt_number: number | null;
  created_at: string;
}

/**
 * Full recent observation row (for web UI)
 */
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
