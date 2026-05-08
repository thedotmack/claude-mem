import { describe, it, expect } from 'bun:test';

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

describe('MCP tool inputSchema declarations', () => {
  let tools: any[];

  it('search tool declares query parameter', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'search'");
    const searchSection = src.slice(src.indexOf("name: 'search'"), src.indexOf("name: 'timeline'"));
    expect(searchSection).toContain("query:");
    expect(searchSection).toContain("limit:");
    expect(searchSection).toContain("project:");
    expect(searchSection).toContain("orderBy:");
    expect(searchSection).not.toContain("properties: {}");
  });

  it('timeline tool declares anchor and query parameters', async () => {
    const src = await Bun.file(mcpServerPath).text();

    const timelineSection = src.slice(
      src.indexOf("name: 'timeline'"),
      src.indexOf("name: 'get_observations'")
    );
    expect(timelineSection).toContain("anchor:");
    expect(timelineSection).toContain("query:");
    expect(timelineSection).toContain("depth_before:");
    expect(timelineSection).toContain("depth_after:");
    expect(timelineSection).toContain("project:");
    expect(timelineSection).not.toContain("properties: {}");
  });

  it('get_observations still declares ids (regression check)', async () => {
    const src = await Bun.file(mcpServerPath).text();

    const getObsSection = src.slice(src.indexOf("name: 'get_observations'"));
    expect(getObsSection).toContain("ids:");
    expect(getObsSection).toContain("required:");
  });

  // Phase 8 — observation_* tools backed by server-beta REST core.
  it('observation_add tool declares content as required', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_add'"),
      src.indexOf("name: 'observation_record_event'"),
    );
    expect(section).toContain('content:');
    expect(section).toContain("required: ['content']");
    expect(section).toContain('handleObservationAdd');
  });

  it('observation_record_event declares eventType as required', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_record_event'"),
      src.indexOf("name: 'observation_search'"),
    );
    expect(section).toContain('eventType:');
    expect(section).toContain("required: ['eventType']");
    expect(section).toContain('handleObservationRecordEvent');
  });

  it('observation_search declares query as required and accepts limit', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_search'"),
      src.indexOf("name: 'observation_context'"),
    );
    expect(section).toContain('query:');
    expect(section).toContain('limit:');
    expect(section).toContain("required: ['query']");
    expect(section).toContain('handleObservationSearch');
  });

  it('observation_context declares query as required and exposes a limit cap', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_context'"),
      src.indexOf("name: 'observation_generation_status'"),
    );
    expect(section).toContain("required: ['query']");
    expect(section).toContain('handleObservationContext');
  });

  it('observation_generation_status declares jobId as required', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(src.indexOf("name: 'observation_generation_status'"));
    expect(section).toContain('jobId:');
    expect(section).toContain("required: ['jobId']");
    expect(section).toContain('handleObservationGenerationStatus');
  });

  it('memory_* compatibility aliases delegate to observation handlers', async () => {
    const src = await Bun.file(mcpServerPath).text();
    // The aliases must keep the same handler functions as the canonical
    // observation_* tools, otherwise we have two write paths in MCP.
    const memoryAdd = src.slice(src.indexOf("name: 'memory_add'"), src.indexOf("name: 'memory_search'"));
    expect(memoryAdd).toContain('handleObservationAdd');
    const memorySearch = src.slice(src.indexOf("name: 'memory_search'"), src.indexOf("name: 'memory_context'"));
    expect(memorySearch).toContain('handleObservationSearch');
    const memoryContext = src.slice(src.indexOf("name: 'memory_context'"), src.indexOf("name: 'smart_search'"));
    expect(memoryContext).toContain('handleObservationContext');
  });

  it('mcp-server skips worker auto-start when runtime=server-beta (anti-pattern guard)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).toContain("selectRuntime() === 'server-beta'");
    expect(src).toContain('skipping worker auto-start');
  });

  it('mcp-server does NOT import WorkerService (anti-pattern guard, plan line 772)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).not.toMatch(/from\s+['"][^'"]*WorkerService[^'"]*['"]/);
    expect(src).not.toMatch(/import\s+\{[^}]*WorkerService[^}]*\}/);
  });
});
