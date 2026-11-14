import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import { formatMcpPayload } from '../../src/servers/mcp-text-format.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

/**
 * #6098: the MCP `save_memory` tool is the same explicit write as
 * `POST /api/memory/save`, so a note saved from a checkout listed in
 * CLAUDE_MEM_EXCLUDED_PROJECTS must be skipped exactly as an HTTP save with
 * cwd is. The HTTP route only runs the exclusion check when the request body
 * carries `cwd`; the MCP handler never sent it, so the note was stored and
 * the caller was told it saved.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
});

function observationCount(db: Database): number {
  return (db.query('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count;
}

function modelText(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

async function startWorker(): Promise<{ port: number; db: Database }> {
  const db = new Database(':memory:');
  const store = new SessionStore(db);
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  const databaseManager = {
    getSessionStore: () => store,
    getChromaSync: () => null,
    getCloudSync: () => null,
  } as unknown as DatabaseManager;
  new MemoryRoutes(databaseManager, 'fixture-project').setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanups.push(() => { server.close(); db.close(); });
  return { port: (server.address() as { port: number }).port, db };
}

async function withMcpClient(
  checkoutDir: string,
  workerPort: number,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-save-exclusion-data-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const inherited = { ...process.env };
  // The MCP server itself must not need the exclusion setting: the worker
  // route owns the check, the tool only has to say where the call came from.
  delete inherited.CLAUDE_MEM_EXCLUDED_PROJECTS;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', '..', 'src', 'servers', 'mcp-server.ts')],
    cwd: checkoutDir,
    stderr: 'pipe',
    env: {
      ...inherited,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(workerPort),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      CLAUDE_MEM_RUNTIME: 'worker',
      PWD: checkoutDir,
    } as Record<string, string>,
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'save-memory-exclusion-fixture', version: '1' });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

function checkoutFixture(): { excludedDir: string; allowedDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-save-exclusion-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const excludedDir = join(root, 'excluded-checkout');
  const allowedDir = join(root, 'allowed-checkout');
  mkdirSync(excludedDir);
  mkdirSync(allowedDir);
  return { excludedDir, allowedDir };
}

describe('save_memory honors CLAUDE_MEM_EXCLUDED_PROJECTS (#6098)', () => {
  it('skips a note saved from an excluded checkout instead of storing it', async () => {
    const { excludedDir } = checkoutFixture();
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'excluded-checkout';
    const { port, db } = await startWorker();
    await withMcpClient(excludedDir, port, async (client) => {
      const result = await client.callTool({
        name: 'save_memory',
        arguments: { text: 'Note from an excluded checkout.', title: 'Excluded note' },
      }) as CallToolResult;
      expect(observationCount(db)).toBe(0);
      expect(result.isError).toBe(true);
      expect(modelText(result)).toContain('excluded');
    });
  }, 60_000);

  it('does not let an explicit project argument bypass the exclusion', async () => {
    const { excludedDir } = checkoutFixture();
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'excluded-checkout';
    const { port, db } = await startWorker();
    await withMcpClient(excludedDir, port, async (client) => {
      const result = await client.callTool({
        name: 'save_memory',
        arguments: { text: 'Sneaky note.', title: 'Bypass attempt', project: 'some-other-project' },
      }) as CallToolResult;
      expect(observationCount(db)).toBe(0);
      expect(result.isError).toBe(true);
    });
  }, 60_000);

  it('still saves a note from a checkout that is not excluded', async () => {
    const { allowedDir } = checkoutFixture();
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'excluded-checkout';
    const { port, db } = await startWorker();
    await withMcpClient(allowedDir, port, async (client) => {
      const result = await client.callTool({
        name: 'save_memory',
        arguments: { text: 'Note from an allowed checkout.', title: 'Allowed note' },
      }) as CallToolResult;
      expect(observationCount(db)).toBe(1);
      expect(result.isError).toBeFalsy();
      expect(modelText(result)).toStartWith('Saved memory #');
    });
  }, 60_000);
});

describe('save result formatting (#6098)', () => {
  it('reports a skipped save as not saved, not as a stored memory', () => {
    const result = formatMcpPayload('save', { success: false, skipped: true, reason: 'project_excluded' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Not saved');
    expect(result.content[0].text).not.toContain('Saved memory #');
  });

  it('keeps the success wording for a stored save', () => {
    const result = formatMcpPayload('save', { success: true, id: 7, title: 'Kept note', project: 'p' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toStartWith('Saved memory #7');
  });
});
