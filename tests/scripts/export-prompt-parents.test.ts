import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { writeFileSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
  import { exportMemories } from './scripts/export-memories.ts';
  const source = new SessionStore(':memory:');
  const destination = new SessionStore(':memory:');
  const promptIds = [];
  for (const platform of ['claude', 'cursor']) {
    const session = source.createSDKSession('same-content-id', 'export-project', 'opening', undefined, platform);
    if (process.env.REGISTER_MEMORY === '1') source.ensureMemorySessionIdRegistered(session, platform + '-memory');
    promptIds.push(source.saveUserPrompt('same-content-id', 1, platform + ' needle', session));
  }
  source.createSDKSession('unselected-source', 'private-other-project', 'not matched');
  const app = express(); app.use(express.json());
  app.get('/api/search', (_req, res) => res.json({observations:[],sessions:[],prompts:source.getUserPromptsByIds(promptIds)}));
  new DataRoutes({}, {getSessionStore:()=>source,getChromaSync:()=>null}, {}, {}, {}, Date.now()).setupRoutes(app);
  const destinationApp = express(); destinationApp.use(express.json());
  new DataRoutes({}, {getSessionStore:()=>destination,getChromaSync:()=>null}, {}, {}, {}, Date.now()).setupRoutes(destinationApp);
  const destinationListener = destinationApp.listen(0, '127.0.0.1');
  await new Promise(resolve => destinationListener.once('listening',resolve));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening',resolve));
  const port = listener.address().port;
  writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'),JSON.stringify({CLAUDE_MEM_WORKER_PORT:String(port)}));
  const output=join(process.env.CLAUDE_MEM_DATA_DIR,'export.json');
  try {
    for (const promptIds of [[0], [-1], [1.5], ['1'], [Number.MAX_SAFE_INTEGER + 1]]) {
      const invalid = await fetch('http://127.0.0.1:' + port + '/api/sdk-sessions/batch', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({memorySessionIds:[],promptIds})});
      if (invalid.status !== 400) throw Error('Malformed prompt IDs accepted: ' + JSON.stringify(promptIds));
    }
    await exportMemories('needle',output,'export-project');
    const data=JSON.parse(readFileSync(output,'utf8'));
    // Force imported row IDs to differ from those in the source database.
    destination.createSDKSession('unrelated','elsewhere','ignore');
    const imported = await fetch('http://127.0.0.1:' + destinationListener.address().port + '/api/import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if (!imported.ok) throw Error(await imported.text());
    const stats=(await imported.json()).stats;
    if(stats.sessionsRejected || stats.promptsRejected) throw Error(JSON.stringify(stats));
    const rows=destination.db.prepare('SELECT up.prompt_text,s.project,s.platform_source FROM user_prompts up JOIN sdk_sessions s ON s.id=up.session_db_id ORDER BY s.platform_source').all();
    console.log(JSON.stringify({parentCount:data.totalSessions,parents:data.sessions.map(s=>s.memory_session_id).sort(),promptCount:data.totalPrompts,rows}));
  } finally { await new Promise(resolve=>listener.close(resolve));await new Promise(resolve=>destinationListener.close(resolve));source.close();destination.close(); }
`;

for (const registered of [true, false]) it('exports prompt parents through HTTP import with ' + (registered ? 'registered' : 'null') + ' memory IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-prompt-export-'));
  try {
    const child = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN: '1', REGISTER_MEMORY: registered ? '1' : '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    if(child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    const actual = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
    expect(actual).toEqual({ parentCount:2,parents:registered?['claude-memory','cursor-memory']:[null,null],promptCount:2,rows:[
      {prompt_text:'claude needle',project:'export-project',platform_source:'claude'},
      {prompt_text:'cursor needle',project:'export-project',platform_source:'cursor'},
    ] });
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
