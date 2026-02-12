/**
 * ChromaSync Service
 *
 * Automatically syncs observations and session summaries to ChromaDB via MCP.
 * This service provides real-time semantic search capabilities by maintaining
 * a vector database synchronized with SQLite.
 *
 * Design: Fail-fast with no fallbacks - if Chroma is unavailable, syncing fails.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

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
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private project: string;
  private collectionName: string;
  private readonly VECTOR_DB_DIR: string;
  private readonly BATCH_SIZE = 100;

  // Windows popup concern resolved: the worker daemon starts with -WindowStyle Hidden,
  // so child processes (uvx/chroma-mcp) inherit the hidden console and don't create new windows.
  // MCP SDK's StdioClientTransport uses shell:false and no detached flag, so console is inherited.
  private readonly disabled: boolean = false;

  constructor(project: string) {
    this.project = project;
    this.collectionName = `cm__${project}`;
    this.VECTOR_DB_DIR = path.join(os.homedir(), '.claude-mem', 'vector-db');
  }

  /**
   * Get or create combined SSL certificate bundle for Zscaler/corporate proxy environments
   * Combines standard certifi certificates with enterprise security certificates (e.g., Zscaler)
   */
  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = path.join(os.homedir(), '.claude-mem', 'combined_certs.pem');

    // If combined certs already exist and are recent (less than 24 hours old), use them
    if (fs.existsSync(combinedCertPath)) {
      const stats = fs.statSync(combinedCertPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return combinedCertPath;
      }
    }

    // Only create on macOS (Zscaler certificate extraction uses macOS security command)
    if (process.platform !== 'darwin') {
      return undefined;
    }

    try {
      // Use uvx to resolve the correct certifi path for the exact Python environment it uses
      // This is more reliable than scanning the uv cache directory structure
      let certifiPath: string | undefined;
      try {
        certifiPath = execSync(
          'uvx --with certifi python -c "import certifi; print(certifi.where())"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        ).trim();
      } catch {
        // uvx or certifi not available
        return undefined;
      }

      if (!certifiPath || !fs.existsSync(certifiPath)) {
        return undefined;
      }

      // Try to extract Zscaler certificate from macOS keychain
      let zscalerCert = '';
      try {
        zscalerCert = execSync(
          'security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
      } catch {
        // Zscaler not found, which is fine - not all environments have it
        return undefined;
      }

      // Validate PEM certificate format (must have both BEGIN and END markers)
      if (!zscalerCert ||
          !zscalerCert.includes('-----BEGIN CERTIFICATE-----') ||
          !zscalerCert.includes('-----END CERTIFICATE-----')) {
        return undefined;
      }

      // Create combined certificate bundle with atomic write (write to temp, then rename)
      const certifiContent = fs.readFileSync(certifiPath, 'utf8');
      const tempPath = combinedCertPath + '.tmp';
      fs.writeFileSync(tempPath, certifiContent + '\n' + zscalerCert);
      fs.renameSync(tempPath, combinedCertPath);
      logger.info('CHROMA_SYNC', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('CHROMA_SYNC', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }

  /**
   * Check if Chroma is disabled (Windows)
   */
  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * Ensure MCP client is connected to Chroma server
   * Throws error if connection fails
   */
  private async ensureConnection(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    logger.info('CHROMA_SYNC', 'Connecting to Chroma MCP server...', { project: this.project });

    try {
      // Use Python 3.13 by default to avoid onnxruntime compatibility issues with Python 3.14+
      // See: https://github.com/thedotmack/claude-mem/issues/170 (Python 3.14 incompatibility)
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const pythonVersion = settings.CLAUDE_MEM_PYTHON_VERSION;

      // Get combined SSL certificate bundle for Zscaler/corporate proxy environments
      const combinedCertPath = this.getCombinedCertPath();

      const transportOptions: any = {
        command: 'uvx',
        args: [
          '--python', pythonVersion,
          'chroma-mcp',
          '--client-type', 'persistent',
          '--data-dir', this.VECTOR_DB_DIR
        ],
        stderr: 'ignore'
      };

      // Add SSL certificate environment variables for corporate proxy/Zscaler environments
      if (combinedCertPath) {
        transportOptions.env = {
          ...process.env,
          SSL_CERT_FILE: combinedCertPath,
          REQUESTS_CA_BUNDLE: combinedCertPath,
          CURL_CA_BUNDLE: combinedCertPath
        };
        logger.info('CHROMA_SYNC', 'Using combined SSL certificates for Zscaler compatibility', {
          certPath: combinedCertPath
        });
      }

      // Note: windowsHide is not needed here because the worker daemon starts with
      // -WindowStyle Hidden, so child processes inherit the hidden console.
      // The MCP SDK ignores custom windowsHide anyway (overridden internally).

      this.transport = new StdioClientTransport(transportOptions);

      // Empty capabilities object: this client only calls Chroma tools, doesn't expose any
      this.client = new Client({
        name: 'claude-mem-chroma-sync',
        version: packageVersion
      }, {
        capabilities: {}
      });

      await this.client.connect(this.transport);
      this.connected = true;

      logger.info('CHROMA_SYNC', 'Connected to Chroma MCP server', { project: this.project });
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Failed to connect to Chroma MCP server', { project: this.project }, error as Error);
      throw new Error(`Chroma connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure collection exists, create if needed
   * Throws error if collection creation fails
   */
  private async ensureCollection(): Promise<void> {
    await this.ensureConnection();

    if (!this.client) {
      throw new Error(
        'Chroma client not initialized. Call ensureConnection() before using client methods.' +
        ` Project: ${this.project}`
      );
    }

    try {
      // Try to get collection info (will fail if doesn't exist)
      await this.client.callTool({
        name: 'chroma_get_collection_info',
        arguments: {
          collection_name: this.collectionName
        }
      });

      logger.debug('CHROMA_SYNC', 'Collection exists', { collection: this.collectionName });
    } catch (error) {
      // Check if this is a connection error - don't try to create collection
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isConnectionError =
        errorMessage.includes('Not connected') ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('MCP error -32000');

      if (isConnectionError) {
        // FIX: Close transport to kill subprocess before resetting state
        // Without this, old chroma-mcp processes leak as zombies
        if (this.transport) {
          try {
            await this.transport.close();
          } catch (closeErr) {
            logger.debug('CHROMA_SYNC', 'Transport close error (expected if already dead)', {}, closeErr as Error);
          }
        }
        // Reset connection state so next call attempts reconnect
        this.connected = false;
        this.client = null;
        this.transport = null;
        logger.error('CHROMA_SYNC', 'Connection lost during collection check',
          { collection: this.collectionName }, error as Error);
        throw new Error(`Chroma connection lost: ${errorMessage}`);
      }

      // Only attempt creation if it's genuinely a "collection not found" error
      logger.error('CHROMA_SYNC', 'Collection check failed, attempting to create', { collection: this.collectionName }, error as Error);
      logger.info('CHROMA_SYNC', 'Creating collection', { collection: this.collectionName });

      try {
        await this.client.callTool({
          name: 'chroma_create_collection',
          arguments: {
            collection_name: this.collectionName,
            embedding_function_name: 'default'
          }
        });

        logger.info('CHROMA_SYNC', 'Collection created', { collection: this.collectionName });
      } catch (createError) {
        logger.error('CHROMA_SYNC', 'Failed to create collection', { collection: this.collectionName }, createError as Error);
        throw new Error(`Collection creation failed: ${createError instanceof Error ? createError.message : String(createError)}`);
      }
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

    if (!this.client) {
      throw new Error(
        'Chroma client not initialized. Call ensureConnection() before using client methods.' +
        ` Project: ${this.project}`
      );
    }

    try {
      await this.client.callTool({
        name: 'chroma_add_documents',
        arguments: {
          collection_name: this.collectionName,
          documents: documents.map(d => d.document),
          ids: documents.map(d => d.id),
          metadatas: documents.map(d => d.metadata)
        }
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
   * No-op on Windows (Chroma disabled to prevent console popups)
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
    if (this.disabled) return;

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
   * No-op on Windows (Chroma disabled to prevent console popups)
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
    if (this.disabled) return;

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
   * No-op on Windows (Chroma disabled to prevent console popups)
   */
  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
    if (this.disabled) return;

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
  private async getExistingChromaIds(): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
  }> {
    await this.ensureConnection();

    if (!this.client) {
      throw new Error(
        'Chroma client not initialized. Call ensureConnection() before using client methods.' +
        ` Project: ${this.project}`
      );
    }

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000; // Large batches, metadata only = fast

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { project: this.project });

    while (true) {
      try {
        const result = await this.client.callTool({
          name: 'chroma_get_documents',
          arguments: {
            collection_name: this.collectionName,
            limit,
            offset,
            where: { project: this.project }, // Filter by project
            include: ['metadatas']
          }
        });

        const data = result.content[0];
        if (data.type !== 'text') {
          throw new Error('Unexpected response type from chroma_get_documents');
        }

        const parsed = JSON.parse(data.text);
        const metadatas = parsed.metadatas || [];

        if (metadatas.length === 0) {
          break; // No more documents
        }

        // Extract SQLite IDs from metadata
        for (const meta of metadatas) {
          if (meta.sqlite_id) {
            if (meta.doc_type === 'observation') {
              observationIds.add(meta.sqlite_id);
            } else if (meta.doc_type === 'session_summary') {
              summaryIds.add(meta.sqlite_id);
            } else if (meta.doc_type === 'user_prompt') {
              promptIds.add(meta.sqlite_id);
            }
          }
        }

        offset += limit;

        logger.debug('CHROMA_SYNC', 'Fetched batch of existing IDs', {
          project: this.project,
          offset,
          batchSize: metadatas.length
        });
      } catch (error) {
        logger.error('CHROMA_SYNC', 'Failed to fetch existing IDs', { project: this.project }, error as Error);
        throw error;
      }
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      project: this.project,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  /**
   * Backfill: Sync all observations missing from Chroma
   * Reads from SQLite and syncs in batches
   * Throws error if backfill fails
   * No-op on Windows (Chroma disabled to prevent console popups)
   */
  async ensureBackfilled(): Promise<void> {
    if (this.disabled) return;

    logger.info('CHROMA_SYNC', 'Starting smart backfill', { project: this.project });

    await this.ensureCollection();

    // Fetch existing IDs from Chroma (fast, metadata only)
    const existing = await this.getExistingChromaIds();

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
      `).all(this.project) as StoredObservation[];

      const totalObsCount = db.db.prepare(`
        SELECT COUNT(*) as count FROM observations WHERE project = ?
      `).get(this.project) as { count: number };

      logger.info('CHROMA_SYNC', 'Backfilling observations', {
        project: this.project,
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
          project: this.project,
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
      `).all(this.project) as StoredSummary[];

      const totalSummaryCount = db.db.prepare(`
        SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
      `).get(this.project) as { count: number };

      logger.info('CHROMA_SYNC', 'Backfilling summaries', {
        project: this.project,
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
          project: this.project,
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
      `).all(this.project) as StoredUserPrompt[];

      const totalPromptCount = db.db.prepare(`
        SELECT COUNT(*) as count
        FROM user_prompts up
        JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        WHERE s.project = ?
      `).get(this.project) as { count: number };

      logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
        project: this.project,
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
          project: this.project,
          progress: `${Math.min(i + this.BATCH_SIZE, promptDocs.length)}/${promptDocs.length}`
        });
      }

      logger.info('CHROMA_SYNC', 'Smart backfill complete', {
        project: this.project,
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
      logger.error('CHROMA_SYNC', 'Backfill failed', { project: this.project }, error as Error);
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
  }

  /**
   * Query Chroma collection for semantic search
   * Used by SearchManager for vector-based search
   * Returns empty results on Windows (Chroma disabled to prevent console popups)
   */
  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    if (this.disabled) {
      return { ids: [], distances: [], metadatas: [] };
    }

    await this.ensureConnection();

    if (!this.client) {
      throw new Error(
        'Chroma client not initialized. Call ensureConnection() before using client methods.' +
        ` Project: ${this.project}`
      );
    }

    const whereStringified = whereFilter ? JSON.stringify(whereFilter) : undefined;

    const arguments_obj = {
      collection_name: this.collectionName,
      query_texts: [query],
      n_results: limit,
      include: ['documents', 'metadatas', 'distances'],
      where: whereStringified
    };

    let result;
    try {
      result = await this.client.callTool({
        name: 'chroma_query_documents',
        arguments: arguments_obj
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isConnectionError =
        errorMessage.includes('Not connected') ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('MCP error -32000');

      if (isConnectionError) {
        // FIX: Close transport to kill subprocess before resetting state
        if (this.transport) {
          try {
            await this.transport.close();
          } catch (closeErr) {
            logger.debug('CHROMA_SYNC', 'Transport close error (expected if already dead)', {}, closeErr as Error);
          }
        }
        // Reset connection state so next call attempts reconnect
        this.connected = false;
        this.client = null;
        this.transport = null;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }
      throw error;
    }

    const resultText = result.content[0]?.text || (() => {
      logger.error('CHROMA', 'Missing text in MCP chroma_query_documents result', {
        project: this.project,
        query_text: query
      });
      return '';
    })();

    // Parse JSON response
    let parsed: any;
    try {
      parsed = JSON.parse(resultText);
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Failed to parse Chroma response', { project: this.project }, error as Error);
      return { ids: [], distances: [], metadatas: [] };
    }

    // Extract unique IDs from document IDs
    const ids: number[] = [];
    const docIds = parsed.ids?.[0] || [];
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

    const distances = parsed.distances?.[0] || [];
    const metadatas = parsed.metadatas?.[0] || [];

    return { ids, distances, metadatas };
  }

  /**
   * Close the Chroma client connection and cleanup subprocess
   */
  async close(): Promise<void> {
    if (!this.connected && !this.client && !this.transport) {
      return;
    }

    // Close client first
    if (this.client) {
      await this.client.close();
    }

    // Explicitly close transport to kill subprocess
    if (this.transport) {
      await this.transport.close();
    }

    logger.info('CHROMA_SYNC', 'Chroma client and subprocess closed', { project: this.project });

    // Always reset state
    this.connected = false;
    this.client = null;
    this.transport = null;
  }
}
