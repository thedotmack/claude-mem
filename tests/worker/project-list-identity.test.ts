import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real SQLite, registered HTTP routes, a native checkout, the SessionStart
// handler and a source MCP subprocess share an owned fixture. No module mocks
// can replace the project parser, cache, renderer or transport under test.
const fixture = String.raw`
import express from 'express';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SessionStore } from './src/services/sqlite/SessionStore.ts';
import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
import { SearchManager } from './src/services/worker/SearchManager.ts';
import { FormattingService } from './src/services/worker/FormattingService.ts';
import { TimelineService } from './src/services/worker/TimelineService.ts';
import { ContextCacheService } from './src/services/worker/ContextCacheService.ts';
import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
import { ModeManager } from './src/services/domain/ModeManager.ts';
import { contextCacheKeys, contextCacheVariantId, readContextCache } from './src/shared/context-cache.ts';
import { projectsQueryString } from './src/shared/project-list.ts';
import { getProjectContext } from './src/utils/project-name.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

ModeManager.getInstance().loadMode('code');
const cwd = join(process.env.FIXTURE_ROOT, 'alpha,beta');
mkdirSync(cwd);
execFileSync('git', ['init', '--quiet', cwd]);
const checkout = getProjectContext(cwd);
const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
for (const [project, title] of [['alpha,beta', 'COMMA_NATIVE'], ['alpha', 'ALPHA_SIBLING'], ['beta', 'BETA_SIBLING'], ['parent', 'PARENT_RECORD']]) {
  const sid = store.createSDKSession('host-' + title, project, 'prompt');
  const memory = store.ensureMemorySessionIdRegistered(sid, 'memory-' + title);
  store.storeObservation(memory, project, { type: 'discovery', title, subtitle: null, narrative: title,
    facts: [], concepts: ['how-it-works'], files_read: ['src/app.ts'], files_modified: [] }, 1);
}
const manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
const cache = new ContextCacheService({
  // Only live routes populate this cache; this fixture does not start its timer.
  renderVariant: async () => { throw new Error('Unexpected background render'); },
  expandProjectReadKeys: projects => store.getProjectReadKeys(projects),
});
const app = express(); app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: 'fixture' }));
app.get('/api/ready', (_req, res) => res.type('text/event-stream').send('event: phase\ndata: {"phase":"ready"}\n\n'));
new SearchRoutes(manager, cache).setupRoutes(app);
new DataRoutes({}, { getSessionStore: () => store }, {}, {}, {}, Date.now()).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
process.env.CLAUDE_MEM_WORKER_PORT = String(port);
const url = 'http://127.0.0.1:' + port;
const read = async path => {
  const response = await fetch(url + path);
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status + ' ' + await response.text());
  return response.text();
};
const transport = new StdioClientTransport({ command: process.execPath, args: ['src/servers/mcp-server.ts'], cwd: process.cwd(), stderr: 'pipe', env: { ...process.env } });
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'project-list-identity', version: '1' });
const mcpText = result => result.content.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n');
try {
  // Prime the *different* two-project scope first. The native one-project hook
  // must not consume its on-disk body, even though both comma-join identically.
  const typed = await read('/api/context/inject?platformSource=claude&projects=alpha%2C%20beta');
  const foreignBefore = readContextCache(contextCacheKeys(checkout.allProjects, 'claude', false), Date.now())?.body ?? null;
  const { contextHandler } = await import('./src/cli/handlers/context.ts');
  const hook = await contextHandler.execute({ sessionId: 'new-comma-session', cwd, platform: 'claude-code' });
  const own = await read('/api/context/inject?platformSource=claude&' + projectsQueryString(['alpha,beta']));
  const single = await read('/api/context/inject?platformSource=claude&' + new URLSearchParams({ project: 'alpha,beta' }));
  const combined = await read('/api/context/inject?platformSource=claude&' + projectsQueryString(['parent', 'alpha,beta']));
  const repeated = await read('/api/context/inject?platformSource=claude&projects=parent&projects=alpha%2Cbeta');
  const repeatedSingularResponse = await fetch(url + '/api/context/inject?platformSource=claude&project=parent&project=alpha%2Cbeta');
  const repeatedSingular = { status: repeatedSingularResponse.status, text: await repeatedSingularResponse.text() };
  const byFile = JSON.parse(await read('/api/observations/by-file?path=src%2Fapp.ts&' + projectsQueryString(['alpha,beta'])));
  const search = await read('/api/search?format=json&query=NATIVE&' + projectsQueryString(['alpha,beta']));
  const cacheOwn = readContextCache(contextCacheKeys(['alpha,beta'], 'claude', false), Date.now())?.body;
  const cacheOther = readContextCache(contextCacheKeys(['alpha', 'beta'], 'claude', false), Date.now())?.body;
  await client.connect(transport);
  const mcp = [];
  for (const args of [{ project: 'alpha,beta' }, { projects: ['alpha,beta'] }, { projects: ['parent', 'alpha,beta'] }]) {
    mcp.push(mcpText(await client.callTool({ name: 'session_start_context', arguments: args })));
  }
  const typedMcp = mcpText(await client.callTool({ name: 'session_start_context', arguments: { projects: 'alpha, beta' } }));
  console.log(JSON.stringify({ checkout, typed, foreignBefore, hook, own, single, combined, repeated, repeatedSingular, byFile, search, cacheOwn, cacheOther, mcp, typedMcp,
    distinctCache: contextCacheVariantId(contextCacheKeys(['alpha,beta'], 'claude', false)) !== contextCacheVariantId(contextCacheKeys(['alpha', 'beta'], 'claude', false)) }));
} finally {
  await client.close(); cache.stop(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); store.close();
}
`;

describe('literal project lists across context and recall', () => {
  let result: any;
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'cm-project-list-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), timeout: 60_000, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, FIXTURE_ROOT: root, CLAUDE_MEM_DATA_DIR: join(root, 'data'), CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_AUTOSTART: 'false',
          CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false', CLAUDE_MEM_WORK_STATE_ENABLED: 'false', CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
          CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false', CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'false',
          CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_PROJECT_NAME_SOURCE: 'path', CLAUDE_MEM_PROJECT_ENVIRONMENTS: '',
          CLAUDE_MEM_CONTEXT_PROJECTS: 'current', CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'codex',
          CLAUDE_MEM_TELEMETRY_ENABLED: 'false' },
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 70_000);

  function expectOwn(text: string): void {
    expect(text).toContain('COMMA_NATIVE');
    expect(text).not.toContain('ALPHA_SIBLING');
    expect(text).not.toContain('BETA_SIBLING');
  }

  it('retains the existing hand-typed comma-list meaning', () => {
    for (const text of [result.typed, result.typedMcp]) {
      expect(text).toContain('ALPHA_SIBLING'); expect(text).toContain('BETA_SIBLING');
      expect(text).not.toContain('COMMA_NATIVE');
    }
  });

  it('does not inject a different project scope from a colliding cache file', () => {
    expect(result.checkout.allProjects).toEqual(['alpha,beta']);
    expect(result.foreignBefore).toBeNull();
    expect(result.distinctCache).toBe(true);
    expectOwn(result.hook.hookSpecificOutput.additionalContext);
  });

  it('round-trips an exact key through the hook query and singular project parameter', () => {
    expectOwn(result.own); expectOwn(result.single);
  });

  it('preserves exact entries alongside another project', () => {
    for (const text of [result.combined, result.repeated]) { expectOwn(text); expect(text).toContain('PARENT_RECORD'); }
  });

  it('reads every exact key from a repeated singular project parameter', () => {
    expect(result.repeatedSingular.status).toBe(200);
    expectOwn(result.repeatedSingular.text);
    expect(result.repeatedSingular.text).toContain('PARENT_RECORD');
  });

  it('keeps the file and search read scopes on the same recorded project', () => {
    expect(result.byFile.observations.map((row: any) => row.title)).toEqual(['COMMA_NATIVE']);
    expectOwn(result.search);
  });

  it('keeps independently cached bodies for the one-key and two-key scopes', () => {
    expectOwn(result.cacheOwn);
    expect(result.cacheOther).toContain('ALPHA_SIBLING'); expect(result.cacheOther).toContain('BETA_SIBLING');
    expect(result.cacheOther).not.toContain('COMMA_NATIVE');
  });

  it('preserves literal project and list arguments through actual MCP stdio', () => {
    for (const text of result.mcp) expectOwn(text);
    expect(result.mcp[2]).toContain('PARENT_RECORD');
  });
});
