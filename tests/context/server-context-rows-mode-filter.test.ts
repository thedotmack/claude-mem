import { describe, expect, it } from 'bun:test';
import { fetchServerContextRows } from '../../src/services/context/ServerContextRows.js';
import type { ContextConfig } from '../../src/services/context/types.js';

/**
 * #5972: fetchServerContextRows handed the renderer whatever the server
 * returned. The route filters in SQL (#5623), but the function's contract --
 * the same one the local SQLite read honors -- is that returned observations
 * match the config's mode filters. A server that ignores the filters it was
 * sent leaked excluded types and concepts into the session-start block.
 * These tests stub such a server: every row below comes back unfiltered.
 */

function serverRuntime(rows: Array<Record<string, unknown>>) {
  return {
    runtime: 'server' as const,
    projectId: 'demo-project',
    serverBaseUrl: 'http://memory.example:37878',
    client: {
      contextObservations: async () => ({ observations: rows }),
    },
  } as never;
}

function config(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 10,
    sessionCount: 5,
    observationTypes: new Set(['bugfix']),
    observationConcepts: new Set(['how-it-works']),
    mainAgentOnly: true,
    ...overrides,
  } as ContextConfig;
}

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'bugfix',
    content: `${id} body`,
    metadata: { title: id, concepts: ['how-it-works'], project: 'demo' },
    createdAtEpoch: 1_760_000_000_000,
    ...extra,
  };
}

const request = (cfg: ContextConfig) => ({
  config: cfg,
  project: 'demo',
  folderProjects: ['demo'],
  platformSource: undefined,
});

describe('fetchServerContextRows mode filters (#5972)', () => {
  it('drops a returned row whose type the config excludes', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('excluded', { kind: 'feature' }),
      row('admitted'),
    ]), request(config()));
    expect(rows!.observations.map(o => o.id)).toEqual(['admitted']);
  });

  it('drops a returned row that carries none of the configured concepts', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('no-concept', { metadata: { title: 'no-concept', concepts: [], project: 'demo' } }),
      row('other-concept', { metadata: { title: 'other-concept', concepts: ['gotcha'], project: 'demo' } }),
      row('admitted'),
    ]), request(config()));
    expect(rows!.observations.map(o => o.id)).toEqual(['admitted']);
  });

  it('reads concepts stored as a JSON string, and treats an unparseable one as none', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('json-string', { metadata: { title: 'json-string', concepts: '["how-it-works"]', project: 'demo' } }),
      row('garbage', { metadata: { title: 'garbage', concepts: 'not json', project: 'demo' } }),
    ]), request(config()));
    expect(rows!.observations.map(o => o.id)).toEqual(['json-string']);
  });

  it('filters before slicing, so an excluded newest row cannot spend a slot', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('newest-excluded', { kind: 'feature', createdAtEpoch: 1_760_000_200_000 }),
      row('older-admitted', { createdAtEpoch: 1_760_000_100_000 }),
    ]), request(config({ totalObservationCount: 1 })));
    expect(rows!.observations.map(o => o.id)).toEqual(['older-admitted']);
  });

  it('never mode-filters summaries', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('sum', { kind: 'summary', metadata: { request: 'Did the work', project: 'demo' } }),
    ]), request(config()));
    expect(rows!.observations).toEqual([]);
    expect(rows!.summaries.map(s => s.id)).toEqual(['sum']);
  });

  it('treats an empty filter set as no constraint', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('any-type', { kind: 'feature', metadata: { title: 'any-type', concepts: [], project: 'demo' } }),
    ]), request(config({ observationTypes: new Set(), observationConcepts: new Set() })));
    expect(rows!.observations.map(o => o.id)).toEqual(['any-type']);
  });

  it('keeps a row that carries no concepts value at all under a concept filter', async () => {
    // No `concepts` key on the row or in its metadata: there is nothing on
    // the row the concept filter can exclude. A row that DOES carry concepts
    // is still filtered on them in the same read.
    const rows = await fetchServerContextRows(serverRuntime([
      row('no-concepts-value', { metadata: { title: 'no-concepts-value', project: 'demo' } }),
      row('other-concept', { metadata: { title: 'other-concept', concepts: ['gotcha'], project: 'demo' } }),
      row('admitted'),
    ]), request(config()));
    expect(rows!.observations.map(o => o.id)).toEqual(['no-concepts-value', 'admitted']);
  });

  it('still drops a concept-less row whose type the config excludes', async () => {
    const rows = await fetchServerContextRows(serverRuntime([
      row('concept-less-excluded-type', {
        kind: 'feature',
        metadata: { title: 'concept-less-excluded-type', project: 'demo' },
      }),
    ]), request(config()));
    expect(rows!.observations).toEqual([]);
  });

  it('falls back to the discovery type for a row with no kind, like the shape conversion does', async () => {
    const kindless = row('kindless');
    delete kindless.kind;
    const admitted = await fetchServerContextRows(serverRuntime([kindless]),
      request(config({ observationTypes: new Set(['discovery']) })));
    expect(admitted!.observations.map(o => o.id)).toEqual(['kindless']);
    const excluded = await fetchServerContextRows(serverRuntime([kindless]), request(config()));
    expect(excluded!.observations).toEqual([]);
  });
});
