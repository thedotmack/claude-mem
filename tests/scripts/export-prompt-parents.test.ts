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


it('exports 65535 prompts through the real batch route with bounded combined bindings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-large-prompt-export-'));
  const large = String.raw`
    import express from 'express';
    import { writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { SessionStore } from './src/services/sqlite/SessionStore.ts';
    import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
    import { exportMemories } from './scripts/export-memories.ts';
    const source = new SessionStore(':memory:');
    const sid = source.createSDKSession('large-export', 'export-project', 'opening');
    source.ensureMemorySessionIdRegistered(sid, 'large-memory');
    const insert = source.db.prepare('INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)');
    source.db.transaction(() => {
      for (let i = 1; i <= 65535; i++) insert.run(sid, 'large-export', i, 'needle ' + i, new Date().toISOString(), Date.now());
    })();
    const promptIds = source.db.prepare('SELECT id FROM user_prompts').all().map(r => r.id);
    const bindings = [];
    const nativePrepare = source.db.prepare.bind(source.db);
    source.db.prepare = (sql) => {
      const statement = nativePrepare(sql);
      if (sql.includes('FROM sdk_sessions') && sql.includes('WHERE')) {
        const nativeAll = statement.all.bind(statement);
        statement.all = (...args) => { bindings.push(args.length); return nativeAll(...args); };
      }
      return statement;
    };
    const app = express(); app.use(express.json({limit:'5mb'}));
    app.get('/api/search', (_req, res) => res.json({observations:[],sessions:[],prompts:source.getUserPromptsByIds(promptIds)}));
    new DataRoutes({}, {getSessionStore:()=>source,getChromaSync:()=>null}, {}, {}, {}, Date.now()).setupRoutes(app);
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'), JSON.stringify({CLAUDE_MEM_WORKER_PORT:String(listener.address().port)}));
    try {
      const output = join(process.env.CLAUDE_MEM_DATA_DIR, 'export.json');
      await exportMemories('needle', output, 'export-project');
      const data = JSON.parse(readFileSync(output, 'utf8'));
      // A second mixed lookup puts both reference types in the same batch and
      // repeats a parent across chunks; output still contains it once.
      const mixed = source.getSdkSessionsBySessionIds(Array.from({length:498},(_,i)=>'missing-'+i).concat('large-memory'), promptIds.slice(0, 1100));
      console.log(JSON.stringify({promptCount:data.totalPrompts,parentCount:data.totalSessions,parentMemory:data.sessions[0].memory_session_id,mixedCount:mixed.length,maxBindings:Math.max(...bindings)}));
    } finally { await new Promise(resolve=>listener.close(resolve));source.close(); }
  `;
  try {
    const child = Bun.spawnSync([process.execPath, '-e', large], { cwd:join(import.meta.dir,'../..'),env:{...process.env,CLAUDE_MEM_DATA_DIR:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN:'1'},stdout:'pipe',stderr:'pipe' });
    if (child.exitCode !== 0) throw Error(new TextDecoder().decode(child.stderr));
    const actual = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
    expect(actual.promptCount).toBe(65535);
    expect(actual.parentCount).toBe(1);
    expect(actual.parentMemory).toBe('large-memory');
    expect(actual.mixedCount).toBe(1);
    expect(actual.maxBindings).toBeLessThanOrEqual(500);
  } finally { rmSync(dir,{recursive:true,force:true}); }
}, 60000);
