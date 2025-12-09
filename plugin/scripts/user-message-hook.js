#!/usr/bin/env node
import{basename as K}from"path";import l from"path";import{existsSync as S}from"fs";import{homedir as R}from"os";import{spawnSync as O}from"child_process";import{readFileSync as P,writeFileSync as b,existsSync as k}from"fs";import{join as W}from"path";import{homedir as $}from"os";var w=["bugfix","feature","refactor","discovery","decision","change"],v=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var h=w.join(","),M=v.join(",");var g=(s=>(s[s.DEBUG=0]="DEBUG",s[s.INFO=1]="INFO",s[s.WARN=2]="WARN",s[s.ERROR=3]="ERROR",s[s.SILENT=4]="SILENT",s))(g||{}),f=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let t=c.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=g[t]??1}return this.level}correlationId(t,e){return`obs-${t}-${e}`}sessionId(t){return`session-${t}`}formatData(t){if(t==null)return"";if(typeof t=="string")return t;if(typeof t=="number"||typeof t=="boolean")return t.toString();if(typeof t=="object"){if(t instanceof Error)return this.getLevel()===0?`${t.message}
${t.stack}`:t.message;if(Array.isArray(t))return`[${t.length} items]`;let e=Object.keys(t);return e.length===0?"{}":e.length<=3?JSON.stringify(t):`{${e.length} keys: ${e.slice(0,3).join(", ")}...}`}return String(t)}formatTool(t,e){if(!e)return t;try{let r=typeof e=="string"?JSON.parse(e):e;if(t==="Bash"&&r.command){let n=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${t}(${n})`}if(t==="Read"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${t}(${n})`}if(t==="Edit"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${t}(${n})`}if(t==="Write"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${t}(${n})`}return t}catch{return t}}log(t,e,r,n,s){if(t<this.getLevel())return;let a=new Date().toISOString().replace("T"," ").substring(0,23),D=g[t].padEnd(5),N=e.padEnd(6),T="";n?.correlationId?T=`[${n.correlationId}] `:n?.sessionId&&(T=`[session-${n.sessionId}] `);let u="";s!=null&&(this.getLevel()===0&&typeof s=="object"?u=`
`+JSON.stringify(s,null,2):u=" "+this.formatData(s));let C="";if(n){let{sessionId:X,sdkSessionId:V,correlationId:B,...d}=n;Object.keys(d).length>0&&(C=` {${Object.entries(d).map(([U,I])=>`${U}=${I}`).join(", ")}}`)}let A=`[${a}] [${D}] [${N}] ${T}${r}${C}${u}`;t===3?console.error(A):console.log(A)}debug(t,e,r,n){this.log(0,t,e,r,n)}info(t,e,r,n){this.log(1,t,e,r,n)}warn(t,e,r,n){this.log(2,t,e,r,n)}error(t,e,r,n){this.log(3,t,e,r,n)}dataIn(t,e,r,n){this.info(t,`\u2192 ${e}`,r,n)}dataOut(t,e,r,n){this.info(t,`\u2190 ${e}`,r,n)}success(t,e,r,n){this.info(t,`\u2713 ${e}`,r,n)}failure(t,e,r,n){this.error(t,`\u2717 ${e}`,r,n)}timing(t,e,r,n){this.info(t,`\u23F1 ${e}`,n,{duration:`${r}ms`})}},E=new f;var c=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_DATA_DIR:W($(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:h,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:M,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return this.DEFAULTS[t]}static getInt(t){let e=this.get(t);return parseInt(e,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!k(t))return this.getAllDefaults();let e=P(t,"utf-8"),r=JSON.parse(e),n=r;if(r.env&&typeof r.env=="object"){n=r.env;try{b(t,JSON.stringify(n,null,2),"utf-8"),E.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:t})}catch(a){E.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:t},a)}}let s={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))n[a]!==void 0&&(s[a]=n[a]);return s}};var _={DEFAULT:5e3,HEALTH_CHECK:1e3,WORKER_STARTUP_WAIT:1e3,WORKER_STARTUP_RETRIES:15,WINDOWS_MULTIPLIER:1.5};function L(o){return process.platform==="win32"?Math.round(o*_.WINDOWS_MULTIPLIER):o}var i=l.join(R(),".claude","plugins","marketplaces","thedotmack"),x=L(_.HEALTH_CHECK),H=_.WORKER_STARTUP_WAIT,F=_.WORKER_STARTUP_RETRIES;function p(){let o=l.join(R(),".claude-mem","settings.json"),t=c.loadFromFile(o);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function m(){try{let o=p();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(x)})).ok}catch(o){return E.debug("SYSTEM","Worker health check failed",{error:o instanceof Error?o.message:String(o),errorType:o?.constructor?.name}),!1}}async function j(){try{let o=l.join(i,"plugin","scripts","worker-service.cjs");if(!S(o))throw new Error(`Worker script not found at ${o}`);if(process.platform==="win32"){let t=o.replace(/'/g,"''"),e=i.replace(/'/g,"''"),r=O("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath 'node' -ArgumentList '${t}' -WorkingDirectory '${e}' -WindowStyle Hidden`],{cwd:i,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(r.status!==0)throw new Error(r.stderr||"PowerShell Start-Process failed")}else{let t=l.join(i,"ecosystem.config.cjs");if(!S(t))throw new Error(`Ecosystem config not found at ${t}`);let e=l.join(i,"node_modules",".bin","pm2"),r;if(S(e))r=e;else{if(O("which",["pm2"],{encoding:"utf-8",stdio:"pipe"}).status!==0)throw new Error(`PM2 not found. Install it locally with:
  cd ${i}
  npm install

Or install globally with: npm install -g pm2`);r="pm2"}let n=O(r,["start",t],{cwd:i,stdio:"pipe",encoding:"utf-8"});if(n.status!==0)throw new Error(n.stderr||"PM2 start failed")}for(let t=0;t<F;t++)if(await new Promise(e=>setTimeout(e,H)),await m())return!0;return!1}catch(o){return E.error("SYSTEM","Failed to start worker",{platform:process.platform,workerScript:l.join(i,"plugin","scripts","worker-service.cjs"),error:o instanceof Error?o.message:String(o),marketplaceRoot:i}),!1}}async function y(){if(await m())return;let o=await j();if(!(!o&&await m())&&!o){let t=p();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${i}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}try{await y();let o=p(),t=K(process.cwd()),e=await fetch(`http://127.0.0.1:${o}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!e.ok)throw new Error(`Worker error ${e.status}`);let r=await e.text();console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+r+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu
\u{1F4FA} Watch live in browser http://localhost:${o}/
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
`)}process.exit(3);
