#!/usr/bin/env node
import{basename as X}from"path";import _ from"path";import{existsSync as f}from"fs";import{homedir as D}from"os";import{spawnSync as O}from"child_process";import{readFileSync as k,writeFileSync as W,existsSync as b}from"fs";import{join as $}from"path";import{homedir as x}from"os";var v=["bugfix","feature","refactor","discovery","decision","change"],P=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var L=v.join(","),M=P.join(",");var S=(s=>(s[s.DEBUG=0]="DEBUG",s[s.INFO=1]="INFO",s[s.WARN=2]="WARN",s[s.ERROR=3]="ERROR",s[s.SILENT=4]="SILENT",s))(S||{}),g=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let t=c.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=S[t]??1}return this.level}correlationId(t,e){return`obs-${t}-${e}`}sessionId(t){return`session-${t}`}formatData(t){if(t==null)return"";if(typeof t=="string")return t;if(typeof t=="number"||typeof t=="boolean")return t.toString();if(typeof t=="object"){if(t instanceof Error)return this.getLevel()===0?`${t.message}
${t.stack}`:t.message;if(Array.isArray(t))return`[${t.length} items]`;let e=Object.keys(t);return e.length===0?"{}":e.length<=3?JSON.stringify(t):`{${e.length} keys: ${e.slice(0,3).join(", ")}...}`}return String(t)}formatTool(t,e){if(!e)return t;try{let r=typeof e=="string"?JSON.parse(e):e;if(t==="Bash"&&r.command){let o=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${t}(${o})`}if(t==="Read"&&r.file_path){let o=r.file_path.split("/").pop()||r.file_path;return`${t}(${o})`}if(t==="Edit"&&r.file_path){let o=r.file_path.split("/").pop()||r.file_path;return`${t}(${o})`}if(t==="Write"&&r.file_path){let o=r.file_path.split("/").pop()||r.file_path;return`${t}(${o})`}return t}catch{return t}}log(t,e,r,o,s){if(t<this.getLevel())return;let a=new Date().toISOString().replace("T"," ").substring(0,23),U=S[t].padEnd(5),N=e.padEnd(6),T="";o?.correlationId?T=`[${o.correlationId}] `:o?.sessionId&&(T=`[session-${o.sessionId}] `);let u="";s!=null&&(this.getLevel()===0&&typeof s=="object"?u=`
`+JSON.stringify(s,null,2):u=" "+this.formatData(s));let C="";if(o){let{sessionId:V,sdkSessionId:B,correlationId:G,...d}=o;Object.keys(d).length>0&&(C=` {${Object.entries(d).map(([I,w])=>`${I}=${w}`).join(", ")}}`)}let A=`[${a}] [${U}] [${N}] ${T}${r}${C}${u}`;t===3?console.error(A):console.log(A)}debug(t,e,r,o){this.log(0,t,e,r,o)}info(t,e,r,o){this.log(1,t,e,r,o)}warn(t,e,r,o){this.log(2,t,e,r,o)}error(t,e,r,o){this.log(3,t,e,r,o)}dataIn(t,e,r,o){this.info(t,`\u2192 ${e}`,r,o)}dataOut(t,e,r,o){this.info(t,`\u2190 ${e}`,r,o)}success(t,e,r,o){this.info(t,`\u2713 ${e}`,r,o)}failure(t,e,r,o){this.error(t,`\u2717 ${e}`,r,o)}timing(t,e,r,o){this.info(t,`\u23F1 ${e}`,o,{duration:`${r}ms`})}},E=new g;var c=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:$(x(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:L,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:M,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return this.DEFAULTS[t]}static getInt(t){let e=this.get(t);return parseInt(e,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!b(t))return this.getAllDefaults();let e=k(t,"utf-8"),r=JSON.parse(e),o=r;if(r.env&&typeof r.env=="object"){o=r.env;try{W(t,JSON.stringify(o,null,2),"utf-8"),E.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:t})}catch(a){E.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:t},a)}}let s={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))o[a]!==void 0&&(s[a]=o[a]);return s}};var l={DEFAULT:5e3,HEALTH_CHECK:1e3,WORKER_STARTUP_WAIT:1e3,WORKER_STARTUP_RETRIES:15,WINDOWS_MULTIPLIER:1.5},h={SUCCESS:0,FAILURE:1,USER_MESSAGE_ONLY:3};function R(n){return process.platform==="win32"?Math.round(n*l.WINDOWS_MULTIPLIER):n}var i=_.join(D(),".claude","plugins","marketplaces","thedotmack"),H=R(l.HEALTH_CHECK),F=l.WORKER_STARTUP_WAIT,K=l.WORKER_STARTUP_RETRIES;function p(){let n=_.join(D(),".claude-mem","settings.json"),t=c.loadFromFile(n);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function m(){try{let n=p();return(await fetch(`http://127.0.0.1:${n}/health`,{signal:AbortSignal.timeout(H)})).ok}catch(n){return E.debug("SYSTEM","Worker health check failed",{error:n instanceof Error?n.message:String(n),errorType:n?.constructor?.name}),!1}}async function j(){try{let n=_.join(i,"plugin","scripts","worker-service.cjs");if(!f(n))throw new Error(`Worker script not found at ${n}`);if(process.platform==="win32"){let t=n.replace(/'/g,"''"),e=i.replace(/'/g,"''"),r=O("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath 'node' -ArgumentList '${t}' -WorkingDirectory '${e}' -WindowStyle Hidden`],{cwd:i,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(r.status!==0)throw new Error(r.stderr||"PowerShell Start-Process failed")}else{let t=_.join(i,"ecosystem.config.cjs");if(!f(t))throw new Error(`Ecosystem config not found at ${t}`);let e=_.join(i,"node_modules",".bin","pm2"),r;if(f(e))r=e;else{if(O("which",["pm2"],{encoding:"utf-8",stdio:"pipe"}).status!==0)throw new Error(`PM2 not found. Install it locally with:
  cd ${i}
  npm install

Or install globally with: npm install -g pm2`);r="pm2"}let o=O(r,["start",t],{cwd:i,stdio:"pipe",encoding:"utf-8"});if(o.status!==0)throw new Error(o.stderr||"PM2 start failed")}for(let t=0;t<K;t++)if(await new Promise(e=>setTimeout(e,F)),await m())return!0;return!1}catch(n){return E.error("SYSTEM","Failed to start worker",{platform:process.platform,workerScript:_.join(i,"plugin","scripts","worker-service.cjs"),error:n instanceof Error?n.message:String(n),marketplaceRoot:i}),!1}}async function y(){if(await m())return;let n=await j();if(!(!n&&await m())&&!n){let t=p();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${i}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}try{await y();let n=p(),t=X(process.cwd()),e=await fetch(`http://127.0.0.1:${n}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!e.ok)throw new Error(`Worker error ${e.status}`);let r=await e.text();console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+r+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu
\u{1F4FA} Watch live in browser http://localhost:${n}/
`)}catch{console.error(`
---
\u{1F389}  Note: This appears under Plugin Hook Error, but it's not an error. That's the only option for
   user messages in Claude Code UI until a better method is provided.
---

\u26A0\uFE0F  Claude-Mem: First-Time Setup

Dependencies are installing in the background. This only happens once.

\u{1F4A1} TIPS:
   \u2022 Memories will start generating while you work
   \u2022 Use /init to write or update your CLAUDE.md for better project context
   \u2022 Try /clear after one session to see what context looks like

Thank you for installing Claude-Mem!

This message was not added to your startup context, so you can continue working as normal.
`)}process.exit(h.USER_MESSAGE_ONLY);
