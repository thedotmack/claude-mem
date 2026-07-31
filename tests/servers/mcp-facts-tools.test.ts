// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';

const mcpServerPath = fileURLToPath(new URL('../../src/servers/mcp-server.ts', import.meta.url));
const dataRoutesPath = fileURLToPath(new URL('../../src/services/worker/http/routes/DataRoutes.ts', import.meta.url));

describe('Semantic memory layer — MCP facts tools', () => {
  it('facts tool declares project/kind/query/limit and proxies to /api/facts', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'facts'");
    const factsSection = src.slice(src.indexOf("name: 'facts'"), src.indexOf("name: 'get_facts'"));
    expect(factsSection).toContain('project:');
    expect(factsSection).toContain('kind:');
    expect(factsSection).toContain('query:');
    expect(factsSection).toContain('limit:');
    expect(factsSection).toContain("callWorker('/api/facts'");
    expect(factsSection).not.toContain('properties: {}');
  });

  it('get_facts tool requires ids and proxies to /api/facts/batch', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'get_facts'");
    const section = src.slice(src.indexOf("name: 'get_facts'"));
    expect(section).toContain('ids:');
    expect(section).toContain("required: ['ids']");
    expect(section).toContain("callWorker('/api/facts/batch'");
  });

  it('worker exposes the facts endpoints with retrieval practice and consolidation', async () => {
    const src = await Bun.file(dataRoutesPath).text();

    expect(src).toContain("app.get('/api/facts'");
    expect(src).toContain("app.post('/api/facts/batch'");
    expect(src).toContain("app.post('/api/facts/consolidate'");
    // Retrieval practice on batch fetch, mirroring /api/observations/batch.
    expect(src).toContain('recordFactsRetrieved');
    // Consolidation stays master-gated even on the manual endpoint.
    expect(src).toContain('consolidationEnabled');
  });
});
