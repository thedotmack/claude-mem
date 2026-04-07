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
import type { CorpusFilter } from '../../knowledge/types.js';

export class CorpusRoutes extends BaseRouteHandler {
  constructor(
    private corpusStore: CorpusStore,
    private corpusBuilder: CorpusBuilder
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/corpus', this.handleBuildCorpus.bind(this));
    app.get('/api/corpus', this.handleListCorpora.bind(this));
    app.get('/api/corpus/:name', this.handleGetCorpus.bind(this));
    app.delete('/api/corpus/:name', this.handleDeleteCorpus.bind(this));
    app.post('/api/corpus/:name/rebuild', this.handleRebuildCorpus.bind(this));
  }

  /**
   * Build a new corpus from matching observations
   * POST /api/corpus
   * Body: { name, description?, project?, types?, concepts?, files?, query?, date_start?, date_end?, limit? }
   */
  private handleBuildCorpus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (!this.validateRequired(req, res, ['name'])) return;

    const { name, description, project, types, concepts, files, query, date_start, date_end, limit } = req.body;

    const filter: CorpusFilter = {};
    if (project) filter.project = project;
    if (types) filter.types = types;
    if (concepts) filter.concepts = concepts;
    if (files) filter.files = files;
    if (query) filter.query = query;
    if (date_start) filter.date_start = date_start;
    if (date_end) filter.date_end = date_end;
    if (limit) filter.limit = limit;

    const corpus = await this.corpusBuilder.build(name, description || '', filter);

    // Return stats without the full observations array
    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });

  /**
   * List all corpora with stats
   * GET /api/corpus
   */
  private handleListCorpora = this.wrapHandler((_req: Request, res: Response): void => {
    const corpora = this.corpusStore.list();
    res.json(corpora);
  });

  /**
   * Get corpus metadata (without observations)
   * GET /api/corpus/:name
   */
  private handleGetCorpus = this.wrapHandler((req: Request, res: Response): void => {
    const { name } = req.params;
    const corpus = this.corpusStore.read(name);

    if (!corpus) {
      this.notFound(res, `Corpus "${name}" not found`);
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
      this.notFound(res, `Corpus "${name}" not found`);
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
      this.notFound(res, `Corpus "${name}" not found`);
      return;
    }

    const corpus = await this.corpusBuilder.build(name, existingCorpus.description, existingCorpus.filter);

    // Return stats without the full observations array
    const { observations, ...metadata } = corpus;
    res.json(metadata);
  });
}
