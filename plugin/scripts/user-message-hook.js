#!/usr/bin/env node
import{join as l,basename as P}from"path";import{homedir as S}from"os";import{existsSync as v}from"fs";import A from"path";import{homedir as R}from"os";import{existsSync as C,readFileSync as k}from"fs";import{join as t,dirname as y,basename as H}from"path";import{homedir as u}from"os";import{fileURLToPath as E}from"url";function x(){return typeof __dirname<"u"?__dirname:y(E(import.meta.url))}var N=x(),r=process.env.CLAUDE_MEM_DATA_DIR||t(u(),".claude-mem"),a=process.env.CLAUDE_CONFIG_DIR||t(u(),".claude"),$=t(r,"archives"),F=t(r,"logs"),G=t(r,"trash"),K=t(r,"backups"),B=t(r,"settings.json"),V=t(r,"claude-mem.db"),J=t(r,"vector-db"),Y=t(a,"settings.json"),Z=t(a,"commands"),q=t(a,"CLAUDE.md");function d(){try{let e=A.join(R(),".claude-mem","settings.json");if(C(e)){let s=JSON.parse(k(e,"utf-8")),n=parseInt(s.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(n))return n}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}var I=l(S(),".claude","plugins","marketplaces","thedotmack"),U=l(I,"node_modules");v(U)||(console.error(`
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
`),process.exit(3));try{let e=d(),s=P(process.cwd()),n=await fetch(`http://127.0.0.1:${e}/api/context/inject?project=${encodeURIComponent(s)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!n.ok)throw new Error(`Worker error ${n.status}`);let f=await n.text(),o=new Date,g=new Date("2025-12-06T00:00:00Z"),h=new Date("2025-12-05T05:00:00Z"),c="";o<h&&(c=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let i="";if(o<g){let w=o.getUTCHours()*60+o.getUTCMinutes(),m=Math.floor((w-300+1440)%1440/60),p=o.getUTCDate(),D=o.getUTCMonth(),T=o.getUTCFullYear()===2025&&D===11&&p>=1&&p<=5,_=m>=17&&m<19;T&&_?i=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:i=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+f+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+c+i+`
\u{1F4FA} Watch live in browser http://localhost:${e}/
`)}catch(e){console.error(`\u274C Failed to load context display: ${e}`)}process.exit(3);
