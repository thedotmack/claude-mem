import { expect, it } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dir, '../..');
function consumer(
  observations: string,
  full: string,
  sessions: string,
  fileSettings?: Record<string, unknown>
) {
  const data = mkdtempSync(join(tmpdir(), 'context-settings-'));
  writeFileSync(join(data, 'settings.json'), JSON.stringify(fileSettings ?? {}));
  const script = `import {loadContextConfig} from './src/services/context/ContextConfigLoader.ts'; import {ModeManager} from './src/services/domain/ModeManager.ts'; import {SessionStore} from './src/services/sqlite/SessionStore.ts'; import {queryObservationsMulti,querySummariesMulti} from './src/services/context/ObservationCompiler.ts'; ModeManager.getInstance().loadMode('code');const store=new SessionStore(':memory:');try{const config=loadContextConfig();const rows=queryObservationsMulti(store,['app'],config);const summaries=querySummariesMulti(store,['app'],config);console.log(JSON.stringify({observations:config.totalObservationCount,full:config.fullObservationCount,sessions:config.sessionCount,rows:rows.length,summaries:summaries.length}));}finally{store.close();}`;
  const environment = {
    ...process.env,
    CLAUDE_MEM_DATA_DIR: data,
    CLAUDE_MEM_MODES_DIR: join(root, 'plugin/modes'),
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: observations,
    CLAUDE_MEM_CONTEXT_FULL_COUNT: full,
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: sessions,
  };
  if (fileSettings) {
    for (const key of [
      'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
      'CLAUDE_MEM_CONTEXT_FULL_COUNT',
      'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
    ])
      delete (environment as Record<string, string | undefined>)[key];
  }
  try {
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: root,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}
it('keeps direct invalid settings out of native SQLite LIMIT queries', () => {
  for (const invalid of ['NaN', 'Infinity', '-1', '3.5', '', '1e3', '10junk']) {
    expect(consumer(invalid, invalid, invalid)).toEqual({
      observations: 50,
      full: 0,
      sessions: 10,
      rows: 0,
      summaries: 0,
    });
  }
});
it('preserves zero and advanced custom counts', () => {
  expect(consumer('0', '0', '0')).toEqual({
    observations: 0,
    full: 0,
    sessions: 0,
    rows: 0,
    summaries: 0,
  });
  expect(consumer('1000', '100', '500')).toEqual({
    observations: 1000,
    full: 100,
    sessions: 500,
    rows: 0,
    summaries: 0,
  });
  expect(consumer('1', '0', '1')).toEqual({
    observations: 1,
    full: 0,
    sessions: 1,
    rows: 0,
    summaries: 0,
  });
  expect(consumer('200', '20', '50')).toEqual({
    observations: 200,
    full: 20,
    sessions: 50,
    rows: 0,
    summaries: 0,
  });
});

it('accepts numeric JSON counts without calling string methods on them', () => {
  expect(
    consumer('', '', '', {
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: 25,
      CLAUDE_MEM_CONTEXT_FULL_COUNT: 5,
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: 4,
    })
  ).toEqual({ observations: 25, full: 5, sessions: 4, rows: 0, summaries: 0 });
});

it('rejects prefix-like counts at the public settings endpoint', () => {
  const data = mkdtempSync(join(tmpdir(), 'context-settings-http-'));
  const script = `import express from 'express'; import { SettingsRoutes } from './src/services/worker/http/routes/SettingsRoutes.ts'; import assert from 'node:assert/strict'; const app=express();app.use(express.json());new SettingsRoutes({} as any).setupRoutes(app);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const url='http://127.0.0.1:'+server.address().port+'/api/settings';for(const value of ['1e3','1.5','1trailing']){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({CLAUDE_MEM_CONTEXT_FULL_COUNT:value})});assert.equal(response.status,400);}const valid=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({CLAUDE_MEM_CONTEXT_FULL_COUNT:5})});assert.equal(valid.status,200);}finally{await new Promise(r=>server.close(r));}`;
  const environment = { ...process.env, CLAUDE_MEM_DATA_DIR: data };
  delete environment.CLAUDE_MEM_CONTEXT_FULL_COUNT;
  try {
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: root,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
