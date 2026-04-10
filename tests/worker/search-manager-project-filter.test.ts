/**
 * Tests for SearchManager project-scoped search (#1539)
 *
 * searchObservations() and searchSessions() were ignoring the `project`
 * query parameter — they called queryChroma and SQLite hydration without
 * passing the project filter. This caused cross-project result leakage.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({ name: 'code', prompts: {}, observation_types: [], observation_concepts: [] }),
      getObservationTypes: () => [],
      getTypeIcon: () => '?',
      getWorkEmoji: () => '',
    }),
  },
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
}));

import { SearchManager } from '../../src/services/worker/SearchManager.js';

function buildMocks() {
  const chromaQueryArgs: any[] = [];

  // Minimal Chroma mock: records call args, returns empty (simulates no recent results)
  const chromaSync = {
    queryChroma: mock(async (query: string, limit: number, whereFilter?: any) => {
      chromaQueryArgs.push({ query, limit, whereFilter });
      return { ids: [], distances: [], metadatas: [] };
    }),
  } as any;

  const sessionStore = {
    getObservationsByIds: mock((_ids: number[], opts?: any) => []),
    getSessionSummariesByIds: mock((_ids: number[], opts?: any) => []),
  } as any;

  const sessionSearch = {} as any;
  const formatter = {
    formatTableHeader: () => 'header',
    formatObservationIndex: () => '',
    formatSessionIndex: () => '',
  } as any;
  const timelineService = {} as any;

  const manager = new SearchManager(sessionSearch, sessionStore, chromaSync, formatter, timelineService);

  return { manager, chromaSync, sessionStore, chromaQueryArgs };
}

describe('SearchManager - project filter (#1539)', () => {
  describe('searchObservations()', () => {
    it('passes project to Chroma where filter when project is provided', async () => {
      const { manager, chromaQueryArgs } = buildMocks();

      await manager.searchObservations({ query: 'typescript refactor', project: 'my-project' });

      expect(chromaQueryArgs.length).toBe(1);
      expect(chromaQueryArgs[0].whereFilter).toEqual({ project: 'my-project' });
    });

    it('does not add project filter to Chroma when project is absent', async () => {
      const { manager, chromaQueryArgs } = buildMocks();

      await manager.searchObservations({ query: 'typescript refactor' });

      expect(chromaQueryArgs.length).toBe(1);
      expect(chromaQueryArgs[0].whereFilter).toBeUndefined();
    });

    it('passes project to SQLite hydration when Chroma returns results', async () => {
      const { manager, sessionStore, chromaQueryArgs } = buildMocks();

      // Override Chroma mock to return one result (triggers SQLite hydration)
      (sessionStore as any).parent_chromaSync = undefined;
      const now = Date.now();
      (manager as any).chromaSync = {
        queryChroma: mock(async (_q: string, _l: number, whereFilter?: any) => {
          chromaQueryArgs.push({ whereFilter });
          return {
            ids: [42],
            distances: [0.1],
            metadatas: [{ doc_type: 'observation', project: 'my-project', created_at_epoch: now }],
          };
        }),
      };

      await manager.searchObservations({ query: 'auth bug', project: 'my-project' });

      const hydrationCall = sessionStore.getObservationsByIds.mock.calls[0];
      expect(hydrationCall).toBeDefined();
      const hydrationOpts = hydrationCall[1];
      expect(hydrationOpts.project).toBe('my-project');
    });
  });

  describe('searchSessions()', () => {
    it('includes project in Chroma where filter alongside doc_type filter', async () => {
      const { manager, chromaQueryArgs } = buildMocks();

      await manager.searchSessions({ query: 'login session', project: 'frontend' });

      expect(chromaQueryArgs.length).toBe(1);
      const whereFilter = chromaQueryArgs[0].whereFilter;
      // Should use $and to combine doc_type + project filters
      expect(whereFilter).toHaveProperty('$and');
      const conditions: any[] = whereFilter.$and;
      expect(conditions).toContainEqual({ doc_type: 'session_summary' });
      expect(conditions).toContainEqual({ project: 'frontend' });
    });

    it('uses only doc_type filter in Chroma when project is absent', async () => {
      const { manager, chromaQueryArgs } = buildMocks();

      await manager.searchSessions({ query: 'login session' });

      expect(chromaQueryArgs.length).toBe(1);
      expect(chromaQueryArgs[0].whereFilter).toEqual({ doc_type: 'session_summary' });
    });

    it('passes project to SQLite hydration when Chroma returns results', async () => {
      const { manager, sessionStore, chromaQueryArgs } = buildMocks();

      const now = Date.now();
      (manager as any).chromaSync = {
        queryChroma: mock(async (_q: string, _l: number, whereFilter?: any) => {
          chromaQueryArgs.push({ whereFilter });
          return {
            ids: [10],
            distances: [0.2],
            metadatas: [{ doc_type: 'session_summary', project: 'backend', created_at_epoch: now }],
          };
        }),
      };

      await manager.searchSessions({ query: 'deployment', project: 'backend' });

      const hydrationCall = sessionStore.getSessionSummariesByIds.mock.calls[0];
      expect(hydrationCall).toBeDefined();
      const hydrationOpts = hydrationCall[1];
      expect(hydrationOpts.project).toBe('backend');
    });
  });
});
