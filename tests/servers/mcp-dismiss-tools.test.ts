import { describe, it, expect } from 'bun:test';
import { fileURLToPath } from 'node:url';

const mcpServerPath = fileURLToPath(new URL('../../src/servers/mcp-server.ts', import.meta.url));

describe('observation dismiss MCP tools', () => {
  it('observation_dismiss declares id as required and posts to the worker dismiss endpoint', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_dismiss'"),
      src.indexOf("name: 'observation_undismiss'"),
    );

    expect(section).toContain('id:');
    expect(section).toContain('reason:');
    expect(section).toContain("required: ['id']");
    expect(section).toContain('/api/observations/');
    expect(section).toContain('/dismiss');
    expect(section).toContain('callWorker(');
    expect(section).toContain('{ body }');
  });

  it('observation_undismiss declares id as required and calls the worker with DELETE', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(src.indexOf("name: 'observation_undismiss'"));

    expect(section).toContain('id:');
    expect(section).toContain("required: ['id']");
    expect(section).toContain('callWorker(');
    expect(section).toContain('{ del: true }');
  });

  it('the worker helper supports DELETE', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).toContain('opts.del');
    expect(src).toContain("method: 'DELETE'");
  });
});
