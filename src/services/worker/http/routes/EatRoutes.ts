
import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { runEatPipeline } from '../../eat/pipeline.js';
import { EatError } from '../../eat/errors.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import type { EatPipelineResult, EatReport } from '../../eat/types.js';

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const eatSchema = z.object({
  input: z.string().optional(),
  content: z.string().optional(),
  content_source: z.object({
    kind: z.literal('file'),
    locator: z.string().min(1),
  }).strict().optional(),
  mcp: z.object({
    url: z.string(),
    resource: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }).strict().optional(),
  project: z.string().trim().min(1),
  dry_run: z.boolean().optional(),
  recursive: z.boolean().optional(),
}).strict();

export class EatRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/eat', validateBody(eatSchema), this.handleEat.bind(this));
  }

  private handleEat = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { input, content, content_source, mcp, project, dry_run, recursive } = req.body as z.infer<typeof eatSchema>;
    const request_id = randomUUID();

    const providedSources = [input, content, mcp].filter(value => value !== undefined).length;
    if (providedSources !== 1) {
      res.status(400).json({ error: 'invalid_request', detail: 'Provide exactly one of input, content, or mcp', request_id });
      return;
    }

    if (content_source !== undefined && content === undefined) {
      res.status(400).json({ error: 'invalid_request', detail: 'content_source requires content', request_id });
      return;
    }

    const payload = content ?? input ?? '';
    if (Buffer.byteLength(payload, 'utf-8') > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: 'payload_too_large', request_id });
      return;
    }

    let result: EatPipelineResult;
    try {
      result = await runEatPipeline(input, {
        content,
        contentSource: content_source,
        recursive,
        mcp,
        requestId: request_id,
      });
    } catch (error) {
      if (error instanceof EatError) {
        // Memorable-style structured failure: { error: <code>, detail, request_id }.
        logger.warn('HTTP', 'EAT request failed', { request_id, code: error.code, detail: error.message });
        res.status(error.statusCode).json({ error: error.code, detail: error.message, request_id });
        return;
      }
      throw error; // Unexpected — wrapHandler turns it into a 500.
    }

    if (dry_run) {
      const report: EatReport = {
        request_id,
        source: result.source,
        chunks: result.chunks,
        observation_ids: [],
        drafts: result.drafts,
        rejected: result.rejected,
      };
      res.json(report);
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();
    const gbrainSync = this.dbManager.getGbrainSync();

    const memorySessionId = sessionStore.getOrCreateManualSession(project);

    const observations = result.drafts.map(draft => {
      const draftSource = draft.source ?? result.source;
      return {
        type: draft.type,
        title: draft.title,
        subtitle: draft.subtitle,
        facts: draft.facts,
        narrative: draft.narrative,
        concepts: draft.concepts,
        files_read: draftSource.kind === 'file' ? [draftSource.locator] : [],
        files_modified: [] as string[],
        metadata: JSON.stringify({ eat: true, source: draftSource }),
      };
    });

    const stored = sessionStore.storeObservations(
      memorySessionId,
      project,
      observations,
      null,
      0,
      0,
      undefined,
      result.model
    );

    logger.info('HTTP', 'EAT observations stored', {
      request_id,
      project,
      count: stored.observationIds.length
    });

    // Fire-and-forget cloud sync nudge — every local write must nudge
    // (placed before the chroma branch so the chroma-disabled early return
    // cannot skip it).
    this.dbManager.getCloudSync()?.notify();

    // storeObservations may return the same id more than once when the model
    // emits duplicate title+narrative content. Sync each durable row once;
    // repeated Chroma writes otherwise hit "IDs already exist", and repeated
    // gbrain captures race on the same deterministic slug.
    const uniqueStoredObservations = new Map<number, typeof observations[number]>();
    stored.observationIds.forEach((observationId, index) => {
      const observation = observations[index];
      if (observation && !uniqueStoredObservations.has(observationId)) {
        uniqueStoredObservations.set(observationId, observation);
      }
    });

    for (const [observationId, observation] of uniqueStoredObservations) {
      void gbrainSync?.syncObservation(
        observationId,
        project,
        observation,
        stored.createdAtEpoch,
        memorySessionId
      ).catch(err => {
        logger.warn('GBRAIN_SYNC', 'EAT gbrain sync failed', { id: observationId }, err as Error);
      });
    }

    const report: EatReport = {
      request_id,
      source: result.source,
      chunks: result.chunks,
      observation_ids: stored.observationIds,
      rejected: result.rejected,
    };

    if (!chromaSync) {
      logger.debug('CHROMA', 'ChromaDB sync skipped (chromaSync not available)', { request_id });
      res.json(report);
      return;
    }
    for (const [observationId, observation] of uniqueStoredObservations) {
      chromaSync.syncObservation(
        observationId,
        memorySessionId,
        project,
        observation,
        0,
        stored.createdAtEpoch
      ).catch(err => {
        logger.error('CHROMA', 'ChromaDB sync failed', { id: observationId }, err as Error);
      });
    }

    res.json(report);
  });
}
