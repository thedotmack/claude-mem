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
import { SyncProvider, SyncStats, QueryResult } from './SyncProvider.js';

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
   * Make authenticated request to mem-pro API
   */
  private async apiRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: any
  ): Promise<T> {
    const url = `${this.config.apiUrl}${endpoint}`;

    const headers: HeadersInit = {
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

    return response.json();
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
      logger.error('CLOUD_SYNC', 'Failed to sync observation', { observationId }, error as Error);
      throw error;
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
      logger.error('CLOUD_SYNC', 'Failed to sync summary', { summaryId }, error as Error);
      throw error;
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
      logger.error('CLOUD_SYNC', 'Failed to sync user prompt', { promptId }, error as Error);
      throw error;
    }
  }

  /**
   * Backfill: Sync all local data to cloud
   * Uses batch endpoints for efficiency
   */
  async ensureBackfilled(): Promise<void> {
    logger.info('CLOUD_SYNC', 'Starting cloud backfill', { project: this.config.project });

    const db = new SessionStore();

    try {
      // Get cloud sync status (which IDs are already synced)
      const syncStatus = await this.apiRequest<{
        observations: number[];
        summaries: number[];
        prompts: number[];
      }>(`/api/pro/sync/status?project=${encodeURIComponent(this.config.project)}`);

      const existingObsIds = new Set(syncStatus.observations);
      const existingSummaryIds = new Set(syncStatus.summaries);
      const existingPromptIds = new Set(syncStatus.prompts);

      // Build exclusion list for observations
      const obsExclusionClause = existingObsIds.size > 0
        ? `AND id NOT IN (${Array.from(existingObsIds).join(',')})`
        : '';

      // Get missing observations
      const observations = db.db.prepare(`
        SELECT * FROM observations
        WHERE project = ? ${obsExclusionClause}
        ORDER BY id ASC
      `).all(this.config.project) as StoredObservation[];

      logger.info('CLOUD_SYNC', 'Backfilling observations', {
        project: this.config.project,
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
            facts: obs.facts ? JSON.parse(obs.facts) : [],
            narrative: obs.narrative,
            concepts: obs.concepts ? JSON.parse(obs.concepts) : [],
            filesRead: obs.files_read ? JSON.parse(obs.files_read) : [],
            filesModified: obs.files_modified ? JSON.parse(obs.files_modified) : [],
            promptNumber: obs.prompt_number,
            createdAtEpoch: obs.created_at_epoch,
            discoveryTokens: obs.discovery_tokens
          }))
        });

        logger.debug('CLOUD_SYNC', 'Observation batch synced', {
          project: this.config.project,
          progress: `${Math.min(i + this.BATCH_SIZE, observations.length)}/${observations.length}`
        });
      }

      // Build exclusion list for summaries
      const summaryExclusionClause = existingSummaryIds.size > 0
        ? `AND id NOT IN (${Array.from(existingSummaryIds).join(',')})`
        : '';

      // Get missing summaries
      const summaries = db.db.prepare(`
        SELECT * FROM session_summaries
        WHERE project = ? ${summaryExclusionClause}
        ORDER BY id ASC
      `).all(this.config.project) as StoredSummary[];

      logger.info('CLOUD_SYNC', 'Backfilling summaries', {
        project: this.config.project,
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
          project: this.config.project,
          progress: `${Math.min(i + this.BATCH_SIZE, summaries.length)}/${summaries.length}`
        });
      }

      // Build exclusion list for prompts
      const promptExclusionClause = existingPromptIds.size > 0
        ? `AND up.id NOT IN (${Array.from(existingPromptIds).join(',')})`
        : '';

      // Get missing prompts
      const prompts = db.db.prepare(`
        SELECT
          up.*,
          s.project,
          s.memory_session_id
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        WHERE s.project = ? ${promptExclusionClause}
        ORDER BY up.id ASC
      `).all(this.config.project) as StoredUserPrompt[];

      logger.info('CLOUD_SYNC', 'Backfilling prompts', {
        project: this.config.project,
        missing: prompts.length,
        existing: existingPromptIds.size
      });

      // Batch sync prompts
      for (let i = 0; i < prompts.length; i += this.BATCH_SIZE) {
        const batch = prompts.slice(i, i + this.BATCH_SIZE);
        await this.apiRequest('/api/pro/sync/prompts/batch', 'POST', {
          prompts: batch.map(prompt => ({
            localId: prompt.id,
            memorySessionId: prompt.memory_session_id,
            project: prompt.project,
            promptText: prompt.prompt_text,
            promptNumber: prompt.prompt_number,
            createdAtEpoch: prompt.created_at_epoch
          }))
        });

        logger.debug('CLOUD_SYNC', 'Prompt batch synced', {
          project: this.config.project,
          progress: `${Math.min(i + this.BATCH_SIZE, prompts.length)}/${prompts.length}`
        });
      }

      logger.info('CLOUD_SYNC', 'Cloud backfill complete', {
        project: this.config.project,
        synced: {
          observations: observations.length,
          summaries: summaries.length,
          prompts: prompts.length
        }
      });

    } catch (error) {
      logger.error('CLOUD_SYNC', 'Cloud backfill failed', { project: this.config.project }, error as Error);
      throw error;
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
