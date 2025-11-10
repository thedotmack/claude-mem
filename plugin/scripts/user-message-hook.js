#!/usr/bin/env node
import{execSync as p}from"child_process";import{join as r}from"path";import{homedir as s}from"os";import{existsSync as u}from"fs";import i from"path";import{homedir as a}from"os";import{existsSync as c,readFileSync as l}from"fs";function n(){try{let e=i.join(a(),".claude-mem","settings.json");if(c(e)){let t=JSON.parse(l(e,"utf-8")),o=parseInt(t.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(o))return o}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}var m=r(s(),".claude","plugins","marketplaces","thedotmack"),d=r(m,"node_modules");u(d)||(console.error(`
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
`),process.exit(3));try{let e=r(s(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),t=p(`node "${e}" --colors`,{encoding:"utf8"}),o=n();console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+t+`

\u{1F4FA} Watch live in browser http://localhost:${o}/ (New! v5.1)
`)}catch(e){console.error(`\u274C Failed to load context display: ${e}`)}process.exit(3);
