import { describe, expect, it } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// #4606: behavioral check of CLAUDE_MEM_WORK_STATE_ENABLED through the real stdio
// transport. A stub worker records every request, so the test sees whether a
// work_state_* call reached the worker, not only what the server answered.
async function withServer(
  env: Record<string, string>,
  run: (client: Client, workStateHits: () => string[]) => Promise<void>,
): Promise<void> {
  const hits: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { hits.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/work-state/entries', (_req, res) => res.json({ entries: [] }));
  app.get('/api/work-state', (_req, res) => res.json({ entries: [] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-work-state-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts')],
    cwd: process.cwd(),
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_RUNTIME: 'worker',
      ...env,
    } as Record<string, string>,
  });
  const client = new Client({ name: 'work-state-switch-fixture', version: '1' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    await run(client, () => hits.filter(hit => hit.includes('/api/work-state')));
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const workStateCalls = [
  { name: 'work_state_write', arguments: { list: 'switch-fixture', fields: { task: 'Check the switch', status: 'doing' } } },
  { name: 'work_state_read', arguments: { list: 'switch-fixture' } },
];

describe('CLAUDE_MEM_WORK_STATE_ENABLED over stdio (#4606)', () => {
  it('turned off: tools/list hides both work_state tools and tools/call rejects them without reaching the worker', async () => {
    await withServer({ CLAUDE_MEM_WORK_STATE_ENABLED: 'false' }, async (client, workStateHits) => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('work_state_write');
      expect(names).not.toContain('work_state_read');
      expect(names).toContain('mem_search');

      for (const call of workStateCalls) {
        const result = await client.callTool(call) as CallToolResult;
        expect(result.isError).toBe(true);
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        expect(text).toContain('Work state is turned off (CLAUDE_MEM_WORK_STATE_ENABLED=false).');
      }
      expect(workStateHits()).toEqual([]);
    });
  }, 20_000);

  it('on by default: both tools are listed and calls reach the worker', async () => {
    await withServer({}, async (client, workStateHits) => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('work_state_write');
      expect(names).toContain('work_state_read');

      for (const call of workStateCalls) {
        await client.callTool(call);
      }
      expect(workStateHits().length).toBeGreaterThanOrEqual(2);
    });
  }, 20_000);
});
