// #4782 Problem 1: naming a child project must allow an explicit read boundary.
// Real Git layouts and SQLite data exercise the resolver -> MCP -> HTTP chain.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { getProjectContext, getProjectName } from '../../src/utils/project-name.js';
import { withCheckoutProjects } from '../../src/servers/checkout-search-scope.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

const ENVIRONMENTS = 'CLAUDE_MEM_PROJECT_ENVIRONMENTS';
const NAME_SOURCE = 'CLAUDE_MEM_PROJECT_NAME_SOURCE';
const savedEnvironment = process.env[ENVIRONMENTS];
const savedNameSource = process.env[NAME_SOURCE];
const text = (result: { content: Array<{ text?: string }> }) => result.content.map(c => c.text ?? '').join('\n');
let root: string;
let repo: string;
let childA: string;
let childB: string;
let worktree: string;
let submodule: string;
let store: SessionStore;
let server: Server;
let base: string;
let native: number;
let adopted: number;
let foreign: number;
let shared: number;
let sibling: number;
let sequence: number;
const epoch = Date.now();

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
}
function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'fixture');
}
function environment(dir: string, name: string, inherit: string[] = []) {
  return { name, patterns: [`${dir}/**`], inherit };
}
function seed(project: string, title: string, merge?: string) {
  const session = `environment-${++sequence}`;
  const sid = store.createSDKSession(session, project, title);
  store.ensureMemorySessionIdRegistered(sid, session);
  const observation = store.storeObservation(session, project, {
    type: 'discovery', title, subtitle: null, narrative: title,
    facts: [], concepts: [], files_read: [], files_modified: [],
  }, 1, 0, epoch);
  if (merge) store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run(merge, observation.id);
  return { ...observation, session, sid };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-4782-scope-')));
  repo = join(root, 'Workspace');
  initRepo(repo);
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/workspace.git');
  childA = join(repo, 'business-a');
  childB = join(repo, 'business-b');
  mkdirSync(join(childA, 'src'), { recursive: true });
  mkdirSync(childB);
  worktree = join(root, 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  const moduleOrigin = join(root, 'module-origin');
  initRepo(moduleOrigin);
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', moduleOrigin, 'module');
  submodule = join(repo, 'module');
  ModeManager.getInstance().loadMode('code');
}, 30_000);

beforeEach(async () => {
  process.env[NAME_SOURCE] = 'path';
  process.env[ENVIRONMENTS] = JSON.stringify([
    environment(childA, 'business-a'), environment(childB, 'business-b'),
  ]);
  store = new SessionStore(':memory:');
  sequence = 0;
  native = seed('business-a', 'Needle native A').id;
  adopted = seed('Workspace', 'Needle adopted A', 'business-a').id;
  const unrelated = seed('Workspace', 'Needle unrelated parent');
  foreign = unrelated.id;
  const prompt = store.saveUserPrompt(unrelated.session, 1, 'Private parent prompt', unrelated.sid);
  store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(epoch, prompt);
  store.storeSummary(unrelated.session, 'Workspace', {
    request: 'Private parent summary', investigated: '', learned: '', completed: '', next_steps: '', notes: null,
  }, 1, 0, epoch);
  shared = seed('shared', 'Needle shared memory').id;
  sibling = seed('business-b', 'Needle sibling B').id;
  const manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
  const app = express();
  app.use(express.json());
  new SearchRoutes(manager).setupRoutes(app);
  new DataRoutes({} as never, { getSessionStore: () => store } as never, {} as never, {} as never, {} as never, Date.now()).setupRoutes(app);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  if (savedEnvironment === undefined) delete process.env[ENVIRONMENTS];
  else process.env[ENVIRONMENTS] = savedEnvironment;
  if (savedNameSource === undefined) delete process.env[NAME_SOURCE];
  else process.env[NAME_SOURCE] = savedNameSource;
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('explicit environment inheritance (#4782)', () => {
  it('gives sibling projects separate write keys and read scopes throughout their subdirectories', () => {
    for (const [cwd, expected] of [[childA, 'business-a'], [join(childA, 'src'), 'business-a'], [childB, 'business-b']]) {
      const context = getProjectContext(cwd);
      expect(getProjectName(cwd)).toBe(expected);
      expect(context.primary).toBe(expected);
      expect(context.allProjects).toEqual([expected]);
      expect(context.keySource).toBe('environment');
    }
    expect(getProjectContext(repo).allProjects).toEqual(['Workspace']);
  });

  it('replaces derived folder and remote keys with the explicit inherited list, keeping the primary last', () => {
    process.env[NAME_SOURCE] = 'git-remote';
    process.env[ENVIRONMENTS] = JSON.stringify([environment(childA, 'business-a', ['shared', 'business-a', 'shared'])]);
    const context = getProjectContext(childA);
    expect(context.primary).toBe('business-a');
    expect(context.allProjects).toEqual(['shared', 'business-a']);
    expect(withCheckoutProjects({ project: 'business-a' }, context).projects).toBe('shared,business-a');
    expect(getProjectContext(childB).allProjects).toEqual(['Workspace', 'acme/workspace']);
  });

  it.each(['worktree', 'submodule'] as const)('preserves %s identity metadata while isolating reads', kind => {
    const cwd = kind === 'worktree' ? worktree : submodule;
    const before = getProjectContext(cwd);
    expect(before.allProjects).toContain('Workspace');
    process.env[ENVIRONMENTS] = JSON.stringify([environment(cwd, 'isolated')]);
    const context = getProjectContext(cwd);
    expect(context.allProjects).toEqual(['isolated']);
    expect(context.isWorktree).toBe(before.isWorktree);
    expect(context.isSubmodule).toBe(before.isSubmodule);
    expect(getProjectName(cwd)).toBe('isolated');
  });

  it('reads changed inheritance settings without restarting and rejects invalid explicit settings', () => {
    expect(getProjectContext(childA).allProjects).toEqual(['business-a']);
    process.env[ENVIRONMENTS] = JSON.stringify([{ name: 'business-a', patterns: [`${childA}/**`] }]);
    expect(getProjectContext(childA).allProjects).toEqual(['Workspace', 'business-a']);
    process.env[ENVIRONMENTS] = JSON.stringify([{ ...environment(childA, 'business-a'), inherit: null }]);
    expect(() => getProjectContext(childA)).toThrow('inherit');
    expect(() => getProjectName(childA)).toThrow('inherit');
  });

  it.each([false, true])('keeps HTTP search, timeline and selected details aligned (inherit shared=%s)', async includeShared => {
    process.env[ENVIRONMENTS] = JSON.stringify([environment(childA, 'business-a', includeShared ? ['shared'] : [])]);
    const scope = withCheckoutProjects({ project: 'business-a' }, getProjectContext(childA));
    const index = await (await fetch(`${base}/api/search?${new URLSearchParams({ ...scope, query: 'Needle', type: 'observations', limit: '20' })}`)).json();
    const timeline = await (await fetch(`${base}/api/timeline?${new URLSearchParams({ ...scope, anchor: String(native), depth_before: '20', depth_after: '20' })}`)).json();
    for (const result of [index, timeline]) {
      expect(result.isError).not.toBe(true);
      expect(text(result)).toContain('Needle native A');
      expect(text(result)).toContain('Needle adopted A');
      expect(text(result)).not.toContain('Needle unrelated parent');
      expect(text(result)).not.toContain('Private parent prompt');
      expect(text(result)).not.toContain('Private parent summary');
      expect(text(result)).not.toContain('Needle sibling B');
      expect(text(result).includes('Needle shared memory')).toBe(includeShared);
    }
    const selected = await (await fetch(`${base}/api/observations/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...scope, ids: [native, adopted, foreign, shared, sibling] }),
    })).json();
    expect(selected.map((row: { id: number }) => row.id).sort()).toEqual((includeShared ? [native, adopted, shared] : [native, adopted]).sort());
  });

  it.each([{ inherit: [] }, { inherit: ['shared'] }])('passes the chosen scope through capture and all three injection hooks (%j)', ({ inherit }) => {
    const dataDir = mkdtempSync(join(root, 'hook-data-'));
    writeFileSync(join(dataDir, 'settings.json'), '{}');
    const file = join(childA, 'src', 'example.ts');
    writeFileSync(file, '// example fixture\n'.repeat(150));
    const env = {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_PROJECT_ENVIRONMENTS: JSON.stringify([environment(childA, 'business-a', inherit)]),
    };
    delete env.CLAUDE_MEM_INTERNAL;
    delete env.CLAUDE_PROJECT_DIR;
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', `
        import { mock } from 'bun:test';
        import assert from 'node:assert/strict';
        const calls = [];
        const settings = {
          CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_CONTEXT_PROJECTS: 'current', CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: 'false',
          CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false', CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5', CLAUDE_MEM_SEMANTIC_INJECT_FORMAT: 'index',
        };
        mock.module('./src/shared/hook-settings.ts', () => ({ loadFromFileOnce: () => settings }));
        const request = async (url, method, body) => {
          calls.push({ url, body });
          if (url === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (url === '/api/context/semantic') return { context: '', count: 0 };
          if (url.startsWith('/api/observations/by-file')) return { observations: [], count: 0 };
          return '';
        };
        const worker = await import('./src/shared/worker-utils.ts');
        mock.module('./src/shared/worker-utils.ts', () => ({
          ...worker, executeWithWorkerFallback: request, isWorkerFallback: () => false, getWorkerPort: () => 37777,
        }));
        const { contextHandler } = await import('./src/cli/handlers/context.ts');
        const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
        const { fileContextHandler } = await import('./src/cli/handlers/file-context.ts');
        setSessionInitDependenciesForTesting({
          loadFromFileOnce: () => settings, resolveRuntimeContext: () => ({ runtime: 'worker' }),
          executeWithWorkerFallback: request, isWorkerFallback: () => false,
        });
        const input = { sessionId: 'inheritance-hooks', cwd: ${JSON.stringify(childA)}, platform: 'claude-code' };
        await contextHandler.execute(input);
        await sessionInitHandler.execute({ ...input, prompt: 'Find the previous decision about this subsystem' });
        await fileContextHandler.execute({ ...input, toolName: 'Read', toolInput: { file_path: ${JSON.stringify(file)} } });
        const expected = ${JSON.stringify([...inherit, 'business-a'])};
        const init = calls.find(call => call.url === '/api/sessions/init');
        assert.equal(init.body.project, 'business-a');
        assert.equal(init.body.projectKeySource, 'environment');
        const semantic = calls.find(call => call.url === '/api/context/semantic');
        assert.deepEqual(semantic.body.projects, expected);
        for (const prefix of ['/api/context/inject?', '/api/observations/by-file?']) {
          const call = calls.find(call => call.url.startsWith(prefix));
          assert(call, 'Missing hook request: ' + prefix);
          assert.equal(new URL(call.url, 'http://fixture').searchParams.get('projects'), expected.join(','));
        }
      `],
      cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe',
    });
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps semantic anchor hydration scoped even when the vector index returns unrelated candidates', async () => {
    const search = new SessionSearch(store.db);
    search.searchObservations = () => { throw new Error('Semantic anchor must not fall back to keyword search'); };
    const manager = new SearchManager(search, store, {
      queryChroma: async () => ({ ids: [foreign, native, adopted, sibling], metadatas: [foreign, native, adopted, sibling].map(() => ({ doc_type: 'observation', created_at_epoch: epoch })) }),
    } as never, new FormattingService(), new TimelineService(), 0);
    const scope = withCheckoutProjects({ project: 'business-a' }, getProjectContext(childA));
    const result = await manager.timeline({ ...scope, query: 'Needle', depth_before: 20, depth_after: 20 });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('Needle native A');
    expect(text(result)).toContain('Needle adopted A');
    expect(text(result)).not.toContain('Needle unrelated parent');
    expect(text(result)).not.toContain('Private parent prompt');
  });
});
