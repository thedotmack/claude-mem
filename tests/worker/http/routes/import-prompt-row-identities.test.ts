import { expect, it } from 'bun:test';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';
import { getNativeContentOperation } from '../../../../src/services/sync/CloudSync.js';
import { decodeChanges } from '../../../../src/services/sync/SyncClient.js';
import { SyncApply } from '../../../../src/services/sync/SyncApply.js';

async function serve(store: SessionStore, search = false) {
  const app = express();
  app.use(express.json());
  const facade = { getSessionStore: () => store, getChromaSync: () => null } as never;
  new DataRoutes({} as never, facade, {} as never, {} as never, {} as never, Date.now()).setupRoutes(app);
  if (search) new SearchRoutes(new SearchManager(new SessionSearch(store.db), store, null,
    new FormattingService(), new TimelineService())).setupRoutes(app);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => listener.once('listening', resolve));
  const port = (listener.address() as { port: number }).port;
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => {
    listener.closeAllConnections(); listener.close(() => resolve());
  }) };
}

it('round-trips distinct synced prompts sharing a turn number through the real exporter and HTTP import', async () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'cmem-prompt-identities-'));
  const sourceHttp = await serve(source, true);
  const targetHttp = await serve(target);
  try {
    const apply = new SyncApply(source.db, { deviceId: 'exporting-device' });
    for (const [index, text] of ['needle first request', 'needle different request', 'needle first request'].entries()) {
      const origin = new SessionStore(':memory:');
      try {
        const sid = origin.createSDKSession('shared-conversation', 'prompt-project', 'Opening');
        origin.ensureMemorySessionIdRegistered(sid, 'shared-memory');
        // Independent devices number their first stored prompt as turn 1.
        const id = origin.saveUserPrompt('shared-conversation', 1, text, sid, undefined, undefined, 1_790_000_000_000 + index);
        const operation = getNativeContentOperation(origin.db, 'prompt', String(id), `origin-${index}`)!.operation;
        const result = apply.applyOps(decodeChanges([{ ...operation, seq: String(index + 1), server_ts: '1790000000100' }]));
        expect(result.quarantined).toBe(0);
      } finally { origin.close(); }
    }
    const output = join(directory, 'export.json');
    const root = resolve(import.meta.dir, '../../../..');
    const child = Bun.spawn([process.execPath, join(root, 'scripts/export-memories.ts'), 'needle', output, '--project=prompt-project'], {
      cwd: root, env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'settings'),
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(sourceHttp.port), DO_NOT_TRACK: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    if (exit !== 0) throw new Error(stderr);
    const exported = JSON.parse(readFileSync(output, 'utf8'));
    expect(exported.totalPrompts).toBe(3);
    expect(exported.prompts.map((row: { prompt_number: number }) => row.prompt_number)).toEqual([1, 1, 1]);
    // The destination already has its own first turn in this conversation.
    const native = target.createSDKSession('shared-conversation', 'prompt-project', 'Local opening');
    target.saveUserPrompt('shared-conversation', 1, 'Local request', native, undefined, undefined, 1_789_000_000_000);
    for (const replay of [false, true]) {
      const response = await fetch(`${targetHttp.url}/api/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).stats).toMatchObject({
        promptsImported: replay ? 0 : 3, promptsSkipped: replay ? 3 : 0, promptsRejected: 0,
      });
    }
    const restored = target.db.query('SELECT prompt_text, created_at_epoch FROM user_prompts ORDER BY created_at_epoch').all();
    expect(restored).toEqual([
      { prompt_text: 'Local request', created_at_epoch: 1_789_000_000_000 },
      { prompt_text: 'needle first request', created_at_epoch: 1_790_000_000_000 },
      { prompt_text: 'needle different request', created_at_epoch: 1_790_000_000_001 },
      { prompt_text: 'needle first request', created_at_epoch: 1_790_000_000_002 },
    ]);
  } finally {
    await sourceHttp.close(); await targetHttp.close();
    source.close(); target.close(); rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps distinct native receipts with identical preview, timestamp and turn number', () => {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  try {
    const sid = source.createSDKSession('native-session', 'prompt-project', 'Opening');
    const hash = createHash('sha256').update('Same preview').digest('hex');
    const ids = ['first-receipt', 'second-receipt'].map(key =>
      source.saveUserPrompt('native-session', 1, 'Same preview', sid, key, hash, 1000));
    target.importSdkSession(source.getSdkSessionsBySessionIds([], ids)[0]);
    const prompts = source.getUserPromptsByIds(ids);
    for (const row of prompts) expect(target.importUserPrompt(row).imported).toBe(true);
    for (const row of prompts) expect(target.importUserPrompt(row).imported).toBe(false);
    expect(target.db.query('SELECT native_prompt_id FROM user_prompts ORDER BY native_prompt_id').all()).toEqual([
      { native_prompt_id: 'first-receipt' }, { native_prompt_id: 'second-receipt' },
    ]);
  } finally { source.close(); target.close(); }
});

function importPair(seed: (target: SessionStore, sid: number) => number) {
  const target = new SessionStore(':memory:');
  const sid = target.createSDKSession('receipt-session', 'prompt-project', 'Opening');
  const existingId = seed(target, sid);
  const [stored] = target.getUserPromptsByIds([existingId]);
  return { target, stored, existingId };
}

it('skips a known native receipt even when its time or text differs, instead of failing the import', () => {
  const { target, stored, existingId } = importPair((store, sid) =>
    store.saveUserPrompt('receipt-session', 1, 'Captured here', sid, 'receipt-x', 'hash-x', 1));
  try {
    // The same native prompt captured on another device: a different time and a redacted text.
    expect(target.importUserPrompt({ ...stored, created_at_epoch: 2, prompt_text: 'Captured there' }))
      .toEqual({ imported: false, id: existingId });
    expect(target.db.query('SELECT COUNT(*) AS n FROM user_prompts').get()).toEqual({ n: 1 });
  } finally { target.close(); }
});

it('skips an export taken before receipts when the matching row has gained one since', () => {
  const { target, stored, existingId } = importPair((store, sid) =>
    store.saveUserPrompt('receipt-session', 1, 'Same ask', sid, 'receipt-y', 'hash-y', 5));
  try {
    expect(target.importUserPrompt({ ...stored, native_prompt_id: null, native_prompt_hash: null }))
      .toEqual({ imported: false, id: existingId });
    expect(target.db.query('SELECT COUNT(*) AS n FROM user_prompts').get()).toEqual({ n: 1 });
  } finally { target.close(); }
});
