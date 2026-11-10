import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { configureToolUseIndex, searchToolUses } from '../../src/services/sqlite/tool-use-search.js';
import { DEEP_SEARCH_DEADLINE_MS } from '../../src/services/deep-search/protocol.js';

async function vacantPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady); });
  const port = (server.address() as any).port;
  await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  return port;
}

// The slow query must still be running when DEEP_SEARCH_DEADLINE_MS expires,
// on whatever machine runs this. Its cost is CPU-bound LIKE work, so a fixed
// row count races the runner: 8,000 rows took 5.5 s on a loaded M1 Max but
// under 4 s on CI, which then answered 'ok' instead of 'timeout'. So the
// fixture is sized from a timed sample on this machine instead.
// Each term ('ab', 'aab', ... 'a'.repeat(85) + 'b') matches only at the end of
// the long 'a' run, so every LIKE re-scans the run at each start position: one
// row costs about RUN x (1 + 2 + ... + 85 = 3,655) character steps (45 ms on that M1 Max), which
// keeps the database small. 85 terms is the most that fit the 4,096-character
// query limit in searchToolUses.
const SLOW_RUN_LENGTH = 4096;
const SLOW_TERM_COUNT = 85;
const SLOW_SAMPLE_ROWS = 5;
// Measured spread between repeated in-process runs of the sample: 1.9x
// (first run cold). 10x leaves room for the child running faster than the
// sample did; the extra rows cost under a second and a few MB to seed.
const SLOW_QUERY_DEADLINE_MULTIPLE = 10;

// End the seeding scope before opening the long-lived checkpoint connection.
// SessionStore retains cached statements, which Windows keeps open until GC.
function seedReleaseData(file: string) {
  const store = new SessionStore(file);
  try {
    const session = store.createSDKSession('context-session', 'app', 'test context');
    store.ensureMemorySessionIdRegistered(session, 'context-memory');
    store.storeObservation('context-memory', 'app', { type: 'discovery', title: 'ORDINARY_CONTEXT_RECORD',
      subtitle: null, narrative: 'ordinary context fixture', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
    store.markSessionCompleted(session); // historical evidence must not resume an observer
    const slowBody = '一 ' + 'a'.repeat(SLOW_RUN_LENGTH) + 'b';
    const slowQuery = '一 ' + Array.from({ length: SLOW_TERM_COUNT }, (_, k) => 'a'.repeat(k + 1) + 'b').join(' ') + ' absent';
    const write = (id: string, project: string, body: string) => store.upsertToolUse({ toolUseId: id,
      contentSessionId: 'raw-session', project, toolName: 'Read', toolResponse: body });
    const writeSlowRows = (from: number, to: number) => store.db.transaction(() => {
      for (let i = from; i < to; i++) write(`slow-${i}`, 'slow', slowBody);
    })();
    const id = write('hit', 'app', 'RECOVERY_MARKER 中文');
    writeSlowRows(0, SLOW_SAMPLE_ROWS);
    configureToolUseIndex(store.db, true);
    let sampleMs = Infinity;
    for (let run = 0; run < 2; run++) {
      const started = performance.now();
      const sample = searchToolUses(store.db, slowQuery, { project: 'slow' });
      if (sample.deep.status !== 'ok' || sample.deep.count !== 0) throw new Error('Slow fixture sample: ' + JSON.stringify(sample.deep));
      sampleMs = Math.min(sampleMs, performance.now() - started);
    }
    const slowRows = Math.ceil(SLOW_SAMPLE_ROWS * SLOW_QUERY_DEADLINE_MULTIPLE * DEEP_SEARCH_DEADLINE_MS / sampleMs);
    writeSlowRows(SLOW_SAMPLE_ROWS, slowRows); // the ready index's triggers cover these rows
    return { id, slowQuery, slowFixture: { sampleMs, slowRows } };
  } finally { store.close(); }
}

// CI builds before running this lane. These are the actual release entrypoints,
// copied out of the checkout; no test replacement for WorkerService or MCP.
for (const artifact of ['bundle', 'standalone']) {
  it(`round-trips deep search through the release ${artifact}, HTTP and MCP`, async () => {
    const root = resolve(process.env.CM_RELEASE_TEST_ROOT ?? '.');
    if (!existsSync(join(root, 'plugin/scripts/mcp-server.cjs'))) throw new Error('Run npm run build before release E2E tests');
    const dir = mkdtempSync(join(tmpdir(), 'cm-release-e2e-'));
    let ownedDb: Database | undefined;
    try {
      const data = join(dir, 'data'); mkdirSync(data);
      const plugin = join(dir, 'plugin'); cpSync(join(root, 'plugin'), plugin, { recursive: true });
      mkdirSync(join(dir, 'node_modules')); // No automatic dependency installation.
      const port = await vacantPort();
      const settings = { CLAUDE_MEM_WORKER_PORT: String(port), CLAUDE_MEM_CHROMA_ENABLED: 'false',
        CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'false', CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
        CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH: 'false',
        CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED: 'true', CLAUDE_MEM_WORKER_AUTOSTART: 'false' };
      writeFileSync(join(data, 'settings.json'), JSON.stringify(settings));
      const file = join(data, 'claude-mem.db');
      const { id, slowQuery, slowFixture } = seedReleaseData(file);
      Bun.gc(true);
      const db = ownedDb = new Database(file);
      const env = { ...process.env, ...settings, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: join(dir, 'config'),
        CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_MEM_MODES_DIR: join(plugin, 'modes'), CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_RUNTIME: 'worker', DO_NOT_TRACK: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dir, 'bun-cache') } as Record<string, string>;
      delete env.BUN_BE_BUN;
      let command = process.execPath;
      let args = [join(plugin, 'scripts/worker-service.cjs'), '--daemon'];
      if (artifact === 'standalone') {
        command = join(plugin, 'scripts', process.platform === 'win32' ? 'claude-mem.exe' : 'claude-mem');
        const build = spawnSync(process.execPath, [join(root, 'scripts/build-native-worker.js'), '--native', '--outfile', command],
          { cwd: root, encoding: 'utf8', timeout: 30_000 });
        if (build.status !== 0) throw new Error('Standalone build failed: ' + build.stderr.slice(-2000));
        args = ['--daemon'];
      }
      const worker = spawn(command, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let logs = '';
      worker.stdout.on('data', b => { logs = (logs + b).slice(-6000); });
      worker.stderr.on('data', b => { logs = (logs + b).slice(-6000); });
      worker.on('error', error => { logs += String(error); });
      const exited = new Promise<void>(resolveExit => worker.once('close', () => resolveExit()));
      const clients: Client[] = [];
      const transports: StdioClientTransport[] = [];
      const origin = `http://127.0.0.1:${port}`;
      const http = async (query: string, project = 'app') => {
        const response = await fetch(origin + '/api/search?' + new URLSearchParams({ query, project, deep: 'true', format: 'json' }),
          { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        return response.json() as Promise<any>;
      };
      const mcp = async () => {
        const transport = new StdioClientTransport({ command: 'node', args: [join(plugin, 'scripts/mcp-server.cjs')], cwd: dir, env, stderr: 'pipe' });
        transports.push(transport);
        transport.stderr?.on('data', b => { logs = (logs + b).slice(-6000); });
        const client = new Client({ name: 'release-deep-e2e', version: '1' }); clients.push(client);
        await client.connect(transport); return client;
      };
      // This test verifies release transport/lifecycle behavior. SQL overlap is
      // proved separately with a deep-only database in the isolation fixture.
      const call = async (client: Client, query: string, project = 'app') => {
        const result = await client.callTool({ name: 'search', arguments: { query, project, deep: true } });
        expect(result.isError).not.toBe(true);
        return (result.content as Array<{text: string}>).map(c => c.text ?? '').join('\n');
      };
      try {
        const readyDeadline = Date.now() + 15_000;
        let lastRead: unknown;
        while (true) {
          if (worker.exitCode !== null || worker.signalCode) throw new Error(`Worker exited: ${logs}`);
          try { lastRead = await http('RECOVERY_MARKER'); if ((lastRead as any).deep.status === 'ok') break; } catch (error) { lastRead = String(error); }
          if (Date.now() > readyDeadline) throw new Error('Worker never became ready: ' + JSON.stringify(lastRead) + '\n' + logs);
          await Bun.sleep(25);
        }
        const found = await http('RECOVERY_MARKER'); expect(found.toolUses[0].id).toBe(id!);
        expect((await http('NO_SUCH_MARKER')).deep).toEqual({ status: 'ok', complete: true, count: 0, hasMore: false });
        const client = await mcp(); const other = await mcp();
        expect(await call(client, 'RECOVERY_MARKER')).toContain('#T' + id);
        expect(await call(client, 'NO_SUCH_MARKER')).toContain('0 of 0 returned raw matches');
        const context = async () => {
          const started = performance.now();
          const response = await fetch(origin + '/api/context/inject?projects=app', { signal: AbortSignal.timeout(5000) });
          expect(response.ok).toBe(true);
          expect(await response.text()).toContain('ORDINARY_CONTEXT_RECORD');
          return performance.now() - started;
        };
        await context();
        const baseline: number[] = []; for (let i = 0; i < 5; i++) baseline.push(await context());
        let finished = false;
        // Submit equivalent slow requests together. A readiness probe using a
        // fast deep query could itself take the slot before the MCP request.
        const pendingHttp = [http(slowQuery, 'slow'), http(slowQuery, 'slow')];
        const timed = Promise.all(pendingHttp).finally(() => { finished = true; });
        expect((await Promise.race(pendingHttp)).deep.status).toBe('busy');
        expect((await http('RECOVERY_MARKER')).deep.status).toBe('busy');
        expect(await call(other, 'RECOVERY_MARKER')).toContain('Raw tool search: busy.');
        const during: number[] = [];
        for (let i = 0; i < 5 && !finished; i++) {
          const ms = await context();
          if (!finished) during.push(ms);
        }
        const ordinaryResponse = await fetch(origin + '/api/search?query=ORDINARY_CONTEXT_RECORD&project=app&deep=false&format=json');
        const ordinary = await ordinaryResponse.json() as any;
        expect(ordinary.observations).toHaveLength(1); expect(ordinary).not.toHaveProperty('deep');
        console.log(JSON.stringify({ artifact, slowFixture, contextBaselineMs: baseline, contextWhileDeepPendingMs: during }));
        const httpResults = await timed;
        expect(httpResults.map(result => result.deep.status).sort()).toEqual(['busy', 'timeout']);
        expect(httpResults.find(result => result.deep.status === 'timeout').deep)
          .toEqual({ status: 'timeout', complete: false, count: null, hasMore: null });
        for (let n = 0; n < 50; n++) { if ((await http('RECOVERY_MARKER')).deep.status === 'ok') break; await Bun.sleep(10); }
        const mcpResults = await Promise.all([call(client, slowQuery, 'slow'), call(other, slowQuery, 'slow')]);
        expect(mcpResults.filter(text => text.includes('Raw tool search: busy.'))).toHaveLength(1);
        const text = mcpResults.find(text => text.includes('Raw tool search: timeout.'))!;
        expect(text).toBeDefined();
        expect(text).toContain('does not mean no raw evidence');
        for (let n = 0; n < 50; n++) { if ((await http('RECOVERY_MARKER')).deep.status === 'ok') break; await Bun.sleep(10); }
        expect((await http('RECOVERY_MARKER')).deep.complete).toBe(true);
        expect((db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
      } catch (error) {
        const logDir = join(data, 'logs');
        const diagnostic = existsSync(logDir) ? readdirSync(logDir).filter(name => name.endsWith('.log'))
          .map(name => readFileSync(join(logDir, name), 'utf8').split('\n').slice(-50).join('\n')).join('\n') : '';
        throw new Error(`${artifact} release E2E failed: ${error}\n${diagnostic}\n${logs}`);
      } finally {
        await Promise.allSettled(clients.map(c => c.close()));
        await Promise.allSettled(transports.map(t => t.close()));
        // Stop only this owned temporary worker, never use the user's lifecycle CLI.
        try { await fetch(origin + '/api/admin/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch {}
        const timer = setTimeout(() => worker.kill('SIGKILL'), 3000);
        await exited; clearTimeout(timer);
      }
    } finally {
      ownedDb?.close(); ownedDb = undefined;
      Bun.gc(true); // Finalize fixture statements before unlinking SQLite files on Windows.
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
}
