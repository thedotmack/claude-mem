import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('follows a burst with bounded native reads and byte-exact UTF-8 output', async () => {
  const home=mkdtempSync(join(tmpdir(),'claude-mem-follow-chunks-'));
  const stamp=new Date().toISOString().slice(0,10);
  const log=join(home,'.claude-mem','logs',`worker-${stamp}.log`);
  mkdirSync(join(home,'.claude-mem','logs'),{recursive:true});
  writeFileSync(log,'before\n');
  const preload=join(home,'trace.cjs');
  // Observe actual filesystem calls; every read still executes the native
  // implementation against the owned log. No synthetic read result is used.
  writeFileSync(preload, `
    const fs=require('fs');const owned=new Set();
    const open=fs.openSync,read=fs.readSync,close=fs.closeSync;
    fs.openSync=function(path,...args){const fd=open.call(this,path,...args);if(String(path)===process.env.OWNED_LOG_PATH)owned.add(fd);return fd;};
    fs.readSync=function(fd,buffer,offset,length,position){if(owned.has(fd))process.stderr.write('READ_LENGTH:'+length+'\\n');return read.call(this,fd,buffer,offset,length,position);};
    fs.closeSync=function(fd){owned.delete(fd);return close.call(this,fd);};
  `);
  const child=spawn('node',['--require',preload,join(import.meta.dir,'../../scripts/worker-logs.cjs'),'--follow'],{
    env:{...process.env,HOME:home,USERPROFILE:home,CLAUDE_MEM_DATA_DIR:'',TZ:'UTC',OWNED_LOG_PATH:log},
  });
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  let output='',trace='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{trace+=chunk});
  const wait=async(predicate:()=>boolean)=>{const end=Date.now()+10000;while(!predicate()){
    if(Date.now()>end)throw Error('Owned follower did not produce expected output: '+trace);await Bun.sleep(10);}};
  try{
    await wait(()=>output==='before\n');
    const burst='€ captured\n'.repeat(200000);
    child.stdout.pause();
    appendFileSync(log,burst);
    await Bun.sleep(350);
    const pausedReadLengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    expect(pausedReadLengths.length).toBeGreaterThan(1);
    const bytesReadWhilePaused=pausedReadLengths.reduce((total,length)=>total+length,0);
    expect(bytesReadWhilePaused).toBeLessThan(Buffer.byteLength(burst));
    const duringBackpressure='second burst €\n'.repeat(5000);
    appendFileSync(log,duringBackpressure);
    await Bun.sleep(350);
    // The second poll must stay behind the blocked write, not read ahead
    // into another in-memory queue while the consumer remains paused.
    const laterReadLengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    expect(laterReadLengths).toEqual(pausedReadLengths);
    child.stdout.resume();
    await wait(()=>output.length==='before\n'.length+burst.length+duringBackpressure.length);
    expect(output).toBe('before\n'+burst+duringBackpressure);
    const lengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    expect(lengths.length).toBeGreaterThan(1);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(64*1024);
  }finally{
    const exited=child.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();await exited;
    rmSync(home,{recursive:true,force:true});
  }
},15000);
