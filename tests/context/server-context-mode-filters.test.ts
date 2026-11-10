import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchServerContextRows } from '../../src/services/context/ServerContextRows.js';
import { ServerClient } from '../../src/services/hooks/server-client.js';
import type { ContextConfig } from '../../src/services/context/types.js';

for (const [types, concepts] of [[['decision'], ['trade-off']], [[], []]]) {
  it(`carries ${types.length ? 'selected' : 'empty'} mode filters through the server HTTP client`, async () => {
    const previousFetch = globalThis.fetch;
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url, options) => {
      payload = JSON.parse(String(options?.body));
      return Response.json({ observations: [], context: '' });
    }) as typeof fetch;
    try {
      const result = await fetchServerContextRows({
        runtime: 'server', projectId: 'project-1', serverBaseUrl: 'https://memory.example',
        client: new ServerClient({ serverBaseUrl: 'https://memory.example', apiKey: 'test' }),
      }, {
        config: {
          totalObservationCount: 3, sessionCount: 1,
          observationTypes: new Set(types), observationConcepts: new Set(concepts), mainAgentOnly: true,
        } as ContextConfig,
        project: 'demo', folderProjects: ['demo'], platformSource: 'claude',
      });
      assert.deepEqual(result, { observations: [], summaries: [] });
      assert.deepEqual(payload?.observationTypes, types);
      assert.deepEqual(payload?.observationConcepts, concepts);
      assert.equal(payload?.query, undefined);
      assert.equal(payload?.summaryLimit, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}
