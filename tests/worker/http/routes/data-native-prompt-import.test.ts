import { expect, it } from 'bun:test';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { PaginationHelper } from '../../../../src/services/worker/PaginationHelper.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';

async function serve(store: () => SessionStore, search = false) {
  const app = express();
  app.use(express.json());
  const facade = { getSessionStore: store, getChromaSync: () => null } as any;
  new DataRoutes(new PaginationHelper(facade), facade, {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
  if (search) new SearchRoutes(new SearchManager(new SessionSearch(store().db), store(), null,
    new FormattingService(), new TimelineService())).setupRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP listener');
  return { url: `http://127.0.0.1:${address.port}`, port: address.port, async close() {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

it('preserves native receipts through the real export CLI, HTTP import and a restart', async () => {
  const source = new SessionStore(':memory:', { syncOpsEnabled: false });
  const dir = mkdtempSync(join(tmpdir(), 'cmem-native-import-'));
  let destination = new SessionStore(join(dir, 'restored.sqlite'), { syncOpsEnabled: false });
  const sourceHttp = await serve(() => source, true);
  const destinationHttp = await serve(() => destination);
  try {
    const sid = source.createSDKSession('imported-native', 'project', 'again', undefined, 'hermes');
    const original = source.saveNativeUserPrompt('imported-native', sid, 'host-turn-one', 'again');
    const output = join(dir, 'export.json');
    const root = resolve(import.meta.dir, '../../../..');
    const child = Bun.spawn([process.execPath, join(root, 'scripts/export-memories.ts'), 'again', output, '--project=project'], {
      cwd: root, env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'export-settings'),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(sourceHttp.port), DO_NOT_TRACK: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(exitCode).toBe(0);
    const exported = JSON.parse(readFileSync(output, 'utf8'));
    expect(exported.totalPrompts).toBe(1);
    expect(exported.prompts[0].native_prompt_id).toBe('host-turn-one');
    expect(exported.prompts[0].native_prompt_hash).toMatch(/^[a-f0-9]{64}$/);
    const response = await fetch(`${destinationHttp.url}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { stats: { promptsImported: number; promptsRejected: number } };
    expect(result.stats.promptsImported).toBe(1);
    expect(result.stats.promptsRejected).toBe(0);
    destination.close();
    destination = new SessionStore(join(dir, 'restored.sqlite'), { syncOpsEnabled: false });
    const restoredSid = destination.createSDKSession('imported-native', 'project', 'again', undefined, 'hermes');
    const restored = destination.saveNativeUserPrompt('imported-native', restoredSid, 'host-turn-one', 'again');
    expect(restored.duplicate).toBe(true);
    expect(restored.promptNumber).toBe(original.promptNumber);
    expect(destination.getPromptNumberFromUserPrompts('imported-native', restoredSid)).toBe(1);
    expect(() => destination.saveNativeUserPrompt('imported-native', restoredSid, 'host-turn-one', 'different'))
      .toThrow('Native prompt identity was reused with different text');
  } finally {
    await sourceHttp.close(); await destinationHttp.close();
    source.close(); destination.close(); rmSync(dir, { recursive: true, force: true });
  }
});

it('still imports legacy prompt rows without either native receipt column', async () => {
  const store = new SessionStore(':memory:', { syncOpsEnabled: false });
  const http = await serve(() => store);
  try {
    store.createSDKSession('legacy-import', 'project', 'old prompt');
    const response = await fetch(`${http.url}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompts: [{
        content_session_id: 'legacy-import', prompt_number: 1, prompt_text: 'old prompt',
        created_at: new Date(1000).toISOString(), created_at_epoch: 1000,
      }] }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { stats: { promptsImported: number; promptsRejected: number } };
    expect(result.stats.promptsImported).toBe(1); expect(result.stats.promptsRejected).toBe(0);
    expect(store.db.query('SELECT prompt_text, native_prompt_id, native_prompt_hash FROM user_prompts').get())
      .toEqual({ prompt_text: 'old prompt', native_prompt_id: null, native_prompt_hash: null });
  } finally { await http.close(); store.close(); }
});
