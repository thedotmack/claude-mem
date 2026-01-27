/**
 * SyncProvider Interface
 *
 * Abstraction layer for vector sync backends.
 * Implementations: ChromaSync (local), CloudSync (Pro)
 *
 * Two modes of operation:
 * 1. Sync mode (isCloudPrimary=false): Data stored in SQLite, synced to vector store
 * 2. Cloud-primary mode (isCloudPrimary=true): Data stored directly in cloud (Supabase/Pinecone)
 */

import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../sqlite/types.js';

export interface SyncStats {
  observations: number;
  summaries: number;
  prompts: number;
  vectors: number;
}

export interface QueryResult {
  ids: number[];
  distances: number[];
  metadatas: any[];
}

/**
 * Result of storing data (returns generated ID and epoch)
 */
export interface StoreResult {
  id: number;
  createdAtEpoch: number;
}

/**
 * Result of batch store operation
 */
export interface BatchStoreResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

/**
 * Interface for sync providers (local Chroma or cloud Supabase/Pinecone)
 */
export interface SyncProvider {
  /**
   * Check if sync provider is disabled (e.g., Windows for Chroma)
   */
  isDisabled(): boolean;

  /**
   * Check if this provider is cloud-primary (Pro) vs sync-only (Free)
   * Cloud-primary providers store data directly; sync-only providers backup from SQLite
   */
  isCloudPrimary(): boolean;

  // ============================================
  // SYNC MODE METHODS (Free users - backup to vector store)
  // ============================================

  /**
   * Sync a single observation (sync mode - data already in SQLite)
   */
  syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens?: number
  ): Promise<void>;

  /**
   * Sync a single summary (sync mode - data already in SQLite)
   */
  syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens?: number
  ): Promise<void>;

  /**
   * Sync a single user prompt (sync mode - data already in SQLite)
   */
  syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void>;

  /**
   * Backfill missing data to sync provider
   */
  ensureBackfilled(): Promise<void>;

  // ============================================
  // CLOUD-PRIMARY MODE METHODS (Pro users - store directly)
  // ============================================

  /**
   * Store observation directly (cloud-primary mode)
   * Returns the cloud-generated ID
   */
  storeObservation(
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    discoveryTokens?: number
  ): Promise<StoreResult>;

  /**
   * Store summary directly (cloud-primary mode)
   * Returns the cloud-generated ID
   */
  storeSummary(
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    discoveryTokens?: number
  ): Promise<StoreResult>;

  /**
   * Store user prompt directly (cloud-primary mode)
   * Returns the cloud-generated ID
   */
  storeUserPrompt(
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number
  ): Promise<StoreResult>;

  /**
   * Store observations + optional summary atomically (cloud-primary mode)
   * Mirrors SessionStore.storeObservations() for consistency
   */
  storeObservationsAndSummary(
    memorySessionId: string,
    project: string,
    observations: ParsedObservation[],
    summary: ParsedSummary | null,
    promptNumber: number,
    discoveryTokens?: number,
    originalTimestamp?: number
  ): Promise<BatchStoreResult>;

  // ============================================
  // FETCH METHODS (for hydrating vector search results)
  // ============================================

  /**
   * Fetch observations by IDs (for hydrating vector search results)
   */
  getObservationsByIds(
    ids: number[],
    options?: { type?: string | string[]; concepts?: string | string[]; files?: string | string[]; orderBy?: string; limit?: number; project?: string }
  ): Promise<ObservationSearchResult[]>;

  /**
   * Fetch session summaries by IDs (for hydrating vector search results)
   */
  getSessionSummariesByIds(
    ids: number[],
    options?: { orderBy?: string; limit?: number; project?: string }
  ): Promise<SessionSummarySearchResult[]>;

  /**
   * Fetch user prompts by IDs (for hydrating vector search results)
   */
  getUserPromptsByIds(
    ids: number[],
    options?: { orderBy?: string; limit?: number; project?: string }
  ): Promise<UserPromptSearchResult[]>;

  // ============================================
  // COMMON METHODS
  // ============================================

  /**
   * Query for semantic search
   */
  query(
    queryText: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<QueryResult>;

  /**
   * Get sync stats
   */
  getStats(): Promise<SyncStats>;

  /**
   * Close connection
   */
  close(): Promise<void>;
}
