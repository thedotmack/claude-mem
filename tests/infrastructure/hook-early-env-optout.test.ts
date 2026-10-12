import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { buildShellCommand, buildCodexWindowsCommand } from '../../src/build/hook-shell-template.js';

function probe(event: string, flag: string, windows=false) {
 const dir=mkdtempSync(join(tmpdir(),'hook-early-optout-'));const marker=join(dir,'started');
 try {
  mkdirSync(join(dir,'scripts'));writeFileSync(join(dir,'scripts','worker-service.cjs'),'');
  writeFileSync(join(dir,'scripts','bun-runner.js'),`require('fs').writeFileSync(${JSON.stringify(marker)},'started')`);
  const args=['hook',windows?'codex':'claude-code',event];
  const command=windows?buildCodexWindowsCommand(args):buildShellCommand({host:'claude-code',requireFile:'bun-runner.js',requireFileSecondary:'worker-service.cjs',trailingCommand:['node','"$_P/scripts/bun-runner.js"','"$_P/scripts/worker-service.cjs"',...args],notFoundMessage:'missing',failOpen:true});
  const env={...process.env,CLAUDE_PLUGIN_ROOT:dir,CLAUDE_MEM_DISABLE_TOOL_HOOKS:'',CLAUDE_MEM_DISABLE_OBSERVATION:'',CLAUDE_MEM_DISABLE_FILE_CONTEXT:'',[flag]:'1'};
  const result=spawnSync('/bin/sh',['-c',command],{env,encoding:'utf8'});
  return {status:result.status,stderr:result.stderr,started:existsSync(marker)};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
for(const windows of [false,true])for(const [event,flag] of [['file-context','CLAUDE_MEM_DISABLE_FILE_CONTEXT'],['observation','CLAUDE_MEM_DISABLE_OBSERVATION'],['file-context','CLAUDE_MEM_DISABLE_TOOL_HOOKS']]) {
 test(`exits before launching runtime for ${event} ${flag} windows=${windows}`,()=>expect(probe(event,flag,windows)).toEqual({status:0,stderr:'',started:false}));
}
test('does not skip an unrelated tool hook',()=>expect(probe('observation','CLAUDE_MEM_DISABLE_FILE_CONTEXT').started).toBe(true));
test('does not skip SessionStart context',()=>expect(probe('context','CLAUDE_MEM_DISABLE_TOOL_HOOKS').started).toBe(true));
