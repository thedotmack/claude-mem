#!/usr/bin/env node
import{join as M,basename as B}from"path";import{homedir as j}from"os";import{existsSync as G}from"fs";import l from"path";import{existsSync as A}from"fs";import{homedir as b}from"os";import{spawnSync as W}from"child_process";import{join as r,dirname as R,basename as Z}from"path";import{homedir as g}from"os";import{fileURLToPath as y}from"url";function I(){return typeof __dirname<"u"?__dirname:R(y(import.meta.url))}var w=I(),a=process.env.CLAUDE_MEM_DATA_DIR||r(g(),".claude-mem"),p=process.env.CLAUDE_CONFIG_DIR||r(g(),".claude"),et=r(a,"archives"),ot=r(a,"logs"),rt=r(a,"trash"),nt=r(a,"backups"),st=r(a,"settings.json"),it=r(a,"claude-mem.db"),at=r(a,"vector-db"),ct=r(p,"settings.json"),_t=r(p,"commands"),Et=r(p,"CLAUDE.md");function m(){return r(w,"..","..")}import{readFileSync as k,existsSync as v}from"fs";var x=["bugfix","feature","refactor","discovery","decision","change"],P=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var O=x.join(","),f=P.join(",");var E=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:O,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:f,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let o=this.get(t);return parseInt(o,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!v(t))return this.getAllDefaults();let o=k(t,"utf-8"),n=JSON.parse(o).env||{},i={...this.DEFAULTS};for(let s of Object.keys(this.DEFAULTS))n[s]!==void 0&&(i[s]=n[s]);return i}};var H=100,F=500,X=10;function u(){let e=l.join(b(),".claude-mem","settings.json"),t=E.loadFromFile(e);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function C(){try{let e=u();return(await fetch(`http://127.0.0.1:${e}/health`,{signal:AbortSignal.timeout(H)})).ok}catch{return!1}}async function V(){try{let e=m(),t=l.join(e,"ecosystem.config.cjs");if(!A(t))throw new Error(`Ecosystem config not found at ${t}`);let o=l.join(e,"node_modules",".bin","pm2"),c=process.platform==="win32"?o+".cmd":o,n=A(c)?c:"pm2",i=W(n,["start",t],{cwd:e,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(i.status!==0)throw new Error(i.stderr||"PM2 start failed");for(let s=0;s<X;s++)if(await new Promise(_=>setTimeout(_,F)),await C())return!0;return!1}catch{return!1}}async function D(){if(await C())return;if(!await V()){let t=u(),o=m();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${o}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}var K=M(j(),".claude","plugins","marketplaces","thedotmack"),Y=M(K,"node_modules");G(Y)||(console.error(`
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
`),process.exit(3));try{await D();let e=u(),t=B(process.cwd()),o=await fetch(`http://127.0.0.1:${e}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!o.ok)throw new Error(`Worker error ${o.status}`);let c=await o.text(),n=new Date,i=new Date("2025-12-06T00:00:00Z"),s=new Date("2025-12-05T05:00:00Z"),_="";n<s&&(_=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let T="";if(n<i){let h=n.getUTCHours()*60+n.getUTCMinutes(),S=Math.floor((h-300+1440)%1440/60),d=n.getUTCDate(),N=n.getUTCMonth(),U=n.getUTCFullYear()===2025&&N===11&&d>=1&&d<=5,L=S>=17&&S<19;U&&L?T=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:T=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+c+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+_+T+`
\u{1F4FA} Watch live in browser http://localhost:${e}/
`)}catch(e){console.error(`\u274C Failed to load context display: ${e}`)}process.exit(3);
