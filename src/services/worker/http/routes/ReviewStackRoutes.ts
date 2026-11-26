import type { Database } from 'bun:sqlite';
import type { Application, Request, Response } from 'express';
import { REVIEW_STACK_CARD_KIND, type ReviewStackSnapshot } from '../../../../shared/review-stack.js';
import { getRedactionConfig } from '../../../../utils/redaction.js';
import { stripMemoryTags } from '../../../../utils/tag-stripping.js';
import {
  prepareReviewStackWrite, renderReviewStack, reviewStackImage, reviewStackPage, ReviewStackError,
} from '../../../work-view/review-stack.js';
import { createSharedRecordReader, publishSharedRecords, readSharedRecordValue } from '../../../work-view/shared-record-store.mjs';
import { isSharedProjectionValue } from '../../../work-view/shared-projection.mjs';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { requireWorkViewOrigin, requireWorkViewReadOrigin, workViewLoopbackOnly } from './WorkViewRoutes.js';

const stackPath = '/api/work-view/review-stack';
// Callers pass the loopback host guard. Include the worker's actual port in both tool results.
const deckUrl = (req: Request) => `${req.protocol}://${req.get('host')}/?view=review-stack`;

function validateReviewValue(...args: Parameters<typeof isSharedProjectionValue>): boolean {
  if (!isSharedProjectionValue(...args)) {
    throw new ReviewStackError(400, 'Add enough visible text to review this item after private sections are removed.');
  }
  return true;
}

/** Review data belongs to this installation. Cloud Sync transfers its reserved rows only when shared My Work is enabled. */
export class ReviewStackRoutes extends BaseRouteHandler {
  private readonly readRecords;
  private rendered?: { sourceRevision: string; redactionKey: string; snapshot: ReviewStackSnapshot };

  constructor(private readonly db: Database, private readonly deviceId: string, private readonly notify: () => void) {
    super();
    this.readRecords = createSharedRecordReader(db, { deviceId, validateValue: validateReviewValue, reviewStack: 'metadata' });
  }

  setupRoutes(app: Application): void {
    app.get(stackPath, workViewLoopbackOnly, requireWorkViewReadOrigin, this.stackHandler((req, res) => {
      const { records, revision } = this.readRecords();
      if (req.query.summary === '1') {
        let itemCount = 0;
        for (const record of records.values()) {
          if (record.kind === REVIEW_STACK_CARD_KIND && !record.deleted) itemCount++;
        }
        res.json({ deckUrl: deckUrl(req), itemCount });
        return;
      }
      if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') {
        this.badRequest(res, 'Invalid review stack cursor.'); return;
      }
      // All cursor pages in a read share one revision. Keep their rendered metadata, which includes only image URLs.
      const policy = getRedactionConfig();
      const redactionKey = policy.enabled ? JSON.stringify(policy) : 'off';
      if (this.rendered?.sourceRevision !== revision || this.rendered.redactionKey !== redactionKey) {
        const snapshot = renderReviewStack(records.values(), {
          thumbnailUrl: (id, imageHash) => `${stackPath}/media/${encodeURIComponent(id)}?revision=${imageHash}`,
          redactText: stripMemoryTags,
        });
        this.rendered = { sourceRevision: revision, redactionKey, snapshot };
      }
      res.json(reviewStackPage(this.rendered.snapshot, req.query.cursor));
    }));

    app.get(`${stackPath}/media/:id`, workViewLoopbackOnly, requireWorkViewReadOrigin, this.stackHandler((req, res) => {
      const revision = req.query.revision;
      if (revision !== undefined && (typeof revision !== 'string' || revision.length !== 64 || /[^a-f0-9]/u.test(revision))) {
        this.badRequest(res, 'Invalid review image revision.'); return;
      }
      // Warm the committed reader before opening our transaction. The reader checks its revision again under the lock.
      // Only its own read transaction can cache newly verified rows; a caller's transaction might roll back.
      this.readRecords();
      const image = this.db.transaction(() => reviewStackImage(
        this.readRecords().records.values(), this.toStringParam(req.params.id),
        head => readSharedRecordValue(this.db, this.deviceId, head), revision,
      ))();
      if (!image) { this.notFound(res, 'Review image not found.'); return; }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.type(image.mimeType).send(Buffer.from(image.bytes));
    }));

    for (const operation of ['import', 'action'] as const) {
      app.post(`${stackPath}/${operation}`, workViewLoopbackOnly, requireWorkViewOrigin, this.stackHandler((req, res) => {
        const id = req.get('Idempotency-Key');
        if (!id) { this.badRequest(res, 'Include an Idempotency-Key for this review change.'); return; }
        this.readRecords();
        // The read, state changes and replay receipt commit under the same SQLite writer lock.
        const { result, changed } = this.db.transaction(() => {
          const write = prepareReviewStackWrite(this.readRecords().records.values(), operation, req.body, id, Date.now(), {
            redactText: stripMemoryTags,
          });
          const { changed } = publishSharedRecords(this.db, {
            deviceId: this.deviceId, project: '__my_work__', reader: this.readRecords,
            validateValue: validateReviewValue, updates: write.updates,
          });
          return { result: write.result, changed };
        }).immediate();
        if (changed) this.notify();
        res.json(operation === 'import' ? { ...result, deckUrl: deckUrl(req) } : result);
      }));
    }
  }

  private stackHandler(handler: (req: Request, res: Response) => void) {
    return this.wrapHandler((req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      try { handler(req, res); }
      catch (error) {
        if (error instanceof ReviewStackError) { res.status(error.status).json({ error: error.message }); return; }
        throw error;
      }
    });
  }
}
