import { expect, it } from 'bun:test';
import express from 'express';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerRoutes } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome for restart recovery tests');

for (const stalled of ['post', 'health', 'health-body', 'readiness', 'no-successor'] as const) {
  (chrome ? it : it.skip)(`restart page recovers after a stalled ${stalled} request`, async () => {
    const owned=mkdtempSync(join(tmpdir(),'claude-mem-restart-timeout-'));
    let child:ReturnType<typeof Bun.spawn>|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let report!:(result:unknown)=>void;
    const result=new Promise(resolve=>{report=resolve});
    const sockets=new Set<Socket>();
    const app=express();
    // The driver is appended to the real HTTP route's HTML. It does not replace
    // fetch, clocks, timers, or the restart implementation.
    app.use((req,res,next)=>{
      if(req.path==='/restart') {
        const send=res.send.bind(res);
        res.send=((body:string)=>send(body.replace('</body>','<script src="/driver.js"></script></body>'))) as typeof res.send;
      }
      next();
    });
    let healthRequests=0;
    let readinessRequests=0;
    app.post('/api/admin/restart',(_req,res)=>{if(stalled!=='post')res.json({success:true})});
    app.get('/health',(_req,res)=>{
      const attempt=++healthRequests;
      if(attempt===1 && stalled==='health')return;
      if(attempt===1 && stalled==='health-body') {
        res.setHeader('Content-Type','application/json');res.write('{"pid":');return;
      }
      res.json({pid:process.pid+(stalled==='no-successor'?0:1),status:'ok'});
    });
    app.get('/api/readiness',(_req,res)=>{
      if(++readinessRequests===1 && stalled==='readiness')return;
      res.json({ready:true});
    });
    app.get('/driver.js',(_req,res)=>res.type('application/javascript').send(`
      (async()=>{
        document.getElementById('go').click();
        const started=Date.now();
        const deadline=started+${stalled==='no-successor'?65000:9000};
        while(document.getElementById('status').textContent==='Restarting…' && Date.now()<deadline)
          await new Promise(resolve=>setTimeout(resolve,10));
        await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          status:document.getElementById('status').textContent,disabled:document.getElementById('go').disabled,elapsed:Date.now()-started})});
      })();
    `));
    app.post('/result',express.json(),(req,res)=>{report(req.body);res.send('received')});
    new ViewerRoutes(null as any,null as any,null as any).setupRoutes(app);
    const server=createServer(app);
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
    try {
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const address=server.address();
      if(!address||typeof address==='string')throw Error('No native TCP address');
      child=Bun.spawn([chrome!,'--headless','--no-sandbox','--disable-gpu','--disable-background-networking',
        '--no-first-run',`--user-data-dir=${join(owned,'browser')}`,`http://127.0.0.1:${address.port}/restart`],
        {stdout:'ignore',stderr:'ignore'});
      const received=await Promise.race([result,new Promise(resolve=>{timer=setTimeout(()=>resolve({failure:'Browser timed out'}),(stalled==='no-successor'?75000:15000))})]);
      const observation=received as {status:string;disabled:boolean;elapsed:number};
      if(stalled==='no-successor') {
        expect(observation.status).toContain('doctor');
        expect(observation.disabled).toBe(false);
        expect(observation.elapsed).toBeGreaterThanOrEqual(60000);
        expect(observation.elapsed).toBeLessThan(65000);
      } else {
        expect(observation.status).toBe('Memory worker restarted. You can close this tab.');
        expect(observation.disabled).toBe(true);
      }
      expect(healthRequests).toBeGreaterThanOrEqual(stalled==='post'?1:2);
    } finally {
      clearTimeout(timer);
      if(child){child.kill();await child.exited;}
      for(const socket of sockets)socket.destroy();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      rmSync(owned,{recursive:true,force:true});
    }
  },stalled==='no-successor'?80000:20000);
}
