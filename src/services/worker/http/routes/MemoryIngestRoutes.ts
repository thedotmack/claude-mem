import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import '../../../sqlite/manual-session.js';
import {
  ingestMemorySource,
  claudeProjectsDir,
  MemorySourceError,
  type MemoryIngestDeps,
  type MemoryIngestReport,
  type MemoryObservationToStore,
} from '../../../memory/ingest.js';
import { computeObservationContentHash } from '../../../sqlite/observations/store.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Auto-memory ingest route. Stores Claude Code memory files DIRECTLY as
 * observations — mechanical, no model call — through the same store seam as
 * POST /api/memory/save, looped over a directory tree. Runs inside the worker
 * because the SQLite store lives here; the CLI is a thin client that POSTs
 * (dry-run stays client-side). Sources outside Claude Code's projects directory
 * are refused with 400.
 */
export class MemoryIngestRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/ingest', this.wrapHandler(this.handleIngest.bind(this)));
  }

  /** Build the store deps: a mechanical store-direct per observation with dedup. */
  private buildDeps(): MemoryIngestDeps {
    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    return {
      storeMemoryObservation: async (obs: MemoryObservationToStore) => {
        const memorySessionId = sessionStore.getOrCreateManualSession(obs.project);
        const observation = {
          type: obs.type,
          title: obs.title,
          subtitle: obs.subtitle,
          facts: [] as string[],
          narrative: obs.narrative,
          concepts: obs.concepts,
          files_read: [] as string[],
          files_modified: [] as string[],
          metadata: JSON.stringify(obs.metadata),
        };

        // Re-running an import must not touch rows it already stored: an exact
        // content_hash match is reported as deduped without calling the store
        // (whose Tier-0 merge would count it as a repeat).
        const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
        const existing = sessionStore.db
          .prepare('SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ? LIMIT 1')
          .get(memorySessionId, contentHash) as { id: number } | undefined;
        if (existing) return { id: existing.id, deduped: true };

        // Backdate to the file mtime via overrideTimestampEpoch.
        const result = sessionStore.storeObservation(
          memorySessionId,
          obs.project,
          observation,
          0,
          0,
          obs.createdAtEpoch
        );

        // A Tier-0 merge re-confirmed an existing row whose vector already
        // matches its stored text; re-syncing would overwrite it (as /api/memory/save).
        if (chromaSync && !result.mergedIntoExisting) {
          chromaSync
            .syncObservation(result.id, memorySessionId, obs.project, observation, 0, result.createdAtEpoch)
            .catch((err: unknown) => {
              logger.error('CHROMA', 'memory-ingest Chroma sync failed', { id: result.id }, err as Error);
            });
        }

        return { id: result.id, deduped: result.mergedIntoExisting };
      },
    };
  }

  private async handleIngest(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { source?: unknown; all?: unknown; requireCwd?: unknown };
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const all = body.all === true;
    if (!source && !all) {
      this.badRequest(res, 'source is required (or pass all=true)');
      return;
    }
    const requireCwd = body.requireCwd === true;
    const effectiveSource = source || claudeProjectsDir();

    logger.info('INGEST', 'Memory ingest starting', { source: effectiveSource, all, requireCwd });
    let report: MemoryIngestReport;
    try {
      report = await ingestMemorySource(effectiveSource, { all, requireCwd }, this.buildDeps());
    } catch (error: unknown) {
      if (error instanceof MemorySourceError) {
        this.badRequest(res, error.message);
        return;
      }
      throw error;
    }
    logger.info('INGEST', 'Memory ingest complete', {
      found: report.found,
      stored: report.stored,
      deduped: report.deduped,
      skipped: report.skipped,
      failed: report.failed,
    });

    // Every local write nudges cloud sync, as /api/memory/save does.
    if (report.stored > 0) this.dbManager.getCloudSync()?.notify();

    res.json(report);
  }
}
