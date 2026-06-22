import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../worker/http/BaseRouteHandler.js';
import { validateBody } from '../worker/http/middleware/validateBody.js';
import { logger } from '../../utils/logger.js';
import { getWorkerHost, getWorkerPort } from '../../shared/worker-utils.js';
import {
  getApiBaseUrl,
  getDeviceId,
  readCloudConfig,
  writeCloudConfig,
} from './config.js';
import { CloudClient } from './CloudClient.js';
import type { CloudSyncService } from './CloudSyncService.js';

/**
 * Worker-side HTTP control plane for cloud sync. Implements the RouteHandler
 * interface (setupRoutes(app)) and is registered in worker-service.registerRoutes().
 *
 * SECURITY: the connect route accepts a setupToken in the body for the HTTP API,
 * but the CLI entrypoint that calls this MUST read the token from STDIN, never
 * argv (so it does not leak into shell history / process listings). See the note
 * on handleConnect.
 */

const connectSchema = z.object({
  setupToken: z.string().min(1),
  userId: z.string().min(1),
  apiBaseUrl: z.string().url().optional(),
});

const emptySchema = z.object({}).passthrough();

export class CloudRoutes extends BaseRouteHandler {
  private readonly client = new CloudClient();

  /**
   * @param getSync       returns the running sync service (or null if not started)
   * @param ensureSync    lazily creates+starts the service (used by /connect so a
   *                      default-off install can be connected without a restart)
   */
  constructor(
    private readonly getSync: () => CloudSyncService | null,
    private readonly ensureSync: () => CloudSyncService
  ) {
    super();
  }

  setupRoutes(app: Application): void {
    app.get('/api/cloud/status', this.handleStatus);
    app.get('/api/cloud/checkout-url', this.handleCheckoutUrl);
    app.post('/api/cloud/connect', validateBody(connectSchema), this.handleConnect);
    app.post('/api/cloud/disconnect', validateBody(emptySchema), this.handleDisconnect);
    app.post('/api/cloud/sync-now', validateBody(emptySchema), this.handleSyncNow);
  }

  private handleStatus = this.wrapHandler((_req: Request, res: Response): void => {
    const sync = this.getSync();
    if (sync) {
      // Service is up — report its live view (includes outbox depth etc.).
      res.json(sync.buildStatusPublic());
      return;
    }
    // Cloud disabled / service not started: report config-only status.
    const cfg = readCloudConfig();
    res.json({
      connected: Boolean(cfg.userId && cfg.deviceId && cfg.setupToken),
      enabled: cfg.enabled === true,
      syncing: false,
      lane: null,
      outboxDepth: 0,
      quarantined: 0,
      lastAckAt: cfg.lastAckAt ?? null,
      backfill: { done: cfg.backfillDone === true, cursor: cfg.backfillCursor ?? {} },
      authError: false,
    });
  });

  private handleCheckoutUrl = this.wrapHandler((_req: Request, res: Response): void => {
    const base = getApiBaseUrl();
    const workerUrl = `http://${getWorkerHost()}:${getWorkerPort()}`;
    const url = `${base}/dashboard?cloud=1&return_to=${encodeURIComponent(workerUrl)}`;
    res.json({ url });
  });

  /**
   * Connect: validate token (cheap authed GET /status?project=__connectivity__),
   * mint a deviceId, persist cloud-config (enabled:true, chmod 600), and kick
   * startBackfill().
   *
   * VERSION HANDSHAKE: the cloud exposes no worker-version handshake endpoint we
   * can reach, so this is skipped (best-effort, noted). If one is added, gate here.
   *
   * STDIN NOTE: the CLI entrypoint must pipe the token to this route's body from
   * stdin, NEVER pass it on argv. The token is never logged anywhere.
   */
  private handleConnect = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { setupToken, userId, apiBaseUrl } = req.body as z.infer<typeof connectSchema>;

    // Persist identity FIRST (so validateToken reads it from config), then verify.
    const deviceId = getDeviceId();
    writeCloudConfig({
      enabled: true,
      userId,
      deviceId,
      setupToken,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    });

    const validation = await this.client.validateToken();
    if (!validation.valid && validation.authError) {
      // Roll back: do not leave a half-connected enabled config with a bad token.
      writeCloudConfig({ enabled: false, setupToken: undefined });
      res.status(401).json({ error: 'invalid_setup_token', status: validation.status });
      return;
    }

    logger.info('CLOUD', 'Cloud sync connected', { userId, deviceId, status: validation.status });

    // Lazily create + start the engine so a default-off install connects without
    // a worker restart. ensureSync() is idempotent (start() guards re-entry).
    const sync = this.ensureSync();
    sync.start();
    void sync.startBackfill();
    // Token deliberately omitted from the response.
    res.json({ connected: true, deviceId });
  });

  private handleDisconnect = this.wrapHandler((_req: Request, res: Response): void => {
    // Keep identity/cursor; only flip the gate off so a reconnect resumes.
    writeCloudConfig({ enabled: false });
    const sync = this.getSync();
    sync?.stop();
    logger.info('CLOUD', 'Cloud sync disconnected (config retained)');
    res.json({ disconnected: true });
  });

  private handleSyncNow = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const sync = this.getSync();
    if (!sync) {
      res.status(409).json({ error: 'cloud_not_enabled' });
      return;
    }
    await sync.syncNow();
    res.json({ ok: true, status: sync.buildStatusPublic() });
  });
}
