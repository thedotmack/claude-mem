#!/usr/bin/env node
import{join as M,basename as k}from"path";import{homedir as v}from"os";import{existsSync as x}from"fs";import c from"path";import{existsSync as m}from"fs";import{homedir as C}from"os";import{spawnSync as R}from"child_process";import{readFileSync as L,existsSync as y}from"fs";var h=["bugfix","feature","refactor","discovery","decision","change"],U=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var p=h.join(","),S=U.join(",");var a=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:p,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:S,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let n=this.get(t);return parseInt(n,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!y(t))return this.getAllDefaults();let n=L(t,"utf-8"),o=JSON.parse(n).env||{},r={...this.DEFAULTS};for(let s of Object.keys(this.DEFAULTS))o[s]!==void 0&&(r[s]=o[s]);return r}};var E=c.join(C(),".claude","plugins","marketplaces","thedotmack"),w=100,I=500,P=10;function _(){let e=c.join(C(),".claude-mem","settings.json"),t=a.loadFromFile(e);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function f(){try{let e=_();return(await fetch(`http://127.0.0.1:${e}/health`,{signal:AbortSignal.timeout(w)})).ok}catch{return!1}}async function W(){try{let e=c.join(E,"ecosystem.config.cjs");if(!m(e))throw new Error(`Ecosystem config not found at ${e}`);let t=c.join(E,"node_modules",".bin","pm2"),n=process.platform==="win32"?t+".cmd":t,i=m(n)?n:"pm2",o=R(i,["start",e],{cwd:E,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(o.status!==0)throw new Error(o.stderr||"PM2 start failed");for(let r=0;r<P;r++)if(await new Promise(s=>setTimeout(s,I)),await f())return!0;return!1}catch{return!1}}async function A(){if(await f())return;if(!await W()){let t=_();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${E}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}var b=M(v(),".claude","plugins","marketplaces","thedotmack"),X=M(b,"node_modules");x(X)||(console.error(`
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
`),process.exit(3));try{await A();let e=_(),t=k(process.cwd()),n=await fetch(`http://127.0.0.1:${e}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!n.ok)throw new Error(`Worker error ${n.status}`);let i=await n.text(),o=new Date,r=new Date("2025-12-06T00:00:00Z"),s=new Date("2025-12-05T05:00:00Z"),u="";o<s&&(u=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let T="";if(o<r){let d=o.getUTCHours()*60+o.getUTCMinutes(),l=Math.floor((d-300+1440)%1440/60),O=o.getUTCDate(),g=o.getUTCMonth(),N=o.getUTCFullYear()===2025&&g===11&&O>=1&&O<=5,D=l>=17&&l<19;N&&D?T=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:T=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+i+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+u+T+`
\u{1F4FA} Watch live in browser http://localhost:${e}/
`)}catch(e){console.error(`\u274C Failed to load context display: ${e}`)}process.exit(3);
