import { timingSafeEqual } from 'crypto';
import type { Application, Request, Response } from 'express';
import { HookSpool, type HookSpoolConsumedMarkers } from '../../../../shared/hook-spool.js';
import { normalizeRemoteSpoolEntry, remoteSpoolEnvelopeSchema,
  remoteHookSpoolToken, REMOTE_SPOOL_PROTOCOL_VERSION } from '../../../../shared/hook-spool-remote.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class HookSpoolRoutes extends BaseRouteHandler {
  constructor(
    private readonly spool: HookSpool,
    private readonly consumedMarkers: () => HookSpoolConsumedMarkers,
    private readonly requestDrain: () => void,
    private readonly getToken: () => string,
  ) { super(); }

  setupRoutes(app: Application): void {
    app.post('/api/spool/ingest', this.wrapHandler(this.handleIngest));
  }

  private handleIngest = (req: Request, res: Response): void => {
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
    const receipt = this.spool.enqueueRemote(entry, this.consumedMarkers());
    this.requestDrain();
    res.status(202).json({ protocolVersion: REMOTE_SPOOL_PROTOCOL_VERSION, status: 'accepted', receipt });
  };
}
