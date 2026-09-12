import { describe, expect, it, mock } from 'bun:test';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';

const bugfixObservation = {
  id: 42,
  memory_session_id: 'session-bugfix',
  project: 'corpus-project',
  text: null,
  type: 'bugfix' as const,
  title: 'Preserve corpus observation filters',
  subtitle: null,
  facts: '[]',
  narrative: 'The corpus search keeps the selected observation type.',
  concepts: '[]',
  files_read: '[]',
  files_modified: '[]',
  prompt_number: 1,
  discovery_tokens: 0,
  created_at: '2025-01-01T00:00:00.000Z',
  created_at_epoch: 1735689600000,
};

const featureObservation = {
  ...bugfixObservation,
  id: 43,
  memory_session_id: 'session-feature',
  type: 'feature' as const,
  title: 'Unrelated feature observation',
};

describe('CorpusBuilder observation type filters', () => {
  it('passes types through the search layer before phase-two hydration', async () => {
    const searchObservations = mock((_query: string | undefined, options: { type?: string[] }) => {
      // Model the default search page: without the observation-type filter the
      // requested bugfix is beyond the page and is never available to hydrate.
      return options.type?.includes('bugfix') ? [bugfixObservation] : [featureObservation];
    });
    const searchOrchestrator = new SearchOrchestrator(
      {
        searchObservations,
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
      } as any,
      {} as any,
      null,
    );
    const getObservationsByIds = mock((ids: number[], options: { type?: string[] }) => {
      const rows = ids.includes(bugfixObservation.id) ? [bugfixObservation] : [];
      return options.type?.includes('bugfix') ? rows : [];
    });
    const write = mock(() => undefined);
    const builder = new CorpusBuilder(
      { getObservationsByIds } as any,
      searchOrchestrator,
      { write } as any,
    );

    const corpus = await builder.build('bugfixes', 'Bugfix observations', {
      types: ['bugfix'],
    });

    expect(searchObservations).toHaveBeenCalledWith(undefined, expect.objectContaining({
      type: ['bugfix'],
    }));
    expect(getObservationsByIds).toHaveBeenCalledWith([bugfixObservation.id], expect.objectContaining({
      type: ['bugfix'],
    }));
    expect(corpus.observations).toHaveLength(1);
    expect(corpus.observations[0]?.id).toBe(bugfixObservation.id);
    expect(write).toHaveBeenCalledWith(corpus);
  });
});
