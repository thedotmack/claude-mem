import { afterAll, beforeAll, expect, it } from 'bun:test';
import express from 'express';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { ViewerRoutes } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';
import {
  UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for restart recovery tests');

let chrome:OwnedChrome|undefined;
let page:DevToolsPage|undefined;

beforeAll(async()=>{
  if(!chromeExecutablePath)return;
  chrome=launchChrome('about:blank',{profilePrefix:'claude-mem-restart-timeout-',extraFlags:UNTHROTTLED_TIMER_FLAGS,remoteDebugging:true});
  page=await connectToPage(chrome,'about:blank');
},30000);

afterAll(async()=>{
  page?.close();
  await chrome?.close();
},10000);

for (const stalled of ['post', 'health', 'health-body', 'readiness', 'no-successor', 'missing-pid', 'readiness-404'] as const) {
  (chromeExecutablePath ? it : it.skip)(`restart page recovers from ${stalled}`, async () => {
    let markReady!:()=>void;
    const ready=new Promise<void>(resolve=>{markReady=resolve});
    let report!:(result:unknown)=>void;
    const result=new Promise(resolve=>{report=resolve});
    const sockets=new Set<Socket>();
    const app=express();
    // The driver is appended to the real HTTP route's HTML. It does not replace
    // fetch, timers, or the restart implementation.
    app.use((req,res,next)=>{
      if(req.path==='/restart') {
        const send=res.send.bind(res);
        res.send=((body:string)=>send(body.replace('</body>','<script src="/driver.js"></script></body>'))) as typeof res.send;
      }
      next();
    });
    let restartRequests=0;
    let healthRequests=0;
    let readinessRequests=0;
    app.post('/api/admin/restart',(_req,res)=>{restartRequests++;if(stalled!=='post')res.json({success:true})});
    app.get('/health',(_req,res)=>{
      const attempt=++healthRequests;
      if(attempt===1 && stalled==='health')return;
      if(attempt===1 && stalled==='health-body') {
        res.setHeader('Content-Type','application/json');res.write('{"pid":');return;
      }
      res.json({...(stalled==='missing-pid'?{}:{pid:process.pid+(stalled==='no-successor'?0:1)}),status:'ok'});
    });
    app.get('/api/readiness',(_req,res)=>{
      if(++readinessRequests===1 && stalled==='readiness')return;
      res.status(stalled==='readiness-404'?404:200).json({ready:true});
    });
    // no-successor: the click handler fixes its 60 s deadline from the real
    // clock before its first await. Running the page clock 56 s ahead right
    // after the click brings that deadline about 4 s of real time away.
    app.get('/driver.js',(_req,res)=>res.type('application/javascript').send(`
      (async()=>{
        await fetch('/ready');
        await new Promise(requestAnimationFrame);
        const beforeClick=await fetch('/before-click').then(response=>response.json());
        document.getElementById('go').click();
        ${stalled==='no-successor'?'const realNow=Date.now.bind(Date);Date.now=()=>realNow()+56000;':''}
        const started=performance.now();
        const deadline=started+${stalled==='no-successor'?15000:9000};
        while(document.getElementById('status').textContent==='Restarting…' && performance.now()<deadline)
          await new Promise(resolve=>setTimeout(resolve,10));
        await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
          beforeClick,status:document.getElementById('status').textContent,disabled:document.getElementById('go').disabled,elapsed:performance.now()-started})});
      })();
    `));
    app.get('/before-click',(_req,res)=>res.json({restartRequests,healthRequests,readinessRequests}));
    app.get('/ready',(_req,res)=>{markReady();res.send('ready')});
    app.post('/result',express.json(),(req,res)=>{report(req.body);res.send('received')});
    new ViewerRoutes(null as any,null as any,null as any).setupRoutes(app);
    const server=createServer(app);
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
    try {
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const address=server.address();
      if(!address||typeof address==='string')throw Error('No native TCP address');
      await page!.send('Page.navigate',{url:`http://127.0.0.1:${address.port}/restart`});
      await withTimeout(ready,30000,'Restart page did not become ready');
      const received=await withTimeout(result,25000,'Browser timed out');
      const observation=received as {beforeClick:{restartRequests:number;healthRequests:number;readinessRequests:number};status:string;disabled:boolean;elapsed:number};
      expect(observation.beforeClick).toEqual({restartRequests:0,healthRequests:0,readinessRequests:0});
      expect(restartRequests).toBe(1);
      if(stalled==='no-successor') {
        expect(readinessRequests).toBe(0);
        expect(observation.status).toContain('doctor');
        expect(observation.disabled).toBe(false);
        expect(observation.elapsed).toBeGreaterThanOrEqual(3000);
        expect(observation.elapsed).toBeLessThan(10000);
      } else {
        expect(readinessRequests).toBeGreaterThanOrEqual(1);
        expect(observation.status).toBe('Memory worker restarted. You can close this tab.');
        expect(observation.disabled).toBe(true);
      }
      expect(healthRequests).toBeGreaterThanOrEqual(['post','missing-pid','readiness-404'].includes(stalled)?1:2);
    } finally {
      try {
        await page!.send('Page.navigate',{url:'about:blank'});
      } finally {
        for(const socket of sockets)socket.destroy();
        await new Promise<void>(resolve=>server.close(()=>resolve()));
      }
    }
  },80000);
}
