#!/usr/bin/env node
import{execSync as e}from"child_process";try{let o=e("node ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/context-hook.js --colors",{encoding:"utf8"});console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+o)}catch(o){console.error(`\u274C Failed to load context display: ${o}`)}process.exit(3);
