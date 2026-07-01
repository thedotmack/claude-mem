import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';

// Mirrors mcp-tool-schemas.test.ts: assert the reserved-table dismiss tools are
// declared and wired to the worker dismiss endpoints via source inspection
// (the MCP server registers tools from a static array). fileURLToPath (not
// URL.pathname) keeps the path openable on Windows, where pathname yields
// a leading-slash "/C:/..." form.
const mcpServerPath = fileURLToPath(new URL('../../src/servers/mcp-server.ts', import.meta.url));

describe('observation dismiss MCP tools', () => {
  it('observation_dismiss declares id as required and posts to the worker dismiss endpoint', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'observation_dismiss'");
    const section = src.slice(
      src.indexOf("name: 'observation_dismiss'"),
      src.indexOf("name: 'observation_undismiss'"),
    );
    expect(section).toContain('id:');
    expect(section).toContain('reason:');
    expect(section).toContain("required: ['id']");
    expect(section).toContain('/api/observations/');
    expect(section).toContain('/dismiss');
    expect(section).toContain('callWorkerAPIPost');
  });

  it('observation_undismiss declares id as required and calls the DELETE helper', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'observation_undismiss'");
    const section = src.slice(src.indexOf("name: 'observation_undismiss'"));
    expect(section).toContain('id:');
    expect(section).toContain("required: ['id']");
    expect(section).toContain('callWorkerAPIDelete');
  });

  it('defines a DELETE worker helper that dismiss/undismiss can reuse', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).toContain('async function callWorkerAPIDelete');
    expect(src).toContain("method: 'DELETE'");
  });
});
