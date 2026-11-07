import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { hasForwardedClientHeaders, hasLoopbackHostHeader, isLocalhost } from '../../../../server/middleware/request-auth-helpers.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { SyncRecoveryError } from '../../../sync/SyncConflictRecovery.js';
import { RecoveryError } from '../../../sync/SyncRecovery.js';
import { logger } from '../../../../utils/logger.js';

const kind = z.enum(['observation', 'summary', 'prompt', 'work_state']);
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/).max(20);
const scope = z.object({
  project: z.string().min(1).max(512), from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
  kinds: z.array(kind).min(1).max(4).refine(values => new Set(values).size === values.length),
  maxItems: z.number().int().min(1).max(1000).optional(),
}).strict().refine(value => Date.parse(value.from) < Date.parse(value.to));
const create = z.object({ scope, previewToken: z.string().min(1).max(100) }).strict();
const transition = z.object({ action: z.enum(['resume', 'pause', 'cancel']), expectedEpoch: decimal.nullable().optional() }).strict()
  .refine(value => value.action !== 'resume' || Object.hasOwn(value, 'expectedEpoch'));
const conflict = z.object({ kind, originLocalId: decimal, choice: z.literal('local_current') }).strict();
const apply = z.object({ previewToken: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
const jobId = z.string().uuid();

/** Recovery owns sensitive scope/authority controls, even when the viewer is broadcast remotely. */
export function requireRecoveryLocal(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalhost(req) || !hasLoopbackHostHeader(req) || hasForwardedClientHeaders(req)
    || req.get('sec-fetch-site') === 'cross-site' || isForeignLoopbackBrowserWrite(req)
    || (req.method === 'POST' && !req.is('application/json'))) {
    res.status(403).json({ code: 'recovery_local_only' }); return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}

type RecoveryManager = Pick<DatabaseManager, 'getCloudSync' | 'getSyncRecoveryReader' | 'getSyncConflictRecovery'>;

/** Explicit recovery endpoints; preview never creates a job or wakes the uploader. */
export class SyncRecoveryRoutes {
  constructor(private readonly manager: RecoveryManager) {}

  setupRoutes(app: express.Application): void {
    const base = '/api/sync/recovery';
    app.get(`${base}/inventory`, requireRecoveryLocal, this.handle(async () => this.reader().inventory()));
    app.post(`${base}/preview`, requireRecoveryLocal, this.handle(async req => this.reader().preview(this.parse(scope, req.body))));
    app.get(`${base}/jobs`, requireRecoveryLocal, this.handle(async () => this.recovery().list()));
    app.get(`${base}/jobs/:id`, requireRecoveryLocal, this.handle(async req => this.recovery().get(this.parse(jobId, req.params.id))));
    app.post(`${base}/jobs`, requireRecoveryLocal, this.handle(async req => {
      const input = this.parse(create, req.body);
      const preview = await this.reader().preview(input.scope);
      return this.recovery().createFromPreview(preview, input.previewToken);
    }));
    app.post(`${base}/jobs/:id/transition`, requireRecoveryLocal, this.handle(async req => {
      const id = this.parse(jobId, req.params.id);
      const input = this.parse(transition, req.body);
      const result = this.recovery().transition(id, input.action, input.expectedEpoch ?? null);
      if (input.action === 'resume') this.manager.getCloudSync()?.notify();
      return result;
    }));
    app.get(`${base}/conflicts`, requireRecoveryLocal, this.handle(async () => this.conflicts().list()));
    app.post(`${base}/conflicts/preview`, requireRecoveryLocal, this.handle(async req => {
      const input = this.parse(conflict, req.body); return this.conflicts().preview(input);
    }));
    app.post(`${base}/conflicts/apply`, requireRecoveryLocal, this.handle(async req => {
      const input = this.parse(apply, req.body);
      const result = await this.conflicts().apply(input);
      this.manager.getCloudSync()?.notify();
      return result;
    }));
  }

  private recovery() {
    const recovery = this.manager.getCloudSync()?.recovery;
    if (!recovery) throw new SyncRecoveryError('recovery_unconfigured', 503);
    return recovery;
  }
  private reader() {
    const reader = this.manager.getSyncRecoveryReader();
    if (!reader) throw new SyncRecoveryError('recovery_unconfigured', 503);
    return reader;
  }
  private conflicts() {
    const conflicts = this.manager.getSyncConflictRecovery();
    if (!conflicts) throw new SyncRecoveryError('recovery_unconfigured', 503);
    return conflicts;
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new SyncRecoveryError('invalid_recovery_request', 400);
    return result.data;
  }
  private handle(action: (req: Request) => Promise<unknown>) {
    return (req: Request, res: Response): void => {
      void action(req).then(result => res.json(result)).catch((error: unknown) => {
        if (error instanceof SyncRecoveryError || error instanceof RecoveryError) {
          logger.debug('CLOUD_SYNC', 'Recovery request refused', { status: error.status });
          res.status(error.status).json({ code: error.code }); return;
        }
        // Database/transport failures can contain tokens, native content or filesystem paths.
        // Only fixed diagnostic codes leave this surface.
        const message = error instanceof Error ? error.message : '';
        const code = message.startsWith('Recovery selection exceeds') ? 'recovery_scope_too_large'
          : message.startsWith('Recovery preview is stale') ? 'recovery_preview_stale'
          : message.startsWith('Recovery epoch changed') ? 'recovery_epoch_changed'
          : message.startsWith('Recovery job not found') ? 'recovery_job_not_found'
          : message.startsWith('Cancelled jobs') ? 'recovery_job_cancelled'
          : message === 'Recovery selection is empty' ? 'recovery_selection_empty'
          : message === 'recovery_scope_too_large' ? message
          : message.startsWith('recovery_reader_') ? 'recovery_reader_unavailable'
          : 'recovery_failed';
        const status = code === 'recovery_failed' || code === 'recovery_reader_unavailable' ? 503 : 409;
        logger.debug('CLOUD_SYNC', 'Recovery request failed', { code, status });
        res.status(status).json({ code });
      });
    };
  }
}
