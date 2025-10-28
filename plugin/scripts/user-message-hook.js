#!/usr/bin/env node
import{execSync as s}from"child_process";import{join as e}from"path";import{homedir as t}from"os";var i=e(t(),".claude","plugins","marketplaces","thedotmack"),p=e(i,"node_modules");try{let o=e(t(),".claude","plugins","marketplaces","thedotmack","plugin","scripts","context-hook.js"),n=s(`node "${o}" --colors`,{encoding:"utf8",stdio:["pipe","pipe","pipe"]});console.log(JSON.stringify({continue:!0,systemMessage:"\u{1F4BE} Use /mem-status to view your Claude-Mem context report.",hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:`# Claude-Mem Context Report

${n}`}}))}catch{console.log(JSON.stringify({continue:!0,systemMessage:"\u{1F4BE} Use /mem-status to view your Claude-Mem context (report building in background)."}))}process.exit(0);
