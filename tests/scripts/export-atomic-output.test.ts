import { expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const python = Bun.which('python3');
const supported = process.platform !== 'win32' && !!python;
if (process.env.CI && process.platform !== 'win32' && !python) throw new Error('The native file-limit export test requires Python3');

// A process-local file-size limit exercises a real short write/EFBIG without
// filling the host disk or replacing the filesystem implementation.
const limitLauncher = `import os,resource,signal,sys
resource.setrlimit(resource.RLIMIT_FSIZE,(512,512))
signal.signal(signal.SIGXFSZ,signal.SIG_IGN)
os.execv(sys.argv[1],sys.argv[1:])`;
const fixture = String.raw`
  import { writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { exportMemories } from './scripts/export-memories.ts';
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({observations:[],sessions:[],prompts:[{prompt_text:'large export body '.repeat(1000)}]})});
  writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR,'settings.json'),JSON.stringify({CLAUDE_MEM_WORKER_PORT:String(server.port)}));
  try {
    await exportMemories('owned',join(process.env.CLAUDE_MEM_DATA_DIR,'export.json'));
    throw Error('The export unexpectedly succeeded under the file-size limit');
  } catch(error) {
    if(error.code!=='EFBIG') throw error;
    console.log('EXPECTED_EFBIG');
  } finally {server.stop(true);}
`;

(supported ? it : it.skip)('preserves a previous valid export when the native filesystem refuses a partial replacement', () => {
  const dir=mkdtempSync(join(tmpdir(),'claude-mem-export-atomic-'));
  const original=JSON.stringify({previous:'last successful export',observations:[]});
  try{
    const destination=join(dir,'export.json');writeFileSync(destination,original);
    const child=Bun.spawnSync([python!,'-c',limitLauncher,process.execPath,'-e',fixture],{
      cwd:join(import.meta.dir,'../..'),
      env:{...process.env,CLAUDE_MEM_DATA_DIR:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN:'1'},stdout:'pipe',stderr:'pipe',
    });
    if(child.exitCode!==0)throw Error(new TextDecoder().decode(child.stderr));
    expect(new TextDecoder().decode(child.stdout)).toContain('EXPECTED_EFBIG');
    expect(readFileSync(destination,'utf8')).toBe(original);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

(supported ? it : it.skip)('keeps exporting to the native null device, including an owned symlink', () => {
  const dir=mkdtempSync(join(tmpdir(),'claude-mem-export-null-'));
  const script=String.raw`
    import {writeFileSync,symlinkSync} from 'node:fs';
    import {join} from 'node:path';
    import {exportMemories} from './scripts/export-memories.ts';
    const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({observations:[],sessions:[],prompts:[]})});
    writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR,'settings.json'),JSON.stringify({CLAUDE_MEM_WORKER_PORT:String(server.port)}));
    try {
      await exportMemories('owned','/dev/null');
      const link=join(process.env.CLAUDE_MEM_DATA_DIR,'null-link');symlinkSync('/dev/null',link);
      await exportMemories('owned',link);
      console.log('EXPECTED_NULL_EXPORT');
    } finally {server.stop(true);}
  `;
  try {
    const child=Bun.spawnSync([process.execPath,'-e',script],{cwd:join(import.meta.dir,'../..'),
      env:{...process.env,CLAUDE_MEM_DATA_DIR:dir,CLAUDE_CONFIG_DIR:join(dir,'config'),CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN:'1'},stdout:'pipe',stderr:'pipe'});
    if(child.exitCode!==0)throw Error(new TextDecoder().decode(child.stderr));
    expect(new TextDecoder().decode(child.stdout)).toContain('EXPECTED_NULL_EXPORT');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
