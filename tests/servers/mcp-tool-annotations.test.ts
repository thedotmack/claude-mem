import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Plan mode runs an MCP tool without a prompt only when the tool declares
// readOnlyHint, and treats a missing annotation as false (#3483). The File Read
// Gate's deny sends Claude to smart_outline, smart_unfold and get_observations,
// which therefore have to be callable in plan mode.
const MCP_SERVER_PATH = join(import.meta.dir, '..', '..', 'plugin', 'scripts', 'mcp-server.cjs');

const READ_ONLY_TOOL_NAMES = [
  'important_workflow', 'search', 'timeline', 'get_observations', 'get_tool_uses', 'work_state_read',
  'session_start_context', 'observation_search', 'observation_context', 'observation_generation_status',
  'smart_search', 'smart_unfold', 'smart_outline', 'list_corpora',
];

describe('mcp-search tool annotations (#3483)', () => {
  let dataDirectory: string;
  let client: Client;
  let tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;

  beforeAll(async () => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'mcp-tool-annotations-'));
    // The server must never launch a worker from a test.
    writeFileSync(join(dataDirectory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_AUTOSTART: 'false' }));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    client = new Client({ name: 'annotations-test', version: '0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_PATH],
      cwd: dataDirectory,
      env: { ...environment, CLAUDE_MEM_DATA_DIR: dataDirectory },
    }));
    tools = (await client.listTools()).tools;
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('marks the tools the File Read Gate routes to as read-only', () => {
    for (const name of ['smart_outline', 'smart_unfold', 'get_observations']) {
      expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('marks only tools that read as read-only', () => {
    const readOnly = tools.filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.name).sort();
    const advertisedReadOnly = READ_ONLY_TOOL_NAMES.filter(name => tools.some(tool => tool.name === name)).sort();

    expect(readOnly).toEqual(advertisedReadOnly);
    expect(tools.find(tool => tool.name === 'work_state_write')?.annotations?.readOnlyHint).toBeUndefined();
  });
});
