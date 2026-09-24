
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { CorpusStore, CORPUS_NAME_PATTERN, CORPUS_NAME_ERROR } from '../../knowledge/CorpusStore.js';
import { CorpusBuilder } from '../../knowledge/CorpusBuilder.js';
import { KnowledgeAgent } from '../../knowledge/KnowledgeAgent.js';
import type { CorpusFilter } from '../../knowledge/types.js';
import { KeyedMutex } from '../../../../shared/keyed-mutex.js';
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

export class CorpusRoutes extends BaseRouteHandler {
  // Serializes writes to a given corpus file so a build and a rebuild of the
  // same name cannot interleave. Without this, a destructive rebuild could
  // restore its stale snapshot over a newer concurrent write.
  private readonly corpusMutex = new KeyedMutex();

  constructor(
    private corpusStore: CorpusStore,
    private corpusBuilder: CorpusBuilder,
    private knowledgeAgent: KnowledgeAgent
  ) {
    super();
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

  private corpusNotFound(res: Response, name: string): void {
    res.status(404).json({
      error: `Corpus "${name}" not found`,
      fix: 'Check the corpus name or build a new one',
      available: this.corpusStore.list().map(c => c.name)
    });
  }

  private handleBuildCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
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
    const corpus = await this.corpusMutex.runExclusive(name, () =>
      this.corpusBuilder.build(name, description || '', filter)
    );

    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

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

  private handleRebuildCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const name = this.toStringParam(req.params.name);

    if (!this.corpusStore.read(name)) {
      this.corpusNotFound(res, name);
      return;
    }

    const force = req.body?.force === true;

    // Hold the per-corpus lock across the whole read-build-restore sequence so a
    // concurrent rebuild cannot write between `build` and a possible restore.
    await this.corpusMutex.runExclusive(name, async () => {
      // Re-read under the lock: another rebuild may have finished between the
      // not-found check above and acquiring the lock, so the restore target and
      // the source filter must come from the latest persisted state.
      const previousCorpus = this.corpusStore.read(name);
      if (!previousCorpus) {
        this.corpusNotFound(res, name);
        return;
      }
      const previousCount = previousCorpus.stats.observation_count;

      const corpus = await this.corpusBuilder.build(name, previousCorpus.description, previousCorpus.filter);
      const newCount = corpus.stats.observation_count;

      // `build` has already overwritten the corpus file. If the rebuild dropped
      // a large share of the observations, restore the previous corpus so a
      // stale or wrong filter cannot silently destroy user-created state.
      // `force` opts in to the shrink.
      if (!force && this.isDestructiveShrink(previousCount, newCount)) {
        this.corpusStore.write(previousCorpus);
        res.status(409).json({
          error: `Rebuild would shrink corpus "${name}" from ${previousCount} to ${newCount} observations`,
          fix: 'The previous corpus was kept. Re-run with force=true to accept the smaller result, or check the stored date filter.',
          filter: previousCorpus.filter,
          previous_count: previousCount,
          rebuilt_count: newCount,
        });
        return;
      }

      const { observations, ...metadata } = corpus;
      res.json(metadata);
    });
  });

  // A rebuild that keeps at least half of a non-trivial corpus is treated as a
  // routine refresh; anything below that is a destructive shrink that must be
  // confirmed. The floor keeps tiny corpora from tripping the guard on normal
  // churn.
  private isDestructiveShrink(previousCount: number, newCount: number): boolean {
    return previousCount >= 4 && newCount < previousCount / 2;
  }

  private handlePrimeCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      this.corpusNotFound(res, name);
      return;
    }

    const sessionId = await this.knowledgeAgent.prime(corpus);
    res.json({ session_id: sessionId, name: corpus.name });
  });

  private handleQueryCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      this.corpusNotFound(res, name);
      return;
    }

    const { question } = req.body;
    const result = await this.knowledgeAgent.query(corpus, question);
    res.json({ answer: result.answer, session_id: result.session_id });
  });

  private handleReprimeCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const name = this.toStringParam(req.params.name);
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      this.corpusNotFound(res, name);
      return;
    }

    const sessionId = await this.knowledgeAgent.reprime(corpus);
    res.json({ session_id: sessionId, name: corpus.name });
  });
}
