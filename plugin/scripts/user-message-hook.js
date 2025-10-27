#!/usr/bin/env node
import{execSync as e}from"child_process";import{join as r}from"path";import{homedir as n}from"os";try{let o=r(n(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),t=e(`node "${o}" --colors`,{encoding:"utf8"});console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+t)}catch(o){console.error(`\u274C Failed to load context display: ${o}`)}process.exit(3);
