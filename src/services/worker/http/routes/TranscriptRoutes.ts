import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { TranscriptEventProcessor } from '../../../transcripts/processor.js';
import { ingestSource, type IngestDeps } from '../../../transcripts/ingest.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Transcript backfill route (#2690). Runs the real, spending ingest INSIDE the
 * worker process — the only place ingestObservation's context is set. The CLI
 * is a thin client that POSTs here (mirroring how summaries reach the worker).
 *
 * Dry-run is intentionally NOT served here: it is pure parse + count with no
 * model spend, so the CLI runs it client-side.
 */
export class TranscriptRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/transcript/ingest', this.wrapHandler(this.handleIngest.bind(this)));
  }

  private sessionExists(contentSessionId: string): boolean {
    const row = this.dbManager
      .getSessionStore()
      .db.prepare('SELECT 1 FROM sdk_sessions WHERE content_session_id = ? LIMIT 1')
      .get(contentSessionId);
    return row !== null && row !== undefined;
  }

  private async handleIngest(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as { source?: unknown; includeSubagents?: unknown };
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    if (!source) {
      this.badRequest(res, 'source is required');
      return;
    }
    const includeSubagents = body.includeSubagents === true;

    const deps: IngestDeps = {
      processor: new TranscriptEventProcessor(),
      sessionExists: id => this.sessionExists(id),
    };

    logger.info('TRANSCRIPT', 'Backfill ingest starting', { source, includeSubagents });
    const report = await ingestSource(source, { includeSubagents }, deps);
    logger.info('TRANSCRIPT', 'Backfill ingest complete', {
      found: report.found,
      ingested: report.ingested,
      alreadyIndexed: report.alreadyIndexed,
      failed: report.failed,
    });

    res.json(report);
  }
}
