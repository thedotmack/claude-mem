/**
 * ChromaSync Service
 *
 * Automatically syncs observations and session summaries to ChromaDB via HTTP.
 * This service provides real-time semantic search capabilities by maintaining
 * a vector database synchronized with SQLite.
 *
 * Uses the chromadb npm package's built-in ChromaClient for HTTP connections.
 * Supports both local server (managed by ChromaServerManager) and remote/cloud
 * servers for future claude-mem pro features.
 *
 * Design: Fail-fast with no fallbacks - if Chroma is unavailable, syncing fails.
 */

import { ChromaClient, Collection } from 'chromadb';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ChromaServerManager } from './ChromaServerManager.js';
import path from 'path';
import os from 'os';

interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null; // JSON
  narrative: string | null;
  concepts: string | null; // JSON
  files_read: string | null; // JSON
  files_modified: string | null; // JSON
  prompt_number: number;
  discovery_tokens: number; // ROI metrics
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
  discovery_tokens: number; // ROI metrics
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

export class ChromaSync {
  private chromaClient: ChromaClient | null = null;
  private collection: Collection | null = null;
  private project: string;
  private collectionName: string;
  private readonly VECTOR_DB_DIR: string;
  private readonly BATCH_SIZE = 100;
  private modelCacheCorruptionRetried = false;

  constructor(project: string) {
    this.project = project;
    // Chroma collection names only allow [a-zA-Z0-9._-], 3-512 chars,
    // must start/end with [a-zA-Z0-9]
    const sanitized = project
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/[^a-zA-Z0-9]+$/, '');  // strip trailing non-alphanumeric
    this.collectionName = `cm__${sanitized || 'unknown'}`;
    this.VECTOR_DB_DIR = path.join(os.homedir(), '.claude-mem', 'vector-db');
  }

  /**
   * Ensure HTTP client is connected to Chroma server
   * In local mode, verifies ChromaServerManager has started the server
   * In remote mode, connects directly to configured host
   * Throws error if connection fails
   */
  private async ensureConnection(): Promise<void> {
    if (this.chromaClient) {
      return;
    }

    logger.info('CHROMA_SYNC', 'Connecting to Chroma HTTP server...', { project: this.project });

    try {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const mode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
      const host = settings.CLAUDE_MEM_CHROMA_HOST || '127.0.0.1';
      const port = parseInt(settings.CLAUDE_MEM_CHROMA_PORT || '8000', 10);
      const ssl = settings.CLAUDE_MEM_CHROMA_SSL === 'true';

      // Multi-tenancy settings (used in remote/pro mode)
      const tenant = settings.CLAUDE_MEM_CHROMA_TENANT || 'default_tenant';
      const database = settings.CLAUDE_MEM_CHROMA_DATABASE || 'default_database';
      const apiKey = settings.CLAUDE_MEM_CHROMA_API_KEY || '';

      // In local mode, verify server is reachable
      if (mode === 'local') {
        const serverManager = ChromaServerManager.getInstance();
        const reachable = await serverManager.isServerReachable();
        if (!reachable) {
          throw new Error('Chroma server not reachable. Ensure worker started correctly.');
        }
      }

      // Create HTTP client
      const protocol = ssl ? 'https' : 'http';
      const chromaPath = `${protocol}://${host}:${port}`;

      // Build client options
      const clientOptions: { path: string; tenant?: string; database?: string; headers?: Record<string, string> } = {
        path: chromaPath
      };

      // In remote mode, use tenant isolation for pro users
      if (mode === 'remote') {
        clientOptions.tenant = tenant;
        clientOptions.database = database;

        // Add API key header if configured
        if (apiKey) {
          clientOptions.headers = {
            'Authorization': `Bearer ${apiKey}`
          };
        }

        logger.info('CHROMA_SYNC', 'Connecting with tenant isolation', {
          tenant,
          database,
          hasApiKey: !!apiKey
        });
      }

      this.chromaClient = new ChromaClient(clientOptions);

      // Verify connection with heartbeat
      await this.chromaClient.heartbeat();

      logger.info('CHROMA_SYNC', 'Connected to Chroma HTTP server', {
        project: this.project,
        host,
        port,
        ssl,
        mode,
        tenant: mode === 'remote' ? tenant : 'default_tenant'
      });
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Failed to connect to Chroma HTTP server', { project: this.project }, error as Error);
      this.chromaClient = null;
      throw new Error(`Chroma connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure collection exists, create if needed
   * Throws error if collection creation fails
   */
  private async ensureCollection(): Promise<void> {
    await this.ensureConnection();

    if (this.collection) {
      return;
    }

    if (!this.chromaClient) {
      throw new Error(
        'Chroma client not initialized. Call ensureConnection() before using client methods.' +
        ` Project: ${this.project}`
      );
    }

    try {
      // Store model cache outside node_modules so reinstalls don't corrupt it
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = path.join(os.homedir(), '.claude-mem', 'models');

      // Use WASM backend to avoid native ONNX binary issues (#1104, #1105, #1110).
      // Same model (all-MiniLM-L6-v2), same embeddings, but runs in WASM —
      // no native binary loading, no segfaults, no ENOENT errors.
      const { DefaultEmbeddingFunction } = await import('@chroma-core/default-embed');
      const embeddingFunction = new DefaultEmbeddingFunction({ wasm: true });

      this.collection = await this.chromaClient.getOrCreateCollection({
        name: this.collectionName,
        embeddingFunction
      });

      logger.debug('CHROMA_SYNC', 'Collection ready', {
        collection: this.collectionName
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Self-heal: corrupted model cache → clear and retry once
      if (errorMessage.includes('Protobuf parsing failed') && !this.modelCacheCorruptionRetried) {
        this.modelCacheCorruptionRetried = true;
        logger.warn('CHROMA_SYNC', 'Corrupted model cache detected, clearing and retrying...');
        const modelCacheDir = path.join(os.homedir(), '.claude-mem', 'models');
        const fs = await import('fs');
        if (fs.existsSync(modelCacheDir)) {
          fs.rmSync(modelCacheDir, { recursive: true, force: true });
        }
        return this.ensureCollection(); // retry once
      }

      logger.error('CHROMA_SYNC', 'Failed to get/create collection', { collection: this.collectionName }, error as Error);
      throw new Error(`Collection setup failed: ${errorMessage}`);
    }
  }

  /**
   * Format observation into Chroma documents (granular approach)
   * Each semantic field becomes a separate vector document
   */
  private formatObservationDocs(obs: StoredObservation): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    // Parse JSON fields
    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const files_read = obs.files_read ? JSON.parse(obs.files_read) : [];
    const files_modified = obs.files_modified ? JSON.parse(obs.files_modified) : [];

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

    // Add optional metadata fields
    if (obs.subtitle) {
      baseMetadata.subtitle = obs.subtitle;
    }
    if (concepts.length > 0) {
      baseMetadata.concepts = concepts.join(',');
    }
    if (files_read.length > 0) {
      baseMetadata.files_read = files_read.join(',');
    }
    if (files_modified.length > 0) {
      baseMetadata.files_modified = files_modified.join(',');
    }

    // Narrative as separate document
    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    // Text as separate document (legacy field)
    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    // Each fact as separate document
    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    return documents;
  }

  /**
   * Format summary into Chroma documents (granular approach)
   * Each summary field becomes a separate vector document
   */
  private formatSummaryDocs(summary: StoredSummary): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    // Each field becomes a separate document
    if (summary.request) {
      documents.push({
        id: `summary_${summary.id}_request`,
        document: summary.request,
        metadata: { ...baseMetadata, field_type: 'request' }
      });
    }

    if (summary.investigated) {
      documents.push({
        id: `summary_${summary.id}_investigated`,
        document: summary.investigated,
        metadata: { ...baseMetadata, field_type: 'investigated' }
      });
    }

    if (summary.learned) {
      documents.push({
        id: `summary_${summary.id}_learned`,
        document: summary.learned,
        metadata: { ...baseMetadata, field_type: 'learned' }
      });
    }

    if (summary.completed) {
      documents.push({
        id: `summary_${summary.id}_completed`,
        document: summary.completed,
        metadata: { ...baseMetadata, field_type: 'completed' }
      });
    }

    if (summary.next_steps) {
      documents.push({
        id: `summary_${summary.id}_next_steps`,
        document: summary.next_steps,
        metadata: { ...baseMetadata, field_type: 'next_steps' }
      });
    }

    if (summary.notes) {
      documents.push({
        id: `summary_${summary.id}_notes`,
        document: summary.notes,
        metadata: { ...baseMetadata, field_type: 'notes' }
      });
    }

    return documents;
  }

  /**
   * Add documents to Chroma in batch
   * Throws error if batch add fails
   */
  private async addDocuments(documents: ChromaDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    await this.ensureCollection();

    if (!this.collection) {
      throw new Error(
        'Chroma collection not initialized. Call ensureCollection() before using collection methods.' +
        ` Project: ${this.project}`
      );
    }

    try {
      await this.collection.add({
        ids: documents.map(d => d.id),
        documents: documents.map(d => d.document),
        metadatas: documents.map(d => d.metadata)
      });

      logger.debug('CHROMA_SYNC', 'Documents added', {
        collection: this.collectionName,
        count: documents.length
      });
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Failed to add documents', {
        collection: this.collectionName,
        count: documents.length
      }, error as Error);
      throw new Error(`Document add failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sync a single observation to Chroma
   * Blocks until sync completes, throws on error
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
    // Convert ParsedObservation to StoredObservation format
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project: project,
      text: null, // Legacy field, not used
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatObservationDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing observation', {
      observationId,
      documentCount: documents.length,
      project
    });

    await this.addDocuments(documents);
  }

  /**
   * Sync a single summary to Chroma
   * Blocks until sync completes, throws on error
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
    // Convert ParsedSummary to StoredSummary format
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project: project,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatSummaryDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing summary', {
      summaryId,
      documentCount: documents.length,
      project
    });

    await this.addDocuments(documents);
  }

  /**
   * Format user prompt into Chroma document
   * Each prompt becomes a single document (unlike observations/summaries which split by field)
   */
  private formatUserPromptDoc(prompt: StoredUserPrompt): ChromaDocument {
    return {
      id: `prompt_${prompt.id}`,
      document: prompt.prompt_text,
      metadata: {
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        memory_session_id: prompt.memory_session_id,
        project: prompt.project,
        created_at_epoch: prompt.created_at_epoch,
        prompt_number: prompt.prompt_number
      }
    };
  }

  /**
   * Sync a single user prompt to Chroma
   * Blocks until sync completes, throws on error
   */
  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
    // Create StoredUserPrompt format
    const stored: StoredUserPrompt = {
      id: promptId,
      content_session_id: '', // Not needed for Chroma sync
      prompt_number: promptNumber,
      prompt_text: promptText,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch,
      memory_session_id: memorySessionId,
      project: project
    };

    const document = this.formatUserPromptDoc(stored);

    logger.info('CHROMA_SYNC', 'Syncing user prompt', {
      promptId,
      project
    });

    await this.addDocuments([document]);
  }

  /**
   * Fetch all existing document IDs from Chroma collection
   * Returns Sets of SQLite IDs for observations, summaries, and prompts
   */
  private async getExistingChromaIds(projectOverride?: string): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
  }> {
    const targetProject = projectOverride ?? this.project;
    await this.ensureCollection();

    if (!this.collection) {
      throw new Error(
        'Chroma collection not initialized. Call ensureCollection() before using collection methods.' +
        ` Project: ${targetProject}`
      );
    }

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000; // Large batches, metadata only = fast

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { project: targetProject });

    while (true) {
      try {
        const result = await this.collection.get({
          limit,
          offset,
          where: { project: targetProject },
          include: ['metadatas']
        });

        const metadatas = result.metadatas || [];

        if (metadatas.length === 0) {
          break; // No more documents
        }

        // Extract SQLite IDs from metadata
        for (const meta of metadatas) {
          if (meta && meta.sqlite_id) {
            const sqliteId = meta.sqlite_id as number;
            if (meta.doc_type === 'observation') {
              observationIds.add(sqliteId);
            } else if (meta.doc_type === 'session_summary') {
              summaryIds.add(sqliteId);
            } else if (meta.doc_type === 'user_prompt') {
              promptIds.add(sqliteId);
            }
          }
        }

        offset += limit;

        logger.debug('CHROMA_SYNC', 'Fetched batch of existing IDs', {
          project: targetProject,
          offset,
          batchSize: metadatas.length
        });
      } catch (error) {
        logger.error('CHROMA_SYNC', 'Failed to fetch existing IDs', { project: targetProject }, error as Error);
        throw error;
      }
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      project: targetProject,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  /**
   * Backfill: Sync all observations missing from Chroma
   * Reads from SQLite and syncs in batches
   * @param projectOverride - If provided, backfill this project instead of this.project.
   *   Used by backfillAllProjects() to iterate projects without mutating instance state.
   * Throws error if backfill fails
   */
  async ensureBackfilled(projectOverride?: string): Promise<void> {
    const backfillProject = projectOverride ?? this.project;
    logger.info('CHROMA_SYNC', 'Starting smart backfill', { project: backfillProject });

    await this.ensureCollection();

    // Fetch existing IDs from Chroma (fast, metadata only)
    const existing = await this.getExistingChromaIds(backfillProject);

    const db = new SessionStore();

    try {
      // Build exclusion list for observations
      const existingObsIds = Array.from(existing.observations);
      const obsExclusionClause = existingObsIds.length > 0
        ? `AND id NOT IN (${existingObsIds.join(',')})`
        : '';

      // Get only observations missing from Chroma
      const observations = db.db.prepare(`
        SELECT * FROM observations
        WHERE project = ? ${obsExclusionClause}
        ORDER BY id ASC
      `).all(backfillProject) as StoredObservation[];

      const totalObsCount = db.db.prepare(`
        SELECT COUNT(*) as count FROM observations WHERE project = ?
      `).get(backfillProject) as { count: number };

      logger.info('CHROMA_SYNC', 'Backfilling observations', {
        project: backfillProject,
        missing: observations.length,
        existing: existing.observations.size,
        total: totalObsCount.count
      });

      // Format all observation documents
      const allDocs: ChromaDocument[] = [];
      for (const obs of observations) {
        allDocs.push(...this.formatObservationDocs(obs));
      }

      // Sync in batches
      for (let i = 0; i < allDocs.length; i += this.BATCH_SIZE) {
        const batch = allDocs.slice(i, i + this.BATCH_SIZE);
        await this.addDocuments(batch);

        logger.debug('CHROMA_SYNC', 'Backfill progress', {
          project: backfillProject,
          progress: `${Math.min(i + this.BATCH_SIZE, allDocs.length)}/${allDocs.length}`
        });
      }

      // Build exclusion list for summaries
      const existingSummaryIds = Array.from(existing.summaries);
      const summaryExclusionClause = existingSummaryIds.length > 0
        ? `AND id NOT IN (${existingSummaryIds.join(',')})`
        : '';

      // Get only summaries missing from Chroma
      const summaries = db.db.prepare(`
        SELECT * FROM session_summaries
        WHERE project = ? ${summaryExclusionClause}
        ORDER BY id ASC
      `).all(backfillProject) as StoredSummary[];

      const totalSummaryCount = db.db.prepare(`
        SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
      `).get(backfillProject) as { count: number };

      logger.info('CHROMA_SYNC', 'Backfilling summaries', {
        project: backfillProject,
        missing: summaries.length,
        existing: existing.summaries.size,
        total: totalSummaryCount.count
      });

      // Format all summary documents
      const summaryDocs: ChromaDocument[] = [];
      for (const summary of summaries) {
        summaryDocs.push(...this.formatSummaryDocs(summary));
      }

      // Sync in batches
      for (let i = 0; i < summaryDocs.length; i += this.BATCH_SIZE) {
        const batch = summaryDocs.slice(i, i + this.BATCH_SIZE);
        await this.addDocuments(batch);

        logger.debug('CHROMA_SYNC', 'Backfill progress', {
          project: backfillProject,
          progress: `${Math.min(i + this.BATCH_SIZE, summaryDocs.length)}/${summaryDocs.length}`
        });
      }

      // Build exclusion list for prompts
      const existingPromptIds = Array.from(existing.prompts);
      const promptExclusionClause = existingPromptIds.length > 0
        ? `AND up.id NOT IN (${existingPromptIds.join(',')})`
        : '';

      // Get only user prompts missing from Chroma
      const prompts = db.db.prepare(`
        SELECT
          up.*,
          s.project,
          s.memory_session_id
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        WHERE s.project = ? ${promptExclusionClause}
        ORDER BY up.id ASC
      `).all(backfillProject) as StoredUserPrompt[];

      const totalPromptCount = db.db.prepare(`
        SELECT COUNT(*) as count
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        WHERE s.project = ?
      `).get(backfillProject) as { count: number };

      logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
        project: backfillProject,
        missing: prompts.length,
        existing: existing.prompts.size,
        total: totalPromptCount.count
      });

      // Format all prompt documents
      const promptDocs: ChromaDocument[] = [];
      for (const prompt of prompts) {
        promptDocs.push(this.formatUserPromptDoc(prompt));
      }

      // Sync in batches
      for (let i = 0; i < promptDocs.length; i += this.BATCH_SIZE) {
        const batch = promptDocs.slice(i, i + this.BATCH_SIZE);
        await this.addDocuments(batch);

        logger.debug('CHROMA_SYNC', 'Backfill progress', {
          project: backfillProject,
          progress: `${Math.min(i + this.BATCH_SIZE, promptDocs.length)}/${promptDocs.length}`
        });
      }

      logger.info('CHROMA_SYNC', 'Smart backfill complete', {
        project: backfillProject,
        synced: {
          observationDocs: allDocs.length,
          summaryDocs: summaryDocs.length,
          promptDocs: promptDocs.length
        },
        skipped: {
          observations: existing.observations.size,
          summaries: existing.summaries.size,
          prompts: existing.prompts.size
        }
      });

    } catch (error) {
      logger.error('CHROMA_SYNC', 'Backfill failed', { project: backfillProject }, error as Error);
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
  }

  /**
   * Query Chroma collection for semantic search
   * Used by SearchManager for vector-based search
   */
  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    await this.ensureCollection();

    if (!this.collection) {
      throw new Error(
        'Chroma collection not initialized. Call ensureCollection() before using collection methods.' +
        ` Project: ${this.project}`
      );
    }

    try {
      const results = await this.collection.query({
        queryTexts: [query],
        nResults: limit,
        where: whereFilter,
        include: ['documents', 'metadatas', 'distances']
      });

      // Extract unique SQLite IDs from document IDs
      const ids: number[] = [];
      const docIds = results.ids?.[0] || [];
      for (const docId of docIds) {
        // Extract sqlite_id from document ID (supports three formats):
        // - obs_{id}_narrative, obs_{id}_fact_0, etc (observations)
        // - summary_{id}_request, summary_{id}_learned, etc (session summaries)
        // - prompt_{id} (user prompts)
        const obsMatch = docId.match(/obs_(\d+)_/);
        const summaryMatch = docId.match(/summary_(\d+)_/);
        const promptMatch = docId.match(/prompt_(\d+)/);

        let sqliteId: number | null = null;
        if (obsMatch) {
          sqliteId = parseInt(obsMatch[1], 10);
        } else if (summaryMatch) {
          sqliteId = parseInt(summaryMatch[1], 10);
        } else if (promptMatch) {
          sqliteId = parseInt(promptMatch[1], 10);
        }

        if (sqliteId !== null && !ids.includes(sqliteId)) {
          ids.push(sqliteId);
        }
      }

      return {
        ids,
        distances: results.distances?.[0] || [],
        metadatas: results.metadatas?.[0] || []
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check for connection errors
      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('fetch failed');

      if (isConnectionError) {
        // Reset connection state so next call attempts reconnect
        this.chromaClient = null;
        this.collection = null;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }

      logger.error('CHROMA_SYNC', 'Query failed', { project: this.project, query }, error as Error);
      throw error;
    }
  }

  /**
   * Backfill all projects that have observations in SQLite but may be missing from Chroma.
   * Uses a single shared ChromaSync('claude-mem') instance and Chroma connection.
   * Per-project scoping is passed as a parameter to ensureBackfilled(), avoiding
   * instance state mutation. All documents land in the cm__claude-mem collection
   * with project scoped via metadata, matching how DatabaseManager and SearchManager operate.
   * Designed to be called fire-and-forget on worker startup.
   */
  static async backfillAllProjects(): Promise<void> {
    const db = new SessionStore();
    const sync = new ChromaSync('claude-mem');
    try {
      const projects = db.db.prepare(
        'SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ?'
      ).all('') as { project: string }[];

      logger.info('CHROMA_SYNC', `Backfill check for ${projects.length} projects`);

      for (const { project } of projects) {
        try {
          await sync.ensureBackfilled(project);
        } catch (error) {
          logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, {}, error as Error);
          // Continue to next project — don't let one failure stop others
        }
      }
    } finally {
      await sync.close();
      db.close();
    }
  }

  /**
   * Close the Chroma client connection
   * Server lifecycle is managed by ChromaServerManager, not here
   */
  async close(): Promise<void> {
    // Just clear references - server lifecycle managed by ChromaServerManager
    this.chromaClient = null;
    this.collection = null;
    logger.info('CHROMA_SYNC', 'Chroma client closed', { project: this.project });
  }
}
