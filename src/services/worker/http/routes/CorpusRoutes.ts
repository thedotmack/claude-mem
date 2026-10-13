
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { CorpusStore, CORPUS_NAME_PATTERN, CORPUS_NAME_ERROR } from '../../knowledge/CorpusStore.js';
import { CorpusBuilder } from '../../knowledge/CorpusBuilder.js';
import { KnowledgeAgent } from '../../knowledge/KnowledgeAgent.js';
import type { CorpusFilter } from '../../knowledge/types.js';
import { logger } from '../../../../utils/logger.js';

const ALLOWED_CORPUS_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change', 'security_alert', 'security_note', 'sensitive'] as const;
const ALLOWED_CORPUS_TYPE_SET = new Set<string>(ALLOWED_CORPUS_TYPES);

const stringArrayLike = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string().min(1)).optional());

const positiveIntegerLike = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}, z.number().int().positive().optional());

const buildCorpusSchema = z.object({
  // Validate the raw name — do NOT .trim() first, or a padded name like
  // " bad " would be silently normalized to "bad" and accepted instead of
  // rejected. CORPUS_NAME_PATTERN already disallows whitespace, so surrounding
  // spaces correctly fail here and return a 400.
  name: z.string().min(1).regex(CORPUS_NAME_PATTERN, CORPUS_NAME_ERROR),
  description: z.string().optional(),
  project: z.string().optional(),
  types: stringArrayLike.refine(
    (arr) => arr === undefined || arr.every((t) => ALLOWED_CORPUS_TYPE_SET.has(t)),
    { message: `types must contain only ${ALLOWED_CORPUS_TYPES.join(', ')}` }
  ),
  concepts: stringArrayLike,
  files: stringArrayLike,
  query: z.string().optional(),
  // Accept both the snake_case names this route reads and the camelCase names
  // the MCP tool sends. Without the camelCase aliases the dates passed by
  // `build_corpus` slipped through `.passthrough()` unread, so the stored
  // filter kept no date range at all.
  date_start: z.string().optional(),
  date_end: z.string().optional(),
  dateStart: z.string().optional(),
  dateEnd: z.string().optional(),
  limit: positiveIntegerLike,
}).passthrough();

const queryCorpusSchema = z.object({
  question: z.string().trim().min(1),
}).passthrough();

/** One finished corpus request: the HTTP status and JSON body the JSON mode sends. */
interface CorpusOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Comment-line heartbeat cadence for SSE mode (the MCP client's idle window is 30 s). */
const DEFAULT_CORPUS_SSE_HEARTBEAT_INTERVAL_MS = 10_000;

export interface CorpusRoutesOptions {
  sseHeartbeatIntervalMs?: number;
}

function clientAcceptsEventStream(req: Request): boolean {
  const acceptHeader = req.headers.accept;
  return typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream');
}

function writeSseEvent(res: Response, eventName: 'result' | 'error', data: Record<string, unknown>): void {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * build / rebuild / prime / reprime / query can run for minutes (an Agent SDK
 * session over a whole corpus). With `Accept: text/event-stream` the route
 * answers at once with SSE: a `: ping` comment every heartbeat interval, then
 * exactly one terminal event — `result` (data = the JSON body the JSON mode
 * returns) or `error` (data = the JSON error body plus its HTTP `status`).
 * Without that header the route keeps its single JSON response.
 *
 * Either way, a client that disconnects before the work settles aborts it
 * (the AbortController reaches the Agent SDK `query()`), so nobody pays for an
 * answer nobody is waiting on.
 */
export class CorpusRoutes extends BaseRouteHandler {
  private readonly sseHeartbeatIntervalMs: number;

  constructor(
    private corpusStore: CorpusStore,
    private corpusBuilder: CorpusBuilder,
    private knowledgeAgent: KnowledgeAgent,
    options: CorpusRoutesOptions = {}
  ) {
    super();
    this.sseHeartbeatIntervalMs = options.sseHeartbeatIntervalMs ?? DEFAULT_CORPUS_SSE_HEARTBEAT_INTERVAL_MS;
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/corpus', validateBody(buildCorpusSchema), this.handleBuildCorpus.bind(this));
    app.get('/api/corpus', this.handleListCorpora.bind(this));
    app.get('/api/corpus/:name', this.handleGetCorpus.bind(this));
    app.delete('/api/corpus/:name', this.handleDeleteCorpus.bind(this));
    app.post('/api/corpus/:name/rebuild', this.handleRebuildCorpus.bind(this));
    app.post('/api/corpus/:name/prime', this.handlePrimeCorpus.bind(this));
    app.post('/api/corpus/:name/query', validateBody(queryCorpusSchema), this.handleQueryCorpus.bind(this));
    app.post('/api/corpus/:name/reprime', this.handleReprimeCorpus.bind(this));
  }

  private corpusNotFoundBody(name: string): Record<string, unknown> {
    return {
      error: `Corpus "${name}" not found`,
      fix: 'Check the corpus name or build a new one',
      available: this.corpusStore.list().map(c => c.name)
    };
  }

  private corpusNotFound(res: Response, name: string): void {
    res.status(404).json(this.corpusNotFoundBody(name));
  }

  private corpusNotFoundOutcome(name: string): CorpusOutcome {
    return { status: 404, body: this.corpusNotFoundBody(name) };
  }

  /**
   * Run long corpus work under a client-disconnect abort, answering as SSE or
   * JSON depending on the Accept header (see the class comment).
   */
  private async runLongCorpusWork(
    req: Request,
    res: Response,
    work: (abortController: AbortController) => Promise<CorpusOutcome>
  ): Promise<void> {
    const abortController = new AbortController();
    let workSettled = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };
    const abortWhenClientDisconnects = (): void => {
      if (workSettled || abortController.signal.aborted) return;
      stopHeartbeat();
      abortController.abort(new Error(`Client disconnected before ${req.path} finished`));
    };
    // Node fires res 'close' on a dropped client; Bun's node:http only fires the
    // socket's 'close' (Phase 4 finding), so watch both.
    const clientSocket = req.socket;
    res.on('close', abortWhenClientDisconnects);
    clientSocket.on('close', abortWhenClientDisconnects);

    const streamAsSse = clientAcceptsEventStream(req);
    if (streamAsSse) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(': ping\n\n');
      heartbeatTimer = setInterval(() => res.write(': ping\n\n'), this.sseHeartbeatIntervalMs);
    }

    let outcome: CorpusOutcome | null = null;
    let failure: Error | null = null;
    try {
      outcome = await work(abortController);
    } catch (error: unknown) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      workSettled = true;
      stopHeartbeat();
      res.off('close', abortWhenClientDisconnects);
      clientSocket.off('close', abortWhenClientDisconnects);
    }

    if (abortController.signal.aborted) {
      logger.info('HTTP', 'Corpus request abandoned by client; underlying work aborted', {
        path: req.path,
        workError: failure?.message,
      });
      res.end();
      return;
    }

    if (!streamAsSse) {
      if (failure) throw failure;
      if (outcome!.status === 200) res.json(outcome!.body);
      else res.status(outcome!.status).json(outcome!.body);
      return;
    }

    // finally: the stream always closes, even if serialising the terminal event throws
    // (that error still reaches wrapHandler and is logged there).
    try {
      if (failure) {
        // Logs exactly as the JSON mode does; headers are already sent, so it writes nothing.
        this.handleError(res, failure);
        writeSseEvent(res, 'error', { ...this.errorResponseBody(failure), status: this.errorStatusCode(failure) });
      } else if (outcome!.status === 200) {
        writeSseEvent(res, 'result', outcome!.body);
      } else {
        writeSseEvent(res, 'error', { ...outcome!.body, status: outcome!.status });
      }
    } finally {
      res.end();
    }
  }

  private handleBuildCorpus = this.wrapHandler((req: Request, res: Response) => this.runLongCorpusWork(req, res, async () => {
    const body = req.body as z.infer<typeof buildCorpusSchema>;
    const { name, description, project, types, concepts, files, query, limit } = body;
    const dateStart = body.date_start ?? body.dateStart;
    const dateEnd = body.date_end ?? body.dateEnd;

    const filter: CorpusFilter = {};
    if (project) filter.project = project;
    if (types && types.length > 0) filter.types = types as CorpusFilter['types'];
    if (concepts && concepts.length > 0) filter.concepts = concepts;
    if (files && files.length > 0) filter.files = files;
    if (query) filter.query = query;
    if (dateStart) filter.date_start = dateStart;
    if (dateEnd) filter.date_end = dateEnd;
    if (limit !== undefined) filter.limit = limit;

    logger.info('SEARCH', 'Building corpus', { name, project, filterKeys: Object.keys(filter) });
    const corpus = await this.corpusBuilder.build(name, description || '', filter);

    const { observations, ...metadata } = corpus;
    return { status: 200, body: metadata };
  }));

  private handleListCorpora = this.wrapHandler((_req: Request, res: Response): void => {
    const corpora = this.corpusStore.list();
    res.json({
      content: [{ type: 'text', text: JSON.stringify(corpora, null, 2) }]
    });
  });

  private handleGetCorpus = this.wrapHandler((req: Request, res: Response): void => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      this.corpusNotFound(res, name);
      return;
    }

    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  private handleDeleteCorpus = this.wrapHandler((req: Request, res: Response): void => {
    const name = this.toStringParam(req.params.name);
    const existed = this.corpusStore.delete(name);

    if (!existed) {
      this.corpusNotFound(res, name);
      return;
    }

    res.json({ success: true });
  });

  private handleRebuildCorpus = this.wrapHandler((req: Request, res: Response) => this.runLongCorpusWork(req, res, async () => {
    const name = this.toStringParam(req.params.name);
    const previousCorpus = this.corpusStore.read(name);

    if (!previousCorpus) return this.corpusNotFoundOutcome(name);

    const force = req.body?.force === true;
    const previousCount = previousCorpus.stats.observation_count;

    // Build without writing, decide, then write: a rebuild that would shrink the corpus
    // never touches the stored file unless the caller confirms it with force, so a stale
    // or wrong filter cannot silently destroy user-created state.
    const corpus = await this.corpusBuilder.build(name, previousCorpus.description, previousCorpus.filter, { writeFile: false });
    const newCount = corpus.stats.observation_count;

    if (!force && this.isDestructiveShrink(previousCount, newCount)) {
      return {
        status: 409,
        body: {
          error: `Rebuild would shrink corpus "${name}" from ${previousCount} to ${newCount} observations`,
          fix: 'The previous corpus was kept. Re-run with force=true to accept the smaller result, or check the stored date filter.',
          filter: previousCorpus.filter,
          previous_count: previousCount,
          rebuilt_count: newCount,
        },
      };
    }

    this.corpusStore.write(corpus);
    const { observations, ...metadata } = corpus;
    return { status: 200, body: metadata };
  }));

  // A rebuild that keeps more than half of a non-trivial corpus is treated as a
  // routine refresh; keeping half or less is a destructive shrink that must be
  // confirmed. The floor keeps tiny corpora from tripping the guard on normal
  // churn.
  private isDestructiveShrink(previousCount: number, newCount: number): boolean {
    return previousCount >= 4 && newCount <= previousCount / 2;
  }

  private handlePrimeCorpus = this.wrapHandler((req: Request, res: Response) => this.runLongCorpusWork(req, res, async (abortController) => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) return this.corpusNotFoundOutcome(name);

    const sessionId = await this.knowledgeAgent.prime(corpus, { abortController });
    return { status: 200, body: { session_id: sessionId, name: corpus.name } };
  }));

  private handleQueryCorpus = this.wrapHandler((req: Request, res: Response) => this.runLongCorpusWork(req, res, async (abortController) => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) return this.corpusNotFoundOutcome(name);

    const { question } = req.body;
    const result = await this.knowledgeAgent.query(corpus, question, { abortController });
    return { status: 200, body: { answer: result.answer, session_id: result.session_id } };
  }));

  private handleReprimeCorpus = this.wrapHandler((req: Request, res: Response) => this.runLongCorpusWork(req, res, async (abortController) => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) return this.corpusNotFoundOutcome(name);

    const sessionId = await this.knowledgeAgent.reprime(corpus, { abortController });
    return { status: 200, body: { session_id: sessionId, name: corpus.name } };
  }));
}
