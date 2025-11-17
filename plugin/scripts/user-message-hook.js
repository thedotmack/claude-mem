#!/usr/bin/env node
import{execSync as _}from"child_process";import{join as i}from"path";import{homedir as p}from"os";import{existsSync as x}from"fs";import l from"path";import{homedir as f}from"os";import{existsSync as g,readFileSync as h}from"fs";import{join as t,dirname as m,basename as y}from"path";import{homedir as c}from"os";import{fileURLToPath as u}from"url";function d(){return typeof __dirname<"u"?__dirname:m(u(import.meta.url))}var A=d(),e=process.env.CLAUDE_MEM_DATA_DIR||t(c(),".claude-mem"),s=process.env.CLAUDE_CONFIG_DIR||t(c(),".claude"),P=t(e,"archives"),w=t(e,"logs"),C=t(e,"trash"),I=t(e,"backups"),b=t(e,"settings.json"),v=t(e,"claude-mem.db"),U=t(e,"vector-db"),M=t(s,"settings.json"),O=t(s,"commands"),L=t(s,"CLAUDE.md");function a(){try{let o=l.join(f(),".claude-mem","settings.json");if(g(o)){let n=JSON.parse(h(o,"utf-8")),r=parseInt(n.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(r))return r}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}var D=i(p(),".claude","plugins","marketplaces","thedotmack"),k=i(D,"node_modules");x(k)||(console.error(`
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
`),process.exit(3));try{let o=i(p(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),n=_(`node "${o}" --colors`,{encoding:"utf8"}),r=a();console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+n+`

\u{1F4AC} Feedback & Support
https://github.com/thedotmack/claude-mem/discussions/110

\u{1F4FA} Watch live in browser http://localhost:${r}/
`)}catch(o){console.error(`\u274C Failed to load context display: ${o}`)}process.exit(3);
