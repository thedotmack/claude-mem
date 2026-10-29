import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real HTTP routes, persistent SQLite, and the existing read-only worker thread.
const fixture = String.raw`
import express from 'express';
import { SessionStore } from './src/services/sqlite/SessionStore.ts';
import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
import { SearchManager } from './src/services/worker/SearchManager.ts';
import { FormattingService } from './src/services/worker/FormattingService.ts';
import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
const search = new SessionSearch(store.db);
const reader = new ContextReadWorkerClient();
const seed = (project, merged) => {
  const id = store.createSDKSession(project, project, 'prompt');
  store.ensureMemorySessionIdRegistered(id, project + '-memory');
  store.storeObservation(project + '-memory', project, {type: 'discovery', title: 'unrelated summary', subtitle: null,
    narrative: '', facts: [], concepts: [], files_read: [], files_modified: []}, 1);
  if (merged) store.db.run('UPDATE observations SET merged_into_project = ? WHERE project = ?', [merged, project]);
};
seed('legacy', 'target'); seed('partial', 'target');
store.storeObservation('partial-memory', 'partial', {type: 'discovery', title: 'not adopted', subtitle: null,
  narrative: '', facts: [], concepts: [], files_read: [], files_modified: []}, 2);
const ids = {};
for (const project of ['target', 'legacy', 'partial', 'raw-only', 'other']) ids[project] = store.upsertToolUse({
  toolUseId: project, contentSessionId: project, project, toolName: 'Bash', platformSource: 'codex',
  toolInput: 'diagnose', toolResponse: 'DB_CONN_1042: increase pool to 30',
});
await search.configureToolUseIndex(true);
const manager = new SearchManager(search, store, null, new FormattingService(), {}, undefined, reader);
const app = express(); app.use(express.json());
new SearchRoutes(manager).setupRoutes(app);
new DataRoutes({}, {getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null}, {getSession: () => undefined}, {broadcast: () => {}}, {}, Date.now()).setupRoutes(app);
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const get = async params => {
  const r = await fetch(url + '/api/search?' + new URLSearchParams({query:'DB_CONN_1042', deep:'true', format:'json', ...params}));
  return { status:r.status, body:await r.json() };
};
const batch = async (ids, scope) => {
  const r = await fetch(url + '/api/tool-uses/batch', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids,...scope})});
  return {status:r.status,body:await r.json()};
};
try {
  const scoped = await get({project:'TARGET',platformSource:'codex'});
  const selected = await batch(scoped.body.toolUses.map(r=>r.id), {project:'TARGET',platformSource:'codex'});
  const rekey = await get({project:'target',projects:'target,raw-only',platformSource:'codex'});
  const rekeySelected = await batch(rekey.body.toolUses.map(r=>r.id), {project:'target',projects:'target,raw-only',platformSource:'codex'});
  const wrongPlatform = await get({project:'target',platformSource:'claude'});
  const rejected = await get({project:'target',deep:'yes'});
  seed('delete-me', null);
  store.upsertToolUse({toolUseId:'delete-me',contentSessionId:'delete-me',project:'delete-me',toolName:'Bash',toolResponse:'DB_CONN_1042'});
  const deleteUrl = url + '/api/sessions/claude/delete-me';
  store.db.run("CREATE TRIGGER fail_raw_delete BEFORE DELETE ON tool_uses BEGIN SELECT RAISE(ABORT, 'fixture index failure'); END");
  const failedDelete = await fetch(deleteUrl, {method:'DELETE'});
  const failedDeleteStatus = failedDelete.status; await failedDelete.text();
  const afterFailedDelete = store.db.query("SELECT count(*) n FROM observations WHERE project='delete-me'").get().n;
  store.db.run('DROP TRIGGER fail_raw_delete');
  const deleted = await fetch(deleteUrl, {method:'DELETE'});
  const deletedStatus = deleted.status; const deletedBody = await deleted.text();
  const afterDelete = await get({project:'delete-me'});
  store.db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
  console.log(JSON.stringify({ids,scoped,selected,rekey,rekeySelected,wrongPlatform,rejected,failedDeleteStatus,afterFailedDelete,deletedStatus,deletedBody,afterDelete}));
} finally { await new Promise(resolve=>server.close(resolve)); await reader.close(); store.close(); }
`;

it('keeps HTTP search, worker reads and selected raw bodies in the same project/platform scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-search-http-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir, CLAUDE_MEM_CHROMA_ENABLED: 'false' },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    const data = JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
    const ids = (rows: any[]) => rows.map(r => r.id).sort((a,b)=>a-b);
    expect(data.scoped.status).toBe(200);
    expect(data.scoped.body.deep.status).toBe('ok');
    expect(ids(data.scoped.body.toolUses)).toEqual([data.ids.target, data.ids.legacy].sort((a,b)=>a-b));
    expect(ids(data.selected.body)).toEqual(ids(data.scoped.body.toolUses));
    expect(data.rekeySelected.status).toBe(200);
    expect(ids(data.rekeySelected.body)).toEqual(ids(data.rekey.body.toolUses));
    expect(ids(data.rekey.body.toolUses)).toContain(data.ids['raw-only']);
    expect(ids(data.rekey.body.toolUses)).not.toContain(data.ids.partial);
    expect(ids(data.rekey.body.toolUses)).not.toContain(data.ids.other);
    expect(data.wrongPlatform.body.toolUses).toEqual([]);
    expect(data.rejected.status).toBe(400);
    expect(data.failedDeleteStatus).toBe(500);
    expect(data.afterFailedDelete).toBe(1);
    expect({status:data.deletedStatus,body: data.deletedStatus === 200 ? '' : data.deletedBody}).toEqual({status:200,body:''});
    expect(JSON.parse(data.deletedBody).deletedCounts.toolUses).toBe(1);
    expect(data.afterDelete.body.toolUses).toEqual([]);
  } finally { rmSync(dir, {recursive:true,force:true}); }
}, 20_000);
