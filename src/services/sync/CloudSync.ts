/**
 * CloudSync Service
 *
 * Syncs observations, summaries, and prompts to Claude-Mem Pro cloud infrastructure.
 * Uses Supabase for relational data and Pinecone for vector search via mem-pro API.
 *
 * Requires:
 * - CLAUDE_MEM_PRO_API_URL: Base URL of mem-pro API
 * - CLAUDE_MEM_PRO_SETUP_TOKEN: Setup token from /pro-setup skill
 */

import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { SyncProvider, SyncStats, QueryResult, StoreResult, BatchStoreResult } from './SyncProvider.js';
import type {
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../sqlite/types.js';

interface CloudSyncConfig {
  apiUrl: string;
  setupToken: string;
  userId: string;
  project: string;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface StoredUserPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
  memory_session_id: string;
  project: string;
}

/**
 * Safely parse JSON, returning empty array on failure
 * Handles corrupted data from older versions
 */
function safeJsonParse(str: string | null | undefined): any[] {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Log but don't fail - some older data may have plain text instead of JSON
    return [];
  }
}

export class CloudSync implements SyncProvider {
  private readonly config: CloudSyncConfig;
  private readonly BATCH_SIZE = 50;

  constructor(config: CloudSyncConfig) {
    this.config = config;
    logger.info('CLOUD_SYNC', 'Initialized CloudSync for Pro user', {
      project: config.project,
      apiUrl: config.apiUrl,
      userId: config.userId.substring(0, 8) + '...'
    });
  }

  /**
   * Cloud sync is always enabled (not Windows-dependent like Chroma)
   */
  isDisabled(): boolean {
    return false;
  }

  /**
   * CloudSync IS cloud-primary - data is stored directly in Supabase/Pinecone
   * Pro users store data directly in cloud, not SQLite
   */
  isCloudPrimary(): boolean {
    return true;
  }

  /**
   * Make authenticated request to mem-pro API
   */
  private async apiRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: any
  ): Promise<T> {
    const url = `${this.config.apiUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.setupToken}`,
      'X-User-Id': this.config.userId,
      'Content-Type': 'application/json'
    };

    const options: RequestInit = {
      method,
      headers
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Sync a single observation to cloud
   */
  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    logger.info('CLOUD_SYNC', 'Syncing observation to cloud', {
      observationId,
      project,
      type: obs.type
    });

    try {
      await this.apiRequest('/api/pro/sync/observation', 'POST', {
        localId: observationId,
        memorySessionId,
        project,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        facts: obs.facts,
        narrative: obs.narrative,
        concepts: obs.concepts,
        filesRead: obs.files_read,
        filesModified: obs.files_modified,
        promptNumber,
        createdAtEpoch,
        discoveryTokens
      });

      logger.debug('CLOUD_SYNC', 'Observation synced successfully', { observationId });
    } catch (error) {
      // Log error but don't throw - data is already saved locally in SQLite
      // Cloud sync failures shouldn't break the hook flow
      logger.error('CLOUD_SYNC', 'Failed to sync observation to cloud (data saved locally)', { observationId }, error as Error);
    }
  }

  /**
   * Sync a single summary to cloud
   */
  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    logger.info('CLOUD_SYNC', 'Syncing summary to cloud', {
      summaryId,
      project
    });

    try {
      await this.apiRequest('/api/pro/sync/summary', 'POST', {
        localId: summaryId,
        memorySessionId,
        project,
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        nextSteps: summary.next_steps,
        notes: summary.notes,
        promptNumber,
        createdAtEpoch,
        discoveryTokens
      });

      logger.debug('CLOUD_SYNC', 'Summary synced successfully', { summaryId });
    } catch (error) {
      // Log error but don't throw - data is already saved locally in SQLite
      logger.error('CLOUD_SYNC', 'Failed to sync summary to cloud (data saved locally)', { summaryId }, error as Error);
    }
  }

  /**
   * Sync a single user prompt to cloud
   */
  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
    logger.info('CLOUD_SYNC', 'Syncing user prompt to cloud', {
      promptId,
      project
    });

    try {
      await this.apiRequest('/api/pro/sync/prompt', 'POST', {
        localId: promptId,
        memorySessionId,
        project,
        promptText,
        promptNumber,
        createdAtEpoch
      });

      logger.debug('CLOUD_SYNC', 'User prompt synced successfully', { promptId });
    } catch (error) {
      // Log error but don't throw - data is already saved locally in SQLite
      logger.error('CLOUD_SYNC', 'Failed to sync user prompt to cloud (data saved locally)', { promptId }, error as Error);
    }
  }

  // ============================================
  // CLOUD-PRIMARY STORE METHODS (Pro users store directly in cloud)
  // ============================================

  /**
   * Store observation directly in cloud (cloud-primary mode)
   * Returns the cloud-generated ID - data is NOT stored in SQLite
   */
  async storeObservation(
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    discoveryTokens: number = 0
  ): Promise<StoreResult> {
    logger.info('CLOUD_SYNC', 'Storing observation directly in cloud', {
      project,
      type: obs.type
    });

    const createdAtEpoch = Math.floor(Date.now() / 1000);

    const result = await this.apiRequest<{ id: number; createdAtEpoch: number }>(
      '/api/pro/store/observation',
      'POST',
      {
        memorySessionId,
        project,
        type: obs.type,
        title: obs.title,
        subtitle: obs.subtitle,
        facts: obs.facts,
        narrative: obs.narrative,
        concepts: obs.concepts,
        filesRead: obs.files_read,
        filesModified: obs.files_modified,
        promptNumber,
        discoveryTokens
      }
    );

    logger.debug('CLOUD_SYNC', 'Observation stored in cloud', {
      id: result.id,
      project
    });

    return {
      id: result.id,
      createdAtEpoch: result.createdAtEpoch || createdAtEpoch
    };
  }

  /**
   * Store summary directly in cloud (cloud-primary mode)
   * Returns the cloud-generated ID - data is NOT stored in SQLite
   */
  async storeSummary(
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    discoveryTokens: number = 0
  ): Promise<StoreResult> {
    logger.info('CLOUD_SYNC', 'Storing summary directly in cloud', {
      project
    });

    const createdAtEpoch = Math.floor(Date.now() / 1000);

    const result = await this.apiRequest<{ id: number; createdAtEpoch: number }>(
      '/api/pro/store/summary',
      'POST',
      {
        memorySessionId,
        project,
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        nextSteps: summary.next_steps,
        notes: summary.notes,
        promptNumber,
        discoveryTokens
      }
    );

    logger.debug('CLOUD_SYNC', 'Summary stored in cloud', {
      id: result.id,
      project
    });

    return {
      id: result.id,
      createdAtEpoch: result.createdAtEpoch || createdAtEpoch
    };
  }

  /**
   * Store user prompt directly in cloud (cloud-primary mode)
   * Returns the cloud-generated ID - data is NOT stored in SQLite
   */
  async storeUserPrompt(
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number
  ): Promise<StoreResult> {
    logger.info('CLOUD_SYNC', 'Storing user prompt directly in cloud', {
      project,
      promptNumber
    });

    const createdAtEpoch = Math.floor(Date.now() / 1000);

    const result = await this.apiRequest<{ id: number; createdAtEpoch: number }>(
      '/api/pro/store/prompt',
      'POST',
      {
        memorySessionId,
        project,
        promptText,
        promptNumber
      }
    );

    logger.debug('CLOUD_SYNC', 'User prompt stored in cloud', {
      id: result.id,
      project
    });

    return {
      id: result.id,
      createdAtEpoch: result.createdAtEpoch || createdAtEpoch
    };
  }

  /**
   * Store observations + optional summary atomically (cloud-primary mode)
   * This is the main entry point for ResponseProcessor in Pro mode
   * Mirrors SessionStore.storeObservations() for API consistency
   */
  async storeObservationsAndSummary(
    memorySessionId: string,
    project: string,
    observations: ParsedObservation[],
    summary: ParsedSummary | null,
    promptNumber: number,
    discoveryTokens: number = 0,
    originalTimestamp?: number
  ): Promise<BatchStoreResult> {
    logger.info('CLOUD_SYNC', 'Storing observations batch directly in cloud', {
      project,
      obsCount: observations.length,
      hasSummary: !!summary
    });

    const createdAtEpoch = originalTimestamp || Math.floor(Date.now() / 1000);

    const result = await this.apiRequest<{
      observationIds: number[];
      summaryId: number | null;
      createdAtEpoch: number;
    }>(
      '/api/pro/store/batch',
      'POST',
      {
        memorySessionId,
        project,
        observations: observations.map(obs => ({
          type: obs.type,
          title: obs.title,
          subtitle: obs.subtitle,
          facts: obs.facts,
          narrative: obs.narrative,
          concepts: obs.concepts,
          filesRead: obs.files_read,
          filesModified: obs.files_modified
        })),
        summary: summary ? {
          request: summary.request,
          investigated: summary.investigated,
          learned: summary.learned,
          completed: summary.completed,
          nextSteps: summary.next_steps,
          notes: summary.notes
        } : null,
        promptNumber,
        discoveryTokens,
        createdAtEpoch
      }
    );

    logger.debug('CLOUD_SYNC', 'Batch stored in cloud', {
      observationIds: result.observationIds,
      summaryId: result.summaryId,
      project
    });

    return {
      observationIds: result.observationIds,
      summaryId: result.summaryId,
      createdAtEpoch: result.createdAtEpoch || createdAtEpoch
    };
  }

  // ============================================
  // FETCH METHODS (for hydrating vector search results)
  // ============================================

  /**
   * Fetch observations by IDs from Supabase
   * Used for hydrating vector search results in Pro mode
   */
  async getObservationsByIds(
    ids: number[],
    options?: { type?: string | string[]; concepts?: string | string[]; files?: string | string[]; orderBy?: string; limit?: number; project?: string }
  ): Promise<ObservationSearchResult[]> {
    if (ids.length === 0) return [];

    logger.debug('CLOUD_SYNC', 'Fetching observations by IDs from cloud', {
      count: ids.length,
      project: this.config.project
    });

    const result = await this.apiRequest<{ observations: ObservationSearchResult[] }>(
      '/api/pro/fetch/observations',
      'POST',
      {
        ids,
        options,
        project: this.config.project
      }
    );

    return result.observations || [];
  }

  /**
   * Fetch session summaries by IDs from Supabase
   * Used for hydrating vector search results in Pro mode
   */
  async getSessionSummariesByIds(
    ids: number[],
    options?: { orderBy?: string; limit?: number; project?: string }
  ): Promise<SessionSummarySearchResult[]> {
    if (ids.length === 0) return [];

    logger.debug('CLOUD_SYNC', 'Fetching summaries by IDs from cloud', {
      count: ids.length,
      project: this.config.project
    });

    const result = await this.apiRequest<{ summaries: SessionSummarySearchResult[] }>(
      '/api/pro/fetch/summaries',
      'POST',
      {
        ids,
        options,
        project: this.config.project
      }
    );

    return result.summaries || [];
  }

  /**
   * Fetch user prompts by IDs from Supabase
   * Used for hydrating vector search results in Pro mode
   */
  async getUserPromptsByIds(
    ids: number[],
    options?: { orderBy?: string; limit?: number; project?: string }
  ): Promise<UserPromptSearchResult[]> {
    if (ids.length === 0) return [];

    logger.debug('CLOUD_SYNC', 'Fetching prompts by IDs from cloud', {
      count: ids.length,
      project: this.config.project
    });

    const result = await this.apiRequest<{ prompts: UserPromptSearchResult[] }>(
      '/api/pro/fetch/prompts',
      'POST',
      {
        ids,
        options,
        project: this.config.project
      }
    );

    return result.prompts || [];
  }

  /**
   * Backfill: Sync ALL local data to cloud (all projects)
   * Uses batch endpoints for efficiency
   *
   * This migrates ALL data from the local SQLite database, regardless of project.
   * Used during initial Pro setup to migrate existing data.
   */
  async ensureBackfilled(): Promise<void> {
    logger.info('CLOUD_SYNC', 'Starting full cloud backfill (all projects)');

    const db = new SessionStore();

    try {
      // Get all unique projects from local database
      const projectRows = db.db.prepare(`
        SELECT DISTINCT project FROM observations
        UNION
        SELECT DISTINCT project FROM session_summaries
      `).all() as { project: string }[];

      const allProjects = projectRows.map(r => r.project);
      logger.info('CLOUD_SYNC', 'Found projects to migrate', { projects: allProjects });

      let totalObservations = 0;
      let totalSummaries = 0;
      let totalPrompts = 0;

      // Migrate each project
      for (const project of allProjects) {
        logger.info('CLOUD_SYNC', 'Migrating project', { project });

        // Get cloud sync status for this project
        let existingObsIds = new Set<number>();
        let existingSummaryIds = new Set<number>();
        let existingPromptIds = new Set<number>();

        try {
          const syncStatus = await this.apiRequest<{
            observations: number[];
            summaries: number[];
            prompts: number[];
          }>(`/api/pro/sync/status?project=${encodeURIComponent(project)}`);

          existingObsIds = new Set(syncStatus.observations || []);
          existingSummaryIds = new Set(syncStatus.summaries || []);
          existingPromptIds = new Set(syncStatus.prompts || []);
        } catch (statusError) {
          // If status endpoint fails, assume nothing synced yet
          logger.warn('CLOUD_SYNC', 'Failed to get sync status, assuming empty', { project });
        }

        // Get missing observations for this project using parameterized query
        const safeObsIds = Array.from(existingObsIds).filter(id => Number.isInteger(id));
        let observations: StoredObservation[];
        if (safeObsIds.length > 0) {
          const obsPlaceholders = safeObsIds.map(() => '?').join(',');
          observations = db.db.prepare(`
            SELECT * FROM observations
            WHERE project = ? AND id NOT IN (${obsPlaceholders})
            ORDER BY id ASC
          `).all(project, ...safeObsIds) as StoredObservation[];
        } else {
          observations = db.db.prepare(`
            SELECT * FROM observations
            WHERE project = ?
            ORDER BY id ASC
          `).all(project) as StoredObservation[];
        }

        if (observations.length > 0) {
          logger.info('CLOUD_SYNC', 'Backfilling observations', {
            project,
            missing: observations.length,
            existing: existingObsIds.size
          });

          // Batch sync observations
          for (let i = 0; i < observations.length; i += this.BATCH_SIZE) {
            const batch = observations.slice(i, i + this.BATCH_SIZE);
            await this.apiRequest('/api/pro/sync/observations/batch', 'POST', {
              observations: batch.map(obs => ({
                localId: obs.id,
                memorySessionId: obs.memory_session_id,
                project: obs.project,
                type: obs.type,
                title: obs.title,
                subtitle: obs.subtitle,
                facts: safeJsonParse(obs.facts),
                narrative: obs.narrative,
                concepts: safeJsonParse(obs.concepts),
                filesRead: safeJsonParse(obs.files_read),
                filesModified: safeJsonParse(obs.files_modified),
                promptNumber: obs.prompt_number,
                createdAtEpoch: obs.created_at_epoch,
                discoveryTokens: obs.discovery_tokens
              }))
            });

            logger.debug('CLOUD_SYNC', 'Observation batch synced', {
              project,
              progress: `${Math.min(i + this.BATCH_SIZE, observations.length)}/${observations.length}`
            });
          }

          totalObservations += observations.length;
        }

        // Get missing summaries for this project using parameterized query
        const safeSummaryIds = Array.from(existingSummaryIds).filter(id => Number.isInteger(id));
        let summaries: StoredSummary[];
        if (safeSummaryIds.length > 0) {
          const summaryPlaceholders = safeSummaryIds.map(() => '?').join(',');
          summaries = db.db.prepare(`
            SELECT * FROM session_summaries
            WHERE project = ? AND id NOT IN (${summaryPlaceholders})
            ORDER BY id ASC
          `).all(project, ...safeSummaryIds) as StoredSummary[];
        } else {
          summaries = db.db.prepare(`
            SELECT * FROM session_summaries
            WHERE project = ?
            ORDER BY id ASC
          `).all(project) as StoredSummary[];
        }

        if (summaries.length > 0) {
          logger.info('CLOUD_SYNC', 'Backfilling summaries', {
            project,
            missing: summaries.length,
            existing: existingSummaryIds.size
          });

          // Batch sync summaries
          for (let i = 0; i < summaries.length; i += this.BATCH_SIZE) {
            const batch = summaries.slice(i, i + this.BATCH_SIZE);
            await this.apiRequest('/api/pro/sync/summaries/batch', 'POST', {
              summaries: batch.map(summary => ({
                localId: summary.id,
                memorySessionId: summary.memory_session_id,
                project: summary.project,
                request: summary.request,
                investigated: summary.investigated,
                learned: summary.learned,
                completed: summary.completed,
                nextSteps: summary.next_steps,
                notes: summary.notes,
                promptNumber: summary.prompt_number,
                createdAtEpoch: summary.created_at_epoch,
                discoveryTokens: summary.discovery_tokens
              }))
            });

            logger.debug('CLOUD_SYNC', 'Summary batch synced', {
              project,
              progress: `${Math.min(i + this.BATCH_SIZE, summaries.length)}/${summaries.length}`
            });
          }

          totalSummaries += summaries.length;
        }

        // Get missing prompts for this project using parameterized query
        const safePromptIds = Array.from(existingPromptIds).filter(id => Number.isInteger(id));
        let prompts: StoredUserPrompt[];
        if (safePromptIds.length > 0) {
          const promptPlaceholders = safePromptIds.map(() => '?').join(',');
          prompts = db.db.prepare(`
            SELECT
              up.*,
              s.project,
              s.memory_session_id
            FROM user_prompts up
            JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
            WHERE s.project = ? AND up.id NOT IN (${promptPlaceholders})
            ORDER BY up.id ASC
          `).all(project, ...safePromptIds) as StoredUserPrompt[];
        } else {
          prompts = db.db.prepare(`
            SELECT
              up.*,
              s.project,
              s.memory_session_id
            FROM user_prompts up
            JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
            WHERE s.project = ?
            ORDER BY up.id ASC
          `).all(project) as StoredUserPrompt[];
        }

        if (prompts.length > 0) {
          logger.info('CLOUD_SYNC', 'Backfilling prompts', {
            project,
            missing: prompts.length,
            existing: existingPromptIds.size
          });

          // Batch sync prompts
          for (let i = 0; i < prompts.length; i += this.BATCH_SIZE) {
            const batch = prompts.slice(i, i + this.BATCH_SIZE);
            await this.apiRequest('/api/pro/sync/prompts/batch', 'POST', {
              prompts: batch.map(prompt => ({
                localId: prompt.id,
                contentSessionId: prompt.content_session_id,
                memorySessionId: prompt.memory_session_id,
                project: prompt.project,
                promptText: prompt.prompt_text,
                promptNumber: prompt.prompt_number,
                createdAtEpoch: prompt.created_at_epoch
              }))
            });

            logger.debug('CLOUD_SYNC', 'Prompt batch synced', {
              project,
              progress: `${Math.min(i + this.BATCH_SIZE, prompts.length)}/${prompts.length}`
            });
          }

          totalPrompts += prompts.length;
        }

        logger.info('CLOUD_SYNC', 'Project migration complete', { project });
      }

      logger.info('CLOUD_SYNC', 'Full cloud backfill complete', {
        projects: allProjects.length,
        synced: {
          observations: totalObservations,
          summaries: totalSummaries,
          prompts: totalPrompts
        }
      });

    } catch (error) {
      // Log error but don't throw - backfill can be retried later
      logger.error('CLOUD_SYNC', 'Cloud backfill failed (will retry on next sync)', {}, error as Error);
      throw error; // Re-throw so caller knows migration failed
    } finally {
      db.close();
    }
  }

  /**
   * Query cloud vectors for semantic search
   */
  async query(
    queryText: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<QueryResult> {
    logger.debug('CLOUD_SYNC', 'Querying cloud vectors', {
      project: this.config.project,
      queryLength: queryText.length,
      limit
    });

    try {
      const result = await this.apiRequest<QueryResult>('/api/pro/sync/query', 'POST', {
        query: queryText,
        limit,
        project: this.config.project,
        filter: whereFilter
      });

      logger.debug('CLOUD_SYNC', 'Query returned results', {
        project: this.config.project,
        count: result.ids.length
      });

      return result;
    } catch (error) {
      logger.error('CLOUD_SYNC', 'Cloud query failed', { project: this.config.project }, error as Error);
      // Return empty results on error rather than throwing
      return { ids: [], distances: [], metadatas: [] };
    }
  }

  /**
   * Get cloud sync stats
   */
  async getStats(): Promise<SyncStats> {
    try {
      const stats = await this.apiRequest<SyncStats>(
        `/api/pro/sync/stats?project=${encodeURIComponent(this.config.project)}`
      );
      return stats;
    } catch (error) {
      logger.error('CLOUD_SYNC', 'Failed to get stats', { project: this.config.project }, error as Error);
      return { observations: 0, summaries: 0, prompts: 0, vectors: 0 };
    }
  }

  /**
   * Close connection (no-op for HTTP client)
   */
  async close(): Promise<void> {
    logger.info('CLOUD_SYNC', 'CloudSync closed', { project: this.config.project });
  }
}
