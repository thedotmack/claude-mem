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
});
