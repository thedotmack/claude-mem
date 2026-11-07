import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';

let root = '';
let checkout = '';
const excludedProjects = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'claude-mem-hermes-cwd-'));
  checkout = join(root, 'shop-api', 'src');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(root, 'shop-api', '.claude-mem-project'), '');
});

afterEach(() => {
  if (excludedProjects === undefined) delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
  else process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = excludedProjects;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function request(routes: MemoryRoutes | SearchRoutes, path: string, body: Record<string, unknown>) {
  let chain: Array<(req: Request, res: Response, next: () => void) => void> = [];
  routes.setupRoutes({
    use() {},
    get() {},
    post(route: string, ...handlers: typeof chain) {
      if (route === path) chain = handlers;
    },
  } as any);
  const json = mock(() => {});
  const res: any = { headersSent: false, locals: {}, json, status: mock(() => res) };
  const req = { path, body, query: {}, get: () => undefined } as unknown as Request;
  let index = 0;
  const next = () => chain[index++]?.(req, res, next);
  next();
  await new Promise(resolve => setImmediate(resolve));
  return res;
}

function memoryRoutes() {
  const storeObservation = mock(() => ({ id: 42, createdAtEpoch: 1234567890 }));
  const getOrCreateManualSession = mock(() => 'manual-session');
  const routes = new MemoryRoutes({
    getSessionStore: () => ({ storeObservation, getOrCreateManualSession }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  } as any, 'default-project');
  return { routes, storeObservation, getOrCreateManualSession };
}

const QUERY = 'Find previous deployment decisions for the current checkout';

describe('Hermes checkout scoping', () => {
  it('saves a note under the same project key as the checkout hooks', async () => {
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
    const { routes, getOrCreateManualSession } = memoryRoutes();
    const res = await request(routes, '/api/memory/save', { text: 'Flush the price cache.', cwd: checkout });
    expect(res.status).not.toHaveBeenCalled();
    expect(getOrCreateManualSession).toHaveBeenCalledWith(getProjectContext(checkout).primary, undefined);
  });

  for (const explicit of [{ project: 'explicit-project' }, { metadata: { project: 'explicit-project' } }]) {
    it(`preserves an explicit ${'project' in explicit ? 'top-level' : 'metadata'} project`, async () => {
      process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
      const { routes, getOrCreateManualSession } = memoryRoutes();
      await request(routes, '/api/memory/save', { text: 'Keep the named scope.', cwd: checkout, ...explicit });
      expect(getOrCreateManualSession).toHaveBeenCalledWith('explicit-project', undefined);
    });
  }

  it('searches all checkout read keys when the host supplies no project', async () => {
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
    const search = mock(async () => ({ observations: [] }));
    await request(new SearchRoutes({ search } as any), '/api/context/semantic', { q: QUERY, cwd: checkout });
    const context = getProjectContext(checkout);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ project: context.primary, projects: context.allProjects }));
  });

  for (const explicit of [{ project: 'named-project' }, { projects: ['first', 'second'] }]) {
    it(`preserves explicitly named semantic ${'project' in explicit ? 'project' : 'projects'}`, async () => {
      process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
      const search = mock(async () => ({ observations: [] }));
      await request(new SearchRoutes({ search } as any), '/api/context/semantic', { q: QUERY, cwd: checkout, ...explicit });
      expect(search).toHaveBeenCalledWith(expect.objectContaining(explicit));
    });
  }

  it('skips both writes and reads for excluded checkouts even with explicit project keys', async () => {
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = checkout;
    const { routes, storeObservation } = memoryRoutes();
    const saved = await request(routes, '/api/memory/save', { text: 'Private note.', cwd: checkout, project: 'named' });
    expect(saved.json).toHaveBeenCalledWith({ success: false, skipped: true, reason: 'project_excluded' });
    expect(storeObservation).not.toHaveBeenCalled();
    const search = mock(async () => ({ observations: [] }));
    const context = await request(new SearchRoutes({ search } as any), '/api/context/semantic', { q: QUERY, cwd: checkout, project: 'named' });
    expect(context.json).toHaveBeenCalledWith({ context: '', count: 0 });
    expect(search).not.toHaveBeenCalled();
  });
});
