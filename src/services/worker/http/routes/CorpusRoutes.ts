
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { CorpusStore } from '../../knowledge/CorpusStore.js';
import { CorpusBuilder } from '../../knowledge/CorpusBuilder.js';
import { KnowledgeAgent } from '../../knowledge/KnowledgeAgent.js';
import type { CorpusFilter } from '../../knowledge/types.js';

const ALLOWED_CORPUS_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change', 'security_alert', 'security_note'] as const;
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
  name: z.string().min(1),
  description: z.string().optional(),
  project: z.string().optional(),
  types: stringArrayLike.refine(
    (arr) => arr === undefined || arr.every((t) => ALLOWED_CORPUS_TYPE_SET.has(t)),
    { message: `types must contain only ${ALLOWED_CORPUS_TYPES.join(', ')}` }
  ),
  concepts: stringArrayLike,
  files: stringArrayLike,
  query: z.string().optional(),
  date_start: z.string().optional(),
  date_end: z.string().optional(),
  limit: positiveIntegerLike,
}).passthrough();

const queryCorpusSchema = z.object({
  question: z.string().trim().min(1),
}).passthrough();

const emptyBodySchema = z.object({}).passthrough();

export class CorpusRoutes extends BaseRouteHandler {
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
    app.post('/api/corpus/:name/rebuild', validateBody(emptyBodySchema), this.handleRebuildCorpus.bind(this));
    app.post('/api/corpus/:name/prime', validateBody(emptyBodySchema), this.handlePrimeCorpus.bind(this));
    app.post('/api/corpus/:name/query', validateBody(queryCorpusSchema), this.handleQueryCorpus.bind(this));
    app.post('/api/corpus/:name/reprime', validateBody(emptyBodySchema), this.handleReprimeCorpus.bind(this));
  }

  private handleBuildCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { name, description, project, types, concepts, files, query, date_start, date_end, limit } =
      req.body as z.infer<typeof buildCorpusSchema>;

    const filter: CorpusFilter = {};
    if (project) filter.project = project;
    if (types && types.length > 0) filter.types = types as CorpusFilter['types'];
    if (concepts && concepts.length > 0) filter.concepts = concepts;
    if (files && files.length > 0) filter.files = files;
    if (query) filter.query = query;
    if (date_start) filter.date_start = date_start;
    if (date_end) filter.date_end = date_end;
    if (limit !== undefined) filter.limit = limit;

    const corpus = await this.corpusBuilder.build(name, description || '', filter);

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
    const { name } = req.params;
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      res.status(404).json({
        error: `Corpus "${name}" not found`,
        fix: 'Check the corpus name or build a new one',
        available: this.corpusStore.list().map(c => c.name)
      });
      return;
    }

    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  private handleDeleteCorpus = this.wrapHandler((req: Request, res: Response): void => {
    const { name } = req.params;
    const existed = this.corpusStore.delete(name);

    if (!existed) {
      res.status(404).json({
        error: `Corpus "${name}" not found`,
        fix: 'Check the corpus name or build a new one',
        available: this.corpusStore.list().map(c => c.name)
      });
      return;
    }

    res.json({ success: true });
  });

  private handleRebuildCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { name } = req.params;
    const existingCorpus = this.corpusStore.read(name);

    if (!existingCorpus) {
      res.status(404).json({
        error: `Corpus "${name}" not found`,
        fix: 'Check the corpus name or build a new one',
        available: this.corpusStore.list().map(c => c.name)
      });
      return;
    }

    const corpus = await this.corpusBuilder.build(name, existingCorpus.description, existingCorpus.filter);

    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  private handlePrimeCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { name } = req.params;
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      res.status(404).json({
        error: `Corpus "${name}" not found`,
        fix: 'Check the corpus name or build a new one',
        available: this.corpusStore.list().map(c => c.name)
      });
      return;
    }

    const sessionId = await this.knowledgeAgent.prime(corpus);
    res.json({ session_id: sessionId, name: corpus.name });
  });

  private handleQueryCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { name } = req.params;
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      res.status(404).json({
        error: `Corpus "${name}" not found`,
        fix: 'Check the corpus name or build a new one',
        available: this.corpusStore.list().map(c => c.name)
      });
      return;
    }

    const { question } = req.body;
    const result = await this.knowledgeAgent.query(corpus, question);
    res.json({ answer: result.answer, session_id: result.session_id });
  });

  private handleReprimeCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { name } = req.params;
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      res.status(404).json({
        error: `Corpus "${name}" not found`,
        fix: 'Check the corpus name or build a new one',
        available: this.corpusStore.list().map(c => c.name)
      });
      return;
    }

    const sessionId = await this.knowledgeAgent.reprime(corpus);
    res.json({ session_id: sessionId, name: corpus.name });
  });
}
