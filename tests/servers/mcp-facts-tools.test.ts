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

describe('Provenance audit + temporal query (audit G6) — MCP tools', () => {
  it('fact_provenance requires id and fetches the provenance endpoint', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'fact_provenance'");
    const section = src.slice(src.indexOf("name: 'fact_provenance'"), src.indexOf("name: 'facts_at'"));
    expect(section).toContain('id:');
    expect(section).toContain("required: ['id']");
    expect(section).toContain('handleFactProvenance');
    // Compact render: fact line, sources list, chain status.
    expect(src).toContain('/api/facts/${id}/provenance');
    expect(src).toContain('Superseded by:');
    expect(src).toContain('STALE (superseded)');
  });

  it('facts_at requires ts + project and fetches the temporal endpoint', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'facts_at'");
    const section = src.slice(src.indexOf("name: 'facts_at'"), src.indexOf("name: 'session_start_context'"));
    expect(section).toContain('ts:');
    expect(section).toContain('project:');
    expect(section).toContain('limit:');
    expect(section).toContain("required: ['ts', 'project']");
    expect(section).toContain('handleFactsAt');
    // Grouped render by today's status.
    expect(src).toContain("'/api/facts/at'");
    expect(src).toContain('Still active');
    expect(src).toContain('Superseded later');
    expect(src).toContain('Invalidated later');
  });

  it('worker exposes the read-only audit endpoints', async () => {
    const src = await Bun.file(dataRoutesPath).text();

    expect(src).toContain("app.get('/api/facts/:id/provenance'");
    expect(src).toContain("app.get('/api/facts/at'");
    expect(src).toContain('getFactProvenance');
    expect(src).toContain('getFactsAt');
    expect(src).toContain('parseTemporalTs');
  });
});
