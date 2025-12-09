#!/usr/bin/env node
import{join as g,basename as x}from"path";import{homedir as P}from"os";import{existsSync as k}from"fs";import I from"path";import{homedir as w}from"os";import{join as e,dirname as M,basename as X}from"path";import{homedir as l}from"os";import{fileURLToPath as h}from"url";function N(){return typeof __dirname<"u"?__dirname:M(h(import.meta.url))}var G=N(),i=process.env.CLAUDE_MEM_DATA_DIR||e(l(),".claude-mem"),u=process.env.CLAUDE_CONFIG_DIR||e(l(),".claude"),K=e(i,"archives"),$=e(i,"logs"),Y=e(i,"trash"),q=e(i,"backups"),J=e(i,"settings.json"),Z=e(i,"claude-mem.db"),z=e(i,"vector-db"),Q=e(u,"settings.json"),tt=e(u,"commands"),et=e(u,"CLAUDE.md");import{readFileSync as R,existsSync as y}from"fs";var U=["bugfix","feature","refactor","discovery","decision","change"],L=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var S=U.join(","),d=L.join(",");var E=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:S,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:d,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let o=this.get(t);return parseInt(o,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){let o={...this.DEFAULTS};if(y(t))try{let r=R(t,"utf-8"),c=JSON.parse(r).env||{};for(let a of Object.keys(this.DEFAULTS))c[a]!==void 0&&(o[a]=String(c[a]))}catch(r){console.error(`[SettingsDefaultsManager] Failed to parse settings file at ${t}:`,r)}for(let r of Object.keys(this.DEFAULTS))process.env[r]!==void 0&&(o[r]=String(process.env[r]));return o}};function f(){let s=I.join(w(),".claude-mem","settings.json"),t=E.loadFromFile(s);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}var v=g(P(),".claude","plugins","marketplaces","thedotmack"),b=g(v,"node_modules");k(b)||(console.error(`
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
`),process.exit(3));try{let s=f(),t=x(process.cwd()),o=await fetch(`http://127.0.0.1:${s}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!o.ok)throw new Error(`Worker error ${o.status}`);let r=await o.text(),n=new Date,c=new Date("2025-12-06T00:00:00Z"),a=new Date("2025-12-05T05:00:00Z"),T="";n<a&&(T=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let _="";if(n<c){let O=n.getUTCHours()*60+n.getUTCMinutes(),p=Math.floor((O-300+1440)%1440/60),m=n.getUTCDate(),A=n.getUTCMonth(),C=n.getUTCFullYear()===2025&&A===11&&m>=1&&m<=5,D=p>=17&&p<19;C&&D?_=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:_=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+r+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+T+_+`
\u{1F4FA} Watch live in browser http://localhost:${s}/
`)}catch(s){console.error(`\u274C Failed to load context display: ${s}`)}process.exit(3);
