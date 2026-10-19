import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { DATA_DIR, DB_PATH, USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../../../shared/openrouter-base-url.js';
import { logger } from '../../../../utils/logger.js';
import { formatHostForUrl } from '../../../../shared/worker-url.js';
import { hasForwardedClientHeaders, hasLoopbackHostHeader, isLocalhost } from '../../../../server/middleware/request-auth-helpers.js';
import { WorkStateSource, type WorkViewSnapshot } from '../../../work-view/data-source.mjs';
import { contentFingerprint, LocalReviewStore } from '../../../work-view/review-store.js';
import { chatCompletionsHumanCopyProvider, HumanCopyWorker } from '../../../work-view/human-copy-worker.mjs';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';

const reviewBody = z.object({
  requestId: z.string().min(1).max(2000),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  checked: z.boolean(),
}).strict();

// The viewer is local even when another worker surface is explicitly exposed.
// Match the existing request-auth helpers, including rejecting proxy headers.
export function workViewLoopbackOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalhost(req) || !hasLoopbackHostHeader(req) || hasForwardedClientHeaders(req)) {
    res.status(403).json({ error: 'Work view is available only on this computer.' });
    return;
  }
  next();
}

export function requireWorkViewOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  let valid = req.get('sec-fetch-site') !== 'cross-site';
  if (origin) {
    try {
      const from = new URL(origin);
      const authority = /^(\[::1\]|127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(req.get('host') ?? '');
      if (!authority) throw new Error('Invalid local authority');
      const to = new URL(`http://${formatHostForUrl(authority[1])}${authority[2] ? `:${authority[2]}` : ''}`);
      valid = valid && from.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '[::1]'].includes(from.hostname)
        && from.port === to.port;
    } catch { valid = false; }
  }
  if (!valid || !req.is('application/json')) {
    res.status(403).json({ error: 'Review changes must come from the local work viewer.' });
    return;
  }
  next();
}

interface WorkViewOptions {
  databasePath?: string;
  reviewPath?: string;
  pollIntervalMs?: number;
  getLocalDeviceId?: () => string;
  humanCopy?: HumanCopyWorker | null;
}

type HumanCopyProvider = ReturnType<typeof chatCompletionsHumanCopyProvider>;

/** Readable request summaries use the observer endpoint the user already
 * configured. Other providers keep the recorded wording. */
export function configuredHumanCopyProvider(settingsPath = USER_SETTINGS_PATH): HumanCopyProvider | null {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true });
  const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY?.trim();
  if (settings.CLAUDE_MEM_PROVIDER !== 'openrouter' || !apiKey) return null;
  return chatCompletionsHumanCopyProvider({
    url: resolveOpenRouterChatCompletionsUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL),
    apiKey,
    model: settings.CLAUDE_MEM_OPENROUTER_MODEL,
  });
}

export class WorkViewRoutes extends BaseRouteHandler {
  private source: WorkStateSource;
  private reviews: LocalReviewStore;
  private clients = new Set<Response>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private signature = '';
  private closed = false;
  private pollIntervalMs: number;
  private getLocalDeviceId: () => string;
  private humanCopy: HumanCopyWorker | null;

  constructor(options: WorkViewOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.getLocalDeviceId = options.getLocalDeviceId ?? (() => '');
    this.source = new WorkStateSource({ databasePath: options.databasePath ?? DB_PATH, pollIntervalMs: this.pollIntervalMs });
    this.reviews = new LocalReviewStore(options.reviewPath ?? join(DATA_DIR, 'work-view-reviews.db'));
    this.humanCopy = options.humanCopy === undefined
      ? new HumanCopyWorker({ provider: configuredHumanCopyProvider(), cachePath: join(DATA_DIR, 'work-view', 'human-copy.json') })
      : options.humanCopy;
    if (this.humanCopy) void this.humanCopy.load().then(() => this.humanCopy?.start());
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/work-view', workViewLoopbackOnly, this.wrapHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(this.snapshot());
    }));
    app.get('/api/work-view/events', workViewLoopbackOnly, this.wrapHandler(this.events));
    app.get('/api/work-view/evidence/:kind/:id', workViewLoopbackOnly, this.wrapHandler((req, res) => {
      const id = this.parseIntParam(req, res, 'id');
      if (id === null) return;
      const evidence = this.source.evidence(this.toStringParam(req.params.kind), id);
      res.setHeader('Cache-Control', 'no-store');
      if (!evidence) { this.notFound(res, 'Recorded evidence not found.'); return; }
      res.json(evidence);
    }));
    app.post('/api/work-view/review', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(reviewBody), this.wrapHandler(this.review));
  }

  private snapshot(): WorkViewSnapshot {
    this.source.localDeviceId = this.getLocalDeviceId();
    const snapshot = this.source.read().agentView;
    for (const request of snapshot.humanRequests) {
      request.contentFingerprint = contentFingerprint(request);
      request.review = this.reviews.read(request.id, request.contentFingerprint);
    }
    const reviewRevision = createHash('sha256').update(JSON.stringify(snapshot.humanRequests.map(request => [request.id, request.contentFingerprint, request.review]))).digest('hex').slice(0, 16);
    // Generated wording is display only: it never changes what was reviewed.
    const view = this.humanCopy ? this.humanCopy.observe(snapshot) as WorkViewSnapshot : snapshot;
    return { ...view, revision: `${snapshot.revision}:${reviewRevision}:${this.humanCopy?.revision ?? 0}` };
  }

  private review = (req: Request, res: Response): void => {
    const { requestId, expectedFingerprint, checked } = req.body as z.infer<typeof reviewBody>;
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before reviewing.' }); return; }
    const request = snapshot.humanRequests.find(item => item.id === requestId);
    if (!request) { this.notFound(res, 'Request is outside the loaded work.'); return; }
    if (request.review?.available === false) { res.status(503).json({ error: 'Local review storage is unavailable. Your source work is unchanged.' }); return; }
    if (request.contentFingerprint !== expectedFingerprint) {
      res.status(409).json({ error: 'This work changed. Read the latest result before checking it.', snapshot });
      return;
    }
    const lifecycle = request.lifecycle;
    const complete = lifecycle?.explicit && (lifecycle.complete === true || ['done', 'completed', 'complete', 'shipped', 'delivered'].includes(String(lifecycle.status).toLowerCase()));
    if (checked && !complete) { res.status(409).json({ error: 'This request has not been reported complete.', snapshot }); return; }
    this.reviews.set(requestId, expectedFingerprint, checked);
    logger.debug('HTTP', 'Local work review updated', { checked });
    const updated = this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  private events = (req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    this.clients.add(res);
    const socket = res.socket;
    const cleanup = () => {
      this.clients.delete(res);
      req.off('close', cleanup);
      res.off('close', cleanup);
      socket?.off('close', cleanup);
      if (!this.clients.size) this.stopTimers();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    socket?.on('close', cleanup);
    res.on('error', () => { cleanup(); res.destroy(); });
    this.send(res, 'work-view', this.snapshot());
    if (!this.poll) this.poll = setInterval(() => this.publish(), this.pollIntervalMs);
    if (!this.heartbeat) this.heartbeat = setInterval(() => {
      const snapshot = this.snapshot();
      for (const client of this.clients) this.send(client, 'heartbeat', { at: new Date().toISOString(), source: snapshot.source });
    }, 15000);
    this.poll?.unref(); this.heartbeat?.unref();
  };

  private send(res: Response, event: string, value: unknown): void {
    if (res.destroyed || res.writableEnded || res.writableLength > 4 * 1024 * 1024) {
      this.clients.delete(res); res.destroy(); return;
    }
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
    catch { this.clients.delete(res); res.destroy(); }
  }

  private publish(snapshot = this.snapshot()): void {
    if (this.closed) return;
    const signature = JSON.stringify([snapshot.revision, snapshot.source.connected, snapshot.source.error]);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const client of this.clients) this.send(client, 'work-view', snapshot);
  }

  private stopTimers(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.poll = null; this.heartbeat = null;
  }

  getClientCount(): number { return this.clients.size; }

  close(): void {
    this.closed = true;
    this.stopTimers();
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.source.close();
    this.reviews.close();
    this.humanCopy?.close();
  }
}
