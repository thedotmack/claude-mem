/**
 * SyncProvider Interface
 *
 * Abstraction layer for vector sync backends.
 * Implementations: ChromaSync (local), CloudSync (Pro)
 */

import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';

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
 * Interface for sync providers (local Chroma or cloud Supabase/Pinecone)
 */
export interface SyncProvider {
  /**
   * Check if sync provider is disabled (e.g., Windows for Chroma)
   */
  isDisabled(): boolean;

  /**
   * Sync a single observation
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
   * Sync a single summary
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
   * Sync a single user prompt
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
