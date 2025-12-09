#!/usr/bin/env node
import{basename as B}from"path";import _ from"path";import{existsSync as d}from"fs";import{homedir as U}from"os";import{spawnSync as R}from"child_process";import{readFileSync as b,writeFileSync as $,existsSync as x}from"fs";import{join as H}from"path";import{homedir as F}from"os";var k=["bugfix","feature","refactor","discovery","decision","change"],P=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var L=k.join(","),D=P.join(",");var C=(s=>(s[s.DEBUG=0]="DEBUG",s[s.INFO=1]="INFO",s[s.WARN=2]="WARN",s[s.ERROR=3]="ERROR",s[s.SILENT=4]="SILENT",s))(C||{}),A=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let t=c.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=C[t]??1}return this.level}correlationId(t,r){return`obs-${t}-${r}`}sessionId(t){return`session-${t}`}formatData(t){if(t==null)return"";if(typeof t=="string")return t;if(typeof t=="number"||typeof t=="boolean")return t.toString();if(typeof t=="object"){if(t instanceof Error)return this.getLevel()===0?`${t.message}
${t.stack}`:t.message;if(Array.isArray(t))return`[${t.length} items]`;let r=Object.keys(t);return r.length===0?"{}":r.length<=3?JSON.stringify(t):`{${r.length} keys: ${r.slice(0,3).join(", ")}...}`}return String(t)}formatTool(t,r){if(!r)return t;try{let n=typeof r=="string"?JSON.parse(r):r;if(t==="Bash"&&n.command){let e=n.command.length>50?n.command.substring(0,50)+"...":n.command;return`${t}(${e})`}if(t==="Read"&&n.file_path){let e=n.file_path.split("/").pop()||n.file_path;return`${t}(${e})`}if(t==="Edit"&&n.file_path){let e=n.file_path.split("/").pop()||n.file_path;return`${t}(${e})`}if(t==="Write"&&n.file_path){let e=n.file_path.split("/").pop()||n.file_path;return`${t}(${e})`}return t}catch{return t}}log(t,r,n,e,s){if(t<this.getLevel())return;let i=new Date().toISOString().replace("T"," ").substring(0,23),g=C[t].padEnd(5),l=r.padEnd(6),S="";e?.correlationId?S=`[${e.correlationId}] `:e?.sessionId&&(S=`[session-${e.sessionId}] `);let u="";s!=null&&(this.getLevel()===0&&typeof s=="object"?u=`
`+JSON.stringify(s,null,2):u=" "+this.formatData(s));let T="";if(e){let{sessionId:h,sdkSessionId:w,correlationId:M,...O}=e;Object.keys(O).length>0&&(T=` {${Object.entries(O).map(([v,W])=>`${v}=${W}`).join(", ")}}`)}let p=`[${i}] [${g}] [${l}] ${S}${n}${T}${u}`;t===3?console.error(p):console.log(p)}debug(t,r,n,e){this.log(0,t,r,n,e)}info(t,r,n,e){this.log(1,t,r,n,e)}warn(t,r,n,e){this.log(2,t,r,n,e)}error(t,r,n,e){this.log(3,t,r,n,e)}dataIn(t,r,n,e){this.info(t,`\u2192 ${r}`,n,e)}dataOut(t,r,n,e){this.info(t,`\u2190 ${r}`,n,e)}success(t,r,n,e){this.info(t,`\u2713 ${r}`,n,e)}failure(t,r,n,e){this.error(t,`\u2717 ${r}`,n,e)}timing(t,r,n,e){this.info(t,`\u23F1 ${r}`,e,{duration:`${n}ms`})}},E=new A;var c=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_DATA_DIR:H(F(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:L,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:D,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return this.DEFAULTS[t]}static getInt(t){let r=this.get(t);return parseInt(r,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!x(t))return this.getAllDefaults();let r=b(t,"utf-8"),n=JSON.parse(r),e=n;if(n.env&&typeof n.env=="object"){e=n.env;try{$(t,JSON.stringify(e,null,2),"utf-8"),E.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:t})}catch(i){E.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:t},i)}}let s={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))e[i]!==void 0&&(s[i]=e[i]);return s}};var f={DEFAULT:5e3,HEALTH_CHECK:1e3,WORKER_STARTUP_WAIT:1e3,WORKER_STARTUP_RETRIES:15,WINDOWS_MULTIPLIER:1.5};function y(o){return process.platform==="win32"?Math.round(o*f.WINDOWS_MULTIPLIER):o}var a=_.join(U(),".claude","plugins","marketplaces","thedotmack"),j=y(f.HEALTH_CHECK),K=f.WORKER_STARTUP_WAIT,V=f.WORKER_STARTUP_RETRIES;function m(){let o=_.join(U(),".claude-mem","settings.json"),t=c.loadFromFile(o);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function N(){try{let o=m();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(j)})).ok}catch(o){return E.debug("SYSTEM","Worker health check failed",{error:o instanceof Error?o.message:String(o),errorType:o?.constructor?.name}),!1}}async function X(){try{let o=_.join(a,"plugin","scripts","worker-service.cjs");if(!d(o))throw new Error(`Worker script not found at ${o}`);if(process.platform==="win32"){let t=R("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath 'node' -ArgumentList '${o}' -WorkingDirectory '${a}' -WindowStyle Hidden`],{cwd:a,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(t.status!==0)throw new Error(t.stderr||"PowerShell Start-Process failed")}else{let t=_.join(a,"ecosystem.config.cjs");if(!d(t))throw new Error(`Ecosystem config not found at ${t}`);let r=_.join(a,"node_modules",".bin","pm2"),n=d(r)?r:"pm2",e=R(n,["start",t],{cwd:a,stdio:"pipe",encoding:"utf-8"});if(e.status!==0)throw new Error(e.stderr||"PM2 start failed")}for(let t=0;t<V;t++)if(await new Promise(r=>setTimeout(r,K)),await N())return!0;return!1}catch(o){return E.error("SYSTEM","Failed to start worker",{platform:process.platform,workerScript:_.join(a,"plugin","scripts","worker-service.cjs"),error:o instanceof Error?o.message:String(o),marketplaceRoot:a}),!1}}async function I(){if(await N())return;if(!await X()){let t=m();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${a}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}try{await I();let o=m(),t=B(process.cwd()),r=await fetch(`http://127.0.0.1:${o}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!r.ok)throw new Error(`Worker error ${r.status}`);let n=await r.text(),e=new Date,s=new Date("2025-12-06T00:00:00Z"),i=new Date("2025-12-05T05:00:00Z"),g="";e<i&&(g=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let l="";if(e<s){let u=e.getUTCHours()*60+e.getUTCMinutes(),T=Math.floor((u-300+1440)%1440/60),p=e.getUTCDate(),h=e.getUTCMonth(),M=e.getUTCFullYear()===2025&&h===11&&p>=1&&p<=5,O=T>=17&&T<19;M&&O?l=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:l=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+n+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+g+l+`
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
