#!/usr/bin/env node
import{join as g,basename as x}from"path";import{homedir as P}from"os";import{existsSync as k}from"fs";import I from"path";import{homedir as w}from"os";import{join as e,dirname as M,basename as X}from"path";import{homedir as S}from"os";import{fileURLToPath as N}from"url";function U(){return typeof __dirname<"u"?__dirname:M(N(import.meta.url))}var G=U(),s=process.env.CLAUDE_MEM_DATA_DIR||e(S(),".claude-mem"),_=process.env.CLAUDE_CONFIG_DIR||e(S(),".claude"),K=e(s,"archives"),Y=e(s,"logs"),$=e(s,"trash"),q=e(s,"backups"),J=e(s,"settings.json"),Z=e(s,"claude-mem.db"),z=e(s,"vector-db"),Q=e(_,"settings.json"),tt=e(_,"commands"),et=e(_,"CLAUDE.md");import{readFileSync as R,existsSync as y}from"fs";var h=["bugfix","feature","refactor","discovery","decision","change"],L=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var l=h.join(","),O=L.join(",");var c=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:l,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:O,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_ENDLESS_MODE:"false",CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS:"90000"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let r=this.get(t);return parseInt(r,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!y(t))return this.getAllDefaults();let r=R(t,"utf-8"),o=JSON.parse(r).env||{},a={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))o[i]!==void 0&&(a[i]=o[i]);return a}};function d(){let n=I.join(w(),".claude-mem","settings.json"),t=c.loadFromFile(n);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}var v=g(P(),".claude","plugins","marketplaces","thedotmack"),W=g(v,"node_modules");k(W)||(console.error(`
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
`),process.exit(3));try{let n=d(),t=x(process.cwd()),r=await fetch(`http://127.0.0.1:${n}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!r.ok)throw new Error(`Worker error ${r.status}`);let u=await r.text(),o=new Date,a=new Date("2025-12-06T00:00:00Z"),i=new Date("2025-12-05T05:00:00Z"),T="";o<i&&(T=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let E="";if(o<a){let A=o.getUTCHours()*60+o.getUTCMinutes(),p=Math.floor((A-300+1440)%1440/60),m=o.getUTCDate(),D=o.getUTCMonth(),f=o.getUTCFullYear()===2025&&D===11&&m>=1&&m<=5,C=p>=17&&p<19;f&&C?E=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:E=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+u+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+T+E+`
\u{1F4FA} Watch live in browser http://localhost:${n}/
`)}catch(n){console.error(`\u274C Failed to load context display: ${n}`)}process.exit(3);
