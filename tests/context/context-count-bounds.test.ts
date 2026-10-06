import { expect, it } from 'bun:test';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dir, '../..');
function consumer(observations: string, full: string, sessions: string) {
  const script = `import {loadContextConfig} from './src/services/context/ContextConfigLoader.ts'; import {ModeManager} from './src/services/domain/ModeManager.ts'; import {SessionStore} from './src/services/sqlite/SessionStore.ts'; import {queryObservationsMulti,querySummariesMulti} from './src/services/context/ObservationCompiler.ts'; ModeManager.getInstance().loadMode('code');const store=new SessionStore(':memory:');try{const config=loadContextConfig();const rows=queryObservationsMulti(store,['app'],config);const summaries=querySummariesMulti(store,['app'],config);console.log(JSON.stringify({observations:config.totalObservationCount,full:config.fullObservationCount,sessions:config.sessionCount,rows:rows.length,summaries:summaries.length}));}finally{store.close();}`;
  const child = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_MEM_MODES_DIR: join(root, 'plugin/modes'),
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: observations,
      CLAUDE_MEM_CONTEXT_FULL_COUNT: full,
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: sessions,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
}
it('keeps direct invalid settings out of native SQLite LIMIT queries', () => {
  for (const invalid of ['NaN', 'Infinity', '-1', '3.5', '']) {
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
