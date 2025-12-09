#!/usr/bin/env node
import{join as f,basename as x}from"path";import{homedir as b}from"os";import{existsSync as H}from"fs";import i from"path";import{existsSync as u}from"fs";import{homedir as C}from"os";import{spawnSync as A}from"child_process";import{readFileSync as y,existsSync as w}from"fs";import{join as R}from"path";import{homedir as I}from"os";var h=["bugfix","feature","refactor","discovery","decision","change"],U=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var S=h.join(","),m=U.join(",");var _=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_DATA_DIR:R(I(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:S,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:m,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let o=this.get(t);return parseInt(o,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!w(t))return this.getAllDefaults();let o=y(t,"utf-8"),r=JSON.parse(o).env||{},E={...this.DEFAULTS};for(let s of Object.keys(this.DEFAULTS))r[s]!==void 0&&(E[s]=r[s]);return E}};var n=i.join(C(),".claude","plugins","marketplaces","thedotmack"),P=500,k=1e3,W=15;function c(){let e=i.join(C(),".claude-mem","settings.json"),t=_.loadFromFile(e);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function M(){try{let e=c();return(await fetch(`http://127.0.0.1:${e}/health`,{signal:AbortSignal.timeout(P)})).ok}catch{return!1}}async function v(){try{let e=i.join(n,"plugin","scripts","worker-service.cjs");if(!u(e))throw new Error(`Worker script not found at ${e}`);if(process.platform==="win32"){let t=A("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath 'node' -ArgumentList '${e}' -WorkingDirectory '${n}' -WindowStyle Hidden`],{cwd:n,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(t.status!==0)throw new Error(t.stderr||"PowerShell Start-Process failed")}else{let t=i.join(n,"ecosystem.config.cjs");if(!u(t))throw new Error(`Ecosystem config not found at ${t}`);let o=i.join(n,"node_modules",".bin","pm2"),a=u(o)?o:"pm2",r=A(a,["start",t],{cwd:n,stdio:"pipe",encoding:"utf-8"});if(r.status!==0)throw new Error(r.stderr||"PM2 start failed")}for(let t=0;t<W;t++)if(await new Promise(o=>setTimeout(o,k)),await M())return!0;return!1}catch{return!1}}async function d(){if(await M())return;if(!await v()){let t=c();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${n}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}var F=f(b(),".claude","plugins","marketplaces","thedotmack"),V=f(F,"node_modules");H(V)||(console.error(`
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
`),process.exit(3));try{await d();let e=c(),t=x(process.cwd()),o=await fetch(`http://127.0.0.1:${e}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!o.ok)throw new Error(`Worker error ${o.status}`);let a=await o.text(),r=new Date,E=new Date("2025-12-06T00:00:00Z"),s=new Date("2025-12-05T05:00:00Z"),l="";r<s&&(l=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let T="";if(r<E){let g=r.getUTCHours()*60+r.getUTCMinutes(),O=Math.floor((g-300+1440)%1440/60),p=r.getUTCDate(),D=r.getUTCMonth(),N=r.getUTCFullYear()===2025&&D===11&&p>=1&&p<=5,L=O>=17&&O<19;N&&L?T=`
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
