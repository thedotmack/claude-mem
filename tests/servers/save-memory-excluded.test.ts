import { describe, expect, it } from 'bun:test';
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
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function observationCount(db: Database): number {
  return (db.query('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count;
}

/**
 * `save_memory` is the same explicit write as `POST /api/memory/save`, so it must
 * reach the worker with the checkout the call was made in. Without `cwd` the
 * route skips the `CLAUDE_MEM_EXCLUDED_PROJECTS` check and stores a note from a
 * checkout the owner excluded (#6098).
 */
describe('save_memory honors CLAUDE_MEM_EXCLUDED_PROJECTS', () => {
  it('skips an excluded checkout, saves a normal one, and does not let an explicit project bypass it', async () => {
    const db = new Database(':memory:');
    const store = new SessionStore(db);
    const app = express();
    app.use(express.json());
    const databaseManager = {
      getSessionStore: () => store,
      getChromaSync: () => null,
      getCloudSync: () => null,
    } as unknown as DatabaseManager;
    new MemoryRoutes(databaseManager, 'fixture-project').setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };

    const root = mkdtempSync(join(tmpdir(), 'claude-mem-excluded-save-'));
    const excludedDir = join(root, 'excluded-checkout');
    const allowedDir = join(root, 'allowed-checkout');
    mkdirSync(excludedDir);
    mkdirSync(allowedDir);
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-excluded-save-data-'));
    const previousExclusions = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'excluded-checkout';

    const saveFrom = async (cwd: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const transport = new StdioClientTransport({
        command: 'node',
        args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')],
        cwd,
        stderr: 'pipe',
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
          CLAUDE_MEM_WORKER_PORT: String(address.port),
          CLAUDE_MEM_WORKER_AUTOSTART: 'false',
          CLAUDE_MEM_RUNTIME: 'worker',
        } as Record<string, string>,
      });
      transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'excluded-save-fixture', version: '1' });
      try {
        await client.connect(transport);
        return (await client.callTool({ name: 'save_memory', arguments: args })) as CallToolResult;
      } finally {
        await client.close();
      }
    };

    try {
      const before = observationCount(db);

      await saveFrom(excludedDir, { text: 'EXCLUDED_NOTE_BODY', title: 'Excluded note' });
      expect(observationCount(db)).toBe(before);

      // Naming another project must not bypass the checkout's exclusion.
      await saveFrom(excludedDir, {
        text: 'EXCLUDED_NOTE_WITH_PROJECT',
        title: 'Excluded note with project',
        project: 'somewhere-else',
      });
      expect(observationCount(db)).toBe(before);

      const saved = await saveFrom(allowedDir, { text: 'ALLOWED_NOTE_BODY', title: 'Allowed note' });
      expect(observationCount(db)).toBe(before + 1);
      expect((saved.content as Array<{ type: string; text?: string }>).some((block) => block.type === 'text')).toBe(true);
    } finally {
      if (previousExclusions === undefined) delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      else process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = previousExclusions;
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  }, 30_000);
});
