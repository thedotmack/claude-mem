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
    // POST is expressed by calling the unified worker helper with a body.
    expect(section).toContain('callWorker(');
    expect(section).toContain('{ body }');
  });

  it('observation_undismiss declares id as required and calls the worker with a DELETE', async () => {
    const src = await Bun.file(mcpServerPath).text();

    expect(src).toContain("name: 'observation_undismiss'");
    const section = src.slice(src.indexOf("name: 'observation_undismiss'"));
    expect(section).toContain('id:');
    expect(section).toContain("required: ['id']");
    // DELETE is expressed via the unified worker helper's del option.
    expect(section).toContain('callWorker(');
    expect(section).toContain('{ del: true }');
  });

  it('the unified worker helper supports a DELETE path that undismiss reuses', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).toContain('async function callWorker(');
    expect(src).toContain('opts.del');
    expect(src).toContain("method: 'DELETE'");
  });
});
