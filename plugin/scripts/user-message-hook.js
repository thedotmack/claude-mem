#!/usr/bin/env node
import{join as P,basename as nt}from"path";import{homedir as ot}from"os";import{existsSync as st}from"fs";import p from"path";import{existsSync as h}from"fs";import{homedir as w}from"os";import{spawnSync as I}from"child_process";import{readFileSync as F,existsSync as j}from"fs";import{join as V}from"path";import{homedir as K}from"os";var x=["bugfix","feature","refactor","discovery","decision","change"],H=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"];var D=x.join(","),y=H.join(",");var m=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_DATA_DIR:V(K(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:D,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:y,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(t){return process.env[t]||this.DEFAULTS[t]}static getInt(t){let e=this.get(t);return parseInt(e,10)}static getBool(t){return this.get(t)==="true"}static loadFromFile(t){if(!j(t))return this.getAllDefaults();let e=F(t,"utf-8"),r=JSON.parse(e).env||{},s={...this.DEFAULTS};for(let E of Object.keys(this.DEFAULTS))r[E]!==void 0&&(s[E]=r[E]);return s}};import{join as J}from"path";import{homedir as q}from"os";import{existsSync as Z,readFileSync as z}from"fs";import{appendFileSync as X}from"fs";import{homedir as B}from"os";import{join as G}from"path";var Y=G(B(),".claude-mem","silent.log");function R(o,t,e=""){let n=new Date().toISOString(),l=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),_=l?`${l[1].split("/").pop()}:${l[2]}`:"unknown",i=`[${n}] [${_}] ${o}`;if(t!==void 0)try{i+=` ${JSON.stringify(t)}`}catch(a){i+=` [stringify error: ${a}]`}i+=`
`;try{X(Y,i)}catch(a){console.error("[silent-debug] Failed to write to log:",a)}return e}var O=J(q(),".claude-mem","settings.json");function U(o,t){try{if(Z(O)){let n=JSON.parse(z(O,"utf-8")).env?.[o];if(n!==void 0)return n}}catch(e){R("Failed to load settings file",{error:e,settingsPath:O,key:o})}return process.env[o]||t}var d=(s=>(s[s.DEBUG=0]="DEBUG",s[s.INFO=1]="INFO",s[s.WARN=2]="WARN",s[s.ERROR=3]="ERROR",s[s.SILENT=4]="SILENT",s))(d||{}),C=class{level;useColor;constructor(){let t=U("CLAUDE_MEM_LOG_LEVEL","INFO").toUpperCase();this.level=d[t]??1,this.useColor=process.stdout.isTTY??!1}correlationId(t,e){return`obs-${t}-${e}`}sessionId(t){return`session-${t}`}formatData(t){if(t==null)return"";if(typeof t=="string")return t;if(typeof t=="number"||typeof t=="boolean")return t.toString();if(typeof t=="object"){if(t instanceof Error)return this.level===0?`${t.message}
${t.stack}`:t.message;if(Array.isArray(t))return`[${t.length} items]`;let e=Object.keys(t);return e.length===0?"{}":e.length<=3?JSON.stringify(t):`{${e.length} keys: ${e.slice(0,3).join(", ")}...}`}return String(t)}formatTool(t,e){if(!e)return t;try{let n=typeof e=="string"?JSON.parse(e):e;if(t==="Bash"&&n.command){let r=n.command.length>50?n.command.substring(0,50)+"...":n.command;return`${t}(${r})`}if(t==="Read"&&n.file_path){let r=n.file_path.split("/").pop()||n.file_path;return`${t}(${r})`}if(t==="Edit"&&n.file_path){let r=n.file_path.split("/").pop()||n.file_path;return`${t}(${r})`}if(t==="Write"&&n.file_path){let r=n.file_path.split("/").pop()||n.file_path;return`${t}(${r})`}return t}catch{return t}}log(t,e,n,r,s){if(t<this.level)return;let E=new Date().toISOString().replace("T"," ").substring(0,23),l=d[t].padEnd(5),_=e.padEnd(6),i="";r?.correlationId?i=`[${r.correlationId}] `:r?.sessionId&&(i=`[session-${r.sessionId}] `);let a="";s!=null&&(this.level===0&&typeof s=="object"?a=`
`+JSON.stringify(s,null,2):a=" "+this.formatData(s));let u="";if(r){let{sessionId:L,sdkSessionId:$,correlationId:M,...g}=r;Object.keys(g).length>0&&(u=` {${Object.entries(g).map(([W,b])=>`${W}=${b}`).join(", ")}}`)}let T=`[${E}] [${l}] [${_}] ${i}${n}${u}${a}`;t===3?console.error(T):console.log(T)}debug(t,e,n,r){this.log(0,t,e,n,r)}info(t,e,n,r){this.log(1,t,e,n,r)}warn(t,e,n,r){this.log(2,t,e,n,r)}error(t,e,n,r){this.log(3,t,e,n,r)}dataIn(t,e,n,r){this.info(t,`\u2192 ${e}`,n,r)}dataOut(t,e,n,r){this.info(t,`\u2190 ${e}`,n,r)}success(t,e,n,r){this.info(t,`\u2713 ${e}`,n,r)}failure(t,e,n,r){this.error(t,`\u2717 ${e}`,n,r)}timing(t,e,n,r){this.info(t,`\u23F1 ${e}`,r,{duration:`${n}ms`})}},A=new C;var f={DEFAULT:5e3,HEALTH_CHECK:1e3,WORKER_STARTUP_WAIT:1e3,WORKER_STARTUP_RETRIES:15,WINDOWS_MULTIPLIER:1.5};function N(o){return process.platform==="win32"?Math.round(o*f.WINDOWS_MULTIPLIER):o}var c=p.join(w(),".claude","plugins","marketplaces","thedotmack"),Q=N(f.HEALTH_CHECK),tt=f.WORKER_STARTUP_WAIT,et=f.WORKER_STARTUP_RETRIES;function S(){let o=p.join(w(),".claude-mem","settings.json"),t=m.loadFromFile(o);return parseInt(t.CLAUDE_MEM_WORKER_PORT,10)}async function k(){try{let o=S();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(Q)})).ok}catch(o){return A.debug("SYSTEM","Worker health check failed",{error:o instanceof Error?o.message:String(o),errorType:o?.constructor?.name}),!1}}async function rt(){try{let o=p.join(c,"plugin","scripts","worker-service.cjs");if(!h(o))throw new Error(`Worker script not found at ${o}`);if(process.platform==="win32"){let t=I("powershell.exe",["-NoProfile","-NonInteractive","-Command",`Start-Process -FilePath 'node' -ArgumentList '${o}' -WorkingDirectory '${c}' -WindowStyle Hidden`],{cwd:c,stdio:"pipe",encoding:"utf-8",windowsHide:!0});if(t.status!==0)throw new Error(t.stderr||"PowerShell Start-Process failed")}else{let t=p.join(c,"ecosystem.config.cjs");if(!h(t))throw new Error(`Ecosystem config not found at ${t}`);let e=p.join(c,"node_modules",".bin","pm2"),n=h(e)?e:"pm2",r=I(n,["start",t],{cwd:c,stdio:"pipe",encoding:"utf-8"});if(r.status!==0)throw new Error(r.stderr||"PM2 start failed")}for(let t=0;t<et;t++)if(await new Promise(e=>setTimeout(e,tt)),await k())return!0;return!1}catch(o){return A.error("SYSTEM","Failed to start worker",{platform:process.platform,workerScript:p.join(c,"plugin","scripts","worker-service.cjs"),error:o instanceof Error?o.message:String(o),marketplaceRoot:c}),!1}}async function v(){if(await k())return;if(!await rt()){let t=S();throw new Error(`Worker service failed to start on port ${t}.

To start manually, run:
  cd ${c}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}var it=P(ot(),".claude","plugins","marketplaces","thedotmack"),at=P(it,".first-run-complete");st(at)||(console.error(`
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
`),process.exit(3));try{await v();let o=S(),t=nt(process.cwd()),e=await fetch(`http://127.0.0.1:${o}/api/context/inject?project=${encodeURIComponent(t)}&colors=true`,{method:"GET",signal:AbortSignal.timeout(5e3)});if(!e.ok)throw new Error(`Worker error ${e.status}`);let n=await e.text(),r=new Date,s=new Date("2025-12-06T00:00:00Z"),E=new Date("2025-12-05T05:00:00Z"),l="";r<E&&(l=`

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}

   We launched on Product Hunt!
   https://tinyurl.com/claude-mem-ph

   \u2B50 Your upvote means the world - thank you!

\u{1F680} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u{1F680}
`);let _="";if(r<s){let a=r.getUTCHours()*60+r.getUTCMinutes(),u=Math.floor((a-300+1440)%1440/60),T=r.getUTCDate(),L=r.getUTCMonth(),M=r.getUTCFullYear()===2025&&L===11&&T>=1&&T<=5,g=u>=17&&u<19;M&&g?_=`
   \u{1F534} LIVE NOW: AMA w/ Dev (@thedotmack) until 7pm EST
`:_=`
   \u2013 LIVE AMA w/ Dev (@thedotmack) Dec 1st\u20135th, 5pm to 7pm EST
`}console.error(`

\u{1F4DD} Claude-Mem Context Loaded
   \u2139\uFE0F  Note: This appears as stderr but is informational only

`+n+`

\u{1F4A1} New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.

\u{1F4AC} Community https://discord.gg/J4wttp9vDu`+l+_+`
\u{1F4FA} Watch live in browser http://localhost:${o}/
`)}catch(o){console.error(`\u274C Failed to load context display: ${o}`)}process.exit(3);
