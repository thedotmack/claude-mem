import { describe, expect, test } from 'bun:test';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeExplicitProject } from '../../../../src/utils/project-name.js';
import { applyImport, planImport, saveRequestBody } from '../../../../src/npx-cli/commands/import-memory.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';
import type { DatabaseManager } from '../../../../src/services/worker/DatabaseManager.js';

describe('normalizeExplicitProject', () => {
  test('normalizes POSIX absolute path', () => {
    expect(normalizeExplicitProject('  /tmp/my-app  ')).toBe('my-app');
  });

  test('normalizes Windows absolute path even on POSIX host', () => {
    expect(normalizeExplicitProject('C:\\Users\\dev\\my-app')).toBe('my-app');
    expect(normalizeExplicitProject('C:/Users/dev/my-app')).toBe('my-app');
  });

  test('normalizes UNC path on POSIX host', () => {
    expect(normalizeExplicitProject('\\\\server\\share\\my-app')).toBe('my-app');
  });

  test('normalizes Windows path with trailing separator on POSIX host', () => {
    expect(normalizeExplicitProject('C:\\Users\\dev\\my-app\\')).toBe('my-app');
  });

  test('preserves git-remote org/repo slug', () => {
    expect(normalizeExplicitProject('org/my-app')).toBe('org/my-app');
  });

  test('preserves plain project name', () => {
    expect(normalizeExplicitProject('my-app')).toBe('my-app');
  });

  test('handles root paths without throwing', () => {
    expect(normalizeExplicitProject('/')).toBe('unknown-project');
    expect(normalizeExplicitProject('C:\\')).toBe('drive-C');
  });
});

interface SaveRouteHarness {
  save(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  observationCount(): number;
  firstRow(): { project: string; metadata: string };
  close(): Promise<void>;
}

/** A worker save route on an in-memory database, isolated from ambient settings. */
async function startSaveRoute(exclusions?: string): Promise<SaveRouteHarness> {
  const previousExclusions = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
  const previousGrok = process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED;
  const previousNotion = process.env.CLAUDE_MEM_NOTION_ENABLED;
  if (exclusions === undefined) delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
  else process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = exclusions;
  process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED = 'false';
  process.env.CLAUDE_MEM_NOTION_ENABLED = 'false';

  const store = new SessionStore(':memory:');
  const app = express();
  app.use(express.json());
  new MemoryRoutes({
    getSessionStore: () => store,
    getConnection: () => store.db,
    getCloudSync: () => null,
    getChromaSync: () => null,
  } as unknown as DatabaseManager, 'default-project').setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memory/save`;

  return {
    save: async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    },
    observationCount: () => (store.db.query('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count,
    firstRow: () => store.db.query('SELECT project, metadata FROM observations').get() as { project: string; metadata: string },
    close: async () => {
      if (previousExclusions === undefined) delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
      else process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = previousExclusions;
      if (previousGrok === undefined) delete process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED;
      else process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED = previousGrok;
      if (previousNotion === undefined) delete process.env.CLAUDE_MEM_NOTION_ENABLED;
      else process.env.CLAUDE_MEM_NOTION_ENABLED = previousNotion;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}

describe('POST /api/memory/save project normalization', () => {
  test('refuses an excluded absolute project without cwd and normalizes metadata.project', async () => {
    const route = await startSaveRoute('secret');
    try {
      // Without cwd the route still refuses a project-only absolute excluded path.
      const refused = await route.save({ text: 'excluded note', project: '/tmp/secret' });
      expect(refused).toEqual({ success: false, skipped: true, reason: 'project_excluded' });
      expect(route.observationCount()).toBe(0);

      // A metadata project is normalized to a project identity, in the row and its JSON.
      const saved = await route.save({ text: 'normalized note', metadata: { project: '/tmp/my-app' } });
      expect(saved.success).toBe(true);
      expect(saved.project).toBe('my-app');
      const row = route.firstRow();
      expect(row.project).toBe('my-app');
      expect((JSON.parse(row.metadata) as { project: string }).project).toBe('my-app');
    } finally {
      await route.close();
    }
  });

  test('refuses an excluded metadata-only absolute project without a top-level project', async () => {
    const route = await startSaveRoute('secret');
    try {
      const refused = await route.save({ text: 'excluded metadata note', metadata: { project: '/tmp/secret' } });
      expect(refused).toEqual({ success: false, skipped: true, reason: 'project_excluded' });
      expect(route.observationCount()).toBe(0);
    } finally {
      await route.close();
    }
  });

  test('keeps a plain metadata.project label when the top-level project is an absolute path', async () => {
    const route = await startSaveRoute();
    try {
      const saved = await route.save({
        text: 'labelled note',
        project: '/tmp/my-app',
        metadata: { project: 'custom-label', source: 'fixture' },
      });
      expect(saved.success).toBe(true);
      expect(saved.project).toBe('my-app');
      const row = route.firstRow();
      expect(row.project).toBe('my-app');
      expect((JSON.parse(row.metadata) as { project: string; source: string })).toEqual({ project: 'custom-label', source: 'fixture' });
    } finally {
      await route.close();
    }
  });

  test('resolves a real checkout through CLAUDE_MEM_PROJECT_ENVIRONMENTS', async () => {
    const previousEnvs = process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-save-env-'));
    const checkout = join(root, 'service-a');
    mkdirSync(checkout, { recursive: true });
    process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS = JSON.stringify([
      { name: 'platform-env', patterns: [`${root.replace(/\\/g, '/')}/**`] },
    ]);
    const route = await startSaveRoute();
    try {
      const saved = await route.save({ text: 'env note', project: checkout });
      expect(saved.success).toBe(true);
      expect(saved.project).toBe('platform-env');
      expect(route.firstRow().project).toBe('platform-env');
    } finally {
      if (previousEnvs === undefined) delete process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
      else process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS = previousEnvs;
      await route.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves a real git checkout through CLAUDE_MEM_PROJECT_NAME_SOURCE=git-remote', async () => {
    const previousSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-save-git-remote-'));
    const checkout = join(root, 'local-folder-name');
    mkdirSync(checkout, { recursive: true });
    execFileSync('git', ['init'], { cwd: checkout, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { cwd: checkout, stdio: 'ignore' });
    process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'git-remote';
    const route = await startSaveRoute();
    try {
      const saved = await route.save({ text: 'git remote note', project: checkout });
      expect(saved.success).toBe(true);
      expect(saved.project).toBe('acme/widget');
      expect(route.firstRow().project).toBe('acme/widget');
    } finally {
      if (previousSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
      else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = previousSource;
      await route.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('completes a multi-note import and replay against the route when --project is an absolute path', async () => {
    const plan = planImport([
      { id: 'm1', memory: 'First imported note.', user_id: 'fixture-user', created_at: '2026-11-01T00:00:00Z' },
      { id: 'm2', memory: 'Second imported note.', user_id: 'fixture-user', created_at: '2026-11-01T00:00:01Z' },
    ], {
      provider: 'mem0',
      account: 'fixture-account',
      scope: 'fixture-user',
      project: '/tmp/my-app',
    });
    const route = await startSaveRoute();
    try {
      const first = await applyImport(plan, note => route.save(JSON.parse(saveRequestBody(note, undefined))));
      expect(first).toEqual({ imported: 2, existing: 0 });
      expect(route.observationCount()).toBe(2);
      expect(route.firstRow().project).toBe('my-app');

      const replay = await applyImport(plan, note => route.save(JSON.parse(saveRequestBody(note, undefined))));
      expect(replay).toEqual({ imported: 0, existing: 2 });
      expect(route.observationCount()).toBe(2);
    } finally {
      await route.close();
    }
  });

  test('refuses an import from an allowed cwd when --project names an excluded absolute destination', async () => {
    const plan = planImport([
      { id: 'm1', memory: 'Should not land in excluded destination.', user_id: 'fixture-user', created_at: '2026-11-01T00:00:00Z' },
    ], {
      provider: 'mem0',
      account: 'fixture-account',
      scope: 'fixture-user',
      project: '/tmp/secret',
      cwd: '/tmp/allowed-cwd',
    });
    const route = await startSaveRoute('/tmp/secret');
    try {
      const refusedImport = applyImport(plan, note => route.save(JSON.parse(saveRequestBody(note, '/tmp/allowed-cwd'))));
      await expect(refusedImport).rejects.toThrow('CLAUDE_MEM_EXCLUDED_PROJECTS');
      // The folder is allowed here, so "run it from another folder" alone would be refused
      // again: the words must also name the --project path and what to do about it.
      await expect(refusedImport).rejects.toThrow(/--project path/);
      await expect(refusedImport).rejects.toThrow('name a project that is not excluded');
      expect(route.observationCount()).toBe(0);
    } finally {
      await route.close();
    }
  });
});
