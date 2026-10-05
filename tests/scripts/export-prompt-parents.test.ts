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
    source.ensureMemorySessionIdRegistered(session, platform + '-memory');
    promptIds.push(source.saveUserPrompt('same-content-id', 1, platform + ' needle', session));
  }
  const app = express(); app.use(express.json());
  app.get('/api/search', (_req, res) => res.json({observations:[],sessions:[],prompts:source.getUserPromptsByIds(promptIds)}));
  new DataRoutes({}, {getSessionStore:()=>source,getChromaSync:()=>null}, {}, {}, {}, Date.now()).setupRoutes(app);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening',resolve));
  const port = listener.address().port;
  writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'),JSON.stringify({CLAUDE_MEM_WORKER_PORT:String(port)}));
  const output=join(process.env.CLAUDE_MEM_DATA_DIR,'export.json');
  try {
    await exportMemories('needle',output,'export-project');
    const data=JSON.parse(readFileSync(output,'utf8'));
    // Force imported row IDs to differ from those in the source database.
    destination.createSDKSession('unrelated','elsewhere','ignore');
    for(const session of data.sessions) destination.importSdkSession(session);
    for(const prompt of data.prompts) destination.importUserPrompt(prompt);
    const rows=destination.db.prepare('SELECT up.prompt_text,s.project,s.platform_source FROM user_prompts up JOIN sdk_sessions s ON s.id=up.session_db_id ORDER BY s.platform_source').all();
    console.log(JSON.stringify({parentCount:data.totalSessions,parents:data.sessions.map(s=>s.memory_session_id).sort(),promptCount:data.totalPrompts,rows}));
  } finally { await new Promise(resolve=>listener.close(resolve));source.close();destination.close(); }
`;

it('exports parent metadata for prompt-only results and preserves ownership on native import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-prompt-export-'));
  try {
    const child = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    if(child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
    const actual = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
    expect(actual).toEqual({ parentCount:2,parents:['claude-memory','cursor-memory'],promptCount:2,rows:[
      {prompt_text:'claude needle',project:'export-project',platform_source:'claude'},
      {prompt_text:'cursor needle',project:'export-project',platform_source:'cursor'},
    ] });
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
