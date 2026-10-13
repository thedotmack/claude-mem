import { describe, expect, it, spyOn } from 'bun:test';
import type { Database, Statement } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { projectReadKeys } from '../../src/services/sqlite/project-read-keys.js';
import {
  queryObservationsMulti,
  queryObservationsNewest,
  querySummariesMulti,
} from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 3, fullObservationCount: 0, sessionCount: 1,
  showReadTokens: false, showWorkTokens: false,
  showSavingsAmount: false, showSavingsPercent: false,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['how-it-works']),
  fullObservationField: 'narrative', showLastSummary: true,
  showLastMessage: false, mainAgentOnly: false,
};

function setup(): SessionStore {
  const store = new SessionStore(':memory:');
  const session = store.createSDKSession('context-content', 'app', 'prompt');
  store.ensureMemorySessionIdRegistered(session, 'context-memory');
  store.storeObservation('context-memory', 'app', {
    type: 'discovery', title: 'Context record', subtitle: null,
    facts: [], narrative: 'Context narrative', concepts: ['how-it-works'],
    files_read: [], files_modified: [],
  }, 1, 0, 1_700_000_000_000);
  store.storeSummary('context-memory', 'app', {
    request: 'Context summary', investigated: 'i', learned: 'l',
    completed: 'c', next_steps: 'n', notes: null,
  }, 1, 0, 1_700_000_000_000);
  return store;
}

function captureStatements(db: Database) {
  const statements: Statement[] = [];
  const prepare = db.prepare.bind(db);
  const spy = spyOn(db, 'prepare').mockImplementation(((...args) => {
    const statement = prepare(...args);
    // Retain the native statements so GC cannot hide a missing finalize().
    statements.push(statement);
    return statement;
  }) as typeof db.prepare);
  return {
    statements,
    cleanup() {
      spy.mockRestore();
      for (const statement of statements) statement.finalize();
    },
  };
}

describe('context query statement ownership', () => {
  it('releases read-key, observation and summary statements while keeping the shared connection open', () => {
    const store = setup();
    const captured = captureStatements(store.db);
    try {
      const projects = projectReadKeys(store.db, ['app']);
      expect(queryObservationsMulti(store, projects, config).map(row => row.title)).toEqual(['Context record']);
      expect(querySummariesMulti(store, projects, config).map(row => row.request)).toEqual(['Context summary']);
      expect(captured.statements).toHaveLength(3);
      expect(captured.statements.map(statement => statement.toString() === '')).toEqual([true, true, true]);
      store.db.exec('SELECT 1');
    } finally {
      captured.cleanup();
      store.close();
    }
  });

  it('releases the house-wide observation statement', () => {
    const store = setup();
    const captured = captureStatements(store.db);
    try {
      expect(queryObservationsNewest(store, config, { limit: 3 }).map(row => row.title)).toEqual(['Context record']);
      expect(captured.statements).toHaveLength(1);
      expect(captured.statements[0].toString()).toBe('');
      store.db.exec('SELECT 1');
    } finally {
      captured.cleanup();
      store.close();
    }
  });

  it('releases every statement when project keys require multiple batches', () => {
    const store = setup();
    const captured = captureStatements(store.db);
    try {
      const projects = ['app', ...Array.from({ length: 250 }, (_, index) => `other-${index}`)];
      expect(queryObservationsMulti(store, projects, config).map(row => row.title)).toEqual(['Context record']);
      expect(querySummariesMulti(store, projects, config).map(row => row.request)).toEqual(['Context summary']);
      expect(captured.statements).toHaveLength(4);
      expect(captured.statements.map(statement => statement.toString() === '')).toEqual([true, true, true, true]);
      store.db.exec('SELECT 1');
    } finally {
      captured.cleanup();
      store.close();
    }
  });

  for (const projects of [undefined, ['app']]) {
    it(`releases the observation statement after an execution error (${projects ? 'project-scoped' : 'house-wide'})`, () => {
      const store = setup();
      store.db.exec("UPDATE observations SET concepts = 'invalid json'");
      const captured = captureStatements(store.db);
      try {
        expect(() => queryObservationsNewest(store, config, { limit: 3, projects })).toThrow(/malformed JSON/);
        expect(captured.statements).toHaveLength(1);
        expect(captured.statements[0].toString()).toBe('');
        store.db.exec('SELECT 1');
      } finally {
        captured.cleanup();
        store.close();
      }
    });
  }
});
