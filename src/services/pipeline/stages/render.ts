/**
 * Render Stage - Persist parsed data to storage
 *
 * Responsibilities:
 * - Save observations to SQLite database
 * - Save summaries to SQLite database
 * - Sync to Chroma vector database
 * - Broadcast to SSE clients
 */

import { logger } from '../../../utils/logger.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';
import type {
  RenderInput,
  RenderOutput,
  PipelineConfig
} from '../../../types/pipeline.js';

type RenderConfig = PipelineConfig['stages']['render'];

export class RenderStage {
  private config: RenderConfig;
  private sessionStore: SessionStore | null;
  private chromaSync: ChromaSync | null;

  constructor(
    config: RenderConfig,
    sessionStore: SessionStore | null = null,
    chromaSync: ChromaSync | null = null
  ) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.chromaSync = chromaSync;
  }

  async execute(input: RenderInput): Promise<RenderOutput> {
    const dbWriteStart = Date.now();
    const savedObservations: RenderOutput['savedObservations'] = [];
    let savedSummary: RenderOutput['savedSummary'];
    let chromaSyncStatus: RenderOutput['chromaSyncStatus'] = 'success';

    // Save observations
    for (const obs of input.observations) {
      if (this.sessionStore) {
        const result = this.sessionStore.storeObservation(
          input.sessionId,
          input.project,
          {
            type: obs.type,
            title: obs.title ?? null,
            subtitle: obs.subtitle ?? null,
            facts: obs.facts ?? [],
            narrative: obs.narrative ?? null,
            concepts: obs.concepts ?? [],
            files_read: obs.files_read ?? [],
            files_modified: obs.files_modified ?? [],
          },
          input.promptNumber,
          input.discoveryTokens
        );
        savedObservations.push(result);
      } else {
        logger.warn('PIPELINE:RENDER', 'No SessionStore available, skipping observation save');
      }
    }

    // Save summary
    if (input.summary && this.sessionStore) {
      savedSummary = this.sessionStore.storeSummary(
        input.sessionId,
        input.project,
        {
          request: input.summary.request ?? '',
          investigated: input.summary.investigated ?? '',
          learned: input.summary.learned ?? '',
          completed: input.summary.completed ?? '',
          next_steps: input.summary.next_steps ?? '',
          notes: input.summary.notes ?? null,
        },
        input.promptNumber,
        input.discoveryTokens
      );
    }

    const dbWriteLatencyMs = Date.now() - dbWriteStart;

    // Sync to Chroma
    const chromaStart = Date.now();
    if (this.config.syncToChroma && this.chromaSync && savedObservations.length > 0) {
      try {
        for (let i = 0; i < savedObservations.length; i++) {
          const saved = savedObservations[i];
          const obs = input.observations[i];
          await this.chromaSync.syncObservation(
            saved.id,
            input.sessionId,
            input.project,
            {
              type: obs.type,
              title: obs.title ?? null,
              subtitle: obs.subtitle ?? null,
              facts: obs.facts ?? [],
              narrative: obs.narrative ?? null,
              concepts: obs.concepts ?? [],
              files_read: obs.files_read ?? [],
              files_modified: obs.files_modified ?? [],
            },
            input.promptNumber,
            saved.createdAtEpoch,
            input.discoveryTokens
          );
        }
        if (savedSummary) {
          const summary = input.summary!;
          await this.chromaSync.syncSummary(
            savedSummary.id,
            input.sessionId,
            input.project,
            {
              request: summary.request ?? '',
              investigated: summary.investigated ?? '',
              learned: summary.learned ?? '',
              completed: summary.completed ?? '',
              next_steps: summary.next_steps ?? '',
              notes: summary.notes ?? null,
            },
            input.promptNumber,
            savedSummary.createdAtEpoch,
            input.discoveryTokens
          );
        }
        chromaSyncStatus = 'success';
      } catch (error) {
        logger.warn('PIPELINE:RENDER', 'Chroma sync failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        chromaSyncStatus = 'failed';
      }
    }
    const chromaSyncLatencyMs = Date.now() - chromaStart;

    // Broadcast to SSE
    if (this.config.broadcastToSSE) {
      logger.debug('PIPELINE:RENDER', 'Broadcasting to SSE clients', {
        observationCount: savedObservations.length,
        hasSummary: !!savedSummary,
      });
    }

    const output: RenderOutput = {
      savedObservations,
      savedSummary,
      chromaSyncStatus,
      metadata: {
        dbWriteLatencyMs,
        chromaSyncLatencyMs
      }
    };

    logger.debug('PIPELINE:RENDER', 'Render complete', {
      observationsSaved: savedObservations.length,
      summarySaved: !!savedSummary,
      chromaStatus: chromaSyncStatus,
      dbWriteMs: dbWriteLatencyMs
    });

    return output;
  }
}
