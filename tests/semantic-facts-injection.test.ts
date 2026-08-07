// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { queryActiveFactsMulti } from '../src/services/context/ObservationCompiler.js';
import { renderFactsBlock } from '../src/services/context/sections/FactsRenderer.js';
import { insertFact, supersedeFact, invalidateFact } from '../src/services/sqlite/facts/store.js';
import type { ContextConfig } from '../src/services/context/types.js';

const NOW = new Date('2026-06-17T12:00:00Z');

function makeConfig(factsInjectCount: number): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 0,
    sessionCount: 10,
    factsInjectCount,
    showReadTokens: false,
    showWorkTokens: false,
    showSavingsAmount: false,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['how-it-works']),
    fullObservationField: 'narrative',
    showLastSummary: false,
    showLastMessage: false,
  };
}

function addFact(store: SessionStore, fact: string, kind: string = 'environment'): number {
  return insertFact(store.db, { project: 'proj', kind: kind as any, fact, sourceObservationIds: [] }, NOW).id;
}

describe('Semantic memory layer — facts query for injection', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => store.db.close());

  it('returns only active facts — superseded and invalidated are excluded', () => {
    const live = addFact(store, 'live fact');
    const superseded = addFact(store, 'superseded fact');
    const invalidated = addFact(store, 'invalidated fact');
    supersedeFact(store.db, superseded, live, NOW);
    invalidateFact(store.db, invalidated, NOW);

    const facts = queryActiveFactsMulti({ db: store.db }, ['proj'], makeConfig(15));
    expect(facts.map(f => f.id)).toEqual([live]);
    expect(facts[0].fact).toBe('live fact');
  });

  it('honors the inject cap', () => {
    for (let i = 0; i < 20; i++) addFact(store, `fact number ${i}`);
    const facts = queryActiveFactsMulti({ db: store.db }, ['proj'], makeConfig(15));
    expect(facts.length).toBe(15);
  });

  it('returns nothing when the cap is zero', () => {
    addFact(store, 'a fact');
    expect(queryActiveFactsMulti({ db: store.db }, ['proj'], makeConfig(0))).toEqual([]);
  });
});

describe('Semantic memory layer — facts block rendering', () => {
  it('renders one compact line per fact under a Project Knowledge header', () => {
    const lines = renderFactsBlock([
      { id: 3, project: 'proj', kind: 'environment', fact: 'This project runs on Bun.', created_at_epoch: 1 },
      { id: 7, project: 'proj', kind: 'project_convention', fact: 'Tests run via `bun test`.', created_at_epoch: 2 },
    ]);
    expect(lines[0]).toBe('## Project Knowledge');
    expect(lines).toContain('- #3 [environment] This project runs on Bun.');
    expect(lines).toContain('- #7 [project_convention] Tests run via `bun test`.');
  });

  it('renders nothing for an empty fact set', () => {
    expect(renderFactsBlock([])).toEqual([]);
  });
});

describe('Semantic memory layer — context injection end to end', () => {
  const repoRoot = process.cwd();
  const childScript = `
    import { SessionStore } from './src/services/sqlite/SessionStore.ts';
    import { generateContext } from './src/services/context/ContextBuilder.ts';
    import { insertFact, supersedeFact, invalidateFact } from './src/services/sqlite/facts/store.ts';
    import { ModeManager } from './src/services/domain/ModeManager.ts';
    ModeManager.getInstance().loadMode('code');

    const dbPath = process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db';
    const store = new SessionStore(dbPath);
    const sessionId = store.createSDKSession('content-1', 'facts-proj', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionId, 'memory-1');
    store.storeObservation('memory-1', 'facts-proj', {
      type: 'discovery', title: 'TIMELINE_MARKER_OBS', subtitle: null,
      facts: [], narrative: 'narrative', concepts: ['how-it-works'],
      files_read: [], files_modified: [],
    }, 1, 0, 1_700_000_000_000);

    const now = new Date('2026-06-17T12:00:00Z');
    insertFact(store.db, { project: 'facts-proj', kind: 'environment', fact: 'ACTIVE_FACT_MARKER runs on Bun.', sourceObservationIds: [] }, now);
    const oldFact = insertFact(store.db, { project: 'facts-proj', kind: 'environment', fact: 'SUPERSEDED_FACT_MARKER.', sourceObservationIds: [] }, now);
    const newFact = insertFact(store.db, { project: 'facts-proj', kind: 'environment', fact: 'replacement fact', sourceObservationIds: [] }, now);
    supersedeFact(store.db, oldFact.id, newFact.id, now);
    const dead = insertFact(store.db, { project: 'facts-proj', kind: 'environment', fact: 'INVALIDATED_FACT_MARKER.', sourceObservationIds: [] }, now);
    invalidateFact(store.db, dead.id, now);
    store.close();

    const text = await generateContext({ projects: ['facts-proj'] });
    console.log(JSON.stringify({ text }));
  `;

  it('renders the Project Knowledge block above the timeline, active facts only', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-facts-'));
    try {
      const result = Bun.spawnSync(['bun', '-e', childScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_CONFIG_DIR: dataDir,
          CLAUDE_MEM_MODES_DIR: join(repoRoot, 'plugin', 'modes'),
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      const { text } = JSON.parse(new TextDecoder().decode(result.stdout).trim());

      expect(text).toContain('## Project Knowledge');
      expect(text).toContain('ACTIVE_FACT_MARKER runs on Bun.');
      expect(text).toContain('replacement fact');
      expect(text).not.toContain('SUPERSEDED_FACT_MARKER');
      expect(text).not.toContain('INVALIDATED_FACT_MARKER');

      // The block sits above the observations timeline.
      expect(text.indexOf('## Project Knowledge')).toBeLessThan(text.indexOf('TIMELINE_MARKER_OBS'));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
