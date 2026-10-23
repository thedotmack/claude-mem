import { expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// The follower's stdout goes to a FIFO this test reads only when it chooses to,
// so "paused" is real kernel backpressure. Bun's child_process stdout.pause()
// (and an unread Bun.spawn pipe) keeps draining the pipe into memory, which
// would let the follower read the whole burst without ever blocking.
const supportsFifo = process.platform !== 'win32';

for (const pollDelay of [0, 650]) it.skipIf(!supportsFifo)(`follows a burst with bounded native reads and byte-exact UTF-8 output (${pollDelay ? 'delayed snapshot delivery' : 'native delivery'})`, async () => {
  const home=mkdtempSync(join(tmpdir(),'claude-mem-follow-chunks-'));
  const stamp=new Date().toISOString().slice(0,10);
  const log=join(home,'.claude-mem','logs',`claude-mem-${stamp}.log`);
  mkdirSync(join(home,'.claude-mem','logs'),{recursive:true});
  writeFileSync(log,'before\n');
  const preload=join(home,'trace.cjs');
  // Observe actual filesystem calls; every read still executes the native
  // implementation against the owned log. No synthetic read result is used.
  writeFileSync(preload, `
    const fs=require('fs');const owned=new Set();
    const open=fs.openSync,read=fs.readSync,close=fs.closeSync,watch=fs.watchFile;
    fs.watchFile=function(path,options,listener){
      return watch.call(this,path,options,(...args)=>{
        const size=args[0].size,firstBurst=Number(process.env.OWNED_FIRST_BURST_SIZE);
        process.stderr.write('NATIVE_POLL_SIZE:'+size+'\\n');
        // Queue a pre-second-burst snapshot ahead of its newer snapshot.
        // Both are actual native events; only callback delivery is delayed.
        const delay=Number(process.env.OWNED_POLL_DELAY_MS)
          ? size>firstBurst?2000:size===firstBurst?1200:650 : 0;
        setTimeout(()=>{listener(...args);process.stderr.write('POLL_DELIVERED\\nPOLL_SIZE:'+size+'\\n');},delay);
      });
    };
    fs.openSync=function(path,...args){const fd=open.call(this,path,...args);if(String(path)===process.env.OWNED_LOG_PATH)owned.add(fd);return fd;};
    fs.readSync=function(fd,buffer,offset,length,position){if(owned.has(fd))process.stderr.write('READ_LENGTH:'+length+'\\n');return read.call(this,fd,buffer,offset,length,position);};
    fs.closeSync=function(fd){owned.delete(fd);return close.call(this,fd);};
  `);
  const stdoutFifo=join(home,'stdout.fifo');
  execFileSync('mkfifo',[stdoutFifo],{timeout:5000});
  // Open the read end first (non-blocking) so opening the write end does not block.
  const stdoutReadFd=openSync(stdoutFifo,constants.O_RDONLY|constants.O_NONBLOCK);
  const stdoutWriteFd=openSync(stdoutFifo,constants.O_WRONLY);
  const child=spawn('node',['--require',preload,join(import.meta.dir,'../../scripts/worker-logs.cjs'),'--follow'],{
    env:{...process.env,HOME:home,USERPROFILE:home,CLAUDE_MEM_DATA_DIR:'',TZ:'UTC',OWNED_LOG_PATH:log,OWNED_POLL_DELAY_MS:String(pollDelay),OWNED_FIRST_BURST_SIZE:String(Buffer.byteLength('before\n'+'€ captured\n'.repeat(200000)))},
    stdio:['ignore',stdoutWriteFd,'pipe'],
  });
  closeSync(stdoutWriteFd);
  child.stderr!.setEncoding('utf8');
  let output='',trace='',stdoutPaused=false;child.stderr!.on('data',chunk=>{trace+=chunk});
  const stdoutDecoder=new StringDecoder('utf8');const readBuffer=Buffer.alloc(64*1024);
  const readAvailableStdout=()=>{
    if(stdoutPaused)return;
    for(;;){
      let bytes:number;
      try{bytes=readSync(stdoutReadFd,readBuffer,0,readBuffer.length,null);}
      catch(error){if((error as NodeJS.ErrnoException).code==='EAGAIN')return;throw error;}
      if(bytes===0)return;
      output+=stdoutDecoder.write(readBuffer.subarray(0,bytes));
    }
  };
  const wait=async(predicate:()=>boolean)=>{const end=Date.now()+10000;readAvailableStdout();while(!predicate()){
    if(Date.now()>end)throw Error('Owned follower did not produce expected output: '+trace);await Bun.sleep(10);readAvailableStdout();}};
  try{
    await wait(()=>output==='before\n');
    const burst='€ captured\n'.repeat(200000);
    stdoutPaused=true;
    if(pollDelay){
      const firstHalf=burst.slice(0,burst.length/2);
      appendFileSync(log,firstHalf);
      await wait(()=>trace.includes('NATIVE_POLL_SIZE:'+Buffer.byteLength('before\n'+firstHalf)+'\n'));
      // Queue two real changes before the first delayed callback reaches the
      // follower. The latter stale callback can arrive after the second burst.
      await Bun.sleep(500);
      appendFileSync(log,burst.slice(burst.length/2));
    }else appendFileSync(log,burst);
    // Observe the native follow read before testing backpressure. Poll
    // delivery can be delayed by host scheduling without a reader defect.
    await wait(()=>[...trace.matchAll(/READ_LENGTH:(\d+)/g)].length>1);
    await Bun.sleep(350);
    const pausedReadLengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    expect(pausedReadLengths.length).toBeGreaterThan(1);
    const bytesReadWhilePaused=pausedReadLengths.reduce((total,length)=>total+length,0);
    expect(bytesReadWhilePaused).toBeLessThan(Buffer.byteLength(burst));
    const duringBackpressure='second burst €\n'.repeat(5000);
    const secondBurstSize=Buffer.byteLength('before\n'+burst+duringBackpressure);
    appendFileSync(log,duringBackpressure);
    await wait(()=>[...trace.matchAll(/^POLL_SIZE:(\d+)$/gm)].some(match=>Number(match[1])>=secondBurstSize));
    await Bun.sleep(350);
    // The second poll must stay behind the blocked write, not read ahead
    // into another in-memory queue while the consumer remains paused.
    const laterPollSizes=[...trace.matchAll(/^POLL_SIZE:(\d+)$/gm)].map(match=>Number(match[1]));
    expect(laterPollSizes).toContain(secondBurstSize);
    const laterReadLengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    expect(laterReadLengths).toEqual(pausedReadLengths);
    stdoutPaused=false;
    await wait(()=>output.length==='before\n'.length+burst.length+duringBackpressure.length);
    expect(output).toBe('before\n'+burst+duringBackpressure);
    const lengths=[...trace.matchAll(/READ_LENGTH:(\d+)/g)].map(match=>Number(match[1]));
    expect(lengths.length).toBeGreaterThan(1);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(64*1024);
  }finally{
    const exited=child.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();await exited;
    closeSync(stdoutReadFd);
    rmSync(home,{recursive:true,force:true});
  }
},40000);
