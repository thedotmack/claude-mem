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

function modelText(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

interface SaveHarness {
  db: Database;
  excludedDir: string;
  allowedDir: string;
  saveFrom(cwd: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/**
 * A worker route on an in-memory database plus the real MCP server bundle as a
 * stdio client, launched from a given checkout. `save_memory` is the same
 * explicit write as `POST /api/memory/save`, so it must reach the worker with
 * the checkout the call was made in.
 */
async function startSaveHarness(exclusions: string): Promise<SaveHarness> {
  const previousExclusions = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
  process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = exclusions;

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

  return {
    db,
    excludedDir,
    allowedDir,
    saveFrom,
    close: async () => {
      if (previousExclusions === undefined) delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      else process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = previousExclusions;
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/**
 * Without `cwd` the route skips the `CLAUDE_MEM_EXCLUDED_PROJECTS` check and
 * stores a note from a checkout the owner excluded (#6098).
 */
describe('save_memory honors CLAUDE_MEM_EXCLUDED_PROJECTS', () => {
  it('skips an excluded checkout, saves a normal one, and does not let an explicit project bypass it', async () => {
    const harness = await startSaveHarness('excluded-checkout');
    try {
      const before = observationCount(harness.db);

      const skipped = await harness.saveFrom(harness.excludedDir, { text: 'EXCLUDED_NOTE_BODY', title: 'Excluded note' });
      expect(observationCount(harness.db)).toBe(before);
      expect(skipped.isError).toBe(true);
      expect(modelText(skipped)).toContain('Not saved');
      expect(modelText(skipped)).toContain('excluded by CLAUDE_MEM_EXCLUDED_PROJECTS');

      // Naming another project must not bypass the checkout's exclusion.
      const skippedWithProject = await harness.saveFrom(harness.excludedDir, {
        text: 'EXCLUDED_NOTE_WITH_PROJECT',
        title: 'Excluded note with project',
        project: 'somewhere-else',
      });
      expect(observationCount(harness.db)).toBe(before);
      expect(skippedWithProject.isError).toBe(true);
      expect(modelText(skippedWithProject)).toContain('Not saved');

      const saved = await harness.saveFrom(harness.allowedDir, { text: 'ALLOWED_NOTE_BODY', title: 'Allowed note' });
      expect(observationCount(harness.db)).toBe(before + 1);
      expect(saved.isError).toBeFalsy();
      expect(modelText(saved)).toStartWith('Saved memory #');
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('normalizes an absolute project path into a project identity', async () => {
    const harness = await startSaveHarness('excluded-checkout');
    try {
      const saved = await harness.saveFrom(harness.allowedDir, {
        text: 'ABSOLUTE_PROJECT_NOTE_BODY',
        title: 'Absolute project note',
        project: '/tmp/mcp-abs-project',
      });
      expect(saved.isError).toBeFalsy();
      expect(modelText(saved)).toContain('Project: mcp-abs-project');
      const row = harness.db.query('SELECT project FROM observations ORDER BY id DESC LIMIT 1').get() as { project: string } | null;
      expect(row?.project).toBe('mcp-abs-project');
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('refuses an explicitly named absolute project that is excluded', async () => {
    const harness = await startSaveHarness('excluded-checkout');
    try {
      const before = observationCount(harness.db);
      // The caller's checkout is allowed; only the explicitly named project is excluded.
      const result = await harness.saveFrom(harness.allowedDir, {
        text: 'EXCLUDED_ABSOLUTE_PROJECT_NOTE',
        title: 'Excluded absolute project note',
        project: harness.excludedDir,
      });
      expect(observationCount(harness.db)).toBe(before);
      expect(result.isError).toBe(true);
      const text = modelText(result);
      expect(text).toContain('Not saved');
      // Bundle-agnostic: the shared tail holds in both the old and new wording.
      expect(text).toContain('excluded by CLAUDE_MEM_EXCLUDED_PROJECTS');
    } finally {
      await harness.close();
    }
  }, 30_000);
});
