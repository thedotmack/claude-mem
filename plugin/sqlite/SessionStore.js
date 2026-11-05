var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var Ye=Object.defineProperty;var En=Object.getOwnPropertyDescriptor;var cn=Object.getOwnPropertyNames;var ln=Object.prototype.hasOwnProperty;var un=(r,e)=>{for(var t in e)Ye(r,t,{get:e[t],enumerable:!0})},pn=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of cn(e))!ln.call(r,n)&&n!==t&&Ye(r,n,{get:()=>e[n],enumerable:!(s=En(e,n))||s.enumerable});return r};var mn=r=>pn(Ye({},"__esModule",{value:!0}),r);var ro={};un(ro,{SessionStore:()=>Ot,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS:()=>on,rollupObservationFileLists:()=>an});module.exports=mn(ro);var Tn=new Set,Sn=0;function Q(r,e,t="additive",s){Sn++;for(let n of Tn)n({scope:r,reason:e,kind:t,...s?{changes:s}:{}})}var ft=require("bun:sqlite"),Ve=require("crypto");var C=require("path"),Je=require("os"),Ie=require("fs"),xt=require("url");var L=require("fs"),Mt=require("crypto"),k=require("path");var gn=null;function An(r){return(gn??process.stderr.write.bind(process.stderr))(r)}function re(r){An(r)}var ao=Promise.resolve();var yt=process.platform==="win32";function ce(r){return r.replace(/^\uFEFF/,"")}function qe(r){return JSON.parse(ce(r))}function le(r){return qe((0,L.readFileSync)(r,"utf-8"))}function Rn(r){(0,L.existsSync)(r)||(0,L.mkdirSync)(r,{recursive:!0})}function vt(r){try{return(0,L.realpathSync)(r)}catch(e){if(e.code!=="ENOENT")throw e;let t=(0,k.dirname)(r);return t===r?r:(0,k.join)(vt(t),(0,k.basename)(r))}}function Nn(r){let e=r,t=new Set;try{for(;(0,L.lstatSync)(e).isSymbolicLink();){let s=(0,k.resolve)(e);if(t.has(s))throw Object.assign(new Error(`Symlink loop at ${e}`),{code:"ELOOP"});t.add(s);try{return(0,L.realpathSync)(e)}catch(n){if(n.code!=="ENOENT")throw n;let i=n instanceof Error?n:new Error(String(n));re(`claude-mem: realpathSync failed for ${e}, resolving symlink manually: ${i.message}
`);let o=(0,L.readlinkSync)(e);e=(0,k.resolve)(vt((0,k.dirname)((0,k.resolve)(e))),o)}}}catch(s){if(s.code!=="ENOENT")throw s}return e}var fn=new Set(["EPERM","EBUSY","EACCES"]),Dt=[10,20,40,80,160,320];function On(r){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,r)}function hn(r,e,t=L.renameSync,s=yt){if(!s)return t(r,e);for(let n=0;;n++)try{t(r,e);return}catch(i){let o=i.code??"";if(n>=Dt.length||!fn.has(o))throw i;On(Dt[n])}}function $(r,e,t={}){let s=Nn(r);Rn((0,k.dirname)(s));let n=(0,k.dirname)(s),i=(0,k.basename)(s),o=(0,k.join)(n,`.${i}.${process.pid}.${(0,Mt.randomBytes)(6).toString("hex")}.tmp`),a=Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),_=t.mode;if(_===void 0)try{_=(0,L.statSync)(s).mode&511}catch{}let d;try{d=_!==void 0?(0,L.openSync)(o,"w",_):(0,L.openSync)(o,"w");let E=0;for(;E<a.length;){let c=(0,L.writeSync)(d,a,E,a.length-E);if(c===0)throw new Error(`writeSync stalled at ${E}/${a.length} bytes`);E+=c}if((0,L.fsyncSync)(d),(0,L.closeSync)(d),d=void 0,hn(o,s),!yt){let c;try{c=(0,L.openSync)(n,"r"),(0,L.fsyncSync)(c)}catch(u){let p=u instanceof Error?u:new Error(String(u));re(`claude-mem: directory fsync failed for ${n}: ${p.message}
`)}finally{if(c!==void 0)try{(0,L.closeSync)(c)}catch{}}}}catch(E){if(d!==void 0)try{(0,L.closeSync)(d)}catch{}try{(0,L.unlinkSync)(o)}catch{}throw E}}var bn=r=>r!==null&&typeof r=="object"&&!Array.isArray(r);function Ut(r){let e=r.env;return bn(e)&&Object.keys(e).some(t=>t.startsWith("CLAUDE_MEM_"))?"nested":"flat"}function oe(r){return Ut(r)==="nested"?r.env:r}function wt(r){return Ut(r)!=="nested"?r:Object.fromEntries(Object.entries(r).filter(([e])=>!e.startsWith("CLAUDE_MEM_")))}var kt=require("os"),Ft=require("path");function Z(r,e=process.platform,t=(0,kt.homedir)()){return typeof r!="string"||r.length===0?r:r==="~"?t:r.startsWith("~/")||e==="win32"&&r.startsWith("~\\")?(0,Ft.join)(t,r.slice(2)):r}function Ln(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,C.dirname)((0,xt.fileURLToPath)(__IMPORT_META_URL__))}var Ro=Ln();function In(){if(process.env.CLAUDE_MEM_DATA_DIR)return Z(process.env.CLAUDE_MEM_DATA_DIR);let r=(0,C.join)((0,Je.homedir)(),".claude-mem"),e=(0,C.join)(r,"settings.json");try{if((0,Ie.existsSync)(e)){let t=le(e);if(t===null||typeof t!="object"||Array.isArray(t))return r;let s=oe(t);if(typeof s.CLAUDE_MEM_DATA_DIR=="string"&&s.CLAUDE_MEM_DATA_DIR)return Z(s.CLAUDE_MEM_DATA_DIR)}}catch{}return r}var D=In(),Cn=(0,C.join)((0,Je.homedir)(),".claude"),Dn=process.env.CLAUDE_CONFIG_DIR||Cn,No=(0,C.join)(Dn,"plugins","marketplaces","thedotmack"),Mn=(0,C.join)(D,"logs"),Ce=(0,C.join)(D,"settings.json"),Pt="claude-mem.db";var De=(0,C.join)(D,Pt),yn=(0,C.join)(D,"observer-sessions"),ie=(0,C.basename)(yn);function Me(r){(0,Ie.mkdirSync)(r,{recursive:!0})}var ze={dataDir:()=>D,workerPid:()=>(0,C.join)(D,"worker.pid"),workerHeartbeat:()=>(0,C.join)(D,"worker-heartbeat.json"),serverPid:()=>(0,C.join)(D,".server-beta.pid"),serverPort:()=>(0,C.join)(D,".server-beta.port"),serverRuntime:()=>(0,C.join)(D,".server-beta.runtime.json"),settings:()=>(0,C.join)(D,"settings.json"),database:()=>(0,C.join)(D,Pt),backups:()=>(0,C.join)(D,"backups","auto"),pendingRestore:()=>(0,C.join)(D,"backups","restore-pending.json"),lastRestore:()=>(0,C.join)(D,"backups","last-restore.json"),chroma:()=>(0,C.join)(D,"chroma"),combinedCerts:()=>(0,C.join)(D,"combined_certs.pem"),transcriptsConfig:()=>(0,C.join)(D,"transcript-watch.json"),transcriptsState:()=>(0,C.join)(D,"transcript-watch-state.json"),corpora:()=>(0,C.join)(D,"corpora"),supervisorRegistry:()=>(0,C.join)(D,"supervisor.json"),envFile:()=>(0,C.join)(D,".env"),logsDir:()=>Mn};var U=require("fs"),ye=require("path");var Ze=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(Ze||{}),Qe=null;function X(r){return r.replace(/\r/g,"\\r").replace(/\n/g,"\\n")}function vn(r){return"  "+r.replace(/\r/g,"\\r").replace(/\n(?![ \t]+at )/g,"\\n")}var et=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;logFileDate=null;logFd=null;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){let e=new Date().toISOString().split("T")[0];if(this.logFileInitialized&&this.logFileDate===e)return;let t=this.logFileDate!==e;this.closeLogFd(),this.logFileInitialized=!1,this.logFileDate=e;try{let s=ze.logsDir();(0,U.existsSync)(s)||(0,U.mkdirSync)(s,{recursive:!0}),this.logFilePath=(0,ye.join)(s,`claude-mem-${e}.log`),this.logFileInitialized=!0}catch(s){t&&console.error("[LOGGER] Failed to initialize log file:",s instanceof Error?s.message:String(s)),this.logFilePath=null}}closeLogFd(){if(this.logFd!==null){try{(0,U.closeSync)(this.logFd)}catch{}this.logFd=null}}appendLine(e,t){if(this.logFd!==null){let s=!1;try{let n=(0,U.fstatSync)(this.logFd),i=(0,U.statSync)(e);s=n.ino===i.ino&&n.dev===i.dev}catch{}s||this.closeLogFd()}this.logFd===null&&((0,U.mkdirSync)((0,ye.dirname)(e),{recursive:!0}),this.logFd=(0,U.openSync)(e,"a"));try{let s=Buffer.from(t,"utf8");for(;s.length>0;){let n=(0,U.writeSync)(this.logFd,s);if(n<=0)throw new Error("log write accepted 0 bytes");s=s.subarray(n)}}catch(s){throw this.closeLogFd(),s}}getLevel(){if(this.level===null)try{let e=ze.settings();if((0,U.existsSync)(e)){let s=(oe(le(e)).CLAUDE_MEM_LOG_LEVEL||"INFO").toString().toUpperCase();this.level=Ze[s]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}safeStringify(e,t,s=6){let n=new WeakSet,i=(o,a)=>{if(typeof o=="bigint")return`${o}n`;if(o===null||typeof o!="object")return o;let _=o.toJSON,d=typeof _=="function"?_.call(o):o;if(typeof d=="bigint")return`${d}n`;if(d===null||typeof d!="object")return d;if(n.has(d))return"[Circular]";if(a>=s)return Array.isArray(d)?"[Array]":"[Object]";n.add(d);try{if(Array.isArray(d))return d.map(c=>i(c,a+1));let E={};for(let c of Object.keys(d))try{E[c]=i(d[c],a+1)}catch{E[c]="[unreadable]"}return E}finally{n.delete(d)}};try{return JSON.stringify(i(e,0),null,t)??String(e)}catch{return Array.isArray(e)?`[${e.length} items]`:"[unserializable]"}}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?this.safeStringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(s===null)return e;if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${i}:${o}:${a}.${_}`}log(e,t,s,n,i){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),a=Ze[e].padEnd(5),_=t.padEnd(6),d="";n?.correlationId?d=`[${X(String(n.correlationId))}] `:n?.sessionId&&(d=`[session-${X(String(n.sessionId))}] `);let E="";i!=null&&(i instanceof Error?(E=` ${X(i.message)}`,this.getLevel()===0&&i.stack&&(E+=`
${vn(i.stack)}`)):this.getLevel()===0&&typeof i=="object"?E=`
`+this.safeStringify(i,2):E=" "+X(this.formatData(i)));let c="";if(n){let{sessionId:p,memorySessionId:m,correlationId:b,...R}=n;Object.keys(R).length>0&&(c=` {${Object.entries(R).map(([f,T])=>typeof T!="object"||T===null||T instanceof Error||T instanceof Date?`${X(f)}=${X(String(T))}`:`${X(f)}=${X(Array.isArray(T)?this.safeStringify(T):this.formatData(T))}`).join(", ")}}`)}let u=`[${o}] [${a}] [${_}] ${d}${X(s)}${c}${E}`;if(this.logFilePath)try{this.appendLine(this.logFilePath,u+`
`)}catch(p){let m=p instanceof Error?p:new Error(String(p));re(`[LOGGER] Failed to write to log file: ${m.message}
${m.stack??""}
`)}else re(u+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}setErrorSink(e){Qe=e}error(e,t,s,n){this.log(3,e,t,s,n),this.routeErrorToSink(t,s,n)}routeErrorToSink(e,t,s){try{if(!Qe||!(s instanceof Error))return;Qe(s)}catch{}}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}},l=new et;function P(r){let e=r.projects?.length?r.projects:r.project?[r.project]:[];return[...new Set(e.filter(t=>t.trim().length>0))]}function H(r,e,t){let s=e.map(()=>"?").join(",");return t.includeMerged?{sql:`(${r}.project COLLATE NOCASE IN (${s}) OR ${r}.merged_into_project COLLATE NOCASE IN (${s}))`,params:[...e,...e]}:{sql:`${r}.project COLLATE NOCASE IN (${s})`,params:[...e]}}var Un=4;function Bt(r,e){let t=P({projects:e});if(t.length===0)return[];let s=t.map(()=>"?").join(","),n=[[`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${s})`,1],[`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${s})`,1],[`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${s})`,1],[`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${s})`,1],[`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${s})`,1],[`SELECT candidates.key FROM (
        SELECT project AS key FROM observations WHERE merged_into_project COLLATE NOCASE IN (${s})
        UNION
        SELECT project AS key FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${s})
      ) candidates
      WHERE (
        (SELECT COUNT(*) FROM observations WHERE project COLLATE NOCASE = candidates.key)
        + (SELECT COUNT(*) FROM session_summaries WHERE project COLLATE NOCASE = candidates.key)
      ) = (
        (SELECT COUNT(*) FROM observations
          WHERE project COLLATE NOCASE = candidates.key AND merged_into_project COLLATE NOCASE IN (${s}))
        + (SELECT COUNT(*) FROM session_summaries
          WHERE project COLLATE NOCASE = candidates.key AND merged_into_project COLLATE NOCASE IN (${s}))
      )`,Un]],i=r.prepare(n.map(([o])=>o).join(" UNION "));try{let o=i.all(...n.flatMap(([,a])=>Array(a).fill(t).flat()));return[...new Set([...t,...o.map(a=>a.key)])]}finally{i.finalize()}}var Ht=require("crypto");function tt(r){return typeof r=="string"&&r.trim()!==""}function $t(r,e,t){return(0,Ht.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function st(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[String(e)]}catch(e){return l.debug("DB","File list is not JSON; treating value as a single path",{value:r},e instanceof Error?e:new Error(String(e))),[r]}}function Xt(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function jt(r,e,t,s){r.prepare("DELETE FROM observation_files WHERE observation_id = ?").run(e);let n=new Set([...Xt(t),...Xt(s)]);if(n.size===0)return;let i=r.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let o of n)i.run(o,e)}function Wt(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function nt(r=new Date){return r.toISOString().slice(0,10)}function Gt(r,e=new Date,t=10){let s=nt(e);if(r.includes(s))return r;let n=[...r,s];return n.length>t?n.slice(n.length-t):n}function Kt(r){let e=nt(new Date(r));return{dates:JSON.stringify([e]),lastReinforced:e}}function ve(r,e,t=new Date){let s=r.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(e);if(!s)return!1;let n=Wt(s.reinforcement_dates),i=Gt(n,t);return i===n?!1:(r.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(JSON.stringify(i),i[i.length-1],e),!0)}var qt=require("crypto");var S="claude";function wn(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function O(r){if(!r)return S;let e=wn(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e.includes("kimi")?"kimi":e==="pi-mono"?"pi":e==="agy"||e==="antigravity"||e.startsWith("antigravity-")?"antigravity-cli":e:S}function Vt(r){let e=["claude","codex","antigravity-cli","cursor","kimi"];return[...r].sort((t,s)=>{let n=e.indexOf(t),i=e.indexOf(s);return n!==-1||i!==-1?n===-1?1:i===-1?-1:n-i:t.localeCompare(s)})}var kn=new Set(["dumb_search","claude_mem_search","claude_mem_timeline","claude_mem_get_observations","mem_search","search","timeline","get_observations","get_summaries","get_tool_uses","session_start_context","observation_search","observation_context","memory_search","memory_context"]);function Fn(r){if(!r.startsWith("mcp__"))return null;let e=r.split("__");if(e.length<3)return null;let t=e[1].toLowerCase();return!t.includes("claude-mem")&&!t.includes("claude_mem")&&!t.includes("mcp-search")&&!t.includes("mcp_search")&&!t.includes("cmem")?null:e.slice(2).join("__")}function rt(r){if(!r)return!1;if(r.startsWith("memory_")||r==="claude_mem_search"||r==="claude_mem_timeline"||r==="claude_mem_get_observations"||r==="dumb_search"||r==="mem_search"||r==="get_summaries")return!0;let e=Fn(r);return e!==null&&kn.has(e)}var xn=64*1024;function Yt(r,e=xn){let t=Buffer.byteLength(r,"utf8");if(t<=e)return r;let s=Buffer.from(r,"utf8"),n=e;for(;n>0&&(s[n]&192)===128;)n--;return`${s.subarray(0,n).toString("utf8")}\u2026[truncated: ${t} bytes]`}function Pn(r,e,t){return(0,qt.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function Jt(r){r.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${S}',
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      prompt_number INTEGER,
      agent_type TEXT,
      agent_id TEXT,
      observation_id INTEGER,
      or_generation_id TEXT,
      or_session_id TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(content_session_id, tool_use_id)
    )
  `),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project_nocase_created ON tool_uses(project COLLATE NOCASE, created_at_epoch DESC, id DESC)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function zt(r,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||rt(e.toolName))return null;let t=e.createdAtEpoch??Date.now(),s=new Date(t).toISOString(),n=Pn(e.toolName,e.toolInput,e.toolResponse),i=e.toolInput!=null?Yt(e.toolInput):null,o=e.toolResponse!=null?Yt(e.toolResponse):null,a=r.prepare(`
    INSERT INTO tool_uses (
      tool_use_id, content_session_id, memory_session_id, session_db_id, project,
      platform_source, tool_name, tool_input, tool_response, cwd, prompt_number,
      agent_type, agent_id, or_generation_id, or_session_id, content_hash,
      created_at, created_at_epoch
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_session_id, tool_use_id) DO UPDATE SET
      memory_session_id = CASE WHEN tool_uses.observation_id IS NULL
        THEN COALESCE(excluded.memory_session_id, tool_uses.memory_session_id)
        ELSE tool_uses.memory_session_id END,
      session_db_id     = COALESCE(excluded.session_db_id, tool_uses.session_db_id),
      project           = CASE WHEN excluded.project != '' THEN excluded.project ELSE tool_uses.project END,
      platform_source   = excluded.platform_source,
      tool_input        = COALESCE(excluded.tool_input, tool_uses.tool_input),
      tool_response     = COALESCE(excluded.tool_response, tool_uses.tool_response),
      cwd               = COALESCE(excluded.cwd, tool_uses.cwd),
      prompt_number     = COALESCE(excluded.prompt_number, tool_uses.prompt_number),
      agent_type        = COALESCE(excluded.agent_type, tool_uses.agent_type),
      agent_id          = COALESCE(excluded.agent_id, tool_uses.agent_id),
      or_generation_id  = COALESCE(excluded.or_generation_id, tool_uses.or_generation_id),
      or_session_id     = COALESCE(excluded.or_session_id, tool_uses.or_session_id),
      content_hash      = excluded.content_hash
    RETURNING id
  `).get(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",O(e.platformSource),e.toolName,i,o,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,n,s,t);return a?a.id:null}function Qt(r,e){let t=e.toolUseIds.filter(i=>typeof i=="string"&&i.length>0);if(t.length===0)return 0;let s=t.map(()=>"?").join(","),n=r.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = CASE WHEN observation_id IS NULL
          THEN COALESCE(?, memory_session_id)
          ELSE COALESCE(memory_session_id, ?)
        END
    WHERE content_session_id = ?
      AND tool_use_id IN (${s})
      AND (observation_id IS NULL OR observation_id = ?)
  `).run(e.observationId,e.memorySessionId??null,e.memorySessionId??null,e.contentSessionId,...t,e.observationId);return Number(n.changes??0)}function Zt(r){return r?{clause:`COALESCE(NULLIF(platform_source, ''), '${S}') = ?`,param:O(r)}:null}var Bn=100;function es(r,e,t={}){let s=[],n=[];for(let E of e){if(typeof E=="number"&&Number.isInteger(E)){s.push(E);continue}if(typeof E=="string"&&E.trim().length>0){let c=Number(E);Number.isInteger(c)&&String(c)===E.trim()&&s.push(c),n.push(E.trim())}}if(s.length===0&&n.length===0)return[];let i=[],o=[];s.length>0&&(i.push(`id IN (${s.map(()=>"?").join(",")})`),o.push(...s)),n.length>0&&(i.push(`tool_use_id IN (${n.map(()=>"?").join(",")})`),o.push(...n));let a=[`(${i.join(" OR ")})`];t.project&&(a.push("project COLLATE NOCASE = ?"),o.push(t.project)),t.contentSessionId&&(a.push("content_session_id = ?"),o.push(t.contentSessionId));let _=Zt(t.platformSource);_&&(a.push(_.clause),o.push(_.param));let d=t.limit&&t.limit>0?Math.floor(t.limit):Bn;return r.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    LIMIT ${d}
  `).all(...o)}function ts(r,e={}){let t=[],s=[];if(e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.memorySessionId&&(t.push("memory_session_id = ?"),s.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(t.push("session_db_id = ?"),s.push(e.sessionDbId)),e.toolName){let d=Array.isArray(e.toolName)?e.toolName:[e.toolName];d.length>0&&(t.push(`tool_name IN (${d.map(()=>"?").join(",")})`),s.push(...d))}e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId));let n=Zt(e.platformSource);n&&(t.push(n.clause),s.push(n.param)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let i=t.length>0?`WHERE ${t.join(" AND ")}`:"",o=e.orderBy==="date_asc"?"ASC":"DESC",a=Math.min(Math.max(Math.floor(e.limit??50),1),500),_=Math.max(Math.floor(e.offset??0),0);return r.prepare(`
    SELECT * FROM tool_uses
    ${i}
    ORDER BY created_at_epoch ${o}, id ${o}
    LIMIT ${a} OFFSET ${_}
  `).all(...s)}function ss(r,e={}){let t=[],s=[];e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let n=t.length>0?`WHERE ${t.join(" AND ")}`:"";return r.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${n}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...s)}function ns(r){r.run(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      platform_source TEXT NOT NULL,
      agent_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      bucket_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      declared INTEGER NOT NULL DEFAULT 0,
      list_name TEXT,
      field TEXT,
      tool_use_id TEXT,
      occurred_at_epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `),r.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_deliverables_session_copy ON deliverables(platform_source, content_session_id, bucket_path)"),r.run("CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project COLLATE NOCASE, created_at_epoch)"),r.run("CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at_epoch DESC)")}function rs(r,e){let t=e.createdAtEpoch??Date.now(),s=r.prepare(`
    INSERT OR IGNORE INTO deliverables (
      project, content_session_id, platform_source, agent_id, title, kind, source_path, bucket_path, bytes, sha256,
      declared, list_name, field, tool_use_id, occurred_at_epoch, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.project,e.contentSessionId,e.platformSource,e.agentId??null,e.title,e.kind,e.sourcePath,e.bucketPath,e.bytes,e.sha256,e.declared?1:0,e.listName??null,e.field??null,e.toolUseId??null,e.occurredAtEpoch,new Date(t).toISOString(),t);if(s.changes>0){let i=Number(s.lastInsertRowid);return l.debug("DB","Deliverable recorded",{id:i,project:e.project,bucketPath:e.bucketPath}),{id:i,inserted:!0}}return{id:r.prepare("SELECT id FROM deliverables WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ?").get(e.platformSource,e.contentSessionId,e.bucketPath)?.id??0,inserted:!1}}function os(r,e){return!Number.isSafeInteger(e)||e<1?null:r.prepare("SELECT * FROM deliverables WHERE id = ?").get(e)??null}var xe=require("fs");var j=require("fs"),B=require("path"),ue=require("os");var Ue={HEALTH_CHECK:3e3,API_REQUEST:3e4,SESSION_INIT_HOOK_CAP:15e3,SESSION_INIT_REQUEST:1e4,SESSION_INIT_REQUEST_MAX:14e3,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function Hn(r=process.platform){return r==="win32"?8e3:5e3}function is(r=process.platform){return Ue.SESSION_INIT_HOOK_CAP-Hn(r)}function as(r){return process.platform==="win32"?Math.round(r*Ue.WINDOWS_MULTIPLIER):r}var ls=require("util");function _s(r){try{return new URL(r).hostname.toLowerCase()==="openrouter.ai"}catch{return!1}}var $n="security_alert",Xn="sync-hub.black-pond-afbb.workers.dev",jn="ziczmqtpmaxbornfghye.supabase.co",Wn="https://sync.cmem.ai",Gn=new Set(["xiaomi/mimo-v2-flash:free"]);function Kn(r){return typeof r=="boolean"?String(r):r}var Vn=new Set(["claude-haiku-4-5-20251001","claude-haiku-4-5"]);function Yn(r){let e=process.env.CLAUDE_MEM_ENV_FILE??(0,B.join)((0,B.dirname)(r),".env");try{return(0,j.existsSync)(e)?!!(0,ls.parseEnv)(ce((0,j.readFileSync)(e,"utf-8"))).ANTHROPIC_BASE_URL:!1}catch{return!0}}function qn(r,e){let t=r.CLAUDE_MEM_MODEL;return typeof t!="string"||!Vn.has(t.trim())?!1:(typeof r.CLAUDE_MEM_CLAUDE_AUTH_METHOD=="string"?r.CLAUDE_MEM_CLAUDE_AUTH_METHOD.trim():"")!=="gateway"&&!Yn(e)}function Jn(r){let e=r.CLAUDE_MEM_OPENROUTER_MODEL;if(typeof e!="string"||!Gn.has(e.trim()))return!1;let t=typeof r.CLAUDE_MEM_OPENROUTER_BASE_URL=="string"?r.CLAUDE_MEM_OPENROUTER_BASE_URL.trim():"";return t===""||_s(t)}var ds=18e4,Es=[{key:"CLAUDE_MEM_LLM_TIMEOUT_MS",legacy:"30000",markerTag:"llm-timeout-migrated-v1"},{key:"CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS",legacy:"30000",markerTag:"field-optimize-timeout-migrated-v1"}];function us(r,e){return(0,B.join)((0,B.dirname)(r),`.${(0,B.basename)(r)}.${e.markerTag}`)}function ot(r,e){try{(0,j.writeFileSync)(us(r,e),new Date().toISOString(),{encoding:"utf-8",mode:384})}catch{}}var cs=new Set;function zn(r){if(typeof r!="string")return null;let e=r.trim();if(e.length===0)return null;try{let t=new URL(e).hostname;if(t===Xn||t===jn)return Wn}catch{return null}return null}var ae=class{static DEFAULTS={CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED:"true",CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED:"true",CLAUDE_MEM_MEMORY_WATCH_ROOTS:"",CLAUDE_MEM_MODEL:"haiku",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES:"false",CLAUDE_MEM_CONTEXT_PROJECTS:"current",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_URL:"",CLAUDE_MEM_WORKER_INGEST_TOKEN:"",CLAUDE_MEM_WORKER_INGEST_MAX_BYTES:"5242880",CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:"auto",CLAUDE_MEM_ALLOWED_ORIGINS:"",CLAUDE_MEM_PUBLIC_URL:"",CLAUDE_MEM_API_TIMEOUT_MS:String(as(Ue.API_REQUEST)),CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS:String(is()),CLAUDE_MEM_IDLE_EXIT_SEC:"0",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_SKIP_BASH_PATTERNS:"",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_CAPTURE_ADVISOR_CALLS:"false",CLAUDE_MEM_DELIVERABLES_ENABLED:"true",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_PROVIDER_BY_SOURCE:"",CLAUDE_MEM_OBSERVER_ENABLED:"true",CLAUDE_MEM_MEDIA_CAPTURE_ENABLED:"false",CLAUDE_MEM_MEDIA_INFERENCE_ENABLED:"false",CLAUDE_MEM_CODEX_MODEL:"",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"low",CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE:"8",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS:"32000",CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_API_KEYS:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-flash-latest",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_API_KEYS:"",CLAUDE_MEM_OPENROUTER_MODEL:"cohere/north-mini-code:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_TEMPERATURE:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_PRESET:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEYS:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"",CLAUDE_MEM_OPENAI_COMPAT_REASONING:"",CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER:"claude",CLAUDE_MEM_QUOTA_FALLBACK_MODEL:"",CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD:"",CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR:"0.95",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET:"0.92",CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE:"0.95",CLAUDE_MEM_DATA_DIR:(0,B.join)((0,ue.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:"",CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:"",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY:"true",CLAUDE_MEM_REINFORCE_ALPHA:"0",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_WORK_STATE_ENABLED:"true",CLAUDE_MEM_FILE_READ_GATE_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,B.join)((0,ue.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_CODEX_SUBAGENT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS:"400000",CLAUDE_MEM_OBSERVER_THINKING:"disabled",CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW:"",CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS:"4096",CLAUDE_MEM_OBSERVE_BARE_PROMPTS:"false",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_REDACT_ENABLED:"false",CLAUDE_MEM_REDACT_DISABLED_BUILTINS:"",CLAUDE_MEM_REDACT_CUSTOM_PATTERNS:"[]",CLAUDE_MEM_REDACT_LOG_MATCHES:"false",CLAUDE_MEM_REDACT_GENERIC_ENABLED:"false",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_PROJECT_ENVIRONMENTS:"[]",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_SEMANTIC_INJECT_FORMAT:"narrative",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS:"600000",CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS:"5000",CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_SERVER_VECTOR_SEARCH:"auto",CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS:"",CLAUDE_MEM_EMBEDDING_MODEL:"all-MiniLM-L6-v2",CLAUDE_MEM_CHROMA_UVX_PATH:"",CLAUDE_MEM_SEARCH_RECENCY_DAYS:"90",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,ue.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING:"false",CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE:"40",CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS:"90000",CLAUDE_MEM_TEAMBRAIN_URL:"",CLAUDE_MEM_TEAMBRAIN_TEAM_ID:"",CLAUDE_MEM_LLM_TIMEOUT_MS:String(ds),CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS:String(ds),CLAUDE_MEM_LLM_STREAM_IDLE_TIMEOUT_MS:"90000",CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS:"120000",CLAUDE_MEM_TV_TOKEN:"",CLAUDE_MEM_PRO_TRIAL_EMAIL:"",CLAUDE_MEM_PRO_TRIAL_AT:"",CLAUDE_MEM_PRO_TRIAL_STATE:"",CLAUDE_MEM_PRO_TRIAL_ENDS_AT:"",CLAUDE_MEM_PRO_PLAN:"",CLAUDE_MEM_PRO_FALLBACK_AT:"",CLAUDE_MEM_PRO_FALLBACK_MESSAGE:"",CLAUDE_MEM_PRO_FALLBACK_ACTION:"",CLAUDE_MEM_PRO_FALLBACK_URL:"",CLAUDE_MEM_PRO_MEMORY_KEY:"",CLAUDE_MEM_PRO_MEMORY_BASE_URL:"",CLAUDE_MEM_PRO_MEMORY_MODEL:"",CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH:"true",CLAUDE_MEM_WORK_VIEW_SHARED_STATE:"false",CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER:"",CLAUDE_MEM_WORK_VIEW_COPY_MODEL:"",CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL:"",CLAUDE_MEM_WORK_VIEW_CODEX_MODEL:"",CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL:"",CLAUDE_MEM_BACKUP_ENABLED:"false",CLAUDE_MEM_BACKUP_INTERVAL_HOURS:"24",CLAUDE_MEM_BACKUP_RETAIN_COUNT:"7",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED:"true",CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED:"false",CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES:"{}",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert,sensitive",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED:"true",CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS:"521e962d-2ec3-4488-bfbc-54d5209ce118,95601360-61f7-4fd9-bb3a-2c976b2b85c0",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_URL:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET:"",CLAUDE_MEM_NOTION_ENABLED:"false",CLAUDE_MEM_NOTION_TOKEN:"",CLAUDE_MEM_NOTION_DATABASE_ID:"",CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES:"true",CLAUDE_MEM_GROK_BOT_INJECT_ENABLED:"true",CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS:"*",CLAUDE_MEM_GROK_BOT_INJECT_TIER:"episode",CLAUDE_MEM_GROK_BOT_INJECT_WINDOW:"80",CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK:"house",CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE:"",CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT:"",CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS:"160",CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS:"1500",CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE:"",CLAUDE_MEM_CCS_ALIGN_ENABLED:"true",CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS:"ccs-align",CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS:"false",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:"",CLAUDE_MEM_DEDUP_ENABLED:"false",CLAUDE_MEM_DEDUP_COSINE_THRESHOLD:"0.80",CLAUDE_MEM_DEDUP_IDF_VETO_DF:"10",CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS:"2",CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS:"10",CLAUDE_MEM_DEDUP_MAX_SCAN:"2000",CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS:"50000",CLAUDE_MEM_TOOL_USES_RETENTION_DAYS:"0",CLAUDE_MEM_LOG_RETENTION_DAYS:"30",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_PROJECT_NAME_SOURCE:"path"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){let t=process.env[e]??this.DEFAULTS[e];return e==="CLAUDE_MEM_WORKER_HOST"?this.normalizeWorkerHost(t):e==="CLAUDE_MEM_DATA_DIR"?Z(t):t}static normalizeWorkerHost(e){return e==="localhost"?"127.0.0.1":e}static finalizeSettings(e,t){let s=t?this.applyEnvOverrides(e):e;s.CLAUDE_MEM_WORKER_HOST=this.normalizeWorkerHost(s.CLAUDE_MEM_WORKER_HOST);let n=s.CLAUDE_MEM_DATA_DIR?.trim();return n&&s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH===this.DEFAULTS.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH&&(s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH=(0,B.join)(Z(n),"transcript-watch.json")),s}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0,s={}){try{if(!(0,j.existsSync)(e)){let u=this.getAllDefaults();if(!s.readOnly)try{$(e,u,{mode:384});for(let p of Es)ot(e,p);console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(p){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,p instanceof Error?p.message:String(p))}return this.finalizeSettings(u,t)}let n=(0,j.readFileSync)(e,"utf-8"),i=qe(n),o=oe(i),a=o!==i,_=wt(i),d=a&&Object.keys(_).some(u=>u!=="env");if(a&&!d&&!s.readOnly)try{$(e,o,{mode:384}),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(u){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,u instanceof Error?u.message:String(u))}if(o.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES===$n&&(o={...o,CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES},!s.readOnly))try{$(e,d?{..._,env:o}:o,{mode:384}),console.warn("[SETTINGS] Migrated Telegram trigger types off the legacy default:",e)}catch(u){console.warn("[SETTINGS] Failed to migrate Telegram trigger types:",e,u instanceof Error?u.message:String(u))}if(qn(o,e)){let u=String(o.CLAUDE_MEM_MODEL).trim();if(o={...o,CLAUDE_MEM_MODEL:this.DEFAULTS.CLAUDE_MEM_MODEL},!s.readOnly)try{$(e,d?{..._,env:o}:o,{mode:384}),console.warn(`[SETTINGS] Migrated Claude model off the pinned ${u} to ${this.DEFAULTS.CLAUDE_MEM_MODEL}:`,e)}catch(p){console.warn("[SETTINGS] Failed to migrate the pinned Claude model:",e,p instanceof Error?p.message:String(p))}}if(Jn(o)){let u=String(o.CLAUDE_MEM_OPENROUTER_MODEL).trim();if(o={...o,CLAUDE_MEM_OPENROUTER_MODEL:this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL},!s.readOnly)try{$(e,d?{..._,env:o}:o,{mode:384}),console.warn(`[SETTINGS] Migrated OpenRouter model off the retired default ${u} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,e)}catch(p){console.warn("[SETTINGS] Failed to migrate the retired OpenRouter model:",e,p instanceof Error?p.message:String(p))}}let E=zn(o.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);if(E!==null&&(o={...o,CLAUDE_MEM_CLOUD_SYNC_HUB_URL:E},!s.readOnly))try{$(e,d?{..._,env:o}:o,{mode:384}),console.warn("[SETTINGS] Migrated cloud sync hub URL to",E,"from a retired hub host:",e)}catch(u){console.warn("[SETTINGS] Failed to migrate cloud sync hub URL:",e,u instanceof Error?u.message:String(u))}for(let u of Es)if(!(0,j.existsSync)(us(e,u))){if(o[u.key]!==u.legacy){s.readOnly||ot(e,u);continue}if(o={...o,[u.key]:this.DEFAULTS[u.key]},!s.readOnly)try{$(e,d?{..._,env:o}:o,{mode:384}),ot(e,u),console.warn(`[SETTINGS] Migrated ${u.key} off the old ${u.legacy}ms default to ${this.DEFAULTS[u.key]}ms:`,e)}catch(p){let m=`${u.key}\0${e}`;cs.has(m)||(cs.add(m),console.warn(`[SETTINGS] Failed to migrate ${u.key}; using the new default in memory (reported once per process):`,e,p instanceof Error?p.message:String(p)))}}let c={...this.DEFAULTS};for(let u of Object.keys(this.DEFAULTS))o[u]!==void 0&&(c[u]=Kn(o[u]));return this.finalizeSettings(c,t)}catch(n){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,n instanceof Error?n.message:String(n));let i=this.getAllDefaults();return this.finalizeSettings(i,t)}}};var Te=String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`,Y=`(?=${Te}{8})${Te}*[A-Za-z]${Te}*`,W=String.raw`(?:\\{0,3}["'])?`,x=String.raw`\s{0,8}`;function it(r){return new RegExp(`${r}${Y}`,"gi")}function ps(r){let e=r.replace(/\\.|[a-z]/g,t=>t.length===1?`[${t}${t.toUpperCase()}]`:t);return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${e}`}function Fe(r){return`(?<=${r}${W}${x}[=:]${x}${W})`}var we=String.raw`(?:token|secret|api_key)`,ke=String.raw`\\{0,3}["']`,at=String.raw`(?<!\\)"`,Qn=String.raw`(?:^|[\s?&]|\\[nrt]|${at})`,Zn=String.raw`(?:^|\n|\\n|${at})[ \t]{0,8}(?:-[ \t]{1,8})?`,er=String.raw`(?:${ke})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${at})`,tr=new RegExp([`${Fe(String.raw`\b\w*_${we}`)}${Y}`,`(?<=${ke}${we}${ke}${x}:${x}${ke})${Y}`,`(?<=${Qn}${we}=${W})${Y}(?!\\(|${Te})`,String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${W})${Y}`,`(?<=${Zn}${we}:[ \\t]{1,8}${W})${Y}(?=${er})`].join("|"),"gi"),sr=[{name:"url_credentials",regex:/(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi},{name:"aws_access_key",regex:/(?:AKIA|ASIA)[0-9A-Z]{16}/g},{name:"aws_secret_key",regex:new RegExp(`${Fe(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`,"gi")},{name:"aws_session_token",regex:new RegExp(`${Fe(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`,"gi")},{name:"github_pat",regex:/\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g},{name:"openai_key",regex:/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"anthropic_key",regex:/\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"slack_token",regex:/\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g},{name:"jwt",regex:/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g},{name:"private_key_pem",regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g},{name:"stripe_key",regex:/\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g},{name:"google_api_key",regex:/\bAIza[0-9A-Za-z_-]{35}(?!\w)/g},{name:"google_oauth_token",regex:/\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g},{name:"gitlab_token",regex:/\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g},{name:"huggingface_token",regex:/\bhf_[A-Za-z0-9]{30,}\b/g},{name:"npm_token",regex:/\bnpm_[A-Za-z0-9]{36}\b/g},{name:"docker_pat",regex:/\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g},{name:"linear_key",regex:/\blin_api_[A-Za-z0-9]{40}(?!\w)/g},{name:"notion_token",regex:/\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g},{name:"sendgrid_key",regex:/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g},{name:"digitalocean_token",regex:/\bdo[opr]_v1_[a-f0-9]{64}\b/g},{name:"shopify_token",regex:/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g},{name:"pypi_token",regex:/\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g},{name:"databricks_token",regex:/\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g},{name:"vault_token",regex:/\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g},{name:"nvidia_nim_key",regex:/\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g},{name:"runcrate_key",regex:/\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g},{name:"groq_key",regex:/\bgsk_[A-Za-z0-9]{52}(?!\w)/g},{name:"xai_key",regex:/\bxai-[A-Za-z0-9_]{80}(?!\w)/g},{name:"supabase_token",regex:/\bsbp_[a-f0-9]{40}(?!\w)/g},{name:"sentry_token",regex:/\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g},{name:"slack_webhook",regex:new RegExp(String.raw`(?<=${ps(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`,"g")},{name:"discord_webhook",regex:new RegExp(String.raw`(?<=${ps(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`,"g")},{name:"claude_mem_key",regex:/\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g}],nr=[{name:"generic_password",regex:it(Fe(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`))},{name:"generic_token",regex:tr},{name:"bearer_token",regex:it(`(?<=\\bAuthorization${W}${x}:${x}${W}Bearer${x})`)},{name:"basic_auth",regex:it(`(?<=\\bAuthorization${W}${x}:${x}${W}Basic${x})`)}],rr=1024*1024,or="<redacted type='oversize'/>";function _e(r,e){if(!e.enabled||r.length===0)return{redacted:r,counts:{},oversize:!1};if(r.length>rr)return l.warn("REDACT","field exceeds the 1M-char redaction cap; replaced by an oversize marker",void 0,{inputLength:r.length}),{redacted:or,counts:{oversize:1},oversize:!0};let t=new Set(e.disabledBuiltinPatterns??[]),s={},n=r,i=[];for(let a of e.customPatterns??[]){if(!a.name||a.name.length===0){l.warn("REDACT","custom pattern skipped: missing name",void 0,{pattern:a});continue}try{i.push({name:a.name,regex:new RegExp(a.regex,"g")})}catch(_){l.warn("REDACT","custom pattern skipped: invalid regex",{name:a.name},_ instanceof Error?_:new Error(String(_)))}}let o=[...i,...sr,...e.genericEnabled?nr:[]];for(let a of o)t.has(a.name)||(a.regex.lastIndex=0,n=n.replace(a.regex,()=>(s[a.name]=(s[a.name]??0)+1,`<redacted type='${a.name}'/>`)));return e.logMatches&&Object.keys(s).length>0&&l.debug("REDACT","patterns matched",void 0,{counts:s}),{redacted:n,counts:s,oversize:!1}}function ir(r){if(!r||r.trim()==="")return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>t&&typeof t.name=="string"&&typeof t.regex=="string"):(l.warn("REDACT","CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring"),[])}catch(e){return l.warn("REDACT","failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",void 0,e instanceof Error?e:new Error(String(e))),[]}}function ar(r){return{enabled:r.CLAUDE_MEM_REDACT_ENABLED==="true",disabledBuiltinPatterns:(r.CLAUDE_MEM_REDACT_DISABLED_BUILTINS??"").split(",").map(e=>e.trim()).filter(Boolean),customPatterns:ir(r.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS??"[]"),logMatches:r.CLAUDE_MEM_REDACT_LOG_MATCHES==="true",genericEnabled:r.CLAUDE_MEM_REDACT_GENERIC_ENABLED==="true"}}var pe=null,ms=0,_r=5e3,me=null,Ts=!1,dr={enabled:!0,disabledBuiltinPatterns:[],customPatterns:[],logMatches:!1},Er=/"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;function cr(r){if(!(0,xe.existsSync)(r))return null;try{return(0,xe.readFileSync)(r,"utf-8")}catch{return""}}function lr(r){if(r===null)return!1;try{let e=JSON.parse(ce(r));return e===null||typeof e!="object"||Array.isArray(e)}catch{return!0}}function ur(r,e,t){return process.env.CLAUDE_MEM_REDACT_ENABLED==="false"||!(me?.enabled===!0||Er.test(e))?t:(Ts||(Ts=!0,l.warn("REDACT","settings.json could not be read; secret redaction stays on until it is repaired",{settingsPath:r,using:me?.enabled?"the last configuration that loaded":"the built-in patterns"})),me?.enabled?me:dr)}function Se(r=Ce){let e=Date.now();if(pe&&e-ms<_r)return pe;let t=ae.loadFromFile(r),s=ar(t),n=s.enabled?null:cr(r);return lr(n)?pe=ur(r,n,s):(pe=s,me=s),ms=e,pe}var pr=/(?:password|passwd)$|\w_pwd$/i,mr=/(?:^|_)(?:secret|token|api_key)$/i,Tr=new RegExp(`^${Te}{8,}$`);function Sr(r,e,t){if(!t.genericEnabled)return null;let s=pr.test(r)?"generic_password":mr.test(r)?"generic_token":null;return!s||t.disabledBuiltinPatterns?.includes(s)||!Tr.test(e)||!/[A-Za-z]/.test(e)?null:`<redacted type='${s}'/>`}var Ss=/^(?:proxy-)?authorization$/i,gr=new RegExp(`^(${x}Bearer${x})${Y}`,"i");function Ar(r,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("bearer_token")||!Ss.test(r))return null;let s=gr.exec(e);return s?`${s[1]}<redacted type='bearer_token'/>${e.slice(s[0].length)}`:null}var Rr=new RegExp(`^(${x}Basic${x})${Y}`,"i");function Nr(r,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("basic_auth")||!Ss.test(r))return null;let s=Rr.exec(e);return s?`${s[1]}<redacted type='basic_auth'/>${e.slice(s[0].length)}`:null}var fr=/^(?:aws_session_token|SessionToken)$/i,Or=/^[A-Za-z0-9/+=]{100,}$/;function hr(r,e,t){return t.disabledBuiltinPatterns?.includes("aws_session_token")||!fr.test(r)||!Or.test(e)?null:"<redacted type='aws_session_token'/>"}var br=/^(?:aws_secret_access_key|SecretAccessKey)$/i,Lr=/^[A-Za-z0-9/+=]{40}$/;function Ir(r,e,t){return t.disabledBuiltinPatterns?.includes("aws_secret_key")||!br.test(r)||!Lr.test(e)?null:"<redacted type='aws_secret_key'/>"}function gs(r,e=Se()){if(!e.enabled)return r;let t=(s,n)=>{if(typeof s=="string"){let i=_e(s,e);return n===void 0||Object.keys(i.counts).length>0?i.redacted:hr(n,s,e)??Ir(n,s,e)??Ar(n,s,e)??Nr(n,s,e)??Sr(n,s,e)??i.redacted}return Array.isArray(s)?s.map(i=>t(i)):s!==null&&typeof s=="object"?Object.fromEntries(Object.entries(s).map(([i,o])=>[i,t(o,i)])):s};return t(r)}var Cr=1024*1024,_t="<redacted type='diagnostic_budget'/>";function As(r,e=Se()){if(!e.enabled)return r;let t=5e4,s=(i,o=[])=>{if(!o.length)return _e(i,e).redacted;for(let a of o){let _=gs({[a]:i},e)[a];if(_!==i)return _}return i},n=(i,o,a=[])=>{if(o>32||--t<0)return _t;if(typeof i=="string"){if(i.length>Cr)return _e(i,e).redacted;try{let _=JSON.parse(i);if(_!==null&&(typeof _=="object"||typeof _=="string")){let d=n(_,o+1,a),E=JSON.stringify(d);if(E!==JSON.stringify(_))return E}}catch{}return s(i,a)}if(Array.isArray(i))return i.length>t?_t:i.map(_=>n(_,o+1,a));if(i&&typeof i=="object"){let _=Object.entries(i);return _.length>t?_t:Object.fromEntries(_.map(([d,E])=>[s(d,a),n(E,o+1,[d,...a])]))}return i};return n(r,0)}var _i=Object.freeze({maxImagesPerEvent:4,maxSourceBytes:3145728,maxCanonicalBytes:3145728,maxPixels:24e6,maxDimension:8192,conversionTimeoutSeconds:5,maxConcurrentConversions:1,maxDerivativeBytes:262144,maxDerivativeDimension:1536,maxInlineEncodedBytes:4194304,maxObservationRefs:32,maxLabelChars:64,maxManifestBytes:8192,maxProvenanceBytes:8192,maxSourceLocatorChars:4096,maxGatewayImageBytes:1048576,maxUploadBodyBytes:3211264,ownerQuotaBytes:268435456});var Rs=4096;var Dr=new Set(["set_title","set_prompt_session","remap_project"]),Mr=/^(?:0|[1-9][0-9]*)$/,Ns=18446744073709551615n;function w(r){let e=As(r);throw l.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:e}),new Error(`canonical content: ${e}`)}function Ae(r,e={}){return typeof r!="string"||!Mr.test(r)?w("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(r)>Ns&&w("decimal value exceeds uint64"),e.positive&&r==="0"&&w("decimal value must be positive"),r)}function Be(r){let e=Ae(r);return BigInt(e)===Ns&&w("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function yr(r){(r===null||typeof r!="object"||Array.isArray(r))&&w("mutation must be an object");let e=r;if((typeof e.op!="string"||!Dr.has(e.op))&&w("unsupported mutation op"),e.op==="set_title"){let i=ge(e,["fields","op","target"],"set_title"),o=Pe(i.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");o.memory_session_id===void 0&&o.content_session_id===void 0&&w("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])o[_]!==void 0&&q(o[_],_);let a=ge(i.fields,["custom_title"],"set_title.fields");q(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let i=ge(e,["fields","op","target"],"set_prompt_session"),o=ge(i.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");vr(o.origin_device_id),Ae(o.origin_local_id);let a=Pe(i.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");q(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&q(a[_],_);return}let t=ge(e,["fields","op","where"],"remap_project"),s=Pe(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&q(s.project,"project"),s.memory_session_id!==void 0&&q(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&w("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&w("remap_project where is empty");let n=Pe(t.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&q(n.project,"project"),n.merged_into_project!==void 0&&q(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&w("remap_project fields are empty")}function dt(r){yr(r)}function vr(r){return typeof r!="string"||r.length===0||Buffer.byteLength(r,"utf8")>128?w("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):r}function q(r,e){return typeof r!="string"||r.length===0||r.trim().length===0||Buffer.byteLength(r,"utf8")>Rs?w(`${e} must be a non-blank string of at most ${Rs} UTF-8 bytes`):r}function ge(r,e,t){if(r===null||typeof r!="object"||Array.isArray(r))return w(`${t} must be an object`);let s=r,n=Object.keys(s).sort(),i=[...e].sort();return(n.length!==i.length||n.some((o,a)=>o!==i[a]))&&w(`${t} must contain exactly: ${i.join(", ")}`),s}function Pe(r,e,t){if(r===null||typeof r!="object"||Array.isArray(r))return w(`${t} must be an object`);let s=r,n=new Set(e),i=Object.keys(s).find(o=>!n.has(o));return i&&w(`${t} contains unknown field ${i}`),s}var fs=r=>typeof r=="string"&&/^__my_work_v\d+:/.test(r);function Os(r,e){let t=i=>i.replace(/[A-Z]/g,o=>o.toLowerCase()),s=new Set(e.map(t)),n=e.at(-1);return r.map(i=>n&&s.has(t(i.project))?{...i,scope_project:n}:i)}function hs(r){r.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `),r.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)"),wr(r)}function wr(r){let e=new Set(r.query("PRAGMA table_info(work_state_entries)").all().map(t=>t.name));e.has("synced_at")||r.run("ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER"),e.has("origin_device_id")||r.run("ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT"),e.has("origin_local_id")||r.run("ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT"),e.has("sync_rev")||r.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'"),r.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL"),r.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `)}function bs(r,e){let t=e.createdAtEpoch??Date.now(),s=r.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(e.project,e.listName,JSON.stringify(e.fields),new Date(t).toISOString(),t),n=Number(s.lastInsertRowid);return l.debug("DB","Work state entry appended",{id:n,project:e.project,listName:e.listName}),n}function Ls(r,e,t,s=""){if(e.length===0)return[];let n=e.map(()=>"?").join(", "),i=t===void 0?"":" AND list_name = ?",o=r.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${n})${i}
    ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)
  `);try{return o.all(...e,...t===void 0?[]:[t],s).filter(_=>!fs(_.list_name)).map(_=>({..._,fields:JSON.parse(_.fields)}))}finally{o.finalize()}}var ys=require("crypto");function Re(r){let e=(r??"").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu," ").replace(/\s+/g," ").trim();return/[\p{L}\p{N}]/u.test(e)?e:""}function ee(r){return(r??"").toLowerCase().trim().split(/\s+/).filter(Boolean)}function Et(r,e){return Math.log(1+e/(r+.5))}function Is(r,e){return t=>Et(r(t),e)}function Cs(r,e){let t=new Map;for(let s of new Set(r))t.set(s,e(s));return t}function Ds(r,e,t){let s=Cs(r,t),n=Cs(e,t),i=0,o=0,a=0;for(let[_,d]of s){o+=d*d;let E=n.get(_);E!==void 0&&(i+=d*E)}for(let[,_]of n)a+=_*_;return o===0||a===0?0:i/Math.sqrt(o*a)}function Ms(r,e,t,s){let n=new Set(r),i=new Set(e);for(let o of n)if(!i.has(o)&&t(o)>s)return!0;for(let o of i)if(!n.has(o)&&t(o)>s)return!0;return!1}function ct(r,e,t,s){let n=Re(r);if(n!==""&&n===Re(e))return{tier:"exact",method:"exact",score:1};let i=ee(r),o=ee(e),a=s.minSharedTokens??2,_=new Set(o),d=0;for(let c of new Set(i))_.has(c)&&d++;if(d<a)return{tier:"none",method:"none",score:0};let E=Ds(i,o,t);return E>=s.cosineThreshold&&!Ms(i,o,t,s.vetoThetaIdf)?{tier:"candidate",method:"idf_cosine",score:E}:{tier:"none",method:"none",score:E}}function Ne(r,e){return!!r&&!!e}function He(r,e,t,s=!1){let n=Re(t);if(n==="")return null;let i=O(e),o=s?"subagent":"main";return(0,ys.createHash)("sha256").update(`${r}\0${i}\0${o}\0${n}`).digest("hex").slice(0,32)}function vs(r,e,t){return t===null?null:r.prepare("SELECT id, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC LIMIT 1").get(e,t)??null}function Us(r,e,t){let s=[...new Set(ee(t))],n=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1");for(let i of s)n.run(e,i);r.prepare("INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1").run(e)}function ws(r,e){return Et(r+1,e)}function ks(r,e){return r.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(e)?.doc_count??0}function Fs(r,e){let t=ks(r,e),s=r.prepare("SELECT token, df FROM token_df WHERE project = ?").all(e),n=new Map(s.map(i=>[i.token,i.df]));return{idfFn:Is(i=>n.get(i)??0,t),docCount:t}}function xs(r){return r.prepare("INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")}function Ps(r,e,t){return ks(r,e)>=t}function kr(r,e,t=Number.POSITIVE_INFINITY){let s=r.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(e).c;if(s>t)return l.warn("DEDUP",`Skipping dedup backfill for project ${e}: ${s} rows exceeds cap ${t} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`),0;let n=r.prepare("SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?").all(e),i=r.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?"),o=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)");return r.transaction(()=>{let _=new Map;for(let d of n){i.run(He(e,d.platform_source,d.title,Ne(d.agent_id,d.agent_type)),d.id);for(let E of new Set(ee(d.title)))_.set(E,(_.get(E)??0)+1)}r.prepare("DELETE FROM token_df WHERE project = ?").run(e);for(let[d,E]of _)o.run(e,d,E);r.prepare("INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0").run(e,n.length,n.length)})(),n.length}function Fr(r,e,t){let s=r.prepare("SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC").all(e);if(s.length<2)return 0;if(s.length>t.maxBackfillRows)return l.warn("DEDUP",`Skipping dedup sweep for project ${e}: ${s.length} rows exceeds cap ${t.maxBackfillRows}`),0;let{idfFn:n,docCount:i}=Fs(r,e),o={cosineThreshold:t.cosineThreshold,vetoThetaIdf:ws(t.idfVetoDf,i),minSharedTokens:t.minSharedTokens},a=s.map(R=>new Set(ee(R.title))),_=new Map;for(let R of a)for(let I of R)_.set(I,(_.get(I)??0)+1);let d=Math.max(2,Math.ceil(Math.sqrt(s.length))*4),E=new Map;a.forEach((R,I)=>{for(let f of R){let T=_.get(f);if(T<2||T>d)continue;let M=E.get(f);M||(M=[],E.set(f,M)),M.push(I)}});let c=new Map;for(let R of E.values())for(let I=0;I<R.length;I++)for(let f=I+1;f<R.length;f++){let T=`${R[I]}:${R[f]}`;c.set(T,(c.get(T)??0)+1)}let u=xs(r),p=new Date().toISOString(),m=Date.now(),b=0;for(let[R,I]of c){if(I<t.minSharedTokens)continue;let[f,T]=R.split(":").map(Number),M=ct(s[f].title,s[T].title,n,o);M.tier==="candidate"&&(b+=u.run(s[T].id,s[f].id,e,M.method,M.score,"pending",p,m).changes)}return b}function Bs(r,e){return r.prepare("SELECT DISTINCT project FROM observations").all().map(s=>s.project).map(s=>{let n=kr(r,s,e.maxBackfillRows),i=Fr(r,s,e);return{project:s,docs:n,candidates:i}})}function Hs(r,e,t,s,n){if(!s)return 0;let{idfFn:i,docCount:o}=Fs(r,e),a={cosineThreshold:n.cosineThreshold,vetoThetaIdf:ws(n.idfVetoDf,o),minSharedTokens:n.minSharedTokens},_=r.prepare("SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?").all(e,t,n.maxScan);_.length===n.maxScan&&l.debug("DEDUP",`Tier-1 scan hit MAX_SCAN=${n.maxScan} for project ${e}; older rows covered by dedup-scan`);let d=xs(r),E=new Date().toISOString(),c=Date.now(),u=0;for(let p of _){let m=ct(s,p.title,i,a);m.tier==="candidate"&&(u+=d.run(t,p.id,e,m.method,m.score,"pending",E,c).changes)}return u}function $s(r,e,t,s,n){let i=Date.now()-s,o=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return r.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${S}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${o}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,t,i)??void 0}var Gs=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],xr=new Set(Gs),Xs=/<([A-Za-z_][A-Za-z0-9_-]*)/y,js=/<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;function Pr(r){let e=Object.fromEntries(Gs.map(E=>[E,0]));if(!r.includes("<"))return{text:r,counts:e,total:0};let t=r.length,s=new Int32Array(t+1);s[t]=t;for(let E=t-1;E>=0;E--)s[E]=r.charCodeAt(E)===62?E:s[E+1];let n=new Map,i=[],o=0,a=0;for(;a<t;){if(r.charCodeAt(a)!==60){a+=1;continue}js.lastIndex=a;let E=js.exec(r);if(E){let u=E[1],p=n.get(u),m=p&&p.head<p.items.length?p.items[p.head]:void 0;m&&a>=m.attrEnd&&(p.head+=1,i.push([m.start,a+E[0].length]),e[u]+=1,o+=1),a+=E[0].length;continue}Xs.lastIndex=a;let c=Xs.exec(r);if(c&&xr.has(c[1])){let u=c[1],p=a+c[0].length,m={start:a,attrEnd:s[p]},b=n.get(u);b?b.items.push(m):n.set(u,{items:[m],head:0}),a=p;continue}a+=1}i.sort((E,c)=>E[0]-c[0]);let _="",d=0;for(let[E,c]of i)E>d&&(_+=r.slice(d,E)),c>d&&(d=c);return _+=r.slice(d),{text:_,counts:e,total:o}}var Ws=100;function Br(r){return Hr(r,Pr(r))}function Hr(r,{text:e,counts:t,total:s}){return s>Ws&&l.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:Ws,contentLength:r.length}),{stripped:_e(e.trim(),Se()).redacted,counts:t}}function $e(r){return Br(r).stripped}var $r=["task-notification"],ji=new RegExp(`^\\s*<(${$r.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Wi=256*1024;var lt=4e3,ut="[media prompt]";function te(r){let e=$e(r).trim();return e.length<=lt?e:(l.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:e.length,storedLength:lt}),`${e.slice(0,lt-1)}\u2026`)}var Xr=require("bun:sqlite");var Ks=5e3,jr=4194304,Ee=71;function Vs(r){return r.prepare("PRAGMA user_version").get().user_version}var fe=class extends Error{reason="schema_newer_than_binary";constructor(e){super(e),this.name="SchemaNewerThanBinaryError"}};function Oe(r,e){r.run(`PRAGMA busy_timeout = ${Ks}`);let t=Vs(r);if(!(t<=e))throw new fe(`SQLite database has schema v${t}; this claude-mem knows up to schema v${e}. Upgrade claude-mem before opening this database.`)}function pt(r,e){Oe(r,e),Vs(r)<e&&r.run(`PRAGMA user_version = ${e}`)}function Ys(r,e){r.transaction(()=>pt(r,e)).immediate()}function Wr(r){return r.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function de(r,e,t){try{r.run(e)}catch(s){let n=s instanceof Error?s:new Error(String(s));throw l.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},n),s}}function Xe(r,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;de(r,`PRAGMA busy_timeout = ${Ks}`,"busy_timeout"),de(r,"PRAGMA foreign_keys = ON","foreign_keys"),de(r,"PRAGMA synchronous = NORMAL","synchronous"),de(r,`PRAGMA journal_size_limit = ${jr}`,"journal_size_limit"),s&&!Wr(r)&&de(r,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&de(r,"PRAGMA journal_mode = WAL","journal_mode")}var qs=!1;function he(r,...e){return typeof r.iterate=="function"?r.iterate(...e):(qs||(qs=!0,l.warn("DB","bun:sqlite lacks Statement.iterate(); falling back to .all()",{bunVersion:typeof Bun<"u"?Bun.version:"unknown",requiredBunVersion:">=1.1.31",impact:"rows are materialized in memory; upgrade Bun to restore streaming"})),r.all(...e))}function mt(r,e,t,s){try{let n=Number(s.limit);if(!Number.isInteger(n)||n<0)throw new Error("Page limit must be a non-negative integer");let i=Number(s.offset??0);if(!Number.isInteger(i))throw new Error("Page offset must be an integer");let o=[];if(n===0)return o;let a=Math.max(0,i);for(let _ of he(r,...e))if(t(_)){if(a>0){a--;continue}if(o.push(_),o.length===n)break}return o}finally{r.finalize()}}function Tt(r){let e=`a.id IN (${r.candidateAttachmentIdsSql})
      AND a.state!='deleted'
      AND NOT EXISTS (SELECT 1 FROM media_event_refs r
        WHERE r.attachment_id=a.id AND NOT (${r.eventRefsBeingRemovedSql}))
      AND NOT EXISTS (SELECT 1 FROM observation_media_links l
        WHERE l.attachment_id=a.id AND NOT (${r.observationLinksBeingRemovedSql}))`;return[`INSERT OR IGNORE INTO media_cleanup_jobs (attachment_id, directory, queued_at)
      SELECT a.id, a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${e}`,`INSERT OR IGNORE INTO media_cloud_deletions (attachment_id, queued_at)
      SELECT a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${e}
        AND a.origin='native' AND (a.upload_state='uploaded' OR a.upload_attempts>0)`,`UPDATE media_attachments SET state='deleted', upload_state='cancelled'
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${e})`]}var We="SELECT event_key FROM media_events WHERE session_db_id=OLD.id",Gr=Tt({candidateAttachmentIdsSql:"SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id",eventRefsBeingRemovedSql:"0",observationLinksBeingRemovedSql:"l.observation_id=OLD.id"}),Kr=Tt({candidateAttachmentIdsSql:`SELECT attachment_id FROM media_event_refs WHERE event_key IN (${We})`,eventRefsBeingRemovedSql:`r.event_key IN (${We})`,observationLinksBeingRemovedSql:"0"}),Zi=Tt({candidateAttachmentIdsSql:"SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey",eventRefsBeingRemovedSql:"r.event_key=$eventKey",observationLinksBeingRemovedSql:"0"});function Js(r){r.transaction(()=>{r.exec(`
      CREATE TABLE IF NOT EXISTS media_events (
        event_key TEXT PRIMARY KEY, session_db_id INTEGER NOT NULL,
        platform TEXT NOT NULL, event_identity TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'retained' CHECK(state IN ('retained','deleted')),
        result_state TEXT NOT NULL DEFAULT 'unprocessed' CHECK(result_state IN ('unprocessed','stored','skipped')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_events_session ON media_events(session_db_id);
      CREATE TABLE IF NOT EXISTS media_attachments (
        id TEXT PRIMARY KEY, replay_key TEXT NOT NULL UNIQUE, provenance TEXT NOT NULL,
        recipe TEXT NOT NULL CHECK(recipe IN ('screenshot-v1','photo-v1')),
        state TEXT NOT NULL CHECK(state IN ('converting','ready','failed','deleted')),
        failure_code TEXT, encoder_version TEXT, variants TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        upload_state TEXT NOT NULL DEFAULT 'pending' CHECK(upload_state IN ('pending','uploaded','failed','cancelled')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_event_refs (
        event_key TEXT NOT NULL, attachment_id TEXT NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY(event_key,attachment_id), UNIQUE(event_key,label),
        FOREIGN KEY(event_key) REFERENCES media_events(event_key),
        FOREIGN KEY(attachment_id) REFERENCES media_attachments(id)
      );
      CREATE TABLE IF NOT EXISTS observation_media_links (
        observation_id INTEGER NOT NULL, attachment_id TEXT NOT NULL, event_key TEXT NOT NULL,
        label TEXT NOT NULL, inspection TEXT NOT NULL DEFAULT 'uninspected'
          CHECK(inspection IN ('inspected','uninspected')),
        PRIMARY KEY(observation_id,attachment_id),
        FOREIGN KEY(attachment_id) REFERENCES media_attachments(id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_links_attachment ON observation_media_links(attachment_id);
      CREATE TABLE IF NOT EXISTS media_cleanup_jobs (
        attachment_id TEXT PRIMARY KEY, directory TEXT NOT NULL,
        queued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_refs_attachment ON media_event_refs(attachment_id);
      -- v70: durable source-event -> observation result mapping, written in the
      -- storeObservations transaction so a replayed event recovers its committed
      -- result without another model call.
      CREATE TABLE IF NOT EXISTS media_event_results (
        event_key TEXT NOT NULL, observation_id INTEGER NOT NULL,
        PRIMARY KEY(event_key, observation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_results_observation ON media_event_results(observation_id);
      -- v71: durable cloud media deletions (offline-safe). Drained by
      -- MediaCloudSync; a row survives restarts and reconnects.
      CREATE TABLE IF NOT EXISTS media_cloud_deletions (
        attachment_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `),je(r,"origin","TEXT NOT NULL DEFAULT 'native'"),je(r,"upload_attempts","INTEGER NOT NULL DEFAULT 0"),je(r,"upload_retry_at","INTEGER NOT NULL DEFAULT 0"),je(r,"upload_error","TEXT"),r.exec("CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)"),r.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${Gr.join(`;
        `)};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${Kr.join(`;
        `)};
        DELETE FROM media_event_refs WHERE event_key IN (${We});
        DELETE FROM media_event_results WHERE event_key IN (${We});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);let e=new Date().toISOString();r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(69,e),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(70,e),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(71,e)})()}function je(r,e,t){r.prepare("PRAGMA table_info(media_attachments)").all().some(n=>n.name===e)||r.exec(`ALTER TABLE media_attachments ADD COLUMN ${e} ${t}`)}var Rt=require("bun:sqlite");function se(r){return r.replace(/\\/g,"/").replace(/\/+/g,"/").replace(/\/+$/,"")}function St(r,e){let t=se(r),s=se(e);if(t.startsWith(s+"/"))return!t.slice(s.length+1).includes("/");let n=s.split("/"),i=t.split("/");if(i.length<2)return s===""||s===".";let o=i.slice(0,-1).join("/"),a=i[i.length-1],_=/^([A-Za-z]:)?\//;if(!_.test(s)&&_.test(t)&&s!==""&&o.endsWith("/"+s))return a!=="";if(s.endsWith("/"+o)||s===o)return!a.includes("/");for(let d=0;d<n.length;d++)if(n.slice(d).join("/")===o)return!0;return!1}var Ge=class extends Error{constructor(t,s=500,n,i){super(t);this.statusCode=s;this.code=n;this.details=i;this.name="AppError"}statusCode;code;details};var Vr=/^\d{4}-\d{2}-\d{2}$/,Yr=/^(\d{4})-(\d{2})-(\d{2})/,qr=/^\d{5,}$/,Jr=1440*60*1e3;function ne(r,e){if(typeof r=="number")return gt(r,r,e);let t=r.trim();if(qr.test(t))return gt(Number(t),r,e);let s=zr(t)?new Date(t).getTime():Number.NaN,n=gt(s,r,e);return e==="end"&&Vr.test(t)?n+Jr-1:n}function zr(r){let e=Yr.exec(r);if(!e)return!0;let[t,s,n]=e.slice(1).map(Number),i=new Date(0);return i.setUTCFullYear(t,s-1,n),i.getUTCFullYear()===t&&i.getUTCMonth()===s-1&&i.getUTCDate()===n}function gt(r,e,t){if(Number.isNaN(new Date(r).getTime()))throw new Ge(`Invalid date for the ${t} of the range: ${JSON.stringify(e)}. Use an ISO date such as 2025-01-31 or 2025-01-31T08:00:00Z.`,400,"INVALID_DATE");return r}var At="\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF",zs=["observations_ai","observations_ad","observations_au"],Qs=["session_summaries_ai","session_summaries_ad","session_summaries_au"],be=`
  CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
  END;

  CREATE TRIGGER IF NOT EXISTS observations_au
  AFTER UPDATE OF title, subtitle, narrative, text, facts, concepts ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
    VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
  END;
`,Le=`
  CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
  END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_au
  AFTER UPDATE OF request, investigated, learned, completed, next_steps, notes ON session_summaries BEGIN
    INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
    INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
    VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
  END;
`,Zs=class r{db;constructor(e=De,t={}){e instanceof Rt.Database?this.db=e:(Me(D),this.db=new Rt.Database(e)),Oe(this.db,Ee),t.readOnly||Xe(this.db),this._fts5Available=this.isFts5Available(),t.readOnly||this.ensureFTSTables()}_fts5Available;ensureFTSTables(){let e=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),t=e.some(i=>i.name==="observations_fts"),s=e.some(i=>i.name==="session_summaries_fts");if(t&&s&&this.hasAllFtsTriggers(zs)&&this.hasAllFtsTriggers(Qs))return;if(!this.isFts5Available()){l.warn("DB","FTS5 not available on this platform \u2014 skipping FTS table creation (search uses ChromaDB)");return}let n=t&&s;l.info("DB",n?"Converging FTS5 indexes and recreating missing sync triggers":"Creating FTS5 tables");try{this.db.transaction(()=>{pt(this.db,Ee);let i=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),o=!i.some(E=>E.name==="observations_fts"),a=!i.some(E=>E.name==="session_summaries_fts"),_=!o&&!this.hasAllFtsTriggers(zs),d=!a&&!this.hasAllFtsTriggers(Qs);this.createFTSTablesAndTriggers(o,a),_&&(this.rebuildFtsIndex("observations_fts"),this.db.run(be)),d&&(this.rebuildFtsIndex("session_summaries_fts"),this.db.run(Le))}).immediate(),l.info("DB",n?"FTS5 indexes converged and sync triggers recreated":"FTS5 tables created successfully")}catch(i){if(i instanceof fe)throw i;this._fts5Available=!1,l.warn("DB","FTS5 table creation failed \u2014 search will use ChromaDB and LIKE queries",{},i instanceof Error?i:void 0)}}hasAllFtsTriggers(e){let t=e.map(()=>"?").join(", ");return this.db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${t})`).all(...e).length===e.length}rebuildFtsIndex(e){this.db.run(`INSERT INTO ${e}(${e}) VALUES('rebuild')`)}isFts5Available(){try{return this.db.run("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(test_column)"),this.db.run("DROP TABLE temp._fts5_probe"),!0}catch(e){return l.debug("DB","FTS5 probe failed \u2014 FTS5 unavailable on this platform",void 0,e instanceof Error?e:new Error(String(e))),!1}}canReadFtsIndex(e){try{return this.db.prepare(`SELECT rowid FROM ${e} WHERE ${e} MATCH ? LIMIT 0`).all('"fts_read_probe"'),!0}catch{return!1}}createFTSTablesAndTriggers(e,t){e&&(this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title,
          subtitle,
          narrative,
          text,
          facts,
          concepts,
          content='observations',
          content_rowid='id'
        );
      `),this.db.run(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `),this.db.run(be)),t&&(this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request,
          investigated,
          learned,
          completed,
          next_steps,
          notes,
          content='session_summaries',
          content_rowid='id'
        );
      `),this.db.run(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `),this.db.run(Le))}buildFilterClause(e,t,s="o"){let n=[],i=P(e);if(i.length>0){let o=H(s,i,{includeMerged:!0});n.push(o.sql),t.push(...o.params)}if(e.platformSource&&(n.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = ${s}.memory_session_id), ''), '${S}') = ?`),t.push(O(e.platformSource))),e.type)if(Array.isArray(e.type)){let o=e.type.map(()=>"?").join(",");n.push(`${s}.type IN (${o})`),t.push(...e.type)}else n.push(`${s}.type = ?`),t.push(e.type);if(e.dateRange){let{start:o,end:a}=e.dateRange;o&&(n.push(`${s}.created_at_epoch >= ?`),t.push(ne(o,"start"))),a&&(n.push(`${s}.created_at_epoch <= ?`),t.push(ne(a,"end")))}if(e.concepts){let o=Array.isArray(e.concepts)?e.concepts:[e.concepts],a=`${s}.concepts`,_=`CASE WHEN json_valid(${a}) THEN CASE
        WHEN json_type(${a}) = 'array' THEN ${a}
        WHEN json_type(${a}) = 'text' THEN json_array(json_extract(${a}, '$'))
        ELSE json_array(${a}) END ELSE json_array(${a}) END`,d=o.map(()=>`EXISTS (SELECT 1 FROM json_each(${_}) WHERE type = 'text' AND value = ?)`);d.length>0&&(n.push(`(${d.join(" OR ")})`),t.push(...o))}if(e.files){let o=Array.isArray(e.files)?e.files:[e.files],a=s==="s"?"files_edited":"files_modified",_=o.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${r.fileArrayJson(`${s}.files_read`)}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(${r.fileArrayJson(`${s}.${a}`)}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\')
        )`);_.length>0&&(n.push(`(${_.join(" OR ")})`),o.forEach(d=>{let E=d.replace(/[\\%_]/g,"\\$&");t.push(`%${E}%`,`%${E}%`)}))}return n.length>0?n.join(" AND "):""}static UNSEGMENTED_SCRIPT=new RegExp(`[${At}]`);static UNSEGMENTED_RUN=new RegExp(`[${At}]+|[^\\s${At}]+`,"g");static MAX_SUBSTRING_TERMS=500;static buildSubstringClause(e,t){let s=[...new Set(e.match(r.UNSEGMENTED_RUN)??[])].slice(0,r.MAX_SUBSTRING_TERMS);s.length===0&&s.push(e);let n=[];return{clause:`(${s.map(o=>{let a=`%${o.replace(/[\\%_]/g,"\\$&")}%`;for(let _=0;_<t.length;_+=1)n.push(a);return`(${t.map(_=>`${_} LIKE ? ESCAPE '\\'`).join(" OR ")})`}).join(" AND ")})`,params:n}}static MIN_ANY_TERM_TOKENS=3;static buildFTSMatchQuery(e){let t=(e.match(/\S+/g)??[]).filter(s=>/[\p{L}\p{N}]/u.test(s));return t.length===0?`"${e.replace(/"/g,'""')}"`:t.map(s=>`"${s.replace(/"/g,'""')}"`).join(" AND ")}buildFTSAnyTermQuery(e,t){let s=(e.match(/\S+/g)??[]).filter(a=>/[\p{L}\p{N}]/u.test(a));if(s.length<r.MIN_ANY_TERM_TOKENS)return null;let n=this.termDocFrequency(t),i=[...e].length,o;return n?i<r.ANY_TERM_SHORT_PROMPT_CHARS?o=r.pickRareTokens(s,n,r.ANY_TERM_SHORT_PROMPT_CAP):i<r.ANY_TERM_MEDIUM_PROMPT_CHARS?o=r.pickRareTokens(s,n,r.ANY_TERM_MEDIUM_PROMPT_CAP):o=r.pickRareWords(e,n):o=r.dedupeTokens(s).slice(0,r.ANY_TERM_LONG_PROMPT_CAP),o.length===0?null:o.map(a=>`"${a.replace(/"/g,'""')}"`).join(" OR ")}static ANY_TERM_SHORT_PROMPT_CHARS=200;static ANY_TERM_MEDIUM_PROMPT_CHARS=600;static ANY_TERM_SHORT_PROMPT_CAP=40;static ANY_TERM_MEDIUM_PROMPT_CAP=60;static ANY_TERM_LONG_PROMPT_CAP=40;static ANY_TERM_COMMON_SHARE=.3;static ANY_TERM_MATCHING_DOCUMENT_BUDGET=1024;static ANY_TERM_LONG_PROMPT_MAX_SHARE=.02;static ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS=3;static ANY_TERM_CONTENT_TABLES={observations_fts:"observations",session_summaries_fts:"session_summaries"};vocabLookups=new Map;termDocFrequency(e){if(!this.vocabLookups.has(e)){let s=null;try{this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${e}_vocab USING fts5vocab(main, '${e}', 'row')`),s=this.db.prepare(`SELECT doc FROM temp.${e}_vocab WHERE term = ?`)}catch(n){l.debug("DB","FTS5 vocabulary unavailable; any-term queries are capped without frequencies",{ftsTable:e},n instanceof Error?n:void 0)}this.vocabLookups.set(e,s)}let t=this.vocabLookups.get(e);if(!t)return null;try{let s=r.ANY_TERM_CONTENT_TABLES[e],n=this.db.prepare(`SELECT count(*) AS n FROM ${s}`).get().n,i=new Map;return{rows:a=>{let _=a.toLowerCase().normalize("NFD").replace(new RegExp("\\p{Mn}","gu"),""),d=i.get(_);return d===void 0&&(d=t.get(_)?.doc??0,i.set(_,d)),d},total:n}}catch(s){return l.debug("DB","FTS5 vocabulary lookup failed; any-term queries are capped without frequencies",{ftsTable:e},s instanceof Error?s:void 0),this.vocabLookups.set(e,null),null}}static tokenRows(e,t){let s=e.match(/[\p{L}\p{N}]+/gu)??[];return s.length===0?0:Math.min(...s.map(n=>t.rows(n)))}static commonRowLimit(e,t){return Math.max(e*t,2)}static dedupeTokens(e){let t=new Set;return e.filter(s=>{let n=s.toLowerCase();return t.has(n)?!1:(t.add(n),!0)})}static pickRareTokens(e,t,s){let n=r.commonRowLimit(t.total,r.ANY_TERM_COMMON_SHARE),i=r.dedupeTokens(e),o=i.filter(c=>r.tokenRows(c,t)<n),a=o.length<=s?o:o.map(c=>({token:c,rows:r.tokenRows(c,t)})).sort((c,u)=>c.rows-u.rows).slice(0,s).map(c=>c.token);if(a.some(c=>r.tokenRows(c,t)>0))return a;let _=[...a],d=0,E=i.map(c=>({token:c,rows:r.tokenRows(c,t)})).filter(c=>c.rows>=n).sort((c,u)=>c.rows-u.rows);for(let{token:c,rows:u}of E){if(_.length===s)break;let p=/[^\x00-\x7F]/.test(c)?t.total:u;d+p>r.ANY_TERM_MATCHING_DOCUMENT_BUDGET||(_.push(c),d+=p)}return _}static pickRareWords(e,t){let s=r.commonRowLimit(t.total,r.ANY_TERM_LONG_PROMPT_MAX_SHARE),n=new Set((e.match(/[\p{L}\p{N}]+/gu)??[]).filter(o=>[...o].length>=r.ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS).map(o=>o.toLowerCase())),i=[];for(let o of n){let a=t.rows(o);if(a>0&&a<s&&(i.push(o),i.length===r.ANY_TERM_LONG_PROMPT_CAP))break}return i}buildOrderClause(e="relevance",t=!0,s="observations_fts"){switch(e){case"relevance":return t?`ORDER BY ${s}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC, o.id DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC, o.id ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservationsBySubstring(e,t,s,n,i){let o=r.buildSubstringClause(e,["o.title","o.subtitle","o.narrative","o.text","o.facts","o.concepts"]),a=[],_=this.buildFilterClause(t,a,"o"),d=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${o.clause}
      ${_?"AND "+_:""}
      ${this.buildOrderClause(s,!1)}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(d).all(...o.params,...a,n,i)}searchSessionsBySubstring(e,t,s,n,i){let o=r.buildSubstringClause(e,["s.request","s.investigated","s.learned","s.completed","s.next_steps","s.notes"]),a={...t};delete a.type;let _=[],d=this.buildFilterClause(a,_,"s"),E=s==="date_asc"?"ORDER BY s.created_at_epoch ASC, s.id ASC":"ORDER BY s.created_at_epoch DESC, s.id DESC",c=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${o.clause}
      ${d?"AND "+d:""}
      ${E}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(c).all(...o.params,..._,n,i)}searchObservations(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="relevance",...a}=t;if(!e){let _=this.buildFilterClause(a,s,"o");if(!_)return[];let d=this.buildOrderClause(o,!1),E=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${_}
        ${d}
        LIMIT ? OFFSET ?
      `;return s.push(n,i),this.db.prepare(E).all(...s)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchObservationsBySubstring(e,a,o,n,i);if(this._fts5Available||this.canReadFtsIndex("observations_fts")){let _=this.buildFilterClause(a,s,"o"),d=this.buildOrderClause(o,!0,"observations_fts"),E=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        JOIN observations_fts ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
        ${_?"AND "+_:""}
        ${d}
        LIMIT ? OFFSET ?
      `;s.unshift(r.buildFTSMatchQuery(e));let c;try{c=this.db.prepare(E).all(...s,n,i)}catch(p){throw l.warn("DB","FTS5 observation search failed",{},p instanceof Error?p:void 0),p}if(c.length>0||i>0&&this.db.prepare(E).all(...s,1,0).length>0)return c;let u=this.searchObservationsBySubstring(e,a,o,n,i);return u.length>0||i>0&&this.searchObservationsBySubstring(e,a,o,1,0).length>0?u:this.searchFtsAnyTerm(E,e,s,n,i,"observations_fts")??u}return this.searchObservationsBySubstring(e,a,o,n,i)}searchSessions(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="relevance",...a}=t;if(!e){let _={...a};delete _.type;let d=this.buildFilterClause(_,s,"s");if(!d)return[];let c=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${d}
        ${o==="date_asc"?"ORDER BY s.created_at_epoch ASC, s.id ASC":"ORDER BY s.created_at_epoch DESC, s.id DESC"}
        LIMIT ? OFFSET ?
      `;return s.push(n,i),this.db.prepare(c).all(...s)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchSessionsBySubstring(e,a,o,n,i);if(this._fts5Available||this.canReadFtsIndex("session_summaries_fts")){let _={...a};delete _.type;let d=this.buildFilterClause(_,s,"s"),E=o==="date_asc"?"ORDER BY s.created_at_epoch ASC, s.id ASC":o==="date_desc"?"ORDER BY s.created_at_epoch DESC, s.id DESC":"ORDER BY session_summaries_fts.rank ASC",c=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id
        WHERE session_summaries_fts MATCH ?
        ${d?"AND "+d:""}
        ${E}
        LIMIT ? OFFSET ?
      `;s.unshift(r.buildFTSMatchQuery(e));let u;try{u=this.db.prepare(c).all(...s,n,i)}catch(m){throw l.warn("DB","FTS5 session search failed",{},m instanceof Error?m:void 0),m}if(u.length>0||i>0&&this.db.prepare(c).all(...s,1,0).length>0)return u;let p=this.searchSessionsBySubstring(e,a,o,n,i);return p.length>0||i>0&&this.searchSessionsBySubstring(e,a,o,1,0).length>0?p:this.searchFtsAnyTerm(c,e,s,n,i,"session_summaries_fts")??p}return this.searchSessionsBySubstring(e,a,o,n,i)}searchFtsAnyTerm(e,t,s,n,i,o){let a=this.buildFTSAnyTermQuery(t,o);if(!a)return null;let _=[a,...s.slice(1)],d=this.db.prepare(e).all(..._,n,i);return d.length>0||i>0&&this.db.prepare(e).all(..._,1,0).length>0?d:null}findByConcept(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",...a}=t,_={...a,concepts:e},d=this.buildFilterClause(_,s,"o"),E=this.buildOrderClause(o,!1),c=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${d}
      ${E}
      LIMIT ? OFFSET ?
    `;return s.push(n,i),this.db.prepare(c).all(...s)}hasDirectChildFile(e,t){let s=n=>{if(!n)return!1;try{let i=JSON.parse(n);if(Array.isArray(i))return i.some(o=>typeof o=="string"&&St(o,t))}catch(i){l.debug("DB",`Failed to parse files JSON for observation ${e.id}`,void 0,i instanceof Error?i:void 0)}return!1};return s(e.files_modified)||s(e.files_read)}hasDirectChildFileSession(e,t){let s=n=>{if(!n)return!1;try{let i=JSON.parse(n);if(Array.isArray(i))return i.some(o=>typeof o=="string"&&St(o,t))}catch(i){l.debug("DB",`Failed to parse files JSON for session summary ${e.id}`,void 0,i instanceof Error?i:void 0)}return!1};return s(e.files_read)||s(e.files_edited)}static filePathPatterns(e,t){if(t&&se(e)===".")return["%"];let s=_=>_.replace(/[\\%_]/g,"\\$&"),n=[e,se(e),se(e).replaceAll("/","\\")],i=[...new Set(n)].map(_=>`%${s(_)}%`);if(!t||!/^([A-Za-z]:)?[\\/]/.test(e))return i;let o=se(e).split("/").filter(_=>_.length>0),a=/^[A-Za-z]:$/.test(o[0]??"")?1:0;for(let _=a;_<o.length;_+=1){let d=o.slice(_);i.push(`${s(d.join("/")+"/")}%`),i.push(`${s(d.join("\\")+"\\")}%`)}return i}static fileArrayJson(e){return`CASE WHEN json_valid(${e}) THEN CASE WHEN json_type(${e}) = 'array' THEN ${e} ELSE '[]' END ELSE '[]' END`}static jsonArrayLikeClause(e,t){let s=Array.from({length:t},()=>"type = 'text' AND value LIKE ? ESCAPE '\\'").join(" OR ");return`(${e.map(n=>`EXISTS (SELECT 1 FROM json_each(${r.fileArrayJson(n)}) WHERE ${s})`).join(" OR ")})`}findByFile(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",isFolder:a=!1,..._}=t;delete _.files;let d=a?"":"LIMIT ? OFFSET ?",E=r.filePathPatterns(e,a),c=this.buildFilterClause(_,s,"o");s.push(...E,...E);let u=[c,r.jsonArrayLikeClause(["o.files_read","o.files_modified"],E.length)].filter(Boolean).join(" AND "),p=`${this.buildOrderClause(o,!1)}, o.id ${o==="date_asc"?"ASC":"DESC"}`,m=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${u}
      ${p}
      ${d}
    `;a||s.push(n,i);let b=this.db.prepare(m),R=a?mt(b,s,N=>this.hasDirectChildFile(N,e),{limit:n,offset:i}):b.all(...s),I=[],f={..._};delete f.type;let T=[],M=P(f);if(M.length>0){let N=H("s",M,{includeMerged:!0});T.push(N.sql),I.push(...N.params)}if(f.platformSource&&(T.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = s.memory_session_id), ''), '${S}') = ?`),I.push(O(f.platformSource))),f.dateRange){let{start:N,end:A}=f.dateRange;N&&(T.push("s.created_at_epoch >= ?"),I.push(ne(N,"start"))),A&&(T.push("s.created_at_epoch <= ?"),I.push(ne(A,"end")))}T.push(r.jsonArrayLikeClause(["s.files_read","s.files_edited"],E.length)),I.push(...E,...E);let G=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${T.join(" AND ")}
      ORDER BY s.created_at_epoch ${o==="date_asc"?"ASC":"DESC"}
      ${d}
    `;a||I.push(n,i);let g=this.db.prepare(G),v=a?mt(g,I,N=>this.hasDirectChildFileSession(N,e),{limit:n,offset:i}):g.all(...I);return{observations:R,sessions:v}}findByType(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",...a}=t,_={...a,type:e},d=this.buildFilterClause(_,s,"o"),E=this.buildOrderClause(o,!1),c=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${d}
      ${E}
      LIMIT ? OFFSET ?
    `;return s.push(n,i),this.db.prepare(c).all(...s)}searchUserPrompts(e,t={}){let s=[],{limit:n=20,offset:i=0,orderBy:o="relevance",...a}=t,_=[],d=P(a);if(d.length>0){let m=H("s",d,{includeMerged:!1});_.push(m.sql),s.push(...m.params)}if(a.platformSource&&(_.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),s.push(O(a.platformSource))),a.dateRange){let{start:m,end:b}=a.dateRange;m&&(_.push("up.created_at_epoch >= ?"),s.push(ne(m,"start"))),b&&(_.push("up.created_at_epoch <= ?"),s.push(ne(b,"end")))}if(!e){if(_.length===0)return[];let m=`WHERE ${_.join(" AND ")}`,R=`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        ${m}
        ${o==="date_asc"?"ORDER BY up.created_at_epoch ASC, up.id ASC":"ORDER BY up.created_at_epoch DESC, up.id DESC"}
        LIMIT ? OFFSET ?
      `;return s.push(n,i),this.db.prepare(R).all(...s)}let E=e.replace(/[\\%_]/g,"\\$&");_.push("up.prompt_text LIKE ? ESCAPE '\\'"),s.push(`%${E}%`);let c=`WHERE ${_.join(" AND ")}`,p=`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ${c}
      ${o==="date_asc"?"ORDER BY up.created_at_epoch ASC, up.id ASC":"ORDER BY up.created_at_epoch DESC, up.id DESC"}
      LIMIT ? OFFSET ?
    `;return s.push(n,i),this.db.prepare(p).all(...s)}close(){this.db.close()}};var en=`(SELECT id, rev,
  CASE WHEN json_type(candidate, '$.fields') = 'object' AND CASE json_extract(candidate, '$.op')
    WHEN 'set_title' THEN json_type(candidate, '$.target') = 'object'
    WHEN 'set_prompt_session' THEN json_type(candidate, '$.target') = 'object'
    WHEN 'remap_project' THEN json_type(candidate, '$.where') = 'object'
    ELSE 0 END THEN candidate ELSE NULL END AS mutation
  FROM (SELECT id, CAST(rev AS TEXT) AS rev,
    CASE WHEN canonical_body IS NOT NULL THEN CASE WHEN json_valid(canonical_body) THEN
      CASE WHEN json_type(canonical_body, '$.mutation') = 'object'
        THEN json_extract(canonical_body, '$.mutation') END END
      ELSE CASE WHEN json_valid(body) THEN
        CASE WHEN json_type(body) = 'object' THEN body END END
      END AS candidate FROM sync_outbox))`,Qr=`(SELECT * FROM ${en} ORDER BY id LIMIT 1)`;var Ke=r=>`CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.${r}') END`,Zr={kind:"o.kind",localId:"o.origin_local_id",rev:"o.entity_rev",deleted:"o.deleted",project:Ke("project"),memory:Ke("memory_session_id"),content:Ke("content_session_id"),merged:Ke("merged_into_project")};function tn(r){r.run(`CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
    id TEXT PRIMARY KEY, preview_token TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
    scope_json TEXT NOT NULL, epoch TEXT, status TEXT NOT NULL, pause_reason TEXT,
    created_at_epoch INTEGER NOT NULL, updated_at_epoch INTEGER NOT NULL)`),r.run(`CREATE TABLE IF NOT EXISTS sync_recovery_items (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, origin_local_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    selected_rev TEXT NOT NULL, selected_sha256 TEXT NOT NULL, estimated_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'selected', queued_rev TEXT, queued_sha256 TEXT, queued_epoch TEXT,
    acknowledged_epoch TEXT, detail TEXT, updated_at_epoch INTEGER NOT NULL,
    PRIMARY KEY(job_id, kind, origin_local_id))`),r.query("PRAGMA table_info(sync_recovery_items)").all().some(t=>t.name==="queued_epoch")||r.run("ALTER TABLE sync_recovery_items ADD COLUMN queued_epoch TEXT"),r.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_selection ON sync_recovery_items(job_id, status, kind, origin_local_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_entity_revision ON sync_recovery_items(entity_id, queued_rev, queued_sha256)"),r.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_jobs_active ON sync_recovery_jobs(device_id, status, created_at_epoch)"),r.run(`CREATE TABLE IF NOT EXISTS sync_recovery_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL, operation_sha256 TEXT NOT NULL, epoch TEXT, event TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL)`)}var on=5*6e4,sn=`
  CREATE TABLE IF NOT EXISTS sync_entity_heads (
    entity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_device_id TEXT NOT NULL,
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    updated_at_epoch INTEGER NOT NULL
  )`,nn=`
  CREATE TABLE IF NOT EXISTS sync_content_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    body TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at_epoch INTEGER NOT NULL,
    UNIQUE(entity_id, entity_rev)
  )`,rn=`
  CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    through_rev TEXT NOT NULL,
    PRIMARY KEY (kind, origin_local_id)
  )`,h=r=>typeof r=="object"&&r!==null?JSON.stringify(r):r??null;function an(r){let e=[],t=[],s=new Set,n=new Set;for(let i of r){for(let o of i.files_read??[])!o||s.has(o)||(s.add(o),e.push(o));for(let o of i.files_modified??[])!o||n.has(o)||(n.add(o),t.push(o))}return{files_read:e,files_edited:t}}var eo=200,to=1e3,so=56,no=57;function Nt(r){let e=Number(r);return Number.isSafeInteger(e)&&e>0?e:void 0}var Ot=class{db;syncOpsEnabled;statementCache=new Map;localSyncDeviceId="";constructor(e=De,t={}){this.syncOpsEnabled=t.syncOpsEnabled??!0,e instanceof ft.Database?this.db=e:(e!==":memory:"&&Me(D),this.db=new ft.Database(e)),Oe(this.db,Ee),Xe(this.db),Ys(this.db,Ee),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable(),this.ensureTelegramWrapupsTable(),this.addDedupTables(),this.refreshUnicodeTitleNormKeys(),this.ensureReinforcementColumns(),this.ensureSessionCwdColumn(),this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(),this.ensureProjectNocaseIndexes(),this.ensureAdvisorCallsTable(),this.ensureSessionProjectKeySourceColumn(),this.requeuePromptsDeadLetteredForSize(),this.ensureWorkStateTable(),this.ensureDeliverablesTable(),this.ensureHookSpoolConsumedTable(),this.ensureProjectRecencyIndexes(),this.ensureMergedIntoProjectCoveringIndexes(),this.ensureNativePromptIdentity(),this.ensureObservationFileIndex(),Js(this.db)}ensureObservationFileIndex(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 68").get())return;this.db.run(`CREATE TABLE IF NOT EXISTS observation_files (
        path TEXT NOT NULL,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        PRIMARY KEY (path, observation_id)
      )`),this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_files_observation ON observation_files(observation_id)");let e=t=>`SELECT o.id, je.value FROM observations o, json_each(o.${t}) je
         WHERE json_valid(o.${t}) AND json_type(o.${t}) = 'array' AND je.type = 'text'`;this.db.run(`INSERT OR IGNORE INTO observation_files(observation_id, path)
        ${e("files_read")} UNION ${e("files_modified")}`),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(68,new Date().toISOString())}).immediate()}indexObservationFiles(e,t,s){let n=new Set;for(let o of[...t,...s])typeof o=="string"&&o.length>0&&n.add(o);if(n.size===0)return;let i=this.db.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let o of n)i.run(o,e)}ensureNativePromptIdentity(){this.db.transaction(()=>{let e=this.db.query("PRAGMA table_info(user_prompts)").all();for(let t of["native_prompt_id","native_prompt_hash"])e.some(s=>s.name===t)||this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${t} TEXT`);this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_native_identity
        ON user_prompts(session_db_id, native_prompt_id) WHERE native_prompt_id IS NOT NULL`)}).immediate()}refreshUnicodeTitleNormKeys(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 65").get())return;let e=this.db.prepare(`SELECT o.id, o.project, o.title, o.agent_id, o.agent_type,
        s.platform_source FROM observations o LEFT JOIN sdk_sessions s
        ON s.memory_session_id = o.memory_session_id ORDER BY o.id`),t=this.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?");try{for(let s of he(e)){let n=s;t.run(He(n.project,n.platform_source,n.title,Ne(n.agent_id,n.agent_type)),n.id)}this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(65,new Date().toISOString())}finally{e.finalize(),t.finalize()}}).immediate()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let i=this.getIndexColumns(n.name);return i.length===t.length&&i.every((o,a)=>o===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let n=s?O(s):void 0;return n?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(S,n,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${S}')
        WHEN '${S}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}addDedupTables(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(t=>t.name==="occurrence_count")||this.db.run("ALTER TABLE observations ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1"),e.some(t=>t.name==="title_norm_key")||this.db.run("ALTER TABLE observations ADD COLUMN title_norm_key TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_title_norm ON observations(project, title_norm_key)"),this.db.run(`
      CREATE TABLE IF NOT EXISTS token_df (
        project TEXT    NOT NULL,
        token   TEXT    NOT NULL,
        df      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project, token)
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS dedup_meta (
        project                TEXT    PRIMARY KEY,
        doc_count              INTEGER NOT NULL DEFAULT 0,
        last_rebuild_doc_count INTEGER NOT NULL DEFAULT 0,
        deleted_since_rebuild  INTEGER NOT NULL DEFAULT 0
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_dedup_candidates (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id   INTEGER NOT NULL,
        duplicate_of_id  INTEGER NOT NULL,
        project          TEXT    NOT NULL,
        method           TEXT    NOT NULL CHECK(method IN ('exact', 'idf_cosine')),
        score            REAL    NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending'
                                 CHECK(status IN ('pending', 'merged', 'distinct', 'dismissed')),
        created_at       TEXT    NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        metadata         TEXT,
        FOREIGN KEY (observation_id)  REFERENCES observations(id) ON DELETE CASCADE,
        FOREIGN KEY (duplicate_of_id) REFERENCES observations(id) ON DELETE CASCADE,
        UNIQUE(observation_id, duplicate_of_id)
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(so,new Date().toISOString())}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),l.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){l.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),i=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source");if(!(e&&!t&&s&&i)){if(i||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${S}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let a=o instanceof Error?o:new Error(String(o));throw l.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),o}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${S}',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed')),
        worker_port INTEGER,
        prompt_counter INTEGER DEFAULT 0,
        custom_title TEXT
      )
    `),this.db.run(`
      INSERT INTO sdk_sessions_new (
        id, content_session_id, memory_session_id, project, platform_source,
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      )
      SELECT
        id, content_session_id, memory_session_id, project,
        COALESCE(NULLIF(platform_source, ''), '${S}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),o=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&n&&!o)return;let a=n?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${S}')
            WHEN '${S}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${S}')
            WHEN '${S}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let d=_ instanceof Error?_:new Error(String(_));throw l.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},d),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,t){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
      CREATE TABLE user_prompts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO user_prompts_new (
        id, session_db_id, content_session_id, prompt_number,
        prompt_text, created_at, created_at_epoch
      )
      SELECT
        up.id,
        ${t},
        up.content_session_id,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let i=n instanceof Error?n:new Error(String(n));throw l.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},i),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `),this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(n=>n.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),l.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let t=this.db.query(`PRAGMA table_info(${e})`).all(),s=new Set(t.map(n=>n.name));s.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),l.debug("DB",`Added origin_device_id column to ${e} table`)),s.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),l.debug("DB",`Added origin_local_id column to ${e} table`)),s.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),l.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_${e}_origin
        ON ${e}(origin_device_id, origin_local_id)
        WHERE origin_device_id IS NOT NULL
      `)}this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_state (
        k TEXT PRIMARY KEY,
        v TEXT
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(41,new Date().toISOString())}ensureSyncOutbox(){this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_uuid TEXT NOT NULL UNIQUE,
        rev TEXT NOT NULL DEFAULT '1',
        body TEXT NOT NULL,
        canonical_body TEXT,
        operation_sha256 TEXT,
        created_at_epoch INTEGER NOT NULL
      )
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(o,a)=>this.db.query(`PRAGMA table_info(${o})`).all().find(_=>_.name===a),s=o=>o?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(o=>s(t(o.table,o.column))))return;this.db.transaction(()=>{for(let o of e){let a=this.db.query(`PRAGMA table_info(${o.table})`).all(),_=a.find(E=>E.name===o.column);if(!_)throw new Error(`schema v46: missing ${o.table}.${o.column}`);for(let E of he(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${o.column}) AS storage_type,
                 CAST(${o.column} AS TEXT) AS revision
          FROM ${o.table}
        `))){let c=E;if(c.storage_type==="real")throw new Error(`schema v46: ${o.table}.${o.column} row ${c.row_id} is REAL and unrecoverably rounded`);if(c.storage_type!=="integer"&&c.storage_type!=="text")throw new Error(`schema v46: ${o.table}.${o.column} row ${c.row_id} has unsupported ${c.storage_type} storage`);try{Ae(c.revision,{positive:!0})}catch{throw new Error(`schema v46: ${o.table}.${o.column} row ${c.row_id} is not a positive canonical uint64 revision`)}}if(s(_))continue;if(a.some(E=>E.name===o.temporary))throw new Error(`schema v46: unexpected temporary column ${o.table}.${o.temporary}`);this.db.run(`ALTER TABLE ${o.table} ADD COLUMN ${o.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${o.table} SET ${o.temporary} = CAST(${o.column} AS TEXT)`);let d=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${o.table}
          WHERE ${o.temporary} <> CAST(${o.column} AS TEXT)
          LIMIT 1
        `).get();if(d)throw new Error(`schema v46: failed to copy ${o.table}.${o.column} row ${d.row_id} exactly`);this.db.run(`ALTER TABLE ${o.table} DROP COLUMN ${o.column}`),this.db.run(`ALTER TABLE ${o.table} RENAME COLUMN ${o.temporary} TO ${o.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){tn(this.db),this.db.run(sn),this.widenSyncKindCheck("sync_entity_heads",sn),this.db.run(nn),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(t=>t.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `)),this.widenSyncKindCheck("sync_content_outbox",nn),this.db.run("CREATE INDEX IF NOT EXISTS idx_sync_content_outbox_kind_pending ON sync_content_outbox(kind, deleted DESC, id)"),this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL CHECK (lane IN ('content', 'mutation')),
        queue_key TEXT NOT NULL,
        kind TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(lane, queue_key, entity_rev, reason)
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_pull_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch TEXT NOT NULL,
        seq TEXT NOT NULL,
        kind TEXT,
        entity_id TEXT,
        origin_device_id TEXT,
        origin_local_id TEXT,
        entity_rev TEXT,
        operation_sha256 TEXT,
        reason TEXT NOT NULL,
        raw_body TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(epoch, seq)
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}widenSyncKindCheck(e,t){let s=this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(e);if(!s||s.sql.includes("'work_state'"))return;let n=this.db.query(`PRAGMA table_info(${e})`).all().map(o=>o.name).join(", "),i=`${e}_pre_work_state`;this.db.transaction(()=>{this.db.run(`DROP TABLE IF EXISTS ${i}`),this.db.run(`ALTER TABLE ${e} RENAME TO ${i}`),this.db.run(t),this.db.run(`INSERT INTO ${e} (${n}) SELECT ${n} FROM ${i}`),this.db.run(`DROP TABLE ${i}`)}).immediate(),l.info("DB",`Rebuilt ${e} to admit the work_state sync kind`)}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],t=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!==void 0;this.db.run(rn),this.widenSyncKindCheck("sync_launch_exclusions",rn);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:E,kind:c}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${E}
            WHERE origin_device_id IS NULL
          `).run(c),this.db.prepare(`
            UPDATE ${E} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let d=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,d),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,d)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&t)return;let i=Date.parse(s.applied_at);if(!Number.isSafeInteger(i)||i<0)throw new Error(`schema v48: invalid v47 applied_at ${s.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:_}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(_,i);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}normalizeConceptTags(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49))return;let t=0;this.db.transaction(()=>{let n=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM observations
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `).all();t=n.length,this.db.run(`
        UPDATE observations
        SET concepts = (
          SELECT json_group_array(
            CASE WHEN instr(value, ':') > 0
                 THEN trim(substr(value, 1, instr(value, ':') - 1))
                 ELSE value END)
          FROM json_each(observations.concepts))
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `);for(let i of n){if(i.origin_device_id!==null)continue;let o=Be(i.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,i.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),l.debug("DB",`Normalized prefixed concept tags in ${t} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(o=>o.name)),i=["retry_count","failed_at_epoch","completed_at_epoch"].filter(o=>s.has(o));if(!(e&&i.length===0)){if(i.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let o of i)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${o}`),l.debug("DB",`Dropped dead column ${o} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK"),l.warn("DB","Failed to drop dead columns from pending_messages",{},o instanceof Error?o:new Error(String(o)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),l.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),l.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),l.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),l.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}repairOrphanedSessionParents(e){let t=this.db.prepare(`
      SELECT COUNT(DISTINCT c.memory_session_id) AS n
      FROM ${e} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
    `).get().n;t!==0&&(this.db.run(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      SELECT
        c.memory_session_id,
        c.memory_session_id,
        MIN(c.project),
        MIN(c.created_at),
        MIN(c.created_at_epoch),
        'completed'
      FROM ${e} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
      GROUP BY c.memory_session_id
      ON CONFLICT DO NOTHING
    `),l.warn("DB",`Created ${t} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(s=>s.table==="sdk_sessions"&&s.from==="memory_session_id"&&s.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,t,s){let n=this.db.query(`PRAGMA table_info(${e})`).all(),i=n.filter(o=>!s.includes(o.name));for(let o of i){let a=o.type?` ${o.type}`:"",_=o.dflt_value===null||o.dflt_value===void 0?"":` DEFAULT ${o.dflt_value}`;this.db.run(`ALTER TABLE ${t} ADD COLUMN "${o.name}"${a}${_}`),l.debug("DB",`Carried ${o.name} over the ${e} rebuild (#3849)`)}return n.map(o=>o.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}l.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let s=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],i=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!s.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);for(let a of i){let _=a.type?` ${a.type}`:"",d=a.dflt_value===null||a.dflt_value===void 0?"":` DEFAULT ${a.dflt_value}`;this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${a.name}"${_}${d}`),l.debug("DB",`Carried ${a.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`)}let o=[...s,...i.map(a=>a.name)].map(a=>`"${a}"`).join(", ");this.db.run(`
      INSERT INTO session_summaries_new (${o})
      SELECT ${o}
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.recreateFtsTriggersIfIndexed("session_summaries"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),l.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}l.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),l.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}l.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `),this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `),this.recreateFtsTriggersIfIndexed("observations"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),l.debug("DB","Successfully made observations.text nullable")}recreateFtsTriggersIfIndexed(e){let t=`${e}_fts`;this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(t).length>0&&(this.db.run(`INSERT INTO ${t}(${t}) VALUES('rebuild')`),this.db.run(e==="observations"?be:Le))}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}l.debug("DB","Creating user_prompts table"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_session ON user_prompts(session_db_id);
      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number);
      CREATE INDEX idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),l.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}l.debug("DB","Creating pending_messages table"),this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),l.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;l.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,i,o)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),_=a.some(E=>E.name===i);return a.some(E=>E.name===o)?!1:_?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${i} TO ${o}`),l.debug("DB",`Renamed ${n}.${i} to ${o}`),!0):(l.warn("DB",`Column ${i} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?l.debug("DB",`Successfully renamed ${t} session ID columns`):l.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),l.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),t=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!t){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}l.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let s=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],n=`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,i=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,o=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","discovery_tokens","created_at","created_at_epoch"],a=`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,_=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(n,s,i)),t&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(a,o,_)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),l.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(d){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),d instanceof Error?d:new Error(String(d))}}recreateObservationsWithCascade(e,t,s){this.db.run(e);let i=this.carryLiveColumnsOntoNewTable("observations","observations_new",t).map(o=>`"${o}"`).join(", ");this.db.run(`INSERT INTO observations_new (${i}) SELECT ${i} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.recreateFtsTriggersIfIndexed("observations")}recreateSessionSummariesWithCascade(e,t,s){this.db.run(e);let i=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",t).map(o=>`"${o}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${i}) SELECT ${i} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.recreateFtsTriggersIfIndexed("session_summaries")}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),l.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),l.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),l.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${S}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),s=e.some(n=>n.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),t=e.some(n=>n.name==="observed_model"),s=e.some(n=>n.name==="observed_billing");t&&s||(t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){Jt(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString())}ensureDeliverablesTable(){ns(this.db)}recordDeliverable(e){return rs(this.db,e)}getDeliverable(e){return os(this.db,e)}ensureWorkStateTable(){hs(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(66,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(67,new Date().toISOString())}ensureProjectRecencyIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63,new Date().toISOString())}ensureMergedIntoProjectCoveringIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_project ON observations(merged_into_project COLLATE NOCASE, project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_project ON session_summaries(merged_into_project COLLATE NOCASE, project)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(64,new Date().toISOString())}ensureHookSpoolConsumedTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS hook_spool_consumed (
        entry_key TEXT PRIMARY KEY,
        consumed_at_epoch_ms INTEGER NOT NULL
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(62,new Date().toISOString())}isHookSpoolEntryConsumed(e){return this.db.prepare("SELECT 1 FROM hook_spool_consumed WHERE entry_key = ?").get(e)!=null}markHookSpoolEntryConsumed(e,t){this.db.prepare("INSERT INTO hook_spool_consumed (entry_key, consumed_at_epoch_ms) VALUES (?, ?) ON CONFLICT(entry_key) DO UPDATE SET consumed_at_epoch_ms = excluded.consumed_at_epoch_ms").run(e,t)}clearHookSpoolEntryConsumed(e){this.db.prepare("DELETE FROM hook_spool_consumed WHERE entry_key = ?").run(e)}pruneHookSpoolConsumedMarkersBefore(e){this.db.prepare("DELETE FROM hook_spool_consumed WHERE consumed_at_epoch_ms < ?").run(e)}ensureTelegramWrapupsTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS telegram_wrapups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        route_key TEXT NOT NULL,
        summary_created_at_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('claimed', 'sent')),
        claimed_at_epoch INTEGER NOT NULL,
        sent_at_epoch INTEGER,
        UNIQUE(platform_source, content_session_id, project, route_key)
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())}ensureReinforcementColumns(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(t=>t.name==="reinforcement_dates")||this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT"),e.some(t=>t.name==="last_reinforced")||this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(no,new Date().toISOString())}dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(){let e=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map(s=>s.name),t=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();if(e.length>0||t.length>0){this.db.run("BEGIN TRANSACTION");try{e.includes("observations_au")&&(this.db.run("DROP TRIGGER observations_au"),this.db.run(be)),e.includes("session_summaries_au")&&(this.db.run("DROP TRIGGER session_summaries_au"),this.db.run(Le)),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_fts"),this.db.run("COMMIT")}catch(s){throw this.db.run("ROLLBACK"),l.error("DB","Failed to scope FTS update triggers / drop user_prompts_fts, rolled back",{},s instanceof Error?s:new Error(String(s))),s}l.info("DB","Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts",{rescopedTriggers:e,droppedUserPromptsFts:t.length>0})}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}requeuePromptsDeadLetteredForSize(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60))return;let t="canonical content: body exceeds % UTF-8 bytes";this.db.transaction(()=>{let s=this.db.prepare(`
        UPDATE user_prompts SET synced_at = NULL
        WHERE synced_at = -1 AND origin_device_id IS NULL
          AND CAST(id AS TEXT) IN (
            SELECT origin_local_id FROM sync_dead_letter
            WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
          )
      `).run(t);this.db.prepare(`
        DELETE FROM sync_dead_letter WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
      `).run(t),s.changes>0&&l.info("DB","Re-queued prompts quarantined for size before the cloud-sync prompt clamp",{prompts:s.changes}),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(60,new Date().toISOString())})()}ensureSessionProjectKeySourceColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="project_key_source")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN project_key_source TEXT"),l.debug("DB","Added project_key_source column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(59,new Date().toISOString())}ensureSessionCwdColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="cwd")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN cwd TEXT"),l.debug("DB","Added cwd column to sdk_sessions table (#2864)")),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_cwd ON sdk_sessions(cwd)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(53,new Date().toISOString())}ensureProjectNocaseIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase ON observations(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase ON observations(merged_into_project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase ON session_summaries(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase ON session_summaries(merged_into_project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase ON sdk_sessions(project COLLATE NOCASE)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(55,new Date().toISOString())}ensureAdvisorCallsTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS advisor_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        advisor_model TEXT,
        cwd TEXT,
        last_user_message TEXT,
        transcript_path TEXT,
        transcript_byte_offset INTEGER,
        advice TEXT NOT NULL,
        occurred_at_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_calls_tool_use ON advisor_calls(tool_use_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_session ON advisor_calls(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_project ON advisor_calls(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_occurred ON advisor_calls(occurred_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(58,new Date().toISOString())}recordAdvisorCall(e){let t=new Date,s=this.db.prepare(`
      INSERT OR IGNORE INTO advisor_calls
      (session_db_id, content_session_id, project, platform_source, tool_use_id, advisor_model, cwd, last_user_message, transcript_path, transcript_byte_offset, advice, occurred_at_epoch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sessionDbId,e.contentSessionId,e.project,e.platformSource,e.toolUseId,e.advisorModel??null,e.cwd??null,e.lastUserMessage??null,e.transcriptPath??null,e.transcriptByteOffset??null,e.advice,e.occurredAtEpoch,t.toISOString(),t.getTime());return s.changes>0?{id:Number(s.lastInsertRowid),inserted:!0}:{id:this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(e.toolUseId)?.id??0,inserted:!1}}getAdvisorCalls(e,t,s,n){let i="SELECT * FROM advisor_calls",o=[],a=[];s?(a.push("project = ?"),o.push(s)):(a.push("project != ?"),o.push(ie)),n&&(a.push("platform_source = ?"),o.push(n)),i+=` WHERE ${a.join(" AND ")}`,i+=" ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?",o.push(t+1,e);let _=this.db.prepare(i).all(...o);return{items:_.slice(0,t),hasMore:_.length>t,offset:e,limit:t}}getAdvisorCallById(e){return this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(e)??null}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="agent_type"),n=t.some(o=>o.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let i=this.db.query("PRAGMA table_info(pending_messages)").all();if(i.length>0){let o=i.some(_=>_.name==="agent_type"),a=i.some(_=>_.name==="agent_id");o||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let i=n instanceof Error?n:new Error(String(n));throw l.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},i),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
      DELETE FROM pending_messages
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_db_id, tool_use_id
                      ORDER BY CASE status
                        WHEN 'processing' THEN 0
                        WHEN 'pending' THEN 1
                        ELSE 2
                      END, id
                    ) AS duplicate_rank
               FROM pending_messages
              WHERE tool_use_id IS NOT NULL
           )
          WHERE duplicate_rank > 1
         )
    `),this.db.run(`
      -- tool_use_id is optional for summaries and legacy rows; enforce de-dupe
      -- only for rows that came from a concrete tool-use event.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
      ON pending_messages(session_db_id, tool_use_id)
      WHERE tool_use_id IS NOT NULL
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="memory_session_id"),n=t.some(i=>i.name==="content_hash");if(!s||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let o=i instanceof Error?i:new Error(String(i));throw l.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},o),i}}dedupeObservationsByContentHash(){this.db.run(`
      UPDATE observations
         SET content_hash = '__null_migration_' || id || '__'
       WHERE content_hash IS NULL
    `),this.db.run(`
      DELETE FROM observations
       WHERE id IN (
         SELECT id
           FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY memory_session_id, content_hash
                      ORDER BY id
                    ) AS duplicate_rank
               FROM observations
           )
          WHERE duplicate_rank > 1
       )
    `),this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
      ON observations(memory_session_id, content_hash)
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),l.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){let s=this.db.prepare(`
      SELECT memory_session_id
      FROM sdk_sessions
      WHERE id = ?
    `).get(e);!s||s.memory_session_id===t||(this.db.transaction(()=>{this.db.prepare(`
        UPDATE sdk_sessions
        SET memory_session_id = ?
        WHERE id = ?
      `).run(t,e),this.db.prepare(`
        UPDATE tool_uses
        SET memory_session_id = ?
        WHERE session_db_id = ?
      `).run(t,e)})(),t&&this.requeuePromptSync(e))}enqueueMutationOp(e,t){if(!this.syncOpsEnabled)return;let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let n=s.target;n?.origin_device_id===null&&(n.origin_device_id="self")}dt(s),t.op==="set_prompt_session"&&this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(t.target?.origin_device_id??null,String(t.target?.origin_local_id??"")),this.cachedStatement(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,Ve.randomUUID)(),String(e),JSON.stringify(t),Date.now())}requeuePromptSync(e){if(!this.syncOpsEnabled)return;let t=this.cachedStatement(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let n=this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length===0)return;let i=this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);for(let o of n){let a=Be(o.sync_rev);i.run(a,o.id),this.enqueueMutationOp(a,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:o.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s,t,e)}reopenCompletedSession(e){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', completed_at = NULL, completed_at_epoch = NULL
      WHERE id = ? AND status = 'completed'
    `).run(e)}ensureMemorySessionIdRegistered(e,t,s){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);return n.memory_session_id===null?(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),this.requeuePromptSync(e),l.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,newId:t})):n.memory_session_id!==t&&l.debug("DB","Keeping the registered memory_session_id",{sessionDbId:e,registered:n.memory_session_id,offered:t}),typeof s=="number"&&n.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e),n.memory_session_id??t}getProjectReadKeys(e){return Bt(this.db,e)}getAllProjects(e){let t=e?O(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[ie];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",n.push(S,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...n).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${S}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${S}'), project
      ORDER BY latest_epoch DESC
    `).all(ie),t=[],s=new Set,n={};for(let o of e){let a=O(o.platform_source);n[a]||(n[a]=[]),n[a].includes(o.project)||n[a].push(o.project),s.has(o.project)||(s.add(o.project),t.push(o.project))}let i=Vt(Object.keys(n));return{projects:t,sources:i,projectsBySource:Object.fromEntries(i.map(o=>[o,n[o]||[]]))}}getSessionCatalog(e={}){let t=Math.min(Math.max(Math.trunc(e.limit??eo),1),to),s=Math.max(Math.trunc(e.offset??0),0),n=`
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source,
        s.custom_title,
        s.started_at_epoch,
        (
          (SELECT COUNT(*) FROM observations o WHERE o.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM session_summaries ss WHERE ss.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM user_prompts up WHERE up.session_db_id = s.id)
        ) as item_count
      FROM sdk_sessions s
      WHERE s.project IS NOT NULL AND s.project != ''
        AND s.project != ?
    `,i=[ie];e.project&&(n+=" AND s.project COLLATE NOCASE = ?",i.push(e.project)),e.platformSource&&(n+=` AND COALESCE(s.platform_source, '${S}') = ?`,i.push(O(e.platformSource))),n+=" ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?",i.push(t+1,s);let o=this.db.prepare(n).all(...i);return{sessions:o.slice(0,t),hasMore:o.length>t}}getUserPromptById(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ?
    `).get(e)}findRecentDuplicateUserPrompt(e,t,s,n){return $s(this.db,e,te(t),s,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let n=[e],i="";return s&&(i=`AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`,n.push(O(s))),n.push(t),this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project COLLATE NOCASE = ? AND s.memory_session_id IS NOT NULL
        ${i}
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(...n)}getObservationsForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?
        )
      `,s.push(O(t))),this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch ASC
    `).all(...s)}getObservationById(e,t){return t?this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?
    `).get(e,O(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return zt(this.db,e)}linkToolUsesToObservation(e){return Qt(this.db,e)}getToolUsesByIds(e,t={}){return es(this.db,e,t)}queryToolUses(e={}){return ts(this.db,e)}appendWorkStateEntry(e){let t=bs(this.db,e);return Q({projects:[e.project]},"appendWorkStateEntry","additive",{kinds:["work_state"],workStateLists:[e.listName]}),t}setLocalSyncDeviceId(e){this.localSyncDeviceId=e}getLocalSyncDeviceId(){return this.localSyncDeviceId}getWorkStateEntries(e,t){return Os(Ls(this.db,this.getProjectReadKeys(e),t,this.localSyncDeviceId),e)}countToolUses(e={}){return ss(this.db,e)}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n,type:i,concepts:o,files:a}=t,_=Nt(t.limit),d=P(t),E=s==="relevance",c=s==="date_asc"?"ASC":"DESC",u=E?"":`ORDER BY o.created_at_epoch ${c}, o.id ${c}`,p=_&&!E?"LIMIT ?":"",m=e.map(()=>"?").join(","),b=[...e],R=[];if(d.length>0){let g=H("o",d,{includeMerged:!0});R.push(g.sql),b.push(...g.params)}if(n&&(R.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),b.push(O(n))),i)if(Array.isArray(i)){let g=i.map(()=>"?").join(",");R.push(`o.type IN (${g})`),b.push(...i)}else R.push("o.type = ?"),b.push(i);if(o){let g=Array.isArray(o)?o:[o],v=`CASE WHEN json_valid(o.concepts) THEN CASE
        WHEN json_type(o.concepts) = 'array' THEN o.concepts
        WHEN json_type(o.concepts) = 'text' THEN json_array(json_extract(o.concepts, '$'))
        ELSE json_array(o.concepts) END ELSE json_array(o.concepts) END`,N=g.map(()=>`EXISTS (SELECT 1 FROM json_each(${v}) WHERE type = 'text' AND value = ?)`);N.length>0&&(b.push(...g),R.push(`(${N.join(" OR ")})`))}if(a){let g=Array.isArray(a)?a:[a],v=A=>`CASE WHEN json_valid(${A}) THEN CASE WHEN json_type(${A}) = 'array' THEN ${A} ELSE '[]' END ELSE '[]' END`,N=g.map(()=>`(EXISTS (SELECT 1 FROM json_each(${v("o.files_read")}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(${v("o.files_modified")}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\'))`);N.length>0&&(g.forEach(A=>{let F=A.replace(/[\\%_]/g,"\\$&");b.push(`%${F}%`,`%${F}%`)}),R.push(`(${N.join(" OR ")})`))}let I=R.length>0?`WHERE o.id IN (${m}) AND ${R.join(" AND ")}`:`WHERE o.id IN (${m})`;p&&b.push(_);let T=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${I}
      ${u}
      ${p}
    `).all(...b);if(!E)return T;let M=new Map(T.map(g=>[g.id,g])),G=e.map(g=>M.get(g)).filter(g=>!!g);return _?G.slice(0,_):G}getSummaryForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${S}') = ?
        )
      `,s.push(O(t))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch DESC, id DESC
      LIMIT 1
    `).get(...s)||null}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${S}') as platform_source,
             user_prompt, custom_title, status,
             observed_model, observed_billing
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}findSessionDbIdByContentSessionId(e,t){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
      LIMIT 1
    `).get(S,O(t),e)?.id??null}claimTelegramWrapup({platformSource:e,contentSessionId:t,project:s,routeKey:n,summaryCreatedAtEpoch:i}){let o=Date.now();return this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(O(e),t,s,n,i,o).changes===1?!0:this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(i,o,O(e),t,s,n,o-on).changes===1}markTelegramWrapupSent({platformSource:e,contentSessionId:t,project:s,routeKey:n}){this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(Date.now(),O(e),t,s,n)}releaseTelegramWrapupClaim({platformSource:e,contentSessionId:t,project:s,routeKey:n}){this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(O(e),t,s,n)}setSessionObservedMetadata(e,t,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(t||null,s||null,e)}getSdkSessionsBySessionIds(e,t=[]){if(e.length===0&&t.length===0)return[];let s=[...new Set(e),...new Set(t)],n=new Map;for(let i=0;i<s.length;i+=500){let o=s.slice(i,i+500),a=o.filter(c=>typeof c=="string"),_=o.filter(c=>typeof c=="number"),d=[];a.length&&d.push(`memory_session_id IN (${a.map(()=>"?").join(",")})`),_.length&&d.push(`id IN (SELECT session_db_id FROM user_prompts WHERE id IN (${_.map(()=>"?").join(",")}))`);let E=this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project,
               COALESCE(platform_source, '${S}') as platform_source,
               user_prompt, custom_title,
               started_at, started_at_epoch, completed_at, completed_at_epoch, status
        FROM sdk_sessions
        WHERE ${d.join(" OR ")}
        ORDER BY started_at_epoch DESC
      `);for(let c of E.all(...o))n.set(c.id,c)}return[...n.values()].sort((i,o)=>o.started_at_epoch-i.started_at_epoch)}getPromptNumberFromUserPrompts(e,t,s){let n=this.resolvePromptSessionDbId(e,t),i=n!==null?"session_db_id = ?":"content_session_id = ?",o=n!==null?n:e;return s!==void 0?this.db.prepare(`
        SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${i} AND created_at_epoch <= ?
      `).get(o,s).count:this.db.prepare(`
      SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${i}
    `).get(o).count}getLatestPromptTextFromUserPrompts(e,t){let s=this.resolvePromptSessionDbId(e,t),n=s!==null?"session_db_id = ?":"content_session_id = ?",i=s!==null?s:e;return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${n}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(i)?.prompt_text??null}createSDKSession(e,t,s,n,i){let o=new Date,a=o.getTime(),_=i?O(i):S,d=te(s);n&&this.validateSetTitleMutation(e,_,n);let E=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(S,_,e);if(E){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '' OR (project = 'unknown' AND cwd IS NULL))
        `).run(t,E.id),d&&d!==ut&&this.db.prepare(`
          UPDATE sdk_sessions SET user_prompt = ?
          WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
        `).run(d,E.id,ut),n){let u=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(E.id);u&&u.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,E.id),this.enqueueSetTitleOp(e,_,n))}return E.id}let c=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,_,d,n||null,o.toISOString(),a);return n&&this.enqueueSetTitleOp(e,_,n),Number(c.lastInsertRowid)}setSessionCwd(e,t,s){t.trim()&&this.db.prepare("UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL").run(t,s??null,e)}getSessionCwd(e){return this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(e)?.cwd??null}enqueueSetTitleOp(e,t,s){let n=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,t,s){let n={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return dt(n),n}promptCommitted(e,t){if(this.db.inTransaction)return;let s=t===null?null:this.db.prepare("SELECT project FROM sdk_sessions WHERE id = ?").get(t);Q(s?{projects:[s.project]}:"all",e,"additive",{kinds:["prompt"]})}saveUserPrompt(e,t,s,n,i,o,a){let _=new Date(a??Date.now()),d=_.getTime(),E=te(s),c=this.resolvePromptSessionDbId(e,n),p=this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id, native_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c,e,t,E,_.toISOString(),d,i??null,o??null);return this.promptCommitted("saveUserPrompt",c),p.lastInsertRowid}saveNativeUserPrompt(e,t,s,n,i=n,o={}){if(!s||s.length>256||/[\s\x00-\x1f\x7f]/.test(s))throw new Error("Invalid native prompt identity");let a=te(n),_=(0,Ve.createHash)("sha256").update($e(i).trim()).digest("hex"),d=this.db.transaction(()=>{let E=this.db.prepare(`SELECT id, prompt_number, native_prompt_hash FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id = ?`).get(t,s);if(E){if(E.native_prompt_hash!==_)throw new Error("Native prompt identity was reused with different text");return{id:E.id,promptNumber:E.prompt_number,duplicate:!0}}let c=this.getPromptNumberFromUserPrompts(e,t)+1;return o.reopenSession!==!1&&this.reopenCompletedSession(t),{id:this.saveUserPrompt(e,c,a,t,s,_,o.createdAtEpoch),promptNumber:c,duplicate:!1}}).immediate();return d.duplicate||this.promptCommitted("saveNativeUserPrompt",t),d}importTranscriptUserPrompt(e){let t=te(e.promptText);if(!t)return{reason:"private"};let s=O(e.platformSource),i=this.db.prepare(`SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?`).get(S,s,e.contentSessionId)?.id;if(i!==void 0){let a=[t,...(e.hookTextVariants??[]).map(te).filter(Boolean)],d=this.db.prepare(`SELECT id, created_at_epoch FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id IS NULL
          AND prompt_text IN (${a.map(()=>"?").join(", ")})
          AND ABS(created_at_epoch - ?) <= ?
        ORDER BY ABS(created_at_epoch - ?), id`).all(i,...a,e.createdAtEpoch,e.hookMatchWindowMs,e.createdAtEpoch).find(E=>!e.claimedHookRowIds.has(E.id));if(d)return e.claimedHookRowIds.add(d.id),{reason:"recorded-by-hook",hookRowId:d.id}}else{let a=new Date(e.createdAtEpoch).toISOString(),_=this.db.prepare(`INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'completed')`).run(e.contentSessionId,e.project,s,t,a,e.createdAtEpoch,a,e.createdAtEpoch);i=Number(_.lastInsertRowid)}return{reason:this.saveNativeUserPrompt(e.contentSessionId,i,`transcript:${e.nativePromptId}`,e.promptText,e.promptText,{createdAtEpoch:e.createdAtEpoch,reopenSession:!1}).duplicate?"already-imported":"new"}}listHookRecordedPrompts(e){return this.db.prepare(`SELECT up.id, COALESCE(NULLIF(s.platform_source, ''), ?) AS platformSource,
        s.content_session_id AS contentSessionId, s.project, s.cwd, up.prompt_text AS promptText, up.created_at_epoch AS createdAtEpoch
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
      WHERE up.created_at_epoch >= ? AND s.project != ?
        AND (up.native_prompt_id IS NULL OR up.native_prompt_id NOT LIKE 'transcript:%')
      ORDER BY up.created_at_epoch, up.id`).all(S,e,ie)}streamObservationTokenFields(){return he(this.db.prepare("SELECT title, subtitle, narrative, facts, discovery_tokens FROM observations ORDER BY id"))}getUserPrompt(e,t,s){let n=this.resolvePromptSessionDbId(e,s);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}dedupConfig(){let e=ae.loadFromFile(Ce),t=(n,i)=>{let o=Number(e[n]);return Number.isFinite(o)?o:i},s=(n,i)=>Math.trunc(t(n,i));return{enabled:e.CLAUDE_MEM_DEDUP_ENABLED==="true",cosineThreshold:t("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD",.8),idfVetoDf:s("CLAUDE_MEM_DEDUP_IDF_VETO_DF",10),minSharedTokens:s("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS",2),maxScan:s("CLAUDE_MEM_DEDUP_MAX_SCAN",2e3),maxBackfillRows:s("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS",5e4),minProjectDocs:s("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS",10)}}listDedupCandidates(e,t=100,s){let n="SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ",i="(? IS NULL OR c.status = ?) ",o="ORDER BY c.score DESC, c.id DESC LIMIT ?",a=s??null;return e?this.db.prepare(`${n}WHERE c.project = ? AND ${i}${o}`).all(e,a,a,t):this.db.prepare(`${n}WHERE ${i}${o}`).all(a,a,t)}resolveDedupCandidate(e,t){return this.db.prepare("UPDATE observation_dedup_candidates SET status = ? WHERE id = ?").run(t,e).changes>0}isDedupEnabled(){return this.dedupConfig().enabled}runDedupScan(){return Bs(this.db,this.dedupConfig())}maintainDedupOnInsert(e,t,s,n){Us(this.db,e,s),Ps(this.db,e,n.minProjectDocs)&&Hs(this.db,e,t,s,n)}storeObservation(e,t,s,n,i=0,o,a,_={}){if(!tt(s.title))throw new Error("storeObservation requires a non-empty title");let d=this.storeObservations(e,t,[s],null,n,i,o,a,_);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch,mergedIntoExisting:d.mergedIntoExisting[0]??!1}}storeSummary(e,t,s,n,i=0,o){let a=o??Date.now(),_=new Date(a).toISOString(),E=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,JSON.stringify(s.files_read??[]),JSON.stringify(s.files_edited??[]),s.notes,n||null,i,_,a);return Q({projects:[t]},"storeSummary"),{id:Number(E.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,i,o=0,a,_,d={}){let E=a??Date.now(),c=new Date(E).toISOString(),u=Kt(E),p=new Date(E),m=this.dedupConfig(),b=O(this.db.prepare("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(e)?.platform_source),I=this.db.transaction(()=>{let f=[],T=[],M=[],G=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),g=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let A of s){if(!tt(A.title)){l.debug("DB","Skipping observation with empty title");continue}let F=$t(e,A.title,A.narrative),K=He(t,b,A.title,Ne(A.agent_id,A.agent_type));if(m.enabled){let V=g.get(e,F);if(V){ve(this.db,V.id,p),f.push(V.id),T.push(!1);continue}let z=d.skipTitleDedup?null:vs(this.db,t,K);if(z){this.db.prepare("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(z.id),ve(this.db,z.id,p),f.push(z.id),T.push(!0);continue}}let y=G.get(e,t,A.type,A.title,A.subtitle,JSON.stringify(A.facts),A.narrative,JSON.stringify(A.concepts),JSON.stringify(A.files_read),JSON.stringify(A.files_modified),i||null,o,A.agent_type??null,A.agent_id??null,F,c,E,_||null,A.metadata??null,K,u.dates,u.lastReinforced);if(y){m.enabled&&this.maintainDedupOnInsert(t,y.id,A.title,m),this.indexObservationFiles(y.id,A.files_read,A.files_modified),f.push(y.id),T.push(!1),M.push(y.id);continue}let J=g.get(e,F);if(!J)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${F}`);ve(this.db,J.id,p),f.push(J.id),T.push(!1)}let v=null,N=!1;if(n){let A=an(s),F=n.files_read??A.files_read,K=n.files_edited??A.files_edited,y=i?this.db.prepare(`SELECT id, request, investigated, learned, completed, next_steps,
                      files_read, files_edited, notes, discovery_tokens, sync_rev
               FROM session_summaries
               WHERE memory_session_id = ? AND prompt_number = ? AND origin_device_id IS NULL
               ORDER BY id DESC LIMIT 1`).get(e,i):void 0;if(y){let J=n.request&&n.request.trim()?n.request:y.request??"",V=n.investigated&&n.investigated.trim()?n.investigated:y.investigated??"",z=n.learned&&n.learned.trim()?n.learned:y.learned??"",ht=n.completed&&n.completed.trim()?n.completed:y.completed??"",bt=n.next_steps??"",Lt=n.notes&&n.notes.trim()?n.notes:y.notes,It=[...new Set([...st(y.files_read),...F])],Ct=[...new Set([...st(y.files_edited),...K])],_n=Math.max(y.discovery_tokens??0,o),dn=Be(y.sync_rev||"0");this.db.prepare(`
            UPDATE session_summaries SET
              request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ?,
              files_read = ?, files_edited = ?, notes = ?, discovery_tokens = ?,
              created_at = ?, created_at_epoch = ?,
              sync_rev = ?, synced_at = NULL
            WHERE id = ?
          `).run(J,V,z,ht,bt,JSON.stringify(It),JSON.stringify(Ct),Lt,_n,c,E,dn,y.id),n.request=J,n.investigated=V,n.learned=z,n.completed=ht,n.next_steps=bt,n.notes=Lt,n.files_read=It,n.files_edited=Ct,v=y.id,N=!0}else{let V=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,JSON.stringify(F),JSON.stringify(K),n.notes,i||null,o,c,E);v=Number(V.lastInsertRowid)}}return{observationIds:f,mergedIntoExisting:T,insertedObservationIds:M,summaryId:v,createdAtEpoch:E,summaryUpdated:N}})();return Q({projects:[t]},"storeObservations"),I}updateDiscoveryTokens(e,t,s){e.length===0&&t===null||this.db.transaction(()=>{let n=this.db.prepare("UPDATE observations SET discovery_tokens = ? WHERE id = ?");for(let i of e)n.run(s,i);t!==null&&this.db.prepare("UPDATE session_summaries SET discovery_tokens = MAX(COALESCE(discovery_tokens, 0), ?) WHERE id = ?").run(s,t)})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n}=t,i=Nt(t.limit),o=P(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",d=a?"":`ORDER BY ss.created_at_epoch ${_}, ss.id ${_}`,E=i&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),u=[...e],p=[];if(o.length>0){let T=H("ss",o,{includeMerged:!0});p.push(T.sql),u.push(...T.params)}n&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),u.push(O(n)));let m=p.length>0?`AND ${p.join(" AND ")}`:"";E&&u.push(i);let R=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${m}
      ${d}
      ${E}
    `).all(...u);if(!a)return R;let I=new Map(R.map(T=>[T.id,T])),f=e.map(T=>I.get(T)).filter(T=>!!T);return i?f.slice(0,i):f}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n}=t,i=Nt(t.limit),o=P(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",d=a?"":`ORDER BY up.created_at_epoch ${_}, up.id ${_}`,E=i&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),u=[...e],p=[];if(o.length>0){let T=H("s",o,{includeMerged:!1});p.push(T.sql),u.push(...T.params)}n&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),u.push(O(n)));let m=p.length>0?`AND ${p.join(" AND ")}`:"";E&&u.push(i);let R=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${m}
      ${d}
      ${E}
    `).all(...u);if(!a)return R;let I=new Map(R.map(T=>[T.id,T])),f=e.map(T=>I.get(T)).filter(T=>!!T);return i?f.slice(0,i):f}getSearchScopeRowIds(e,t,s){let n=P(t),i=t.platformSource?O(t.platformSource):void 0,o=[e.observations&&{alias:"o",includeMerged:!0,from:"SELECT o.id FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id"},e.sessions&&{alias:"ss",includeMerged:!0,from:"SELECT ss.id FROM session_summaries ss LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id"},e.prompts&&{alias:"s",includeMerged:!1,from:"SELECT up.id FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id"}].filter(_=>!!_),a=new Set;for(let _ of o){let d=[],E=[];if(n.length>0){let m=H(_.alias,n,{includeMerged:_.includeMerged});d.push(m.sql),E.push(...m.params)}i&&(d.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),E.push(i));let c=d.length>0?`WHERE ${d.join(" AND ")}`:"",u=this.db.prepare(`${_.from} ${c} LIMIT ?`),p;try{p=u.all(...E,s+1)}finally{u.finalize()}for(let m of p)a.add(m.id);if(a.size>s)return null}return[...a]}getTimelineAroundTimestamp(e,t=10,s=10,n,i,o){return this.getTimelineAroundObservation(null,e,t,s,n,i,o)}getTimelineAroundObservation(e,t,s=10,n=10,i,o,a){let _=o?O(o):void 0,d=P({project:i,projects:a}),E=(g,v,N=!1)=>{let A=[],F=[];if(d.length>0){let K=H(g,d,{includeMerged:N});A.push(K.sql),F.push(...K.params)}return _&&(A.push(`COALESCE(NULLIF(${v}.platform_source, ''), '${S}') = ?`),F.push(_)),{clause:A.length>0?`AND ${A.join(" AND ")}`:"",params:F}},c=E("o","src",!0),u=E("ss","src",!0),p=E("s","s"),m,b;if(e!==null){let g=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) <= (?, ?) ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,v=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) >= (?, ?) ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let N=this.db.prepare(g).all(t,e,...c.params,s+1),A=this.db.prepare(v).all(t,e,...c.params,n+1);if(N.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};m=N.length>0?N[N.length-1].created_at_epoch:t,b=A.length>0?A[A.length-1].created_at_epoch:t}catch(N){return N instanceof Error?l.error("DB","Error getting boundary observations",{project:i},N):l.error("DB","Error getting boundary observations with non-Error",{},new Error(String(N))),{observations:[],sessions:[],prompts:[]}}}else{let g=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,v=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let N=this.db.prepare(g).all(t,...c.params,s),A=this.db.prepare(v).all(t,...c.params,n);m=N.length>0?N[N.length-1].created_at_epoch:t,b=A.length>0?A[A.length-1].created_at_epoch:t}catch(N){return N instanceof Error?l.error("DB","Error getting boundary timestamps",{project:i},N):l.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(N))),{observations:[],sessions:[],prompts:[]}}}let R=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${c.clause}
      ORDER BY o.created_at_epoch ASC, o.id ASC
    `,I=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${u.clause}
      ORDER BY ss.created_at_epoch ASC, ss.id ASC
    `,f=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${p.clause}
      ORDER BY up.created_at_epoch ASC, up.id ASC
    `,T=this.db.prepare(R).all(m,b,...c.params),M=this.db.prepare(I).all(m,b,...u.params),G=this.db.prepare(f).all(m,b,...p.params);return{observations:T,sessions:M.map(g=>({id:g.id,memory_session_id:g.memory_session_id,project:g.project,request:g.request,completed:g.completed,next_steps:g.next_steps,created_at:g.created_at,created_at_epoch:g.created_at_epoch})),prompts:G.map(g=>({id:g.id,content_session_id:g.content_session_id,prompt_number:g.prompt_number,prompt_text:g.prompt_text,project:g.project,platform_source:g.platform_source,created_at:g.created_at,created_at_epoch:g.created_at_epoch}))}}getOrCreateManualSession(e,t=S){let s=O(t),n=`manual-${e}-${s}`,i=`manual-content-${e}-${s}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(n))return n;let a=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(n,i,e,s,a.toISOString(),a.getTime()),l.info("SESSION","Created manual session",{memorySessionId:n,project:e,platformSource:s}),n}close(){this.db.close()}cachedStatement(e){let t=this.statementCache.get(e);return t||(t=this.db.prepare(e),this.statementCache.set(e,t)),t}importSdkSession(e){let t=O(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);if(s)return{imported:!1,id:s.id};let n=e.custom_title??null;if(n!==null&&typeof n!="string")throw new TypeError("Imported custom_title must be a string or null");let i=this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);return this.db.transaction(()=>({imported:!0,id:i.run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,n,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}))()}importSessionSummary(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return l.warn("DB","Skipping imported session summary without memory_session_id",{project:typeof e?.project=="string"?e.project:null}),{imported:!1,id:0};let t=this.db.prepare(`SELECT id FROM session_summaries WHERE memory_session_id = ?
        AND request IS ? AND investigated IS ? AND learned IS ? AND completed IS ?
        AND next_steps IS ? AND files_read IS ? AND files_edited IS ? AND notes IS ?
        AND prompt_number IS ? AND created_at_epoch = ?`).get(e.memory_session_id,h(e.request),h(e.investigated),h(e.learned),h(e.completed),h(e.next_steps),h(e.files_read),h(e.files_edited),h(e.notes),e.prompt_number??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let n=this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,h(e.request),h(e.investigated),h(e.learned),h(e.completed),h(e.next_steps),h(e.files_read),h(e.files_edited),h(e.notes),e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch);return Q({projects:[e.project]},"importSessionSummary"),{imported:!0,id:n.lastInsertRowid}}importObservation(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return l.warn("DB","Skipping imported observation without memory_session_id",{title:typeof e?.title=="string"?e.title:null,type:typeof e?.type=="string"?e.type:null}),{imported:!1,id:0};let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND text IS ? AND type = ?
        AND title IS ? AND subtitle IS ? AND facts IS ? AND narrative IS ?
        AND concepts IS ? AND files_read IS ? AND files_modified IS ?
        AND prompt_number IS ? AND agent_type IS ?
        AND agent_id IS ? AND created_at_epoch = ?
    `).get(e.memory_session_id,h(e.text),e.type,h(e.title),h(e.subtitle),h(e.facts),h(e.narrative),h(e.concepts),h(e.files_read),h(e.files_modified),e.prompt_number??null,e.agent_type??null,e.agent_id??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let s=this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),n=this.db.transaction(()=>{let o=s.run(e.memory_session_id,e.project,h(e.text),e.type,h(e.title),h(e.subtitle),h(e.facts),h(e.narrative),h(e.concepts),h(e.files_read),h(e.files_modified),e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid;return jt(this.db,o,e.files_read,e.files_modified),o})();return Q({projects:[e.project]},"importObservation"),{imported:!0,id:n}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?O(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${S}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!s||O(a.platform_source)===s)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);if(n)return{imported:!1,id:n.id};let o=this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch, native_prompt_id, native_prompt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,h(e.prompt_text),e.created_at,e.created_at_epoch,e.native_prompt_id??null,e.native_prompt_hash??null);return this.promptCommitted("importUserPrompt",t),{imported:!0,id:o.lastInsertRowid}}};0&&(module.exports={SessionStore,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
