import { describe, expect, it } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// team_brief / team_search through the real stdio transport, against a stub
// worker that records every request: whether a call reached the worker is
// part of what is checked, not only what the server answered.
async function withServer(
  env: Record<string, string>,
  run: (client: Client, teamBrainHits: () => Array<{ path: string; query: unknown; body: unknown }>) => Promise<void>,
): Promise<void> {
  const hits: Array<{ path: string; query: unknown; body: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { hits.push({ path: req.path, query: { ...req.query }, body: req.body }); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/teambrain/brief', (req, res) => res.type('text/plain').send(`BRIEF for ${String(req.query.project)}`));
  app.post('/api/teambrain/search', (req, res) => res.type('text/plain').send(`SEARCH for ${String(req.body?.query)}`));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-teambrain-tools-'));
  // A TeamBrain setting exported in the developer's shell must not leak into the child.
  const inherited = { ...process.env };
  for (const key of ['CLAUDE_MEM_TEAMBRAIN_URL', 'CLAUDE_MEM_TEAMBRAIN_TEAM_ID', 'CLAUDE_MEM_CLOUD_SYNC_TOKEN', 'CLAUDE_MEM_CLOUD_SYNC_USER_ID']) {
    delete inherited[key];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts')],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...inherited,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_RUNTIME: 'worker',
      ...env,
    } as Record<string, string>,
  });
  const client = new Client({ name: 'teambrain-tools-fixture', version: '1' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    await run(client, () => hits.filter(hit => hit.path.startsWith('/api/teambrain/')));
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function text(result: CallToolResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

const teamBrainCalls = [
  { name: 'team_brief', arguments: { project: 'my-app' } },
  { name: 'team_search', arguments: { query: 'who owns the auth refactor' } },
];

describe('team_brief / team_search MCP tools', () => {
  it('not joined: tools/list hides both and tools/call answers inert without reaching the worker', async () => {
    await withServer({}, async (client, teamBrainHits) => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('team_brief');
      expect(names).not.toContain('team_search');
      expect(names).toContain('search');
      expect(names).toContain('dumb_search');
      expect(names).not.toContain('mem_search');

      for (const call of teamBrainCalls) {
        const result = await client.callTool(call) as CallToolResult;
        expect(result.isError).toBe(true);
        expect(text(result)).toContain('TeamBrain is not set up on this install.');
        expect(text(result)).toContain('npx claude-mem teambrain join <invite-link>');
      }
      expect(teamBrainHits()).toEqual([]);
    });
  }, 20_000);

  it('joined: both are listed read-only and proxy through the worker routes', async () => {
    await withServer({
      CLAUDE_MEM_TEAMBRAIN_URL: 'https://cmem.ai',
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'sync-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-1',
    }, async (client, teamBrainHits) => {
      const tools = (await client.listTools()).tools;
      for (const name of ['team_brief', 'team_search']) {
        expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
      }

      const brief = await client.callTool(teamBrainCalls[0]) as CallToolResult;
      expect(brief.isError).toBeFalsy();
      expect(text(brief)).toBe('BRIEF for my-app');

      const search = await client.callTool(teamBrainCalls[1]) as CallToolResult;
      expect(search.isError).toBeFalsy();
      expect(text(search)).toBe('SEARCH for who owns the auth refactor');

      const defaulted = await client.callTool({ name: 'team_brief', arguments: {} }) as CallToolResult;
      expect(text(defaulted)).toStartWith('BRIEF for ');

      const hits = teamBrainHits();
      expect(hits[0]).toMatchObject({ path: '/api/teambrain/brief', query: { project: 'my-app' } });
      expect(hits[1]).toMatchObject({ path: '/api/teambrain/search', body: { query: 'who owns the auth refactor' } });
      expect((hits[2].query as { project?: string }).project).toBeTruthy();
    });
  }, 20_000);
});
