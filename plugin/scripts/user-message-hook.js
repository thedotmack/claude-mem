#!/usr/bin/env node
import{execSync as P}from"child_process";import{join as a}from"path";import{homedir as f}from"os";import{existsSync as S}from"fs";import k from"path";import{homedir as A}from"os";import{existsSync as R,readFileSync as C}from"fs";import{join as t,dirname as _,basename as H}from"path";import{homedir as d}from"os";import{fileURLToPath as x}from"url";function E(){return typeof __dirname<"u"?__dirname:_(x(import.meta.url))}var j=E(),o=process.env.CLAUDE_MEM_DATA_DIR||t(d(),".claude-mem"),c=process.env.CLAUDE_CONFIG_DIR||t(d(),".claude"),N=t(o,"archives"),$=t(o,"logs"),F=t(o,"trash"),K=t(o,"backups"),B=t(o,"settings.json"),G=t(o,"claude-mem.db"),V=t(o,"vector-db"),J=t(c,"settings.json"),Y=t(c,"commands"),Z=t(c,"CLAUDE.md");function l(){try{let r=k.join(A(),".claude-mem","settings.json");if(R(r)){let s=JSON.parse(C(r,"utf-8")),n=parseInt(s.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(n))return n}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}var v=a(f(),".claude","plugins","marketplaces","thedotmack"),I=a(v,"node_modules");S(I)||(console.error(`
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
`),process.exit(3));try{let r=a(f(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),s=P(`node "${r}" --colors`,{encoding:"utf8",windowsHide:!0}),n=l(),e=new Date,g=new Date("2025-12-06T00:00:00Z"),h=new Date("2025-12-05T05:00:00Z"),m="";e<h&&(m=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let i="";if(e<g){let D=e.getUTCHours()*60+e.getUTCMinutes(),p=Math.floor((D-300+1440)%1440/60),u=e.getUTCDate(),w=e.getUTCMonth(),y=e.getUTCFullYear()===2025&&w===11&&u>=1&&u<=5,T=p>=17&&p<19;y&&T?i=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:i=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+s+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+m+i+`
\u{1F4FA} Watch live in browser http://localhost:${n}/
`)}catch(r){console.error(`\u274C Failed to load context display: ${r}`)}process.exit(3);
