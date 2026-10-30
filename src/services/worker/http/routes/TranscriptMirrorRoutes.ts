import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { requireLocalhost } from '../middleware.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { TranscriptMirror, TranscriptMirrorError } from '../../../transcript-mirror/TranscriptMirror.js';

/** One request carries at most this many messages; a long chat is sent in batches. */
export const MAX_MIRROR_MESSAGES_PER_REQUEST = 500;
/**
 * A request body may be this large. A message is never split across requests, so one long tool
 * result must fit whole; the worker's usual 5 MB limit is skipped for this route (middleware.ts).
 */
export const MAX_MIRROR_REQUEST_BYTES = 64 * 1024 * 1024;

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
});

const messageSchema = z.object({
  id: z.string().min(1).max(400),
  role: z.string().min(1).max(40),
  content: z.unknown().optional(),
  name: z.string().max(200).optional(),
  toolCalls: z.array(toolCallSchema).max(200).optional(),
  toolCallId: z.string().max(400).optional(),
  createdAt: z.string().max(64).optional(),
});

const appendSchema = z.object({
  source: z.string(),
  conversationId: z.string(),
  title: z.string().nullable().optional(),
  messages: z.array(messageSchema).max(MAX_MIRROR_MESSAGES_PER_REQUEST),
});

const STATUS_FOR: Record<TranscriptMirrorError['code'], number> = {
  invalid_input: 400,
  not_found: 404,
  changed_outside: 409,
  corrupt: 500,
};

/**
 * Full chat transcripts kept by claude-mem (services/transcript-mirror). A chat app sends each
 * conversation's messages after every turn; resends are safe because a kept message id is skipped.
 * Loopback only: transcripts are whole conversations, so they never leave this computer through
 * the worker, even when the worker's bind is opened for Observation TV.
 */
export class TranscriptMirrorRoutes extends BaseRouteHandler {
  constructor(private readonly mirror: TranscriptMirror) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post(
      '/api/chat-transcripts',
      requireLocalhost,
      express.json({ limit: MAX_MIRROR_REQUEST_BYTES }),
      validateBody(appendSchema),
      this.handleAppend.bind(this),
    );
    app.get('/api/chat-transcripts', requireLocalhost, this.handleList.bind(this));
    app.get('/api/chat-transcripts/:source/:conversationId', requireLocalhost, this.handleRead.bind(this));
  }

  private fail(res: Response, error: unknown): boolean {
    if (error instanceof TranscriptMirrorError) {
      if (error.code === 'changed_outside' || error.code === 'corrupt') {
        logger.warn('TRANSCRIPT', 'Transcript refused', { code: error.code, message: error.message });
      }
      res.status(STATUS_FOR[error.code]).json({ error: error.code, message: error.message });
      return true;
    }
    return false;
  }

  private handleAppend = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof appendSchema>;
    try {
      const result = await this.mirror.append(body);
      if (result.appended > 0) {
        logger.debug('TRANSCRIPT', 'Messages kept', {
          source: result.source,
          appended: result.appended,
          messageCount: result.messageCount,
        });
      }
      res.json(result);
    } catch (error) {
      if (!this.fail(res, error)) throw error;
    }
  });

  private handleList = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const source = this.toStringParam(req.query.source as string | string[] | undefined) || undefined;
    try {
      res.json({ transcripts: await this.mirror.list(source) });
    } catch (error) {
      if (!this.fail(res, error)) throw error;
    }
  });

  private handleRead = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const source = this.toStringParam(req.params.source);
    const conversationId = this.toStringParam(req.params.conversationId);
    try {
      const { summary, lines } = await this.mirror.read(source, conversationId);
      if (this.toStringParam(req.query.format as string | string[] | undefined) === 'jsonl') {
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.send(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
        return;
      }
      res.json({ ...summary, lines });
    } catch (error) {
      if (!this.fail(res, error)) throw error;
    }
  });
}
