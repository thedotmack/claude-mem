/**
 * Corpus Routes
 *
 * Handles knowledge agent corpus CRUD operations: build, list, get, delete, rebuild.
 * All endpoints delegate to CorpusStore (file I/O) and CorpusBuilder (search + hydrate).
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { CorpusStore } from '../../knowledge/CorpusStore.js';
import { CorpusBuilder } from '../../knowledge/CorpusBuilder.js';
import { KnowledgeAgent } from '../../knowledge/KnowledgeAgent.js';
import type { CorpusFilter } from '../../knowledge/types.js';

const ALLOWED_CORPUS_TYPES = new Set(['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change']);

export class CorpusRoutes extends BaseRouteHandler {
  constructor(
    private corpusStore: CorpusStore,
    private corpusBuilder: CorpusBuilder,
    private knowledgeAgent: KnowledgeAgent
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/corpus', this.handleBuildCorpus.bind(this));
    app.get('/api/corpus', this.handleListCorpora.bind(this));
    app.get('/api/corpus/:name', this.handleGetCorpus.bind(this));
    app.delete('/api/corpus/:name', this.handleDeleteCorpus.bind(this));
    app.post('/api/corpus/:name/rebuild', this.handleRebuildCorpus.bind(this));
    app.post('/api/corpus/:name/prime', this.handlePrimeCorpus.bind(this));
    app.post('/api/corpus/:name/query', this.handleQueryCorpus.bind(this));
    app.post('/api/corpus/:name/reprime', this.handleReprimeCorpus.bind(this));
  }

  /**
   * Build a new corpus from matching observations
   * POST /api/corpus
   * Body: { name, description?, project?, types?, concepts?, files?, query?, date_start?, date_end?, limit? }
   */
  private handleBuildCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (!req.body.name) {
      res.status(400).json({
        error: 'Missing required field: name',
        fix: 'Add a "name" field to your request body',
        example: { name: 'my-corpus', query: 'hooks', limit: 100 }
      });
      return;
    }

    const { name, description, project, types, concepts, files, query, date_start, date_end, limit } = req.body;

    const coercedTypes = this.coerceStringArray(types, 'types', res);
    if (coercedTypes === null) return;
    if (coercedTypes && !coercedTypes.every(type => ALLOWED_CORPUS_TYPES.has(type))) {
      this.badRequest(res, 'types must contain valid observation types');
      return;
    }

    const coercedConcepts = this.coerceStringArray(concepts, 'concepts', res);
    if (coercedConcepts === null) return;

    const coercedFiles = this.coerceStringArray(files, 'files', res);
    if (coercedFiles === null) return;

    const coercedLimit = this.coercePositiveInteger(limit, 'limit', res);
    if (coercedLimit === null) return;

    const filter: CorpusFilter = {};
    if (project) filter.project = project;
    if (coercedTypes && coercedTypes.length > 0) filter.types = coercedTypes as CorpusFilter['types'];
    if (coercedConcepts && coercedConcepts.length > 0) filter.concepts = coercedConcepts;
    if (coercedFiles && coercedFiles.length > 0) filter.files = coercedFiles;
    if (query) filter.query = query;
    if (date_start) filter.date_start = date_start;
    if (date_end) filter.date_end = date_end;
    if (coercedLimit !== undefined) filter.limit = coercedLimit;

    const corpus = await this.corpusBuilder.build(name, description || '', filter);

    // Return stats without the full observations array
    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  private coerceStringArray(value: unknown, fieldName: string, res: Response): string[] | null | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value.split(',').map(part => part.trim()).filter(Boolean);
      }
    }

    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
      this.badRequest(res, `${fieldName} must be an array of strings`);
      return null;
    }

    return parsed.map(item => item.trim()).filter(Boolean);
  }

  private coercePositiveInteger(value: unknown, fieldName: string, res: Response): number | null | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
      this.badRequest(res, `${fieldName} must be a positive integer`);
      return null;
    }

    return parsed;
  }

  /**
   * List all corpora with stats
   * GET /api/corpus
   */
  private handleListCorpora = this.wrapHandler((_req: Request, res: Response): void => {
    const corpora = this.corpusStore.list();
    // Wrap in MCP CallToolResult shape so the MCP server wrapper (callWorkerAPI)
    // can forward it without failing tools/call schema validation.
    // See: #1700 — every other corpus endpoint is a POST that already returns
    // {content:[...]}, but this GET used to return a bare array, which MCP
    // rejects with "expected object, received array".
    res.json({
      content: [{ type: 'text', text: JSON.stringify(corpora, null, 2) }]
    });
  });

  /**
   * Get corpus metadata (without observations)
   * GET /api/corpus/:name
   */
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

    // Return metadata without the full observations array
    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  /**
   * Delete a corpus
   * DELETE /api/corpus/:name
   */
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

  /**
   * Rebuild a corpus from its stored filter
   * POST /api/corpus/:name/rebuild
   */
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

    // Return stats without the full observations array
    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  /**
   * Prime a corpus — load all observations into a new Agent SDK session
   * POST /api/corpus/:name/prime
   */
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

  /**
   * Query a primed corpus — resume the SDK session with a question
   * POST /api/corpus/:name/query
   * Body: { question: string }
   */
  private handleQueryCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { name } = req.params;

    if (!req.body.question || typeof req.body.question !== 'string' || req.body.question.trim().length === 0) {
      res.status(400).json({
        error: 'Missing required field: question',
        fix: 'Add a non-empty "question" string to your request body',
        example: { question: 'What architectural decisions were made about hooks?' }
      });
      return;
    }

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

  /**
   * Reprime a corpus — create a fresh session, clearing prior Q&A context
   * POST /api/corpus/:name/reprime
   */
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
