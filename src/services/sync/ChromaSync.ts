
import { ChromaMcpManager } from './ChromaMcpManager.js';
import { ChromaSyncState, ProjectWatermarks } from './ChromaSyncState.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { parseFileList } from '../sqlite/observations/files.js';

interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
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
  merged_into_project: string | null;
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

export class ChromaSync {
  private project: string;
  private collectionName: string;
  private collectionCreated = false;
  private readonly BATCH_SIZE = 100;

  constructor(project: string) {
    this.project = project;
    const sanitized = project
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/[^a-zA-Z0-9]+$/, '');  
    this.collectionName = `cm__${sanitized || 'unknown'}`;
  }

  private async ensureCollectionExists(): Promise<void> {
    if (this.collectionCreated) {
      return;
    }

    const chromaMcp = ChromaMcpManager.getInstance();
    try {
      await chromaMcp.callTool('chroma_create_collection', {
        collection_name: this.collectionName
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        throw error;
      }
      // Collection already exists - this is the expected path after first creation
    }

    this.collectionCreated = true;

    logger.debug('CHROMA_SYNC', 'Collection ready', {
      collection: this.collectionName
    });
  }

  private formatObservationDocs(obs: StoredObservation): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const files_read = parseFileList(obs.files_read);
    const files_modified = parseFileList(obs.files_modified);

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      merged_into_project: obs.merged_into_project ?? null,
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

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

    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    return documents;
  }

  private formatSummaryDocs(summary: StoredSummary): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      merged_into_project: summary.merged_into_project ?? null,
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

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
   * Write `documents` to Chroma in BATCH_SIZE-sized batches.
   *
   * Returns the number of documents that were successfully written (or
   * confirmed via delete+add reconcile). Per-batch failures are logged and the
   * loop continues — we never throw — so callers must use the returned count
   * to advance their watermark, otherwise an interrupted backfill can mark
   * unsynced records as synced.
   */
  private async addDocuments(documents: ChromaDocument[]): Promise<number> {
    if (documents.length === 0) {
      return 0;
    }

    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    let written = 0;
    for (let i = 0; i < documents.length; i += this.BATCH_SIZE) {
      const batch = documents.slice(i, i + this.BATCH_SIZE);

      const cleanMetadatas = batch.map(d =>
        Object.fromEntries(
          Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
        )
      );

      try {
        await chromaMcp.callTool('chroma_add_documents', {
          collection_name: this.collectionName,
          ids: batch.map(d => d.id),
          documents: batch.map(d => d.document),
          metadatas: cleanMetadatas
        });
        written += batch.length;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('already exist')) {
          try {
            await chromaMcp.callTool('chroma_delete_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id)
            });
            await chromaMcp.callTool('chroma_add_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id),
              documents: batch.map(d => d.document),
              metadatas: cleanMetadatas
            });
            written += batch.length;
            logger.info('CHROMA_SYNC', 'Batch reconciled via delete+add after duplicate conflict', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            });
          } catch (reconcileError) {
            logger.error('CHROMA_SYNC', 'Batch reconcile (delete+add) failed — watermark will not advance for this batch', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            }, reconcileError as Error);
          }
        } else {
          logger.error('CHROMA_SYNC', 'Batch add failed — watermark will not advance for this batch, continuing with remaining batches', {
            collection: this.collectionName,
            batchStart: i,
            batchSize: batch.length
          }, error as Error);
        }
      }
    }

    logger.debug('CHROMA_SYNC', 'Documents added', {
      collection: this.collectionName,
      requested: documents.length,
      written
    });
    return written;
  }

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project: project,
      merged_into_project: null,
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

    // Only advance the watermark on a confirmed full write. addDocuments() now
    // returns a written count and tolerates per-batch failures, so a transient
    // Chroma error must NOT mark this observation as synced — otherwise the
    // backfill pass on next boot will skip past it (CodeRabbit review on PR
    // #2282).
    const written = await this.addDocuments(documents);
    if (written === documents.length) {
      ChromaSyncState.bump(project, 'observations', observationId);
    } else {
      logger.warn('CHROMA_SYNC', 'Observation watermark bump skipped — partial write', {
        observationId,
        project,
        requested: documents.length,
        written
      });
    }
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project: project,
      merged_into_project: null,
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

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const written = await this.addDocuments(documents);
    if (written === documents.length) {
      ChromaSyncState.bump(project, 'summaries', summaryId);
    } else {
      logger.warn('CHROMA_SYNC', 'Summary watermark bump skipped — partial write', {
        summaryId,
        project,
        requested: documents.length,
        written
      });
    }
  }

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

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
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

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const written = await this.addDocuments([document]);
    if (written === 1) {
      ChromaSyncState.bump(project, 'prompts', promptId);
    } else {
      logger.warn('CHROMA_SYNC', 'Prompt watermark bump skipped — write failed', {
        promptId,
        project,
        written
      });
    }
  }

  private async getExistingChromaIds(projectOverride?: string): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
  }> {
    const targetProject = projectOverride ?? this.project;
    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000; 

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { project: targetProject });

    while (true) {
      const result = await chromaMcp.callTool('chroma_get_documents', {
        collection_name: this.collectionName,
        limit: limit,
        offset: offset,
        where: { project: targetProject },
        include: ['metadatas']
      }) as any;

      const metadatas = result?.metadatas || [];

      if (metadatas.length === 0) {
        break; 
      }

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
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      project: targetProject,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size,
      total: observationIds.size + summaryIds.size + promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  async bootstrapWatermarksFromChroma(project: string): Promise<void> {
    const existing = await this.getExistingChromaIds(project);
    const max = (set: Set<number>): number => {
      let m = 0;
      for (const id of set) if (id > m) m = id;
      return m;
    };
    ChromaSyncState.replace(project, {
      observations: max(existing.observations),
      summaries: max(existing.summaries),
      prompts: max(existing.prompts)
    });
    logger.info('CHROMA_SYNC', 'Bootstrapped watermarks from Chroma', {
      project,
      watermarks: ChromaSyncState.get(project)
    });
  }

  async ensureBackfilled(projectOverride?: string, storeOverride?: SessionStore): Promise<void> {
    const backfillProject = projectOverride ?? this.project;
    logger.info('CHROMA_SYNC', 'Starting smart backfill', { project: backfillProject });

    await this.ensureCollectionExists();

    const watermarks = ChromaSyncState.get(backfillProject);

    const db = storeOverride ?? new SessionStore();

    try {
      await this.runBackfillPipeline(db, backfillProject, watermarks);
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Backfill failed', { project: backfillProject }, error instanceof Error ? error : new Error(String(error)));
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!storeOverride) {
        db.close();
      }
    }
  }

  private async runBackfillPipeline(
    db: SessionStore,
    backfillProject: string,
    watermarks: ProjectWatermarks
  ): Promise<void> {
    const allDocs = await this.backfillObservations(db, backfillProject, watermarks.observations);
    const summaryDocs = await this.backfillSummaries(db, backfillProject, watermarks.summaries);
    const promptDocs = await this.backfillPrompts(db, backfillProject, watermarks.prompts);

    logger.info('CHROMA_SYNC', 'Smart backfill complete', {
      project: backfillProject,
      synced: {
        observationDocs: allDocs.length,
        summaryDocs: summaryDocs.length,
        promptDocs: promptDocs.length
      },
      watermarks: ChromaSyncState.get(backfillProject)
    });
  }

  private async backfillObservations(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<ChromaDocument[]> {
    const observations = db.db.prepare(`
      SELECT * FROM observations
      WHERE project = ? AND id > ?
      ORDER BY id ASC
    `).all(backfillProject, watermark) as StoredObservation[];

    if (observations.length === 0) {
      return [];
    }

    const totalObsCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling observations', {
      project: backfillProject,
      missing: observations.length,
      watermark,
      total: totalObsCount.count
    });

    const allDocs: ChromaDocument[] = [];
    const obsByDocCount: Array<{ obs: StoredObservation; docs: ChromaDocument[] }> = [];
    for (const obs of observations) {
      const docs = this.formatObservationDocs(obs);
      allDocs.push(...docs);
      obsByDocCount.push({ obs, docs });
    }

    // Watermark must be durable per-batch: SIGKILL / OOM / reboot mid-flight
    // skips any trailing finally, so a once-at-end bump leaves the watermark
    // at zero and the next boot re-embeds everything (#2214, amplifies #2220).
    //
    // Non-contiguous failure guard: once any batch under-writes, ALL later
    // batches must also skip the watermark bump. The watermark is a single
    // monotonic id, so it cannot represent "synced through 200, then a gap at
    // 201–250, then 251 onward" — bumping past the gap would silently drop
    // 201–250 forever (CodeRabbit review on PR #2282).
    let writtenDocs = 0;
    let lastSyncedObsIdx = -1;
    let hadGap = false;
    for (let i = 0; i < allDocs.length; i += this.BATCH_SIZE) {
      const batch = allDocs.slice(i, i + this.BATCH_SIZE);
      const writtenInBatch = await this.addDocuments(batch);
      // Only advance the watermark for documents that actually landed in
      // Chroma. addDocuments() logs and continues on per-batch failures, so a
      // partial write must not mark unwritten docs as synced.
      if (writtenInBatch < batch.length) {
        hadGap = true;
        logger.debug('CHROMA_SYNC', 'Skipping watermark bump for failed/partial batch', {
          project: backfillProject,
          batchStart: i,
          requested: batch.length,
          written: writtenInBatch
        });
        continue;
      }
      if (hadGap) {
        // A previous batch left a gap; downstream batches cannot bump the
        // watermark even if they themselves succeeded.
        logger.debug('CHROMA_SYNC', 'Skipping watermark bump after prior gap', {
          project: backfillProject,
          batchStart: i
        });
        continue;
      }
      writtenDocs += writtenInBatch;

      let cursor = 0;
      for (let j = 0; j < obsByDocCount.length; j++) {
        cursor += obsByDocCount[j].docs.length;
        if (cursor <= writtenDocs) {
          lastSyncedObsIdx = j;
        } else {
          break;
        }
      }

      if (lastSyncedObsIdx >= 0) {
        ChromaSyncState.bump(
          backfillProject,
          'observations',
          obsByDocCount[lastSyncedObsIdx].obs.id
        );
      }

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        project: backfillProject,
        progress: `${Math.min(i + this.BATCH_SIZE, allDocs.length)}/${allDocs.length}`
      });
    }

    return allDocs;
  }

  private async backfillSummaries(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<ChromaDocument[]> {
    const summaries = db.db.prepare(`
      SELECT * FROM session_summaries
      WHERE project = ? AND id > ?
      ORDER BY id ASC
    `).all(backfillProject, watermark) as StoredSummary[];

    if (summaries.length === 0) {
      return [];
    }

    const totalSummaryCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling summaries', {
      project: backfillProject,
      missing: summaries.length,
      watermark,
      total: totalSummaryCount.count
    });

    const summaryDocs: ChromaDocument[] = [];
    const summaryByDocCount: Array<{ summary: StoredSummary; docs: ChromaDocument[] }> = [];
    for (const summary of summaries) {
      const docs = this.formatSummaryDocs(summary);
      summaryDocs.push(...docs);
      summaryByDocCount.push({ summary, docs });
    }

    // Non-contiguous failure guard: see backfillObservations() for rationale.
    let writtenDocs = 0;
    let lastSyncedIdx = -1;
    let hadGap = false;
    for (let i = 0; i < summaryDocs.length; i += this.BATCH_SIZE) {
      const batch = summaryDocs.slice(i, i + this.BATCH_SIZE);
      const writtenInBatch = await this.addDocuments(batch);
      // Only advance the watermark for documents that actually landed in
      // Chroma. See the analogous comment in backfillObservations().
      if (writtenInBatch < batch.length) {
        hadGap = true;
        logger.debug('CHROMA_SYNC', 'Skipping watermark bump for failed/partial batch', {
          project: backfillProject,
          batchStart: i,
          requested: batch.length,
          written: writtenInBatch
        });
        continue;
      }
      if (hadGap) {
        logger.debug('CHROMA_SYNC', 'Skipping watermark bump after prior gap', {
          project: backfillProject,
          batchStart: i
        });
        continue;
      }
      writtenDocs += writtenInBatch;

      let cursor = 0;
      for (let j = 0; j < summaryByDocCount.length; j++) {
        cursor += summaryByDocCount[j].docs.length;
        if (cursor <= writtenDocs) lastSyncedIdx = j;
        else break;
      }

      if (lastSyncedIdx >= 0) {
        ChromaSyncState.bump(
          backfillProject,
          'summaries',
          summaryByDocCount[lastSyncedIdx].summary.id
        );
      }

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        project: backfillProject,
        progress: `${Math.min(i + this.BATCH_SIZE, summaryDocs.length)}/${summaryDocs.length}`
      });
    }

    return summaryDocs;
  }

  private async backfillPrompts(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<ChromaDocument[]> {
    const prompts = db.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE s.project = ? AND up.id > ?
      ORDER BY up.id ASC
    `).all(backfillProject, watermark) as StoredUserPrompt[];

    if (prompts.length === 0) {
      return [];
    }

    const totalPromptCount = db.db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE s.project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
      project: backfillProject,
      missing: prompts.length,
      watermark,
      total: totalPromptCount.count
    });

    const promptDocs: ChromaDocument[] = [];
    for (const prompt of prompts) {
      promptDocs.push(this.formatUserPromptDoc(prompt));
    }

    // Prompts are 1 doc each — bump the watermark per batch so an interrupted
    // backfill resumes where it left off instead of re-embedding from zero.
    // Only advance the watermark when the batch actually wrote — partial
    // writes must not skip the failed prompts on restart.
    //
    // Non-contiguous failure guard: see backfillObservations() for rationale.
    let hadGap = false;
    for (let i = 0; i < promptDocs.length; i += this.BATCH_SIZE) {
      const batch = promptDocs.slice(i, i + this.BATCH_SIZE);
      const writtenInBatch = await this.addDocuments(batch);
      const upTo = Math.min(i + this.BATCH_SIZE, prompts.length);
      if (writtenInBatch < batch.length) {
        hadGap = true;
        logger.debug('CHROMA_SYNC', 'Skipping prompt watermark bump for failed/partial batch', {
          project: backfillProject,
          batchStart: i,
          requested: batch.length,
          written: writtenInBatch
        });
        continue;
      }
      if (hadGap) {
        logger.debug('CHROMA_SYNC', 'Skipping prompt watermark bump after prior gap', {
          project: backfillProject,
          batchStart: i
        });
        continue;
      }
      const lastSyncedPromptId = prompts[upTo - 1].id;
      ChromaSyncState.bump(backfillProject, 'prompts', lastSyncedPromptId);

      logger.debug('CHROMA_SYNC', 'Backfill progress', {
        project: backfillProject,
        progress: `${upTo}/${promptDocs.length}`
      });
    }

    return promptDocs;
  }

  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    await this.ensureCollectionExists();

    let results: any;
    try {
      const chromaMcp = ChromaMcpManager.getInstance();
      results = await chromaMcp.callTool('chroma_query_documents', {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: limit,
        ...(whereFilter && { where: whereFilter }),
        include: ['documents', 'metadatas', 'distances']
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') || 
        errorMessage.includes('ENOTFOUND') || 
        errorMessage.includes('fetch failed') || 
        errorMessage.includes('subprocess closed') || 
        errorMessage.includes('timed out'); 

      if (isConnectionError) {
        this.collectionCreated = false;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }

      logger.error('CHROMA_SYNC', 'Query failed', { project: this.project, query }, error as Error);
      throw error;
    }

    return this.deduplicateQueryResults(results);
  }

  private deduplicateQueryResults(results: any): { ids: number[]; distances: number[]; metadatas: any[] } {
    const ids: number[] = [];
    const seen = new Set<string>();
    const docIds = results?.ids?.[0] || [];
    const rawMetadatas = results?.metadatas?.[0] || [];
    const rawDistances = results?.distances?.[0] || [];

    const metadatas: any[] = [];
    const distances: number[] = [];

    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i];
      const obsMatch = docId.match(/obs_(\d+)_/);
      const summaryMatch = docId.match(/summary_(\d+)_/);
      const promptMatch = docId.match(/prompt_(\d+)/);

      let sqliteId: number | null = null;
      let entityType: string | null = null;
      if (obsMatch) {
        sqliteId = parseInt(obsMatch[1], 10);
        entityType = 'observation';
      } else if (summaryMatch) {
        sqliteId = parseInt(summaryMatch[1], 10);
        entityType = 'session_summary';
      } else if (promptMatch) {
        sqliteId = parseInt(promptMatch[1], 10);
        entityType = 'user_prompt';
      }

      if (sqliteId !== null && entityType) {
        const dedupeKey = `${entityType}:${sqliteId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        ids.push(sqliteId);
        metadatas.push(rawMetadatas[i] ?? null);
        distances.push(rawDistances[i] ?? 0);
      }
    }

    return { ids, distances, metadatas };
  }

  /** Maximum number of concurrent project backfills to run at once. */
  private static readonly BACKFILL_CONCURRENCY_LIMIT = 3;

  /** Guard flag to prevent overlapping backfill runs from fire-and-forget callers. */
  private static backfillInProgress = false;

  /**
   * Backfill all projects that have observations in SQLite but may be missing from Chroma.
   * Uses a single shared ChromaSync('claude-mem') instance and Chroma connection.
   * Per-project scoping is passed as a parameter to ensureBackfilled(), avoiding
   * instance state mutation. All documents land in the cm__claude-mem collection
   * with project scoped via metadata, matching how DatabaseManager and SearchManager operate.
   * Designed to be called fire-and-forget on worker startup.
   *
   * Concurrency: processes at most BACKFILL_CONCURRENCY_LIMIT projects in parallel
   * to bound CPU and memory pressure from concurrent Chroma embedding operations.
   * A re-entrant guard prevents overlapping backfill runs from accumulating.
   */
  static async backfillAllProjects(storeOverride?: SessionStore): Promise<void> {
    if (ChromaSync.backfillInProgress) {
      logger.info('CHROMA_SYNC', 'Backfill already in progress, skipping duplicate run');
      return;
    }

    // Allocate first so a constructor throw cannot leave the guard stuck true
    // and silently skip every subsequent backfill (CodeRabbit review on PR
    // #2282). The guard only flips to true after both resources are alive,
    // and the finally always clears it.
    let db: SessionStore | undefined;
    let sync: ChromaSync | undefined;
    try {
      db = storeOverride ?? new SessionStore();
      sync = new ChromaSync('claude-mem');
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Failed to initialize backfill resources',
        {}, error instanceof Error ? error : new Error(String(error)));
      // Best-effort cleanup if SessionStore allocated but ChromaSync threw.
      if (db && !storeOverride) {
        try { db.close(); } catch { /* ignore */ }
      }
      throw error;
    }

    ChromaSync.backfillInProgress = true;
    try {
      const projects = db.db.prepare(
        'SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ?'
      ).all('') as { project: string }[];

      logger.info('CHROMA_SYNC', `Backfill check for ${projects.length} projects`);

      if (!ChromaSyncState.exists()) {
        logger.info('CHROMA_SYNC', 'Watermark cache missing — bootstrapping from Chroma (one-time)');
        for (const { project } of projects) {
          try {
            await sync.bootstrapWatermarksFromChroma(project);
          } catch (error) {
            logger.error('CHROMA_SYNC', `Bootstrap failed for project: ${project}`,
              {}, error instanceof Error ? error : new Error(String(error)));
          }
        }
        logger.info('CHROMA_SYNC', 'Bootstrap complete — incremental backfills will use watermarks');
      }

      // Process projects in chunks of BACKFILL_CONCURRENCY_LIMIT to bound
      // CPU/memory pressure from concurrent Chroma embedding operations.
      // Each chunk runs its projects in parallel; we wait for the entire chunk
      // before starting the next one. Simple and predictable — no semaphore
      // overhead, no unbounded fan-out.
      const concurrency = ChromaSync.BACKFILL_CONCURRENCY_LIMIT;
      for (let i = 0; i < projects.length; i += concurrency) {
        const chunk = projects.slice(i, i + concurrency);
        const chunkResults = await Promise.allSettled(
          chunk.map(({ project }) => sync!.ensureBackfilled(project, db!))
        );

        for (let j = 0; j < chunkResults.length; j++) {
          const result = chunkResults[j];
          if (result.status === 'rejected') {
            const project = chunk[j].project;
            const error = result.reason;
            if (error instanceof Error) {
              logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, {}, error);
            } else {
              logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, { error: String(error) });
            }
            // Continue to next chunk — don't let one failure stop others
          }
        }
      }
    } finally {
      ChromaSync.backfillInProgress = false;
      if (sync) {
        try { await sync.close(); } catch (closeError) {
          logger.debug('CHROMA_SYNC', 'sync.close() failed during backfill teardown',
            {}, closeError instanceof Error ? closeError : new Error(String(closeError)));
        }
      }
      if (!storeOverride && db) {
        try { db.close(); } catch (closeError) {
          logger.debug('CHROMA_SYNC', 'db.close() failed during backfill teardown',
            {}, closeError instanceof Error ? closeError : new Error(String(closeError)));
        }
      }
    }
  }

  async updateMergedIntoProject(
    sqliteIds: number[],
    mergedIntoProject: string
  ): Promise<void> {
    if (sqliteIds.length === 0) return;

    await this.ensureCollectionExists();
    const chromaMcp = ChromaMcpManager.getInstance();

    let totalPatched = 0;

    for (let i = 0; i < sqliteIds.length; i += this.BATCH_SIZE) {
      const idBatch = sqliteIds.slice(i, i + this.BATCH_SIZE);

      const existing = await chromaMcp.callTool('chroma_get_documents', {
        collection_name: this.collectionName,
        where: { sqlite_id: { $in: idBatch } },
        include: ['metadatas']
      }) as { ids?: string[]; metadatas?: Array<Record<string, any> | null> };

      const docIds: string[] = existing?.ids ?? [];
      if (docIds.length === 0) continue;

      const metadatas = (existing?.metadatas ?? []).map(m => {
        const merged: Record<string, any> = {
          ...(m ?? {}),
          merged_into_project: mergedIntoProject
        };
        return Object.fromEntries(
          Object.entries(merged).filter(
            ([, v]) => v !== null && v !== undefined && v !== ''
          )
        );
      });

      await chromaMcp.callTool('chroma_update_documents', {
        collection_name: this.collectionName,
        ids: docIds,
        metadatas
      });
      totalPatched += docIds.length;
    }

    logger.info('CHROMA_SYNC', 'merged_into_project metadata patched', {
      collection: this.collectionName,
      mergedIntoProject,
      sqliteIdCount: sqliteIds.length,
      chromaDocsPatched: totalPatched
    });
  }

  async close(): Promise<void> {
    logger.info('CHROMA_SYNC', 'ChromaSync closed', { project: this.project });
  }
}
