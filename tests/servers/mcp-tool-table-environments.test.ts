import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildClaudeMemToolTable, stdioToolEnvironment, type ClaudeMemToolEnvironment } from '../../src/servers/mcp-tool-table.js';
import { directHttpToolEnvironment } from '../../src/services/wire-gateway/mcp/mcp-worker-environment.js';
import { getProjectContext } from '../../src/utils/project-name.js';

// Each tool table keeps its own environment: a process that builds the stdio
// table and the wire gateway's /mcp table gets two tables that each keep their
// own workspace-folder behavior, whichever was built last.

const previousRuntime = process.env.CLAUDE_MEM_RUNTIME;
beforeAll(() => {
  process.env.CLAUDE_MEM_RUNTIME = 'worker';
});
afterAll(() => {
  if (previousRuntime === undefined) delete process.env.CLAUDE_MEM_RUNTIME;
  else process.env.CLAUDE_MEM_RUNTIME = previousRuntime;
});

/** The environment with its worker requests recorded and answered here. */
function recording(environment: ClaudeMemToolEnvironment, bodies: unknown[]): ClaudeMemToolEnvironment {
  return {
    ...environment,
    requestWorker: async (_apiPath, init = {}) => {
      bodies.push(init.jsonBody);
      return Response.json({ success: true, id: 1 });
    },
  };
}

describe('the MCP tool table environment is per table', () => {
  it('a stdio table and an /mcp table built in one process each keep their own workspace folder', async () => {
    const stdioBodies: unknown[] = [];
    const mcpBodies: unknown[] = [];
    const stdioTable = buildClaudeMemToolTable(recording(stdioToolEnvironment, stdioBodies));
    const mcpTable = buildClaudeMemToolTable(recording(directHttpToolEnvironment(apiPath => `http://127.0.0.1:1${apiPath}`), mcpBodies));

    // The stdio table, built first, still defaults to its workspace's project.
    const saved = await stdioTable.callTool('save_memory', { text: 'a note' });
    expect(saved.isError).toBeFalsy();
    expect(stdioBodies).toEqual([{ text: 'a note', project: getProjectContext(process.cwd()).primary }]);

    // The /mcp table has no workspace folder: no project, no default, and nothing sent.
    const refused = await mcpTable.callTool('save_memory', { text: 'a note' });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain('this MCP server has no workspace folder');
    expect(mcpBodies).toEqual([]);

    // Building another stdio table does not give the /mcp table a folder.
    buildClaudeMemToolTable(recording(stdioToolEnvironment, []));
    const stillRefused = await mcpTable.callTool('save_memory', { text: 'a note' });
    expect(stillRefused.isError).toBe(true);
    expect(mcpBodies).toEqual([]);
  });
});
