#!/usr/bin/env node
import{execSync as A}from"child_process";import{join as c}from"path";import{homedir as d}from"os";import{existsSync as C}from"fs";import x from"path";import{homedir as E}from"os";import{existsSync as k,readFileSync as R}from"fs";import{join as t,dirname as T,basename as U}from"path";import{homedir as u}from"os";import{fileURLToPath as y}from"url";function w(){return typeof __dirname<"u"?__dirname:T(y(import.meta.url))}var H=w(),e=process.env.CLAUDE_MEM_DATA_DIR||t(u(),".claude-mem"),a=process.env.CLAUDE_CONFIG_DIR||t(u(),".claude"),W=t(e,"archives"),j=t(e,"logs"),N=t(e,"trash"),$=t(e,"backups"),F=t(e,"settings.json"),K=t(e,"claude-mem.db"),B=t(e,"vector-db"),G=t(a,"settings.json"),V=t(a,"commands"),J=t(a,"CLAUDE.md");function l(){try{let o=x.join(E(),".claude-mem","settings.json");if(k(o)){let s=JSON.parse(R(o,"utf-8")),n=parseInt(s.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(n))return n}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}var P=c(d(),".claude","plugins","marketplaces","thedotmack"),S=c(P,"node_modules");C(S)||(console.error(`
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
`),process.exit(3));try{let o=c(d(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),s=A(`node "${o}" --colors`,{encoding:"utf8"}),n=l(),r=new Date,f=new Date("2025-12-06T00:00:00Z"),i="";if(r<f){let g=r.getUTCHours()*60+r.getUTCMinutes(),m=Math.floor((g-300+1440)%1440/60),p=r.getUTCDate(),h=r.getUTCMonth(),D=r.getUTCFullYear()===2025&&h===11&&p>=1&&p<=5,_=m>=17&&m<19;D&&_?i=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:i=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+s+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+i+`
\u{1F4FA} Watch live in browser http://localhost:${n}/
`)}catch(o){console.error(`\u274C Failed to load context display: ${o}`)}process.exit(3);
