import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';

// Native stdio paths let the CLI feed another program without an intermediate
// export file. Exercise the actual exporter, HTTP routes and SQLite records.
describe.skipIf(process.platform === 'win32')('JSON memory export to stdout', () => {
  let directory: string;
  let store: SessionStore;
  let server: Server;
  let unavailable: boolean;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cmem-export-stdout-'));
    store = new SessionStore(':memory:');
    const session = store.createSDKSession('stdout-session', 'stdio-project', 'Recover the original prompt');
    store.ensureMemorySessionIdRegistered(session, 'stdout-memory');
    store.storeObservation('stdout-memory', 'stdio-project', {
      type: 'decision', title: 'Preserve Unicode 中文', subtitle: null,
      narrative: 'Export complete JSON, including “quoted” text.', facts: ['A line\nwith a newline'],
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    store.saveUserPrompt('stdout-session', 1, 'Recover the original prompt', session);
    const manager = new SearchManager(new SessionSearch(store.db), store, null,
      new FormattingService(), new TimelineService());
    const app = express();
    app.use(express.json());
    unavailable = false;
    app.use((_req, res, next) => unavailable ? res.status(503).send('fixture worker unavailable') : next());
    new SearchRoutes(manager).setupRoutes(app);
    new DataRoutes({} as any, { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: String((server.address() as AddressInfo).port),
    }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function run(output: string, pipe = false) {
    const args = [process.execPath, '--preload', join(import.meta.dir, '../preload.ts'),
      join(import.meta.dir, '../../scripts/export-memories.ts'), '', output, '--project=stdio-project'];
    // Python's capture uses native pipes; Bun.spawn uses Unix socket pairs.
    const launch = pipe ? [Bun.which('python3')!, '-c',
      'import subprocess,json,sys; r=subprocess.run(sys.argv[1:],capture_output=True); print(json.dumps(dict(status=r.returncode,stdout=r.stdout.decode(),stderr=r.stderr.decode())))',
      ...args] : args;
    const child = Bun.spawn(launch, {
      cwd: directory,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'config'),
        CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (pipe) {
      if (status !== 0) throw new Error(stderr);
      return JSON.parse(stdout) as { status: number; stdout: string; stderr: string };
    }
    return { status, stdout, stderr };
  }

  for (const alias of [false, true]) {
    it(`writes one importable JSON document through ${alias ? 'an owned stdout symlink' : '/dev/stdout'}`, async () => {
      const output = alias ? join(directory, 'stdout-link') : '/dev/stdout';
      if (alias) symlinkSync('/dev/stdout', output);
      const result = await run(output);
      expect(result.status).toBe(0);
      const exported = JSON.parse(result.stdout);
      expect(exported).toMatchObject({ totalObservations: 1, totalSessions: 1, totalPrompts: 1 });
      expect(exported.observations[0].title).toBe('Preserve Unicode 中文');
      expect(result.stderr).toContain('Export complete!');
      const restored = new SessionStore(':memory:');
      try {
        restored.importSdkSession(exported.sessions[0]);
        const observation = restored.importObservation(exported.observations[0]);
        restored.importUserPrompt(exported.prompts[0]);
        expect(restored.getObservationById(observation.id)?.narrative)
          .toBe('Export complete JSON, including “quoted” text.');
        expect(restored.getUserPrompt('stdout-session', 1)).toBe('Recover the original prompt');
        expect(restored.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { restored.close(); }
    });
  }

  it.skipIf(!Bun.which('python3'))('keeps native pipe stdout free of progress messages', async () => {
    const result = await run('/dev/stdout', true);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ totalObservations: 1, totalSessions: 1, totalPrompts: 1 });
    expect(result.stderr).toContain('Export complete!');
  });

  it('preserves a regular file export', async () => {
    const output = join(directory, 'export.json');
    const result = await run(output);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      totalObservations: 1, totalSessions: 1, totalPrompts: 1,
    });
  });

  it('keeps JSON on stderr separate from ordinary stdout progress', async () => {
    const result = await run('/dev/stderr');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ totalObservations: 1, totalSessions: 1, totalPrompts: 1 });
    expect(result.stdout).toContain('Export complete!');
  });

  it('leaves the data stream empty when the worker rejects the export', async () => {
    unavailable = true;
    const result = await run('/dev/stdout');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Failed to search: 503');
  });
});
