import { describe, expect, it, mock } from 'bun:test';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';

describe('CorpusBuilder search argument mapping', () => {
  it('routes observation type filters through obs_type, not the search type discriminator', async () => {
    const search = mock(() => Promise.resolve({
      results: {
        observations: [],
      },
    }));
    const write = mock(() => undefined);
    const builder = new CorpusBuilder(
      {
        getObservationsByIds: mock(() => []),
      } as never,
      {
        search,
      } as never,
      {
        write,
      } as never,
    );

    await builder.build('typed-corpus', '', {
      types: ['bugfix', 'decision'],
      date_start: '2026-05-01',
      date_end: '2026-06-01',
      limit: 50,
    });

    expect(search).toHaveBeenCalledWith({
      obs_type: 'bugfix,decision',
      dateStart: '2026-05-01',
      dateEnd: '2026-06-01',
      limit: 50,
    });
    expect(search.mock.calls[0]?.[0]).not.toHaveProperty('type');
    expect(write).toHaveBeenCalled();
  });
});
