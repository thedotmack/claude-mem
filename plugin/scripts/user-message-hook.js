#!/usr/bin/env node
import{execSync as r}from"child_process";import{join as o}from"path";import{homedir as t}from"os";import{existsSync as s}from"fs";var i=o(t(),".claude","plugins","marketplaces","thedotmack"),a=o(i,"node_modules");s(a)||(console.error(`
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
`),process.exit(3));try{let e=o(t(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),n=r(`node "${e}" --colors`,{encoding:"utf8"});console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+n)}catch(e){console.error(`\u274C Failed to load context display: ${e}`)}process.exit(3);
