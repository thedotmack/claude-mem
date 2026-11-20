import { timingSafeEqual } from 'crypto';
import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { HookSpool, remoteHookSpoolReceipt, type HookSpoolConsumedMarkers } from '../../../../shared/hook-spool.js';
import { normalizeRemoteSpoolEntry, remoteSpoolEnvelopeSchema,
  remoteHookSpoolToken, REMOTE_SPOOL_PROTOCOL_VERSION } from '../../../../shared/hook-spool-remote.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import { isLiveObserverEvent } from '../../../../shared/observer-work-policy.js';
import { ingestHookSpoolEntry } from '../../hook-spool-drain.js';

export class HookSpoolRoutes extends BaseRouteHandler {
  constructor(
    private readonly spool: HookSpool,
    private readonly consumedMarkers: () => HookSpoolConsumedMarkers,
    private readonly requestDrain: () => void,
    private readonly getToken: () => string,
    private readonly maxBodyBytes: string | number = 5 * 1024 * 1024,
  ) { super(); }

  setupRoutes(app: Application): void {
    const configuredLimit = Number(this.maxBodyBytes);
    const limit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 5 * 1024 * 1024;
    app.post('/api/spool/ingest', this.authenticate, express.json({ limit }), this.wrapHandler(this.handleIngest));
  }

  private authenticate = (req: Request, res: Response, next: NextFunction): void => {
    const token = remoteHookSpoolToken(this.getToken());
    if (!token) {
      res.status(503).json({ error: 'Remote spool ingestion is disabled; configure CLAUDE_MEM_WORKER_INGEST_TOKEN' });
      return;
    }
    const actual = Buffer.from(req.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: 'Remote spool authentication failed' });
      return;
    }
    next();
  };

  private handleIngest = async (req: Request, res: Response): Promise<void> => {
    if (req.body?.protocolVersion !== REMOTE_SPOOL_PROTOCOL_VERSION) {
      res.status(400).json({ error: 'Unsupported remote spool protocol', code: 'UNSUPPORTED_SPOOL_PROTOCOL' });
      return;
    }
    const parsed = remoteSpoolEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid remote spool envelope', code: 'INVALID_SPOOL_ENTRY' });
      return;
    }
    const entry = normalizeRemoteSpoolEntry(parsed.data.entry);
    if (isLiveObserverEvent(entry.kind)) {
      // The existing authenticated endpoint remains wire-compatible. Keep a
      // receipt, never the inference payload, so retries cannot buy it twice.
      const receipt = remoteHookSpoolReceipt(entry);
      const markers = this.consumedMarkers();
      if (!markers.isConsumed(receipt)) {
        // Reserve synchronously before any await: concurrent redelivery and
        // a crash after acceptance must not send this fragment again. Failed
        // live capture is skipped; this receipt is not a recovery checkpoint.
        markers.markConsumed(receipt, Date.now());
        await ingestHookSpoolEntry(entry, () => {});
      }
      res.status(202).json({ protocolVersion: REMOTE_SPOOL_PROTOCOL_VERSION, status: 'accepted', receipt });
      return;
    }
    const receipt = this.spool.enqueueRemote(entry, this.consumedMarkers());
    logger.debug('HTTP', 'Remote hook spool event accepted', { kind: entry.kind, receipt });
    this.requestDrain();
    res.status(202).json({ protocolVersion: REMOTE_SPOOL_PROTOCOL_VERSION, status: 'accepted', receipt });
  };
}
