#!/usr/bin/env node
import{join as M,basename as W}from"path";import{homedir as v}from"os";import{existsSync as x}from"fs";import i from"path";import{existsSync as u}from"fs";import{homedir as f}from"os";import{spawnSync as d}from"child_process";import{readFileSync as y,existsSync as w}from"fs";var L=["bugfix","feature","refactor","discovery","decision","change"],U=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var S=L.join(","),m=U.join(",");var E=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:S,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:m,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let o=this.get(t);return parseInt(o,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!w(t))return this.getAllDefaults();let o=y(t,"utf-8"),r=JSON.parse(o).env||{},c={...this.DEFAULTS};for(let s of Object.keys(this.DEFAULTS))r[s]!==void 0&&(c[s]=r[s]);return c}};var n=i.join(f(),".claude","plugins","marketplaces","thedotmack"),R=500,P=1e3,I=15;function _(){let e=i.join(f(),".claude-mem","settings.json"),t=E.loadFromFile(e);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function C(){try{let e=_();return(await fetch(`http://127.0.0.1:${e}/health`,{signal:AbortSignal.timeout(R)})).ok}catch{return!1}}async function k(){try{let e=i.join(n,"plugin","scripts","worker-service.cjs");if(!u(e))throw new Error(`Worker script not found at ${e}`);if(process.platform==="win32"){let t=d("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath 'node' -ArgumentList '${e}' -WorkingDirectory '${n}' -WindowStyle Hidden`],{cwd:n,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(t.status!==0)throw new Error(t.stderr||"PowerShell Start-Process failed")}else{let t=i.join(n,"ecosystem.config.cjs");if(!u(t))throw new Error(`Ecosystem config not found at ${t}`);let o=i.join(n,"node_modules",".bin","pm2"),a=u(o)?o:"pm2",r=d(a,["start",t],{cwd:n,stdio:"pipe",encoding:"utf-8"});if(r.status!==0)throw new Error(r.stderr||"PM2 start failed")}for(let t=0;t<I;t++)if(await new Promise(o=>setTimeout(o,P)),await C())return!0;return!1}catch{return!1}}async function A(){if(await C())return;if(!await k()){let t=_();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${n}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}var b=M(v(),".claude","plugins","marketplaces","thedotmack"),F=M(b,"node_modules");x(F)||(console.error(`
---
\u{1F389}  Note: This appears under Plugin Hook Error, but it's not an error. That's the only option for
   user messages in Claude Code UI until a better method is provided.
---

\u26A0\uFE0F  Claude-Mem: First-Time Setup

Dependencies have been installed in the background. This only happens once.

\u{1F4A1} TIPS:
   \u2022 Memories will start generating while you work
   \u2022 Use /init to write or update your CLAUDE.md for better project context
   \u2022 Try /clear after one session to see what context looks like

Thank you for installing Claude-Mem!

This message was not added to your startup context, so you can continue working as normal.
`),process.exit(3));try{await A();let e=_(),t=W(process.cwd()),o=await fetch(`http://127.0.0.1:${e}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!o.ok)throw new Error(`Worker error ${o.status}`);let a=await o.text(),r=new Date,c=new Date("2025-12-06T00:00:00Z"),s=new Date("2025-12-05T05:00:00Z"),l="";r<s&&(l=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let T="";if(r<c){let g=r.getUTCHours()*60+r.getUTCMinutes(),p=Math.floor((g-300+1440)%1440/60),O=r.getUTCDate(),h=r.getUTCMonth(),N=r.getUTCFullYear()===2025&&h===11&&O>=1&&O<=5,D=p>=17&&p<19;N&&D?T=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:T=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+a+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+l+T+`
\u{1F4FA} Watch live in browser http://localhost:${e}/
`)}catch(e){console.error(`\u274C Failed to load context display: ${e}`)}process.exit(3);
