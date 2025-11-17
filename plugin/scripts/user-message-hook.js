#!/usr/bin/env node
import{execSync as p}from"child_process";import{join as r}from"path";import{homedir as i}from"os";import{existsSync as d}from"fs";import n from"path";import{homedir as a}from"os";import{existsSync as c,readFileSync as m}from"fs";import{fileURLToPath as l}from"url";var u=l(import.meta.url),w=n.dirname(u);function s(){try{let t=n.join(a(),".claude-mem","settings.json");if(c(t)){let o=JSON.parse(m(t,"utf-8")),e=parseInt(o.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(e))return e}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}var f=r(i(),".claude","plugins","marketplaces","thedotmack"),h=r(f,"node_modules");d(h)||(console.error(`
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
`),process.exit(3));try{let t=r(i(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),o=p(`node "${t}" --colors`,{encoding:"utf8"}),e=s();console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+o+`

\u{1F4AC} Feedback & Support
https://github.com/thedotmack/claude-mem/discussions/110

\u{1F4FA} Watch live in browser http://localhost:${e}/
`)}catch(t){console.error(`\u274C Failed to load context display: ${t}`)}process.exit(3);
