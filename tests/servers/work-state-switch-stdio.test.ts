import { describe, expect, it } from 'bun:test';
import express from 'express';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

// #4606: behavioral check of CLAUDE_MEM_WORK_STATE_ENABLED through the real stdio
// transport. A stub worker records every request, so the test sees whether a
// work_state_* call reached the worker, not only what the server answered.
async function withServer(
  env: Record<string, string>,
  run: (client: Client, workStateHits: () => string[], workStateWrites: () => Array<Record<string, unknown>>) => Promise<void>,
  options: { cwd?: string; pwd?: string; clientName?: string; roots?: Array<{ uri: string; name?: string }> } = {},
): Promise<void> {
  const hits: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { hits.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/work-state/entries', (req, res) => { writes.push(req.body); res.json({ entries: [] }); });
  app.get('/api/work-state', (_req, res) => res.json({ entries: [] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-work-state-'));
  // A switch exported in the developer's shell must not leak into the child:
  // each test sets the value it means to check.
  const inherited = { ...process.env };
  delete inherited.CLAUDE_MEM_WORK_STATE_ENABLED;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts')],
    cwd: options.cwd ?? process.cwd(),
    stderr: 'pipe',
    env: {
      ...inherited,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_RUNTIME: 'worker',
      ...env,
      ...(options.pwd ? { PWD: options.pwd } : {}),
    } as Record<string, string>,
  });
  const client = new Client(
    { name: options.clientName ?? 'work-state-switch-fixture', version: '1' },
    options.roots ? { capabilities: { roots: { listChanged: true } } } : {},
  );
  if (options.roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: options.roots! }));
  }
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    await run(client, () => hits.filter(hit => hit.includes('/api/work-state')), () => writes);
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
      expect(names).toContain('dumb_search');

      for (const call of workStateCalls) {
        const result = await client.callTool(call) as CallToolResult;
        expect(result.isError).toBe(true);
        const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        expect(text).toContain('Work state is turned off (CLAUDE_MEM_WORK_STATE_ENABLED=false).');
      }
      expect(workStateHits()).toEqual([]);
    });
  }, 20_000);

  it('uses Antigravity PWD when the MCP process was launched from its plugin root', async () => {
    const pluginRoot = join(import.meta.dir, '..', '..', 'src');
    const project = mkdtempSync(join(tmpdir(), 'antigravity-project-'));
    try {
      await withServer({}, async (client, _workStateHits, workStateWrites) => {
        await client.callTool(workStateCalls[0]);
        expect(workStateWrites()).toEqual([{
          cwd: project,
          list: 'switch-fixture',
          fields: { task: 'Check the switch', status: 'doing' },
        }]);
      }, { cwd: pluginRoot, pwd: project, clientName: 'agy' });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 20_000);

  it('prefers client roots over Antigravity PWD and the plugin launch directory', async () => {
    const pluginRoot = join(import.meta.dir, '..', '..', 'src');
    const pwdProject = mkdtempSync(join(tmpdir(), 'antigravity-pwd-'));
    const clientProject = mkdtempSync(join(tmpdir(), 'antigravity-root-'));
    try {
      await withServer({}, async (client, _workStateHits, workStateWrites) => {
        await client.callTool(workStateCalls[0]);
        expect(workStateWrites()[0]?.cwd).toBe(clientProject);
      }, {
        cwd: pluginRoot,
        pwd: pwdProject,
        clientName: 'agy',
        roots: [{ uri: pathToFileURL(clientProject).href, name: 'current project' }],
      });
    } finally {
      rmSync(pwdProject, { recursive: true, force: true });
      rmSync(clientProject, { recursive: true, force: true });
    }
  }, 20_000);

  it('a client without the roots capability keeps main behavior: the launch directory, and no Antigravity tool-use record', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'stdio-launch-project-')));
    const stalePwd = mkdtempSync(join(tmpdir(), 'stdio-stale-pwd-'));
    try {
      await withServer({}, async (client, _workStateHits, workStateWrites) => {
        await client.callTool(workStateCalls[0]);
        expect(workStateWrites()).toEqual([{
          cwd: project,
          list: 'switch-fixture',
          fields: { task: 'Check the switch', status: 'doing' },
        }]);
      }, { cwd: project, pwd: stalePwd });
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(stalePwd, { recursive: true, force: true });
    }
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
