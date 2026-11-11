var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var je=Object.defineProperty;var On=Object.getOwnPropertyDescriptor;var hn=Object.getOwnPropertyNames;var bn=Object.prototype.hasOwnProperty;var Ln=(n,e)=>{for(var t in e)je(n,t,{get:e[t],enumerable:!0})},In=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of hn(e))!bn.call(n,r)&&r!==t&&je(n,r,{get:()=>e[r],enumerable:!(s=On(e,r))||s.enumerable});return n};var Cn=n=>In(je({},"__esModule",{value:!0}),n);var Lo={};Ln(Lo,{SessionStore:()=>ht,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS:()=>An,rollupObservationFileLists:()=>fn});module.exports=Cn(Lo);var Dn=new Set,Mn=0;function ee(n,e,t="additive",s){Mn++;for(let r of Dn)r({scope:n,reason:e,kind:t,...s?{changes:s}:{}})}var Ot=require("bun:sqlite"),Ne=require("crypto");var L=require("path"),Bt=require("os"),Ht=require("fs"),$t=require("url");var Ft=require("fs"),Pt=require("os"),Ye=require("path");var N=require("fs"),yt=require("crypto"),x=require("path");var yn=null;function vn(n){return(yn??process.stderr.write.bind(process.stderr))(n)}function re(n){vn(n)}var Do=Promise.resolve();var Ge=process.platform==="win32";function de(n){return n.replace(/^\uFEFF/,"")}function Ke(n){return JSON.parse(de(n))}function Ee(n){return Ke((0,N.readFileSync)(n,"utf-8"))}function Un(n){(0,N.existsSync)(n)||(0,N.mkdirSync)(n,{recursive:!0})}function vt(n){try{return(0,N.realpathSync)(n)}catch(e){if(e.code!=="ENOENT")throw e;let t=(0,x.dirname)(n);return t===n?n:(0,x.join)(vt(t),(0,x.basename)(n))}}function wn(n){let e=n,t=new Set;try{for(;(0,N.lstatSync)(e).isSymbolicLink();){let s=(0,x.resolve)(e);if(t.has(s))throw Object.assign(new Error(`Symlink loop at ${e}`),{code:"ELOOP"});t.add(s);try{return(0,N.realpathSync)(e)}catch(r){if(r.code!=="ENOENT")throw r;let o=r instanceof Error?r:new Error(String(r));re(`claude-mem: realpathSync failed for ${e}, resolving symlink manually: ${o.message}
`);let i=(0,N.readlinkSync)(e);e=(0,x.resolve)(vt((0,x.dirname)((0,x.resolve)(e))),i)}}}catch(s){if(s.code!=="ENOENT")throw s}return e}var kn=new Set(["EPERM","EBUSY","EACCES"]),Mt=[10,20,40,80,160,320];function xn(n){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,n)}function Fn(n,e,t=N.renameSync,s=Ge){if(!s)return t(n,e);for(let r=0;;r++)try{t(n,e);return}catch(o){let i=o.code??"";if(r>=Mt.length||!kn.has(i))throw o;xn(Mt[r])}}function Pn(n,e,t={}){let s=wn(n);Un((0,x.dirname)(s));let r=(0,x.dirname)(s),o=(0,x.basename)(s),i=(0,x.join)(r,`.${o}.${process.pid}.${(0,yt.randomBytes)(6).toString("hex")}.tmp`),a=t.mode;if(a===void 0)try{a=(0,N.statSync)(s).mode&511}catch{}let _;try{_=a!==void 0?(0,N.openSync)(i,"w",a):(0,N.openSync)(i,"w"),a!==void 0&&!Ge&&(0,N.fchmodSync)(_,a);let E=0;for(;E<e.length;){let d=(0,N.writeSync)(_,e,E,e.length-E);if(d===0)throw new Error(`writeSync stalled at ${E}/${e.length} bytes`);E+=d}if((0,N.fsyncSync)(_),(0,N.closeSync)(_),_=void 0,Fn(i,s),!Ge){let d;try{d=(0,N.openSync)(r,"r"),(0,N.fsyncSync)(d)}catch(c){let S=c instanceof Error?c:new Error(String(c));re(`claude-mem: directory fsync failed for ${r}: ${S.message}
`)}finally{if(d!==void 0)try{(0,N.closeSync)(d)}catch{}}}}catch(E){if(_!==void 0)try{(0,N.closeSync)(_)}catch{}try{(0,N.unlinkSync)(i)}catch{}throw E}}function j(n,e,t={}){Pn(n,Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),t)}var Ut=require("os"),wt=require("path");function H(n,e=process.platform,t=(0,Ut.homedir)()){return typeof n!="string"||n.length===0?n:n==="~"?t:n.startsWith("~/")||e==="win32"&&n.startsWith("~\\")?(0,wt.join)(t,n.slice(2)):n}var kt=n=>n!==null&&typeof n=="object"&&!Array.isArray(n);function Ve(n){let e=n.env;return kt(e)&&Object.keys(e).some(t=>t.startsWith("CLAUDE_MEM_"))?"nested":"flat"}function te(n){return Ve(n)==="nested"?n.env:n}function xt(n){return Ve(n)!=="nested"?n:Object.fromEntries(Object.entries(n).filter(([e])=>!e.startsWith("CLAUDE_MEM_")))}function qe(){if(process.env.CLAUDE_MEM_DATA_DIR)return H(process.env.CLAUDE_MEM_DATA_DIR);let n=(0,Ye.join)((0,Pt.homedir)(),".claude-mem"),e=(0,Ye.join)(n,"settings.json");try{if((0,Ft.existsSync)(e)){let t=Ee(e);if(t===null||typeof t!="object"||Array.isArray(t))return n;let s=te(t);if(typeof s.CLAUDE_MEM_DATA_DIR=="string"&&s.CLAUDE_MEM_DATA_DIR)return H(s.CLAUDE_MEM_DATA_DIR)}}catch{}return n}function Bn(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,L.dirname)((0,$t.fileURLToPath)(__IMPORT_META_URL__))}var Go=Bn(),C=qe(),Hn=(0,L.join)((0,Bt.homedir)(),".claude"),$n=process.env.CLAUDE_CONFIG_DIR||Hn,Ko=(0,L.join)($n,"plugins","marketplaces","thedotmack"),Wn=(0,L.join)(C,"logs"),Oe=(0,L.join)(C,"settings.json"),Wt="claude-mem.db";var Je=(0,L.join)(C,Wt),Xn=(0,L.join)(C,"observer-sessions"),oe=(0,L.basename)(Xn);function ze(n){(0,Ht.mkdirSync)(n,{recursive:!0})}var Qe={dataDir:()=>C,workerPid:()=>(0,L.join)(C,"worker.pid"),workerHeartbeat:()=>(0,L.join)(C,"worker-heartbeat.json"),serverPid:()=>(0,L.join)(C,".server-beta.pid"),serverPort:()=>(0,L.join)(C,".server-beta.port"),serverRuntime:()=>(0,L.join)(C,".server-beta.runtime.json"),settings:()=>(0,L.join)(C,"settings.json"),database:()=>(0,L.join)(C,Wt),backups:()=>(0,L.join)(C,"backups","auto"),pendingRestore:()=>(0,L.join)(C,"backups","restore-pending.json"),lastRestore:()=>(0,L.join)(C,"backups","last-restore.json"),chroma:()=>(0,L.join)(C,"chroma"),combinedCerts:()=>(0,L.join)(C,"combined_certs.pem"),transcriptsConfig:()=>(0,L.join)(C,"transcript-watch.json"),transcriptsState:()=>(0,L.join)(C,"transcript-watch-state.json"),corpora:()=>(0,L.join)(C,"corpora"),supervisorRegistry:()=>(0,L.join)(C,"supervisor.json"),envFile:()=>(0,L.join)(C,".env"),logsDir:()=>Wn};var U=require("fs"),he=require("path");var et=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(et||{}),Ze=null;function G(n){return n.replace(/\r/g,"\\r").replace(/\n/g,"\\n")}function jn(n){return"  "+n.replace(/\r/g,"\\r").replace(/\n(?![ \t]+at )/g,"\\n")}var tt=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;logFileDate=null;logFd=null;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){let e=new Date().toISOString().split("T")[0];if(this.logFileInitialized&&this.logFileDate===e)return;let t=this.logFileDate!==e;this.closeLogFd(),this.logFileInitialized=!1,this.logFileDate=e;try{let s=Qe.logsDir();(0,U.existsSync)(s)||(0,U.mkdirSync)(s,{recursive:!0}),this.logFilePath=(0,he.join)(s,`claude-mem-${e}.log`),this.logFileInitialized=!0}catch(s){t&&console.error("[LOGGER] Failed to initialize log file:",s instanceof Error?s.message:String(s)),this.logFilePath=null}}closeLogFd(){if(this.logFd!==null){try{(0,U.closeSync)(this.logFd)}catch{}this.logFd=null}}appendLine(e,t){if(this.logFd!==null){let s=!1;try{let r=(0,U.fstatSync)(this.logFd),o=(0,U.statSync)(e);s=r.ino===o.ino&&r.dev===o.dev}catch{}s||this.closeLogFd()}this.logFd===null&&((0,U.mkdirSync)((0,he.dirname)(e),{recursive:!0}),this.logFd=(0,U.openSync)(e,"a"));try{let s=Buffer.from(t,"utf8");for(;s.length>0;){let r=(0,U.writeSync)(this.logFd,s);if(r<=0)throw new Error("log write accepted 0 bytes");s=s.subarray(r)}}catch(s){throw this.closeLogFd(),s}}getLevel(){if(this.level===null)try{let e=Qe.settings();if((0,U.existsSync)(e)){let s=(te(Ee(e)).CLAUDE_MEM_LOG_LEVEL||"INFO").toString().toUpperCase();this.level=et[s]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}safeStringify(e,t,s=6){let r=new WeakSet,o=(i,a)=>{if(typeof i=="bigint")return`${i}n`;if(i===null||typeof i!="object")return i;let _=i.toJSON,E=typeof _=="function"?_.call(i):i;if(typeof E=="bigint")return`${E}n`;if(E===null||typeof E!="object")return E;if(r.has(E))return"[Circular]";if(a>=s)return Array.isArray(E)?"[Array]":"[Object]";r.add(E);try{if(Array.isArray(E))return E.map(c=>o(c,a+1));let d={};for(let c of Object.keys(E))try{d[c]=o(E[c],a+1)}catch{d[c]="[unreadable]"}return d}finally{r.delete(E)}};try{return JSON.stringify(o(e,0),null,t)??String(e)}catch{return Array.isArray(e)?`[${e.length} items]`:"[unserializable]"}}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?this.safeStringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(s===null)return e;if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${r} ${o}:${i}:${a}.${_}`}log(e,t,s,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=et[e].padEnd(5),_=t.padEnd(6),E="";r?.correlationId?E=`[${G(String(r.correlationId))}] `:r?.sessionId&&(E=`[session-${G(String(r.sessionId))}] `);let d="";o!=null&&(o instanceof Error?(d=` ${G(o.message)}`,this.getLevel()===0&&o.stack&&(d+=`
${jn(o.stack)}`)):this.getLevel()===0&&typeof o=="object"?d=`
`+this.safeStringify(o,2):d=" "+G(this.formatData(o)));let c="";if(r){let{sessionId:l,memorySessionId:m,correlationId:R,...I}=r;Object.keys(I).length>0&&(c=` {${Object.entries(I).map(([h,T])=>typeof T!="object"||T===null||T instanceof Error||T instanceof Date?`${G(h)}=${G(String(T))}`:`${G(h)}=${G(Array.isArray(T)?this.safeStringify(T):this.formatData(T))}`).join(", ")}}`)}let S=`[${i}] [${a}] [${_}] ${E}${G(s)}${c}${d}`;if(this.logFilePath)try{this.appendLine(this.logFilePath,S+`
`)}catch(l){let m=l instanceof Error?l:new Error(String(l));re(`[LOGGER] Failed to write to log file: ${m.message}
${m.stack??""}
`)}else re(S+`
`)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}setErrorSink(e){Ze=e}error(e,t,s,r){this.log(3,e,t,s,r),this.routeErrorToSink(t,s,r)}routeErrorToSink(e,t,s){try{if(!Ze||!(s instanceof Error))return;Ze(s)}catch{}}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}},u=new tt;function $(n){let e=n.projects?.length?n.projects:n.project?[n.project]:[];return[...new Set(e.filter(t=>t.trim().length>0))]}function X(n,e,t){let s=e.map(()=>"?").join(",");return t.includeMerged?{sql:`(${n}.project COLLATE NOCASE IN (${s}) OR ${n}.merged_into_project COLLATE NOCASE IN (${s}))`,params:[...e,...e]}:{sql:`${n}.project COLLATE NOCASE IN (${s})`,params:[...e]}}function Xt(n,e){let t=$({projects:e});if(t.length===0)return[];let s=t.map((i,a)=>`?${a+1}`).join(","),r=[`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${s})`,`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${s})`,`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${s})`,`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${s})`,`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${s})`,`SELECT candidates.key FROM (
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
      )`],o=n.prepare(r.join(" UNION "));try{let i=o.all(...t);return[...new Set([...t,...i.map(a=>a.key)])]}finally{o.finalize()}}var jt=require("crypto");function st(n){return typeof n=="string"&&n.trim()!==""}function Gt(n,e,t){return(0,jt.createHash)("sha256").update([n||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function nt(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[String(e)]}catch(e){return u.debug("DB","File list is not JSON; treating value as a single path",{value:n},e instanceof Error?e:new Error(String(e))),[n]}}function Kt(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function Vt(n,e,t,s){n.prepare("DELETE FROM observation_files WHERE observation_id = ?").run(e);let r=new Set([...Kt(t),...Kt(s)]);if(r.size===0)return;let o=n.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let i of r)o.run(i,e)}function Yt(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function rt(n=new Date){return n.toISOString().slice(0,10)}function qt(n,e=new Date,t=10){let s=rt(e);if(n.includes(s))return n;let r=[...n,s];return r.length>t?r.slice(r.length-t):r}function Jt(n){let e=rt(new Date(n));return{dates:JSON.stringify([e]),lastReinforced:e}}function be(n,e,t=new Date){let s=n.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(e);if(!s)return!1;let r=Yt(s.reinforcement_dates),o=qt(r,t);return o===r?!1:(n.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(JSON.stringify(o),o[o.length-1],e),!0)}var Zt=require("crypto");var g="claude";function Gn(n){return n.trim().toLowerCase().replace(/\s+/g,"-")}function f(n){if(!n)return g;let e=Gn(n);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e.includes("kimi")?"kimi":e==="pi-mono"?"pi":e==="agy"||e==="antigravity"||e.startsWith("antigravity-")?"antigravity-cli":e:g}function zt(n){let e=["claude","codex","antigravity-cli","cursor","kimi"];return[...n].sort((t,s)=>{let r=e.indexOf(t),o=e.indexOf(s);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:t.localeCompare(s)})}var Kn=new Set(["dumb_search","claude_mem_search","claude_mem_timeline","claude_mem_get_observations","mem_search","search","timeline","get_observations","get_summaries","get_tool_uses","session_start_context","observation_search","observation_context","memory_search","memory_context"]);function Vn(n){if(!n.startsWith("mcp__"))return null;let e=n.split("__");if(e.length<3)return null;let t=e[1].toLowerCase();return!t.includes("claude-mem")&&!t.includes("claude_mem")&&!t.includes("mcp-search")&&!t.includes("mcp_search")&&!t.includes("cmem")?null:e.slice(2).join("__")}function ot(n){if(!n)return!1;if(n.startsWith("memory_")||n==="claude_mem_search"||n==="claude_mem_timeline"||n==="claude_mem_get_observations"||n==="dumb_search"||n==="mem_search"||n==="get_summaries")return!0;let e=Vn(n);return e!==null&&Kn.has(e)}var Yn=64*1024;function Qt(n,e=Yn){let t=Buffer.byteLength(n,"utf8");if(t<=e)return n;let s=Buffer.from(n,"utf8"),r=e;for(;r>0&&(s[r]&192)===128;)r--;return`${s.subarray(0,r).toString("utf8")}\u2026[truncated: ${t} bytes]`}function qn(n,e,t){return(0,Zt.createHash)("sha256").update([n||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function es(n){n.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${g}',
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
      UNIQUE(platform_source, content_session_id, tool_use_id)
    )
  `),n.transaction(()=>{let e=n.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_uses'").get(),t=/UNIQUE\s*\(\s*content_session_id\s*,\s*tool_use_id\s*\)/i;if(!t.test(e.sql))return;let s=n.query(`SELECT sql FROM sqlite_master
      WHERE tbl_name = 'tool_uses' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all(),r=n.query("SELECT seq FROM sqlite_sequence WHERE name = 'tool_uses'").get();n.run(e.sql.replace(/^CREATE TABLE\s+(?:"tool_uses"|tool_uses)\s*\(/i,"CREATE TABLE tool_uses_platform_new (").replace(t,"UNIQUE(platform_source, content_session_id, tool_use_id)")),n.run("INSERT INTO tool_uses_platform_new SELECT * FROM tool_uses"),n.run("DROP TABLE tool_uses"),n.run("ALTER TABLE tool_uses_platform_new RENAME TO tool_uses");for(let o of s)n.run(o.sql);r&&n.run("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'tool_uses'",[r.seq])}).immediate(),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project_nocase_created ON tool_uses(project COLLATE NOCASE, created_at_epoch DESC, id DESC)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function ts(n,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||ot(e.toolName))return null;let t=e.createdAtEpoch??Date.now(),s=new Date(t).toISOString(),r=qn(e.toolName,e.toolInput,e.toolResponse),o=e.toolInput!=null?Qt(e.toolInput):null,i=e.toolResponse!=null?Qt(e.toolResponse):null,a=n.prepare(`
    INSERT INTO tool_uses (
      tool_use_id, content_session_id, memory_session_id, session_db_id, project,
      platform_source, tool_name, tool_input, tool_response, cwd, prompt_number,
      agent_type, agent_id, or_generation_id, or_session_id, content_hash,
      created_at, created_at_epoch
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform_source, content_session_id, tool_use_id) DO UPDATE SET
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
  `).all(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",f(e.platformSource),e.toolName,o,i,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,r,s,t)[0]??null;return a?a.id:null}function ss(n,e){let t=e.toolUseIds.filter(o=>typeof o=="string"&&o.length>0);if(t.length===0)return 0;let s=t.map(()=>"?").join(","),r=n.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = CASE WHEN observation_id IS NULL
          THEN COALESCE(?, memory_session_id)
          ELSE COALESCE(memory_session_id, ?)
        END
    WHERE content_session_id = ?
      AND platform_source = ?
      AND tool_use_id IN (${s})
      AND (observation_id IS NULL OR observation_id = ?)
  `).run(e.observationId,e.memorySessionId??null,e.memorySessionId??null,e.contentSessionId,f(e.platformSource),...t,e.observationId);return Number(r.changes??0)}function ns(n){return n?{clause:`COALESCE(NULLIF(platform_source, ''), '${g}') = ?`,param:f(n)}:null}var Jn=100;function rs(n,e,t={}){let s=[],r=[];for(let c of e){if(typeof c=="number"&&Number.isInteger(c)){s.push(c);continue}if(typeof c=="string"&&c.trim().length>0){let S=Number(c);Number.isInteger(S)&&String(S)===c.trim()&&s.push(S),r.push(c.trim())}}if(s.length===0&&r.length===0)return[];let o=[],i=[];s.length>0&&(o.push(`id IN (${s.map(()=>"?").join(",")})`),i.push(...s)),r.length>0&&(o.push(`tool_use_id IN (${r.map(()=>"?").join(",")})`),i.push(...r));let a=[`(${o.join(" OR ")})`],_=$(t);if(_.length){let c=X("tool_uses",_,{includeMerged:!1});a.push(c.sql),i.push(...c.params)}t.contentSessionId&&(a.push("content_session_id = ?"),i.push(t.contentSessionId));let E=ns(t.platformSource);E&&(a.push(E.clause),i.push(E.param));let d=t.limit&&t.limit>0?Math.floor(t.limit):Jn;return n.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    LIMIT ${d}
  `).all(...i)}function os(n,e={}){return as(n,e,"*")}function is(n,e={}){return as(n,e,`
    id, tool_use_id, tool_name, project, content_session_id, memory_session_id,
    platform_source, agent_id, agent_type, observation_id, or_generation_id,
    or_session_id, prompt_number, created_at, created_at_epoch,
    COALESCE(length(CAST(tool_input AS BLOB)), 0) AS tool_input_bytes,
    COALESCE(length(CAST(tool_response AS BLOB)), 0) AS tool_response_bytes
  `)}function as(n,e,t){let s=[],r=[];if(e.project&&(s.push("project COLLATE NOCASE = ?"),r.push(e.project)),e.contentSessionId&&(s.push("content_session_id = ?"),r.push(e.contentSessionId)),e.memorySessionId&&(s.push("memory_session_id = ?"),r.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(s.push("session_db_id = ?"),r.push(e.sessionDbId)),e.toolName){let d=Array.isArray(e.toolName)?e.toolName:[e.toolName];d.length>0&&(s.push(`tool_name IN (${d.map(()=>"?").join(",")})`),r.push(...d))}e.agentId&&(s.push("agent_id = ?"),r.push(e.agentId));let o=ns(e.platformSource);o&&(s.push(o.clause),r.push(o.param)),typeof e.dateStart=="number"&&(s.push("created_at_epoch >= ?"),r.push(e.dateStart)),typeof e.dateEnd=="number"&&(s.push("created_at_epoch <= ?"),r.push(e.dateEnd));let i=s.length>0?`WHERE ${s.join(" AND ")}`:"",a=e.orderBy==="date_asc"?"ASC":"DESC",_=Math.min(Math.max(Math.floor(e.limit??50),1),500),E=Math.max(Math.floor(e.offset??0),0);return n.prepare(`
    SELECT ${t} FROM tool_uses
    ${i}
    ORDER BY created_at_epoch ${a}, id ${a}
    LIMIT ${_} OFFSET ${E}
  `).all(...r)}function _s(n,e={}){let t=[],s=[];e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let r=t.length>0?`WHERE ${t.join(" AND ")}`:"";return n.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${r}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...s)}function ds(n){n.run(`
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
  `),n.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_deliverables_session_copy ON deliverables(platform_source, content_session_id, bucket_path)"),n.run("CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project COLLATE NOCASE, created_at_epoch)"),n.run("CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at_epoch DESC)")}function Es(n,e){let t=e.createdAtEpoch??Date.now(),s=n.prepare(`
    INSERT OR IGNORE INTO deliverables (
      project, content_session_id, platform_source, agent_id, title, kind, source_path, bucket_path, bytes, sha256,
      declared, list_name, field, tool_use_id, occurred_at_epoch, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.project,e.contentSessionId,e.platformSource,e.agentId??null,e.title,e.kind,e.sourcePath,e.bucketPath,e.bytes,e.sha256,e.declared?1:0,e.listName??null,e.field??null,e.toolUseId??null,e.occurredAtEpoch,new Date(t).toISOString(),t);if(s.changes>0){let o=Number(s.lastInsertRowid);return u.debug("DB","Deliverable recorded",{id:o,project:e.project,bucketPath:e.bucketPath}),{id:o,inserted:!0}}return{id:n.prepare("SELECT id FROM deliverables WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ?").get(e.platformSource,e.contentSessionId,e.bucketPath)?.id??0,inserted:!1}}function cs(n,e){return!Number.isSafeInteger(e)||e<1?null:n.prepare("SELECT * FROM deliverables WHERE id = ?").get(e)??null}var Ue=require("fs");var K=require("fs"),B=require("path"),ce=require("os");var Le={HEALTH_CHECK:3e3,API_REQUEST:3e4,SESSION_INIT_HOOK_CAP:15e3,SESSION_INIT_REQUEST:1e4,SESSION_INIT_REQUEST_MAX:14e3,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function zn(n=process.platform){return n==="win32"?8e3:5e3}function ls(n=process.platform){return Le.SESSION_INIT_HOOK_CAP-zn(n)}function us(n){return process.platform==="win32"?Math.round(n*Le.WINDOWS_MULTIPLIER):n}var hs=require("util");function ps(n){try{return new URL(n).hostname.toLowerCase()==="openrouter.ai"}catch{return!1}}var ms=require("crypto"),Ie=require("fs"),Ts=require("os"),se=require("path");var Qn=37700,Zn=37877,er="37777",tr=77,Ss=37954;function gs(){return process.env.CLAUDE_MEM_DATA_DIR||(0,se.join)((0,Ts.homedir)(),".claude-mem")}function As(n){let e=(0,se.join)(H(n),"settings.json");if(!(0,Ie.existsSync)(e))return null;try{let t=JSON.parse((0,Ie.readFileSync)(e,"utf8").replace(/^\uFEFF/,"")),s=t.env;return s&&typeof s=="object"&&!Array.isArray(s)&&Object.keys(s).some(r=>r.startsWith("CLAUDE_MEM_"))?s:t}catch{return null}}function sr(n){return As(n)?.CLAUDE_MEM_WORKER_PORT===er}function nr(n){let e=As(n);return["CLAUDE_MEM_SERVER_URL","CLAUDE_MEM_SERVER_BETA_URL"].some(t=>{let s=e?.[t];if(typeof s!="string")return!1;try{return new URL(s).port===String(Ss)}catch{return!1}})}function fs(n=gs(),e={}){let t=e.platform??process.platform,s=e.uid===void 0?typeof process.getuid=="function"?process.getuid():null:e.uid;if(s!==null)return(s%100+100)%100;if(t==="win32"&&sr(n))return tr;let r=H(n,t),o=t==="win32"?se.win32.resolve(r):(0,se.resolve)(r);return t==="win32"&&(o=o.toLowerCase()),(0,ms.createHash)("sha256").update(o,"utf8").digest().readUInt32BE(0)%100}function Ce(n,e){return Qn+fs(n,e)}function De(n=gs(),e={}){let t=e.platform??process.platform,s=e.uid===void 0?typeof process.getuid=="function"?process.getuid():null:e.uid;return t==="win32"&&s===null&&nr(n)?Ss:Zn+fs(n,e)}var rr="security_alert",or="sync-hub.black-pond-afbb.workers.dev",ir="ziczmqtpmaxbornfghye.supabase.co",ar="https://sync.cmem.ai",_r=new Set(["xiaomi/mimo-v2-flash:free"]);function dr(n){return typeof n=="boolean"?String(n):n}var Er=new Set(["claude-haiku-4-5-20251001","claude-haiku-4-5"]);function cr(n){let e=process.env.CLAUDE_MEM_ENV_FILE??(0,B.join)((0,B.dirname)(n),".env");try{return(0,K.existsSync)(e)?!!(0,hs.parseEnv)(de((0,K.readFileSync)(e,"utf-8"))).ANTHROPIC_BASE_URL:!1}catch{return!0}}function lr(n,e){let t=n.CLAUDE_MEM_MODEL;return typeof t!="string"||!Er.has(t.trim())?!1:(typeof n.CLAUDE_MEM_CLAUDE_AUTH_METHOD=="string"?n.CLAUDE_MEM_CLAUDE_AUTH_METHOD.trim():"")!=="gateway"&&!cr(e)}function ur(n){let e=n.CLAUDE_MEM_OPENROUTER_MODEL;if(typeof e!="string"||!_r.has(e.trim()))return!1;let t=typeof n.CLAUDE_MEM_OPENROUTER_BASE_URL=="string"?n.CLAUDE_MEM_OPENROUTER_BASE_URL.trim():"";return t===""||ps(t)}var Rs=18e4,Ns=[{key:"CLAUDE_MEM_LLM_TIMEOUT_MS",legacy:"30000",markerTag:"llm-timeout-migrated-v1",unit:"ms",applyOnlyWhenSaved:!1},{key:"CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS",legacy:"30000",markerTag:"field-optimize-timeout-migrated-v1",unit:"ms",applyOnlyWhenSaved:!1},{key:"CLAUDE_MEM_MEDIA_CAPTURE_ENABLED",legacy:"false",markerTag:"media-capture-default-on-v1",unit:"",applyOnlyWhenSaved:!0}];function bs(n,e){return(0,B.join)((0,B.dirname)(n),`.${(0,B.basename)(n)}.${e.markerTag}`)}function it(n,e){try{(0,K.writeFileSync)(bs(n,e),new Date().toISOString(),{encoding:"utf-8",mode:384})}catch{}}var Os=new Set;function pr(n){if(typeof n!="string")return null;let e=n.trim();if(e.length===0)return null;try{let t=new URL(e).hostname;if(t===or||t===ir)return ar}catch{return null}return null}var ie=class{static DEFAULTS={CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED:"true",CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED:"true",CLAUDE_MEM_MEMORY_WATCH_ROOTS:"",CLAUDE_MEM_MODEL:"haiku",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES:"false",CLAUDE_MEM_CONTEXT_PROJECTS:"current",CLAUDE_MEM_WORKER_PORT:String(Ce()),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_URL:"",CLAUDE_MEM_WORKER_INGEST_TOKEN:"",CLAUDE_MEM_WORKER_INGEST_MAX_BYTES:"5242880",CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:"auto",CLAUDE_MEM_ALLOWED_ORIGINS:"",CLAUDE_MEM_PUBLIC_URL:"",CLAUDE_MEM_API_TIMEOUT_MS:String(us(Le.API_REQUEST)),CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS:String(ls()),CLAUDE_MEM_HOOK_HANDOFF_TIMEOUT_MS:"250",CLAUDE_MEM_IDLE_EXIT_SEC:"0",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_SKIP_BASH_PATTERNS:"",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_CAPTURE_ADVISOR_CALLS:"false",CLAUDE_MEM_DELIVERABLES_ENABLED:"true",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_PROVIDER_BY_SOURCE:"",CLAUDE_MEM_OBSERVER_ENABLED:"true",CLAUDE_MEM_MEDIA_CAPTURE_ENABLED:"true",CLAUDE_MEM_MEDIA_INFERENCE_ENABLED:"false",CLAUDE_MEM_CODEX_MODEL:"",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"low",CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE:"8",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS:"32000",CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_API_KEYS:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-flash-latest",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_API_KEYS:"",CLAUDE_MEM_OPENROUTER_MODEL:"cohere/north-mini-code:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_TEMPERATURE:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_PRESET:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEYS:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"",CLAUDE_MEM_OPENAI_COMPAT_REASONING:"",CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER:"claude",CLAUDE_MEM_QUOTA_FALLBACK_MODEL:"",CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD:"",CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR:"0.95",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET:"0.92",CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE:"0.95",CLAUDE_MEM_DATA_DIR:(0,B.join)((0,ce.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:"",CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:"",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY:"true",CLAUDE_MEM_REINFORCE_ALPHA:"0",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_WORK_STATE_ENABLED:"true",CLAUDE_MEM_AUTO_CLEAR_ENABLED:"false",CLAUDE_MEM_AUTO_CLEAR_PERCENT:"33",CLAUDE_MEM_FILE_READ_GATE_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,B.join)((0,ce.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_CODEX_SUBAGENT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS:"400000",CLAUDE_MEM_OBSERVER_THINKING:"disabled",CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW:"",CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS:"4096",CLAUDE_MEM_OBSERVE_BARE_PROMPTS:"false",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_REDACT_ENABLED:"false",CLAUDE_MEM_REDACT_DISABLED_BUILTINS:"",CLAUDE_MEM_REDACT_CUSTOM_PATTERNS:"[]",CLAUDE_MEM_REDACT_LOG_MATCHES:"false",CLAUDE_MEM_REDACT_GENERIC_ENABLED:"false",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_PROJECT_ENVIRONMENTS:"[]",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_SEMANTIC_INJECT_FORMAT:"narrative",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS:"600000",CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS:"5000",CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_SERVER_VECTOR_SEARCH:"auto",CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS:"",CLAUDE_MEM_EMBEDDING_MODEL:"all-MiniLM-L6-v2",CLAUDE_MEM_CHROMA_UVX_PATH:"",CLAUDE_MEM_SEARCH_RECENCY_DAYS:"90",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,ce.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING:"false",CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE:"40",CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS:"90000",CLAUDE_MEM_TEAMBRAIN_URL:"",CLAUDE_MEM_TEAMBRAIN_TEAM_ID:"",CLAUDE_MEM_LLM_TIMEOUT_MS:String(Rs),CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS:String(Rs),CLAUDE_MEM_LLM_STREAM_IDLE_TIMEOUT_MS:"90000",CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS:"120000",CLAUDE_MEM_TV_TOKEN:"",CLAUDE_MEM_PRO_TRIAL_EMAIL:"",CLAUDE_MEM_PRO_TRIAL_AT:"",CLAUDE_MEM_PRO_TRIAL_STATE:"",CLAUDE_MEM_PRO_TRIAL_ENDS_AT:"",CLAUDE_MEM_ONLINE_SIGNUP_EMAIL:"",CLAUDE_MEM_ONLINE_SIGNUP_NOTE:"",CLAUDE_MEM_ONLINE_SIGNUP_AT:"",CLAUDE_MEM_ONLINE_SIGNUP_SENT:"",CLAUDE_MEM_PRO_PLAN:"",CLAUDE_MEM_PRO_FALLBACK_AT:"",CLAUDE_MEM_PRO_FALLBACK_MESSAGE:"",CLAUDE_MEM_PRO_FALLBACK_ACTION:"",CLAUDE_MEM_PRO_FALLBACK_URL:"",CLAUDE_MEM_PRO_MEMORY_KEY:"",CLAUDE_MEM_PRO_MEMORY_BASE_URL:"",CLAUDE_MEM_PRO_MEMORY_MODEL:"",CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH:"true",CLAUDE_MEM_WORK_VIEW_REFRESH_INTERVAL_MIN:"10",CLAUDE_MEM_WORK_VIEW_SHARED_STATE:"false",CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER:"",CLAUDE_MEM_WORK_VIEW_COPY_MODEL:"",CLAUDE_MEM_WORK_VIEW_AGENT:"",CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL:"",CLAUDE_MEM_WORK_VIEW_CODEX_MODEL:"",CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL:"",CLAUDE_MEM_WORK_VIEW_API_MODEL:"",CLAUDE_MEM_WORK_VIEW_TEXT_LANGUAGE:"",CLAUDE_MEM_BACKUP_ENABLED:"false",CLAUDE_MEM_BACKUP_INTERVAL_HOURS:"24",CLAUDE_MEM_BACKUP_RETAIN_COUNT:"7",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED:"true",CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED:"false",CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES:"{}",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert,sensitive",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED:"false",CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_URL:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET:"",CLAUDE_MEM_NOTION_ENABLED:"false",CLAUDE_MEM_NOTION_TOKEN:"",CLAUDE_MEM_NOTION_DATABASE_ID:"",CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES:"true",CLAUDE_MEM_GROK_BOT_INJECT_ENABLED:"true",CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS:"*",CLAUDE_MEM_GROK_BOT_INJECT_TIER:"episode",CLAUDE_MEM_GROK_BOT_INJECT_WINDOW:"80",CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK:"house",CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE:"",CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT:"",CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS:"160",CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS:"1500",CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE:"",CLAUDE_MEM_CCS_ALIGN_ENABLED:"true",CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS:"ccs-align",CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS:"false",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(Ce())}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(De())}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(De())}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:"",CLAUDE_MEM_DEDUP_ENABLED:"false",CLAUDE_MEM_DEDUP_COSINE_THRESHOLD:"0.80",CLAUDE_MEM_DEDUP_IDF_VETO_DF:"10",CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS:"2",CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS:"10",CLAUDE_MEM_DEDUP_MAX_SCAN:"2000",CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS:"50000",CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED:"false",CLAUDE_MEM_TOOL_USES_RETENTION_DAYS:"0",CLAUDE_MEM_LOG_RETENTION_DAYS:"30",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_AUTO_UPDATE:"true",CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL:"",CLAUDE_MEM_PROJECT_NAME_SOURCE:"path"};static getAllDefaults(){return{...this.DEFAULTS}}static defaultsForSettingsPath(e){let t={...this.DEFAULTS},s=(0,B.dirname)(e),r=String(Ce(s)),o=process.env.CLAUDE_MEM_SERVER_PORT??String(De(s));return t.CLAUDE_MEM_WORKER_PORT=r,t.CLAUDE_MEM_QUEUE_REDIS_PREFIX=`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??r}`,t.CLAUDE_MEM_SERVER_URL=`http://127.0.0.1:${o}`,t.CLAUDE_MEM_SERVER_BETA_URL=`http://127.0.0.1:${o}`,t}static get(e){let t=process.env[e]??this.DEFAULTS[e];return e==="CLAUDE_MEM_WORKER_HOST"?this.normalizeWorkerHost(t):e==="CLAUDE_MEM_DATA_DIR"?H(t):t}static normalizeWorkerHost(e){return e==="localhost"?"127.0.0.1":e}static finalizeSettings(e,t){let s=t?this.applyEnvOverrides(e):e;s.CLAUDE_MEM_WORKER_HOST=this.normalizeWorkerHost(s.CLAUDE_MEM_WORKER_HOST);let r=s.CLAUDE_MEM_DATA_DIR?.trim();return r&&s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH===this.DEFAULTS.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH&&(s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH=(0,B.join)(H(r),"transcript-watch.json")),s}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0,s={}){try{let r=this.defaultsForSettingsPath(e);if(!(0,K.existsSync)(e)){if(!s.readOnly)try{j(e,r,{mode:384});for(let l of Ns)it(e,l);console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(l){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,l instanceof Error?l.message:String(l))}return this.finalizeSettings(r,t)}let o=(0,K.readFileSync)(e,"utf-8"),i=Ke(o),a=te(i),_=a!==i,E=xt(i),d=_&&Object.keys(E).some(l=>l!=="env");if(_&&!d&&!s.readOnly)try{j(e,a,{mode:384}),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(l){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,l instanceof Error?l.message:String(l))}if(a.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES===rr&&(a={...a,CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES},!s.readOnly))try{j(e,d?{...E,env:a}:a,{mode:384}),console.warn("[SETTINGS] Migrated Telegram trigger types off the legacy default:",e)}catch(l){console.warn("[SETTINGS] Failed to migrate Telegram trigger types:",e,l instanceof Error?l.message:String(l))}if(lr(a,e)){let l=String(a.CLAUDE_MEM_MODEL).trim();if(a={...a,CLAUDE_MEM_MODEL:this.DEFAULTS.CLAUDE_MEM_MODEL},!s.readOnly)try{j(e,d?{...E,env:a}:a,{mode:384}),console.warn(`[SETTINGS] Migrated Claude model off the pinned ${l} to ${this.DEFAULTS.CLAUDE_MEM_MODEL}:`,e)}catch(m){console.warn("[SETTINGS] Failed to migrate the pinned Claude model:",e,m instanceof Error?m.message:String(m))}}if(ur(a)){let l=String(a.CLAUDE_MEM_OPENROUTER_MODEL).trim();if(a={...a,CLAUDE_MEM_OPENROUTER_MODEL:this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL},!s.readOnly)try{j(e,d?{...E,env:a}:a,{mode:384}),console.warn(`[SETTINGS] Migrated OpenRouter model off the retired default ${l} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,e)}catch(m){console.warn("[SETTINGS] Failed to migrate the retired OpenRouter model:",e,m instanceof Error?m.message:String(m))}}let c=pr(a.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);if(c!==null&&(a={...a,CLAUDE_MEM_CLOUD_SYNC_HUB_URL:c},!s.readOnly))try{j(e,d?{...E,env:a}:a,{mode:384}),console.warn("[SETTINGS] Migrated cloud sync hub URL to",c,"from a retired hub host:",e)}catch(l){console.warn("[SETTINGS] Failed to migrate cloud sync hub URL:",e,l instanceof Error?l.message:String(l))}for(let l of Ns){if((0,K.existsSync)(bs(e,l)))continue;if(a[l.key]!==l.legacy){s.readOnly||it(e,l);continue}if(s.readOnly&&l.applyOnlyWhenSaved)continue;let m=a;if(a={...a,[l.key]:this.DEFAULTS[l.key]},!s.readOnly)try{j(e,d?{...E,env:a}:a,{mode:384}),it(e,l),console.warn(`[SETTINGS] Migrated ${l.key} off the old ${l.legacy}${l.unit} default to ${this.DEFAULTS[l.key]}${l.unit}:`,e)}catch(R){l.applyOnlyWhenSaved&&(a=m);let I=`${l.key}\0${e}`;Os.has(I)||(Os.add(I),console.warn(l.applyOnlyWhenSaved?`[SETTINGS] Failed to migrate ${l.key}; keeping the saved ${l.legacy} (reported once per process):`:`[SETTINGS] Failed to migrate ${l.key}; using the new default in memory (reported once per process):`,e,R instanceof Error?R.message:String(R)))}}let S={...r};for(let l of Object.keys(r))a[l]!==void 0&&(S[l]=dr(a[l]));return this.finalizeSettings(S,t)}catch(r){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,r instanceof Error?r.message:String(r));let o=this.defaultsForSettingsPath(e);return this.finalizeSettings(o,t)}}};var pe=String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`,J=`(?=${pe}{8})${pe}*[A-Za-z]${pe}*`,W=String.raw`(?:\\{0,3}["'])?`,v=String.raw`\s{0,8}`;function at(n){return new RegExp(`${n}${J}`,"gi")}function Ls(n){let e=n.replace(/\\.|[a-z]/g,t=>t.length===1?`[${t}${t.toUpperCase()}]`:t);return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${e}`}function ve(n){return`(?<=${n}${W}${v}[=:]${v}${W})`}var Me=String.raw`(?:token|secret|api_key)`,ye=String.raw`\\{0,3}["']`,_t=String.raw`(?<!\\)"`,mr=String.raw`(?:^|[\s?&]|\\[nrt]|${_t})`,Tr=String.raw`(?:^|\n|\\n|${_t})[ \t]{0,8}(?:-[ \t]{1,8})?`,Sr=String.raw`(?:${ye})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${_t})`,gr=new RegExp([`${ve(String.raw`\b\w*_${Me}`)}${J}`,`(?<=${ye}${Me}${ye}${v}:${v}${ye})${J}`,`(?<=${mr}${Me}=${W})${J}(?!\\(|${pe})`,String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${W})${J}`,`(?<=${Tr}${Me}:[ \\t]{1,8}${W})${J}(?=${Sr})`].join("|"),"gi"),Ar=String.raw`(?:(?<=\\[nrt])|\b)`;function fr(n){let e=n.regex.source.replace(/(^|\||\(\?:)\\b/g,`$1${Ar}`);return{...n,regex:new RegExp(e,n.regex.flags)}}var Rr=String.raw`[^\\\n\r"'\`<]`,Nr=[{name:"cookie_header",regex:new RegExp(`(?<=(?:\\b(?:set-)?cookie)${W}${v}[=:]${v}(?:\\[${v})?${W})(?![ \\t])${Rr}{4,}`,"gi")},{name:"url_credentials",regex:/(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi},{name:"aws_access_key",regex:/(?:AKIA|ASIA)[0-9A-Z]{16}/g},{name:"aws_secret_key",regex:new RegExp(`${ve(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`,"gi")},{name:"aws_session_token",regex:new RegExp(`${ve(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`,"gi")},{name:"github_pat",regex:/\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g},{name:"openai_key",regex:/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"anthropic_key",regex:/\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"slack_token",regex:/\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g},{name:"jwt",regex:/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g},{name:"private_key_pem",regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g},{name:"stripe_key",regex:/\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g},{name:"google_api_key",regex:/\bAIza[0-9A-Za-z_-]{35}(?!\w)/g},{name:"google_oauth_token",regex:/\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g},{name:"gitlab_token",regex:/\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g},{name:"huggingface_token",regex:/\bhf_[A-Za-z0-9]{30,}\b/g},{name:"npm_token",regex:/\bnpm_[A-Za-z0-9]{36}\b/g},{name:"docker_pat",regex:/\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g},{name:"linear_key",regex:/\blin_api_[A-Za-z0-9]{40}(?!\w)/g},{name:"notion_token",regex:/\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g},{name:"sendgrid_key",regex:/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g},{name:"digitalocean_token",regex:/\bdo[opr]_v1_[a-f0-9]{64}\b/g},{name:"shopify_token",regex:/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g},{name:"pypi_token",regex:/\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g},{name:"databricks_token",regex:/\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g},{name:"vault_token",regex:/\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g},{name:"nvidia_nim_key",regex:/\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g},{name:"runcrate_key",regex:/\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g},{name:"groq_key",regex:/\bgsk_[A-Za-z0-9]{52}(?!\w)/g},{name:"xai_key",regex:/\bxai-[A-Za-z0-9_]{80}(?!\w)/g},{name:"perplexity_key",regex:/\bpplx-[A-Za-z0-9]{48}(?!\w)/g},{name:"supabase_token",regex:/\bsbp_[a-f0-9]{40}(?!\w)/g},{name:"sentry_token",regex:/\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g},{name:"grafana_token",regex:/\b(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?!\w)|glc_[A-Za-z0-9+\/]{32,400}={0,2}(?![\w+\/=]))/g},{name:"postman_key",regex:/\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}(?!\w)/g},{name:"slack_webhook",regex:new RegExp(String.raw`(?<=${Ls(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`,"g")},{name:"discord_webhook",regex:new RegExp(String.raw`(?<=${Ls(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`,"g")},{name:"claude_mem_key",regex:/\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g}].map(fr),Or=[{name:"generic_password",regex:at(ve(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`))},{name:"generic_token",regex:gr},{name:"bearer_token",regex:at(`(?<=\\bAuthorization${W}${v}:${v}${W}Bearer${v})`)},{name:"basic_auth",regex:at(`(?<=\\bAuthorization${W}${v}:${v}${W}Basic${v})`)}],hr=1024*1024,br="<redacted type='oversize'/>";function ae(n,e){if(!e.enabled||n.length===0)return{redacted:n,counts:{},oversize:!1};if(n.length>hr)return u.warn("REDACT","field exceeds the 1M-char redaction cap; replaced by an oversize marker",void 0,{inputLength:n.length}),{redacted:br,counts:{oversize:1},oversize:!0};let t=new Set(e.disabledBuiltinPatterns??[]),s={},r=n,o=[];for(let a of e.customPatterns??[]){if(!a.name||a.name.length===0){u.warn("REDACT","custom pattern skipped: missing name",void 0,{pattern:a});continue}try{o.push({name:a.name,regex:new RegExp(a.regex,"g")})}catch(_){u.warn("REDACT","custom pattern skipped: invalid regex",{name:a.name},_ instanceof Error?_:new Error(String(_)))}}let i=[...o,...Nr,...e.genericEnabled?Or:[]];for(let a of i)t.has(a.name)||(a.regex.lastIndex=0,r=r.replace(a.regex,()=>(s[a.name]=(s[a.name]??0)+1,`<redacted type='${a.name}'/>`)));return e.logMatches&&Object.keys(s).length>0&&u.debug("REDACT","patterns matched",void 0,{counts:s}),{redacted:r,counts:s,oversize:!1}}function Lr(n){if(!n||n.trim()==="")return[];try{let e=JSON.parse(n);return Array.isArray(e)?e.filter(t=>t&&typeof t.name=="string"&&typeof t.regex=="string"):(u.warn("REDACT","CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring"),[])}catch(e){return u.warn("REDACT","failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",void 0,e instanceof Error?e:new Error(String(e))),[]}}function Ir(n){return{enabled:n.CLAUDE_MEM_REDACT_ENABLED==="true",disabledBuiltinPatterns:(n.CLAUDE_MEM_REDACT_DISABLED_BUILTINS??"").split(",").map(e=>e.trim()).filter(Boolean),customPatterns:Lr(n.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS??"[]"),logMatches:n.CLAUDE_MEM_REDACT_LOG_MATCHES==="true",genericEnabled:n.CLAUDE_MEM_REDACT_GENERIC_ENABLED==="true"}}var le=null,Is=0,Cr=5e3,ue=null,Cs=!1,Dr={enabled:!0,disabledBuiltinPatterns:[],customPatterns:[],logMatches:!1},Mr=/"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;function yr(n){if(!(0,Ue.existsSync)(n))return null;try{return(0,Ue.readFileSync)(n,"utf-8")}catch{return""}}function vr(n){if(n===null)return!1;try{let e=JSON.parse(de(n));return e===null||typeof e!="object"||Array.isArray(e)}catch{return!0}}function Ur(n,e,t){return process.env.CLAUDE_MEM_REDACT_ENABLED==="false"||!(ue?.enabled===!0||Mr.test(e))?t:(Cs||(Cs=!0,u.warn("REDACT","settings.json could not be read; secret redaction stays on until it is repaired",{settingsPath:n,using:ue?.enabled?"the last configuration that loaded":"the built-in patterns"})),ue?.enabled?ue:Dr)}function me(n=Oe){let e=Date.now();if(le&&e-Is<Cr)return le;let t=ie.loadFromFile(n),s=Ir(t),r=s.enabled?null:yr(n);return vr(r)?le=Ur(n,r,s):(le=s,ue=s),Is=e,le}var wr=/(?:password|passwd)$|\w_pwd$/i,kr=/(?:^|_)(?:secret|token|api_key)$/i,xr=new RegExp(`^${pe}{8,}$`);function Fr(n,e,t){if(!t.genericEnabled)return null;let s=wr.test(n)?"generic_password":kr.test(n)?"generic_token":null;return!s||t.disabledBuiltinPatterns?.includes(s)||!xr.test(e)||!/[A-Za-z]/.test(e)?null:`<redacted type='${s}'/>`}var Ds=/^(?:proxy-)?authorization$/i,Pr=new RegExp(`^(${v}Bearer${v})${J}`,"i");function Br(n,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("bearer_token")||!Ds.test(n))return null;let s=Pr.exec(e);return s?`${s[1]}<redacted type='bearer_token'/>${e.slice(s[0].length)}`:null}var Hr=new RegExp(`^(${v}Basic${v})${J}`,"i");function $r(n,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("basic_auth")||!Ds.test(n))return null;let s=Hr.exec(e);return s?`${s[1]}<redacted type='basic_auth'/>${e.slice(s[0].length)}`:null}var Wr=/^(?:aws_session_token|SessionToken)$/i,Xr=/^[A-Za-z0-9/+=]{100,}$/;function jr(n,e,t){return t.disabledBuiltinPatterns?.includes("aws_session_token")||!Wr.test(n)||!Xr.test(e)?null:"<redacted type='aws_session_token'/>"}var Gr=/^(?:aws_secret_access_key|SecretAccessKey)$/i,Kr=/^[A-Za-z0-9/+=]{40}$/;function Vr(n,e,t){return t.disabledBuiltinPatterns?.includes("aws_secret_key")||!Gr.test(n)||!Kr.test(e)?null:"<redacted type='aws_secret_key'/>"}var Ms=/^(?:set-)?cookie$/i;function Yr(n,e,t){return t.disabledBuiltinPatterns?.includes("cookie_header")||!Ms.test(n)||e.trim().length<4?null:"<redacted type='cookie_header'/>"}function ys(n,e=me()){if(!e.enabled)return n;let t=(s,r)=>{if(typeof s=="string"){let o=r===void 0?null:Yr(r,s,e);if(o)return o;let i=ae(s,e);return r===void 0||Object.keys(i.counts).length>0?i.redacted:jr(r,s,e)??Vr(r,s,e)??Br(r,s,e)??$r(r,s,e)??Fr(r,s,e)??i.redacted}return Array.isArray(s)?s.map(o=>t(o,r!==void 0&&Ms.test(r)?r:void 0)):s!==null&&typeof s=="object"?Object.fromEntries(Object.entries(s).map(([o,i])=>[o,t(i,o)])):s};return t(n)}var qr=1024*1024,dt="<redacted type='diagnostic_budget'/>";function vs(n,e=me()){if(!e.enabled)return n;let t=5e4,s=(o,i=[])=>{if(!i.length)return ae(o,e).redacted;for(let a of i){let _=ys({[a]:o},e)[a];if(_!==o)return _}return o},r=(o,i,a=[])=>{if(i>32||--t<0)return dt;if(typeof o=="string"){if(o.length>qr)return ae(o,e).redacted;try{let _=JSON.parse(o);if(_!==null&&(typeof _=="object"||typeof _=="string")){let E=r(_,i+1,a),d=JSON.stringify(E);if(d!==JSON.stringify(_))return d}}catch{}return s(o,a)}if(Array.isArray(o))return o.length>t?dt:o.map(_=>r(_,i+1,a));if(o&&typeof o=="object"){let _=Object.entries(o);return _.length>t?dt:Object.fromEntries(_.map(([E,d])=>[s(E,a),r(d,i+1,[E,...a])]))}return o};return r(n,0)}var Pi=Object.freeze({maxImagesPerEvent:4,maxSourceBytes:3145728,maxCanonicalBytes:3145728,maxEncodedCanonicalBytes:1048576,maxPixels:24e6,maxDimension:8192,conversionTimeoutSeconds:5,maxConcurrentConversions:1,maxDerivativeBytes:262144,maxDerivativeDimension:1536,maxInlineEncodedBytes:4194304,maxObservationRefs:32,maxLabelChars:64,maxManifestBytes:8192,maxProvenanceBytes:8192,maxSourceLocatorChars:4096,maxGatewayImageBytes:1048576,maxUploadBodyBytes:3211264,ownerQuotaBytes:26843545600});var Us=4096;var Jr=new Set(["set_title","set_prompt_session","remap_project"]),zr=/^(?:0|[1-9][0-9]*)$/,ws=18446744073709551615n;function w(n){let e=vs(n);throw u.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:e}),new Error(`canonical content: ${e}`)}function Se(n,e={}){return typeof n!="string"||!zr.test(n)?w("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(n)>ws&&w("decimal value exceeds uint64"),e.positive&&n==="0"&&w("decimal value must be positive"),n)}function ke(n){let e=Se(n);return BigInt(e)===ws&&w("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function Qr(n){(n===null||typeof n!="object"||Array.isArray(n))&&w("mutation must be an object");let e=n;if((typeof e.op!="string"||!Jr.has(e.op))&&w("unsupported mutation op"),e.op==="set_title"){let o=Te(e,["fields","op","target"],"set_title"),i=we(o.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");i.memory_session_id===void 0&&i.content_session_id===void 0&&w("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])i[_]!==void 0&&z(i[_],_);let a=Te(o.fields,["custom_title"],"set_title.fields");z(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let o=Te(e,["fields","op","target"],"set_prompt_session"),i=Te(o.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");Zr(i.origin_device_id),Se(i.origin_local_id);let a=we(o.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");z(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&z(a[_],_);return}let t=Te(e,["fields","op","where"],"remap_project"),s=we(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&z(s.project,"project"),s.memory_session_id!==void 0&&z(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&w("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&w("remap_project where is empty");let r=we(t.fields,["merged_into_project","project"],"remap_project.fields");r.project!==void 0&&z(r.project,"project"),r.merged_into_project!==void 0&&z(r.merged_into_project,"merged_into_project"),Object.keys(r).length===0&&w("remap_project fields are empty")}function Et(n){Qr(n)}function Zr(n){return typeof n!="string"||n.length===0||Buffer.byteLength(n,"utf8")>128?w("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):n}function z(n,e){return typeof n!="string"||n.length===0||n.trim().length===0||Buffer.byteLength(n,"utf8")>Us?w(`${e} must be a non-blank string of at most ${Us} UTF-8 bytes`):n}function Te(n,e,t){if(n===null||typeof n!="object"||Array.isArray(n))return w(`${t} must be an object`);let s=n,r=Object.keys(s).sort(),o=[...e].sort();return(r.length!==o.length||r.some((i,a)=>i!==o[a]))&&w(`${t} must contain exactly: ${o.join(", ")}`),s}function we(n,e,t){if(n===null||typeof n!="object"||Array.isArray(n))return w(`${t} must be an object`);let s=n,r=new Set(e),o=Object.keys(s).find(i=>!r.has(i));return o&&w(`${t} contains unknown field ${o}`),s}var ks=n=>typeof n=="string"&&/^__my_work_v\d+:/.test(n),ct=n=>`(COALESCE(${n}, '') GLOB '__my_work_v[0-9]*:*'
  AND substr(${n}, 12, instr(substr(${n}, 12), ':') - 1) NOT GLOB '*[^0-9]*')`;function xs(n,e){let t=o=>o.replace(/[A-Z]/g,i=>i.toLowerCase()),s=new Set(e.map(t)),r=e.at(-1);return n.map(o=>r&&s.has(t(o.project))?{...o,scope_project:r}:o)}function Fs(n){n.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `),n.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)"),to(n)}function to(n){let e=new Set(n.query("PRAGMA table_info(work_state_entries)").all().map(t=>t.name));e.has("synced_at")||n.run("ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER"),e.has("origin_device_id")||n.run("ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT"),e.has("origin_local_id")||n.run("ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT"),e.has("sync_rev")||n.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'"),n.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL"),n.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `)}function Ps(n,e){let t=e.createdAtEpoch??Date.now(),s=n.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(e.project,e.listName,JSON.stringify(e.fields),new Date(t).toISOString(),t),r=Number(s.lastInsertRowid);return u.debug("DB","Work state entry appended",{id:r,project:e.project,listName:e.listName}),r}function Bs(n,e,t,s=""){if(e.length===0||ks(t))return[];let r=e.map(()=>"?").join(", "),o=t===void 0?"":" AND list_name = ?",i=n.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${r})${o}
      AND NOT (
        list_name GLOB '__my_work_v[0-9]*:*'
        AND substr(list_name, 12, instr(substr(list_name, 12), ':') - 1) NOT GLOB '*[^0-9]*'
      )
    ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)
  `);try{return i.all(...e,...t===void 0?[]:[t],s).map(_=>({..._,fields:JSON.parse(_.fields)}))}finally{i.finalize()}}var js=require("crypto");function ge(n){let e=(n??"").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu," ").replace(/\s+/g," ").trim();return/[\p{L}\p{N}]/u.test(e)?e:""}function V(n){return(n??"").toLowerCase().trim().split(/\s+/).filter(Boolean)}function lt(n,e){return Math.log(1+e/(n+.5))}function Hs(n,e){return t=>lt(n(t),e)}function $s(n,e){let t=new Map;for(let s of new Set(n))t.set(s,e(s));return t}function Ws(n,e,t){let s=$s(n,t),r=$s(e,t),o=0,i=0,a=0;for(let[_,E]of s){i+=E*E;let d=r.get(_);d!==void 0&&(o+=E*d)}for(let[,_]of r)a+=_*_;return i===0||a===0?0:o/Math.sqrt(i*a)}function Xs(n,e,t,s){let r=new Set(n),o=new Set(e);for(let i of r)if(!o.has(i)&&t(i)>s)return!0;for(let i of o)if(!r.has(i)&&t(i)>s)return!0;return!1}function ut(n,e,t,s){let r=ge(n);if(r!==""&&r===ge(e))return{tier:"exact",method:"exact",score:1};let o=V(n),i=V(e),a=s.minSharedTokens??2,_=new Set(i),E=0;for(let c of new Set(o))_.has(c)&&E++;if(E<a)return{tier:"none",method:"none",score:0};let d=Ws(o,i,t);return d>=s.cosineThreshold&&!Xs(o,i,t,s.vetoThetaIdf)?{tier:"candidate",method:"idf_cosine",score:d}:{tier:"none",method:"none",score:d}}function Ae(n,e){return!!n&&!!e}function xe(n,e,t,s=!1){let r=ge(t);if(r==="")return null;let o=f(e),i=s?"subagent":"main";return(0,js.createHash)("sha256").update(`${n}\0${o}\0${i}\0${r}`).digest("hex").slice(0,32)}function Gs(n,e,t){return t===null?null:n.prepare("SELECT id, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC LIMIT 1").get(e,t)??null}function Ks(n,e,t){let s=[...new Set(V(t))],r=n.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1");for(let o of s)r.run(e,o);n.prepare("INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1").run(e)}function Vs(n,e){return lt(n+1,e)}function Ys(n,e){return n.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(e)?.doc_count??0}function qs(n,e,t){let s=Ys(n,e),r=t===void 0?n.prepare("SELECT token, df FROM token_df WHERE project = ?").all(e):n.prepare("SELECT token, df FROM token_df WHERE project = ? AND token IN (SELECT value FROM json_each(?))").all(e,JSON.stringify([...new Set(t)])),o=new Map(r.map(i=>[i.token,i.df]));return{idfFn:Hs(i=>o.get(i)??0,s),docCount:s}}function Js(n){return n.prepare("INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")}function zs(n,e,t){return Ys(n,e)>=t}function so(n,e,t=Number.POSITIVE_INFINITY){return n.transaction(()=>{let s=n.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(e).c;if(s>t)return u.warn("DEDUP",`Skipping dedup backfill for project ${e}: ${s} rows exceeds cap ${t} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`),0;let r=n.prepare("SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?").all(e),o=n.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?"),i=n.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)"),a=new Map;for(let _ of r){o.run(xe(e,_.platform_source,_.title,Ae(_.agent_id,_.agent_type)),_.id);for(let E of new Set(V(_.title)))a.set(E,(a.get(E)??0)+1)}n.prepare("DELETE FROM token_df WHERE project = ?").run(e);for(let[_,E]of a)i.run(e,_,E);return n.prepare("INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0").run(e,r.length,r.length),r.length}).immediate()}function no(n,e,t){let s=Math.trunc(t.maxBackfillRows),r=Number.isSafeInteger(s)&&s<Number.MAX_SAFE_INTEGER?Math.max(0,s)+1:-1,o=n.prepare("SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC LIMIT ?").all(e,r);if(o.length<2)return 0;if(o.length>t.maxBackfillRows)return u.warn("DEDUP",`Skipping dedup sweep for project ${e}: more than ${t.maxBackfillRows} rows`),0;let{idfFn:i,docCount:a}=qs(n,e),_={cosineThreshold:t.cosineThreshold,vetoThetaIdf:Vs(t.idfVetoDf,a),minSharedTokens:t.minSharedTokens},E=o.map(h=>new Set(V(h.title))),d=new Map;for(let h of E)for(let T of h)d.set(T,(d.get(T)??0)+1);let c=Math.max(2,Math.ceil(Math.sqrt(o.length))*4),S=new Map;E.forEach((h,T)=>{for(let y of h){let k=d.get(y);if(k<2||k>c)continue;let p=S.get(y);p||(p=[],S.set(y,p)),p.push(T)}});let l=new Map;for(let h of S.values())for(let T=0;T<h.length;T++)for(let y=T+1;y<h.length;y++){let k=`${h[T]}:${h[y]}`;l.set(k,(l.get(k)??0)+1)}let m=Js(n),R=new Date().toISOString(),I=Date.now(),F=0;for(let[h,T]of l){if(T<t.minSharedTokens)continue;let[y,k]=h.split(":").map(Number),p=ut(o[y].title,o[k].title,i,_);p.tier==="candidate"&&(F+=m.run(o[k].id,o[y].id,e,p.method,p.score,"pending",R,I).changes)}return F}function Qs(n,e){return n.prepare("SELECT DISTINCT project FROM observations").all().map(s=>s.project).map(s=>{let r=so(n,s,e.maxBackfillRows),o=no(n,s,e);return{project:s,docs:r,candidates:o}})}function Zs(n,e,t,s,r){if(!s)return 0;let o=n.prepare("SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?").all(e,t,r.maxScan);if(o.length===0)return 0;let i=new Set(V(s));for(let m of o)for(let R of V(m.title))i.add(R);let{idfFn:a,docCount:_}=qs(n,e,i),E={cosineThreshold:r.cosineThreshold,vetoThetaIdf:Vs(r.idfVetoDf,_),minSharedTokens:r.minSharedTokens};o.length===r.maxScan&&u.debug("DEDUP",`Tier-1 scan hit MAX_SCAN=${r.maxScan} for project ${e}; older rows covered by dedup-scan`);let d=Js(n),c=new Date().toISOString(),S=Date.now(),l=0;for(let m of o){let R=ut(s,m.title,a,E);R.tier==="candidate"&&(l+=d.run(t,m.id,e,R.method,R.score,"pending",c,S).changes)}return l}function en(n,e,t,s,r){let o=Date.now()-s,i=r!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=r??e;return n.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${g}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${i}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,t,o)??void 0}var rn=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],ro=new Set(rn),tn=/<([A-Za-z_][A-Za-z0-9_-]*)/y,sn=/<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;function oo(n){let e=Object.fromEntries(rn.map(d=>[d,0]));if(!n.includes("<"))return{text:n,counts:e,total:0};let t=n.length,s=new Int32Array(t+1);s[t]=t;for(let d=t-1;d>=0;d--)s[d]=n.charCodeAt(d)===62?d:s[d+1];let r=new Map,o=[],i=0,a=0;for(;a<t;){if(n.charCodeAt(a)!==60){a+=1;continue}sn.lastIndex=a;let d=sn.exec(n);if(d){let S=d[1],l=r.get(S),m=l&&l.head<l.items.length?l.items[l.head]:void 0;m&&a>=m.attrEnd&&(l.head+=1,o.push([m.start,a+d[0].length]),e[S]+=1,i+=1),a+=d[0].length;continue}tn.lastIndex=a;let c=tn.exec(n);if(c&&ro.has(c[1])){let S=c[1],l=a+c[0].length,m={start:a,attrEnd:s[l]},R=r.get(S);R?R.items.push(m):r.set(S,{items:[m],head:0}),a=l;continue}a+=1}o.sort((d,c)=>d[0]-c[0]);let _="",E=0;for(let[d,c]of o)d>E&&(_+=n.slice(E,d)),c>E&&(E=c);return _+=n.slice(E),{text:_,counts:e,total:i}}var nn=100;function io(n){return ao(n,oo(n))}function ao(n,{text:e,counts:t,total:s}){return s>nn&&u.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:nn,contentLength:n.length}),{stripped:ae(e.trim(),me()).redacted,counts:t}}function Fe(n){return io(n).stripped}var _o=["task-notification"],Aa=new RegExp(`^\\s*<(${_o.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),fa=256*1024;function on(n,e,t){let s=Math.min(n.length,Math.max(0,Math.floor(e))),r=Math.max(s,n.length-Math.max(0,Math.floor(t))),o=i=>{let a=n.charCodeAt(i-1),_=n.charCodeAt(i);return a>=55296&&a<=56319&&_>=56320&&_<=57343};return o(s)&&s--,o(r)&&r++,{head:n.slice(0,s),tail:n.slice(r)}}var pt=4e3,mt="[media prompt]";function ne(n){let e=Fe(n).trim();return e.length<=pt?e:(u.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:e.length,storedLength:pt}),`${on(e,pt-1,0).head}\u2026`)}var Eo=require("bun:sqlite");var an=5e3,co=4194304,fe=75;function _n(n){let e=n.prepare("PRAGMA user_version");try{return e.get().user_version}finally{e.finalize()}}var Pe=class extends Error{reason="schema_newer_than_binary";constructor(e){super(e),this.name="SchemaNewerThanBinaryError"}};function Be(n,e){n.run(`PRAGMA busy_timeout = ${an}`);let t=_n(n);if(!(t<=e))throw new Pe(`SQLite database has schema v${t}; this claude-mem knows up to schema v${e}. Upgrade claude-mem before opening this database.`)}function Tt(n,e){Be(n,e),_n(n)<e&&n.run(`PRAGMA user_version = ${e}`)}function dn(n,e){n.transaction(()=>Tt(n,e)).immediate()}function lo(n){let e=n.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `);try{return e.get()!=null}finally{e.finalize()}}function _e(n,e,t){try{n.run(e)}catch(s){let r=s instanceof Error?s:new Error(String(s));throw u.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},r),s}}function St(n,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;_e(n,`PRAGMA busy_timeout = ${an}`,"busy_timeout"),_e(n,"PRAGMA foreign_keys = ON","foreign_keys"),_e(n,"PRAGMA synchronous = NORMAL","synchronous"),_e(n,`PRAGMA journal_size_limit = ${co}`,"journal_size_limit"),s&&!lo(n)&&_e(n,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&_e(n,"PRAGMA journal_mode = WAL","journal_mode")}var En=!1;function He(n,...e){return typeof n.iterate=="function"?n.iterate(...e):(En||(En=!0,u.warn("DB","bun:sqlite lacks Statement.iterate(); falling back to .all()",{bunVersion:typeof Bun<"u"?Bun.version:"unknown",requiredBunVersion:">=1.1.31",impact:"rows are materialized in memory; upgrade Bun to restore streaming"})),n.all(...e))}function gt(n){let e=`a.id IN (${n.candidateAttachmentIdsSql})
      AND a.state!='deleted'
      AND NOT EXISTS (SELECT 1 FROM media_event_refs r
        WHERE r.attachment_id=a.id AND NOT (${n.eventRefsBeingRemovedSql}))
      AND NOT EXISTS (SELECT 1 FROM observation_media_links l
        WHERE l.attachment_id=a.id AND NOT (${n.observationLinksBeingRemovedSql}))`;return[`INSERT OR IGNORE INTO media_cleanup_jobs (attachment_id, directory, queued_at)
      SELECT a.id, a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${e}`,`INSERT OR IGNORE INTO media_cloud_deletions (attachment_id, queued_at)
      SELECT a.id, CAST(strftime('%s','now') AS INTEGER)*1000 FROM media_attachments a
      WHERE ${e}
        AND a.origin='native' AND (a.upload_state='uploaded' OR a.upload_attempts>0)`,`UPDATE media_attachments SET state='deleted', upload_state='cancelled'
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${e})`]}var $e="SELECT event_key FROM media_events WHERE session_db_id=OLD.id",uo=gt({candidateAttachmentIdsSql:"SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id",eventRefsBeingRemovedSql:"0",observationLinksBeingRemovedSql:"l.observation_id=OLD.id"}),po=gt({candidateAttachmentIdsSql:`SELECT attachment_id FROM media_event_refs WHERE event_key IN (${$e})`,eventRefsBeingRemovedSql:`r.event_key IN (${$e})`,observationLinksBeingRemovedSql:"0"}),ya=gt({candidateAttachmentIdsSql:"SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey",eventRefsBeingRemovedSql:"r.event_key=$eventKey",observationLinksBeingRemovedSql:"0"});function cn(n){n.transaction(()=>{n.exec(`
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
    `),Re(n,"media_attachments","origin","TEXT NOT NULL DEFAULT 'native'"),Re(n,"media_attachments","upload_attempts","INTEGER NOT NULL DEFAULT 0"),Re(n,"media_attachments","upload_retry_at","INTEGER NOT NULL DEFAULT 0"),Re(n,"media_attachments","upload_error","TEXT"),n.exec("CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)"),Re(n,"media_events","carry_prompt_number","INTEGER"),n.exec(`CREATE INDEX IF NOT EXISTS idx_media_events_carry ON media_events(session_db_id, carry_prompt_number)
      WHERE carry_prompt_number IS NOT NULL`),n.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${uo.join(`;
        `)};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${po.join(`;
        `)};
        DELETE FROM media_event_refs WHERE event_key IN (${$e});
        DELETE FROM media_event_results WHERE event_key IN (${$e});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);let e=new Date().toISOString();n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(69,e),n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(70,e),n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(71,e),n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(72,e)})()}function Re(n,e,t,s){n.prepare(`PRAGMA table_info(${e})`).all().some(o=>o.name===t)||n.exec(`ALTER TABLE ${e} ADD COLUMN ${t} ${s}`)}var At="\\p{Script=Han}\\u31F0-\\u31FF\\uFF66-\\uFF9F\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF",ln=new RegExp(`[${At}]`,"u"),Ua=new RegExp(`[${At}]+|[^\\s${At}]+`,"gu");var Ba=1440*60*1e3;var We=n=>`(SELECT state = 'ready' OR ${n}.id <= cursor FROM tool_uses_search_schema WHERE id = 1)`,Va=`
CREATE TRIGGER tool_uses_fts_ai AFTER INSERT ON tool_uses WHEN ${We("new")} BEGIN
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response) VALUES(new.id, new.tool_input, new.tool_response);
END;
CREATE TRIGGER tool_uses_fts_ad AFTER DELETE ON tool_uses WHEN ${We("old")} BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    VALUES('delete', old.id, old.tool_input, old.tool_response);
END;
CREATE TRIGGER tool_uses_fts_au AFTER UPDATE OF id, tool_input, tool_response ON tool_uses
WHEN old.id IS NOT new.id OR old.tool_input IS NOT new.tool_input OR old.tool_response IS NOT new.tool_response BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    SELECT 'delete', old.id, old.tool_input, old.tool_response WHERE ${We("old")};
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response)
    SELECT new.id, new.tool_input, new.tool_response WHERE ${We("new")};
END;`;var Ao=require("bun:sqlite");var ft=`
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
`,Rt=`
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
`;var un=`(SELECT id, rev,
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
      END AS candidate FROM sync_outbox))`,fo=`(SELECT * FROM ${un} ORDER BY id LIMIT 1)`;var Xe=n=>`CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.${n}') END`,Ro={kind:"o.kind",localId:"o.origin_local_id",rev:"o.entity_rev",deleted:"o.deleted",project:Xe("project"),memory:Xe("memory_session_id"),content:Xe("content_session_id"),merged:Xe("merged_into_project")};var C_=ct("list_name");function pn(n){n.run(`CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
    id TEXT PRIMARY KEY, preview_token TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
    scope_json TEXT NOT NULL, epoch TEXT, status TEXT NOT NULL, pause_reason TEXT,
    created_at_epoch INTEGER NOT NULL, updated_at_epoch INTEGER NOT NULL)`),n.run(`CREATE TABLE IF NOT EXISTS sync_recovery_items (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, origin_local_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    selected_rev TEXT NOT NULL, selected_sha256 TEXT NOT NULL, estimated_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'selected', queued_rev TEXT, queued_sha256 TEXT, queued_epoch TEXT,
    acknowledged_epoch TEXT, detail TEXT, updated_at_epoch INTEGER NOT NULL,
    PRIMARY KEY(job_id, kind, origin_local_id))`),n.query("PRAGMA table_info(sync_recovery_items)").all().some(t=>t.name==="queued_epoch")||n.run("ALTER TABLE sync_recovery_items ADD COLUMN queued_epoch TEXT"),n.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_selection ON sync_recovery_items(job_id, status, kind, origin_local_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_entity_revision ON sync_recovery_items(entity_id, queued_rev, queued_sha256)"),n.run("CREATE INDEX IF NOT EXISTS idx_sync_recovery_jobs_active ON sync_recovery_jobs(device_id, status, created_at_epoch)"),n.run(`CREATE TABLE IF NOT EXISTS sync_recovery_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL, operation_sha256 TEXT NOT NULL, epoch TEXT, event TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL)`)}var An=5*6e4,mn=`
  CREATE TABLE IF NOT EXISTS sync_entity_heads (
    entity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_device_id TEXT NOT NULL,
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    updated_at_epoch INTEGER NOT NULL
  )`,Tn=`
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
  )`,Sn=`
  CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    through_rev TEXT NOT NULL,
    PRIMARY KEY (kind, origin_local_id)
  )`,O=n=>typeof n=="object"&&n!==null?JSON.stringify(n):n??null;function fn(n){let e=[],t=[],s=new Set,r=new Set;for(let o of n){for(let i of o.files_read??[])!i||s.has(i)||(s.add(i),e.push(i));for(let i of o.files_modified??[])!i||r.has(i)||(r.add(i),t.push(i))}return{files_read:e,files_edited:t}}var No=200,Oo=1e3,ho=56,bo=57;function Nt(n){let e=Number(n);return Number.isSafeInteger(e)&&e>0?e:void 0}function gn(n){return typeof n.merged_into_project=="string"&&n.merged_into_project?[n.project,n.merged_into_project]:[n.project]}var ht=class{db;syncOpsEnabled;statementCache=new Map;localSyncDeviceId="";constructor(e=Je,t={}){this.syncOpsEnabled=t.syncOpsEnabled??!0,e instanceof Ot.Database?this.db=e:(e!==":memory:"&&ze(C),this.db=new Ot.Database(e)),Be(this.db,fe),St(this.db),dn(this.db,fe),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable(),this.ensureCommittedToolUsesTable(),this.ensureDeletedSessionCutoffTriggers(),this.ensureTelegramWrapupsTable(),this.addDedupTables(),this.refreshUnicodeTitleNormKeys(),this.ensureReinforcementColumns(),this.ensureSessionCwdColumn(),this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(),this.ensureProjectNocaseIndexes(),this.ensureAdvisorCallsTable(),this.ensureSessionProjectKeySourceColumn(),this.requeuePromptsDeadLetteredForSize(),this.ensureWorkStateTable(),this.ensureDeliverablesTable(),this.ensureHookSpoolConsumedTable(),this.ensureProjectRecencyIndexes(),this.ensureMergedIntoProjectCoveringIndexes(),this.ensureNativePromptIdentity(),this.ensureObservationFileIndex(),cn(this.db)}ensureObservationFileIndex(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 68").get())return;this.db.run(`CREATE TABLE IF NOT EXISTS observation_files (
        path TEXT NOT NULL,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        PRIMARY KEY (path, observation_id)
      )`),this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_files_observation ON observation_files(observation_id)");let e=t=>`SELECT o.id, je.value FROM observations o, json_each(o.${t}) je
         WHERE json_valid(o.${t}) AND json_type(o.${t}) = 'array' AND je.type = 'text'`;this.db.run(`INSERT OR IGNORE INTO observation_files(observation_id, path)
        ${e("files_read")} UNION ${e("files_modified")}`),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(68,new Date().toISOString())}).immediate()}indexObservationFiles(e,t,s){let r=new Set;for(let i of[...t,...s])typeof i=="string"&&i.length>0&&r.add(i);if(r.size===0)return;let o=this.db.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let i of r)o.run(i,e)}ensureNativePromptIdentity(){this.db.transaction(()=>{let e=this.db.query("PRAGMA table_info(user_prompts)").all();for(let t of["native_prompt_id","native_prompt_hash"])e.some(s=>s.name===t)||this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${t} TEXT`);this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_native_identity
        ON user_prompts(session_db_id, native_prompt_id) WHERE native_prompt_id IS NOT NULL`)}).immediate()}refreshUnicodeTitleNormKeys(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 65").get())return;let e=this.db.prepare(`SELECT o.id, o.project, o.title, o.agent_id, o.agent_type,
        s.platform_source FROM observations o LEFT JOIN sdk_sessions s
        ON s.memory_session_id = o.memory_session_id ORDER BY o.id`),t=this.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?");try{for(let s of He(e)){let r=s;t.run(xe(r.project,r.platform_source,r.title,Ae(r.agent_id,r.agent_type)),r.id)}this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(65,new Date().toISOString())}finally{e.finalize(),t.finalize()}}).immediate()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(r=>{if(r.unique!==1)return!1;let o=this.getIndexColumns(r.name);return o.length===t.length&&o.every((i,a)=>i===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let r=s?f(s):void 0;return r?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(g,r,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${g}')
        WHEN '${g}' THEN 0
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(ho,new Date().toISOString())}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),u.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(r){u.warn("DB","Failed to drop worker_pid column from pending_messages",{},r instanceof Error?r:new Error(String(r)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!t&&s&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${g}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${g}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let a=i instanceof Error?i:new Error(String(i));throw u.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),i}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${g}',
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
        COALESCE(NULLIF(platform_source, ''), '${g}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let r=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&r&&!i)return;let a=r?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${g}')
            WHEN '${g}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${g}')
            WHEN '${g}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let E=_ instanceof Error?_:new Error(String(_));throw u.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},E),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,t){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw u.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),r}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(r=>r.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),u.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let t=this.db.query(`PRAGMA table_info(${e})`).all(),s=new Set(t.map(r=>r.name));s.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),u.debug("DB",`Added origin_device_id column to ${e} table`)),s.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),u.debug("DB",`Added origin_local_id column to ${e} table`)),s.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),u.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(i,a)=>this.db.query(`PRAGMA table_info(${i})`).all().find(_=>_.name===a),s=i=>i?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(i=>s(t(i.table,i.column))))return;this.db.transaction(()=>{for(let i of e){let a=this.db.query(`PRAGMA table_info(${i.table})`).all(),_=a.find(d=>d.name===i.column);if(!_)throw new Error(`schema v46: missing ${i.table}.${i.column}`);for(let d of He(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${i.column}) AS storage_type,
                 CAST(${i.column} AS TEXT) AS revision
          FROM ${i.table}
        `))){let c=d;if(c.storage_type==="real")throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} is REAL and unrecoverably rounded`);if(c.storage_type!=="integer"&&c.storage_type!=="text")throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} has unsupported ${c.storage_type} storage`);try{Se(c.revision,{positive:!0})}catch{throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} is not a positive canonical uint64 revision`)}}if(s(_))continue;if(a.some(d=>d.name===i.temporary))throw new Error(`schema v46: unexpected temporary column ${i.table}.${i.temporary}`);this.db.run(`ALTER TABLE ${i.table} ADD COLUMN ${i.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${i.table} SET ${i.temporary} = CAST(${i.column} AS TEXT)`);let E=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${i.table}
          WHERE ${i.temporary} <> CAST(${i.column} AS TEXT)
          LIMIT 1
        `).get();if(E)throw new Error(`schema v46: failed to copy ${i.table}.${i.column} row ${E.row_id} exactly`);this.db.run(`ALTER TABLE ${i.table} DROP COLUMN ${i.column}`),this.db.run(`ALTER TABLE ${i.table} RENAME COLUMN ${i.temporary} TO ${i.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){pn(this.db),this.db.run(mn),this.widenSyncKindCheck("sync_entity_heads",mn),this.db.run(Tn),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(t=>t.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `)),this.widenSyncKindCheck("sync_content_outbox",Tn),this.db.run("CREATE INDEX IF NOT EXISTS idx_sync_content_outbox_kind_pending ON sync_content_outbox(kind, deleted DESC, id)"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}widenSyncKindCheck(e,t){let s=this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(e);if(!s||s.sql.includes("'work_state'"))return;let r=this.db.query(`PRAGMA table_info(${e})`).all().map(i=>i.name).join(", "),o=`${e}_pre_work_state`;this.db.transaction(()=>{this.db.run(`DROP TABLE IF EXISTS ${o}`),this.db.run(`ALTER TABLE ${e} RENAME TO ${o}`),this.db.run(t),this.db.run(`INSERT INTO ${e} (${r}) SELECT ${r} FROM ${o}`),this.db.run(`DROP TABLE ${o}`)}).immediate(),u.info("DB",`Rebuilt ${e} to admit the work_state sync kind`)}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],t=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!==void 0;this.db.run(Sn),this.widenSyncKindCheck("sync_launch_exclusions",Sn);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:d,kind:c}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${d}
            WHERE origin_device_id IS NULL
          `).run(c),this.db.prepare(`
            UPDATE ${d} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let E=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,E),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,E)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&t)return;let o=Date.parse(s.applied_at);if(!Number.isSafeInteger(o)||o<0)throw new Error(`schema v48: invalid v47 applied_at ${s.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:_}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(_,o);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}normalizeConceptTags(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49))return;let t=0;this.db.transaction(()=>{let r=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM observations
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `).all();t=r.length,this.db.run(`
        UPDATE observations
        SET concepts = (
          SELECT json_group_array(
            CASE WHEN instr(value, ':') > 0
                 THEN trim(substr(value, 1, instr(value, ':') - 1))
                 ELSE value END)
          FROM json_each(observations.concepts))
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `);for(let o of r){if(o.origin_device_id!==null)continue;let i=ke(o.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(i,o.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),u.debug("DB",`Normalized prefixed concept tags in ${t} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>s.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),u.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),u.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),u.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),u.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),u.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),u.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}repairOrphanedSessionParents(e){let t=this.db.prepare(`
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
    `),u.warn("DB",`Created ${t} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(s=>s.table==="sdk_sessions"&&s.from==="memory_session_id"&&s.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,t,s){let r=this.db.query(`PRAGMA table_info(${e})`).all(),o=r.filter(i=>!s.includes(i.name));for(let i of o){let a=i.type?` ${i.type}`:"",_=i.dflt_value===null||i.dflt_value===void 0?"":` DEFAULT ${i.dflt_value}`;this.db.run(`ALTER TABLE ${t} ADD COLUMN "${i.name}"${a}${_}`),u.debug("DB",`Carried ${i.name} over the ${e} rebuild (#3849)`)}return r.map(i=>i.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}u.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let s=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],o=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!s.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `);for(let a of o){let _=a.type?` ${a.type}`:"",E=a.dflt_value===null||a.dflt_value===void 0?"":` DEFAULT ${a.dflt_value}`;this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${a.name}"${_}${E}`),u.debug("DB",`Carried ${a.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`)}let i=[...s,...o.map(a=>a.name)].map(a=>`"${a}"`).join(", ");this.db.run(`
      INSERT INTO session_summaries_new (${i})
      SELECT ${i}
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.recreateFtsTriggersIfIndexed("session_summaries"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),u.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}u.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),u.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}u.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.recreateFtsTriggersIfIndexed("observations"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),u.debug("DB","Successfully made observations.text nullable")}recreateFtsTriggersIfIndexed(e){let t=`${e}_fts`;this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(t).length>0&&(this.db.run(`INSERT INTO ${t}(${t}) VALUES('rebuild')`),this.db.run(e==="observations"?ft:Rt))}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}u.debug("DB","Creating user_prompts table"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),u.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){this.db.query("PRAGMA table_info(observations)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),u.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),u.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}u.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),u.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;u.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),_=a.some(d=>d.name===o);return a.some(d=>d.name===i)?!1:_?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),u.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(u.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?u.debug("DB",`Successfully renamed ${t} session ID columns`):u.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),u.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),t=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!t){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}u.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let s=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],r=`
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
    `,o=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,i=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","discovery_tokens","created_at","created_at_epoch"],a=`
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
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(r,s,o)),t&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(a,i,_)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),u.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(E){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),E instanceof Error?E:new Error(String(E))}}recreateObservationsWithCascade(e,t,s){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("observations","observations_new",t).map(i=>`"${i}"`).join(", ");this.db.run(`INSERT INTO observations_new (${o}) SELECT ${o} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.recreateFtsTriggersIfIndexed("observations")}recreateSessionSummariesWithCascade(e,t,s){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",t).map(i=>`"${i}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${o}) SELECT ${o} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.recreateFtsTriggersIfIndexed("session_summaries")}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),u.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),u.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&r||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${g}'`),u.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${g}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(r=>r.name==="generated_by_model"),s=e.some(r=>r.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),t=e.some(r=>r.name==="observed_model"),s=e.some(r=>r.name==="observed_billing");t&&s||(t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){es(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(75,new Date().toISOString())}ensureDeliverablesTable(){ds(this.db)}recordDeliverable(e){return Es(this.db,e)}getDeliverable(e){return cs(this.db,e)}ensureWorkStateTable(){Fs(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(66,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(67,new Date().toISOString())}ensureProjectRecencyIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63,new Date().toISOString())}ensureMergedIntoProjectCoveringIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_project ON observations(merged_into_project COLLATE NOCASE, project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_project ON session_summaries(merged_into_project COLLATE NOCASE, project)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(64,new Date().toISOString())}ensureHookSpoolConsumedTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS hook_spool_consumed (
        entry_key TEXT PRIMARY KEY,
        consumed_at_epoch_ms INTEGER NOT NULL
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(62,new Date().toISOString())}ensureCommittedToolUsesTable(){this.db.run(`
      CREATE TABLE IF NOT EXISTS committed_observation_tool_uses (
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        committed_at_epoch_ms INTEGER NOT NULL,
        PRIMARY KEY (platform_source, content_session_id, tool_use_id)
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS deleted_content_sessions (
        platform_source TEXT NOT NULL,
        content_session_id TEXT NOT NULL,
        deleted_at_epoch_ms INTEGER NOT NULL,
        PRIMARY KEY (platform_source, content_session_id)
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS deleted_memory_sessions (
        memory_session_id TEXT PRIMARY KEY,
        deleted_at_epoch_ms INTEGER NOT NULL
      )
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(73,new Date().toISOString())}ensureDeletedSessionCutoffTriggers(){this.db.transaction(()=>{for(let e of["prevent_deleted_sdk_session_insert","prevent_deleted_sdk_session_update","prevent_deleted_tool_use_insert","prevent_deleted_tool_use_update"])this.db.run(`DROP TRIGGER IF EXISTS ${e}`);this.db.run(`
        CREATE TRIGGER IF NOT EXISTS block_pre_deletion_sdk_session_insert
        BEFORE INSERT ON sdk_sessions
        WHEN EXISTS (
          SELECT 1 FROM deleted_content_sessions
          WHERE platform_source = NEW.platform_source
            AND content_session_id = NEW.content_session_id
            AND NEW.started_at_epoch <= deleted_at_epoch_ms
        ) OR EXISTS (
          SELECT 1 FROM deleted_memory_sessions
          WHERE memory_session_id = NEW.memory_session_id
        )
        BEGIN SELECT RAISE(ABORT, 'session_deleted'); END
      `),this.db.run(`
        CREATE TRIGGER IF NOT EXISTS block_deleted_sdk_session_rekey
        BEFORE UPDATE OF memory_session_id, content_session_id, platform_source ON sdk_sessions
        WHEN EXISTS (
          SELECT 1 FROM deleted_memory_sessions
          WHERE memory_session_id = NEW.memory_session_id
        ) OR (
          (NEW.content_session_id IS NOT OLD.content_session_id OR NEW.platform_source IS NOT OLD.platform_source)
          AND EXISTS (
            SELECT 1 FROM deleted_content_sessions
            WHERE platform_source = NEW.platform_source
              AND content_session_id = NEW.content_session_id
          )
        )
        BEGIN SELECT RAISE(ABORT, 'session_deleted'); END
      `);for(let[e,t]of[["block_pre_deletion_tool_use_insert","INSERT"],["block_pre_deletion_tool_use_update","UPDATE"]])this.db.run(`
          CREATE TRIGGER IF NOT EXISTS ${e}
          BEFORE ${t} ON tool_uses
          WHEN EXISTS (
            SELECT 1 FROM deleted_content_sessions
            WHERE platform_source = NEW.platform_source
              AND content_session_id = NEW.content_session_id
          ) AND NOT EXISTS (
            SELECT 1 FROM sdk_sessions
            WHERE id = NEW.session_db_id
              AND platform_source = NEW.platform_source
              AND content_session_id = NEW.content_session_id
          )
          BEGIN SELECT RAISE(ABORT, 'session_deleted'); END
        `);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(74,new Date().toISOString())})()}hasCommittedToolUse(e,t,s){return!t||!s?!1:this.db.prepare(`
      SELECT 1 FROM committed_observation_tool_uses
      WHERE platform_source = ? AND content_session_id = ? AND tool_use_id = ?
    `).get(f(e),t,s)!=null}markSessionDeleted(e,t,s){let r=Date.now();this.db.prepare(`
      INSERT INTO deleted_content_sessions
        (platform_source, content_session_id, deleted_at_epoch_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(platform_source, content_session_id)
      DO UPDATE SET deleted_at_epoch_ms = MAX(deleted_at_epoch_ms, excluded.deleted_at_epoch_ms)
    `).run(f(e),t,r),s&&this.db.prepare(`
        INSERT OR IGNORE INTO deleted_memory_sessions
          (memory_session_id, deleted_at_epoch_ms)
        VALUES (?, ?)
      `).run(s,r)}isSessionDeleted(e,t){return this.getSessionDeletedAtEpochMs(e,t)!==null}getSessionDeletedAtEpochMs(e,t){return this.db.prepare(`
      SELECT deleted_at_epoch_ms FROM deleted_content_sessions
      WHERE platform_source = ? AND content_session_id = ?
    `).get(f(e),t)?.deleted_at_epoch_ms??null}isBeforeSessionDeletion(e,t,s){let r=this.getSessionDeletedAtEpochMs(e,t);return r===null?!1:!(typeof s=="number"&&Number.isFinite(s)&&s>r)}markCommittedToolUses(e){if(!e.contentSessionId)throw new Error("Committed tool uses require a content session");let t=this.db.prepare(`
      INSERT OR IGNORE INTO committed_observation_tool_uses
      (platform_source, content_session_id, tool_use_id, committed_at_epoch_ms)
      VALUES (?, ?, ?, ?)
    `),s=f(e.platformSource),r=Date.now();this.db.transaction(()=>{for(let o of new Set(e.toolUseIds))o&&t.run(s,e.contentSessionId,o,r)})()}isHookSpoolEntryConsumed(e){return this.db.prepare("SELECT 1 FROM hook_spool_consumed WHERE entry_key = ?").get(e)!=null}markHookSpoolEntryConsumed(e,t){this.db.prepare("INSERT INTO hook_spool_consumed (entry_key, consumed_at_epoch_ms) VALUES (?, ?) ON CONFLICT(entry_key) DO UPDATE SET consumed_at_epoch_ms = excluded.consumed_at_epoch_ms").run(e,t)}clearHookSpoolEntryConsumed(e){this.db.prepare("DELETE FROM hook_spool_consumed WHERE entry_key = ?").run(e)}pruneHookSpoolConsumedMarkersBefore(e){this.db.prepare("DELETE FROM hook_spool_consumed WHERE consumed_at_epoch_ms < ?").run(e)}ensureTelegramWrapupsTable(){this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())}ensureReinforcementColumns(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(t=>t.name==="reinforcement_dates")||this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT"),e.some(t=>t.name==="last_reinforced")||this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(bo,new Date().toISOString())}dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(){let e=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map(s=>s.name),t=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();if(e.length>0||t.length>0){this.db.run("BEGIN TRANSACTION");try{e.includes("observations_au")&&(this.db.run("DROP TRIGGER observations_au"),this.db.run(ft)),e.includes("session_summaries_au")&&(this.db.run("DROP TRIGGER session_summaries_au"),this.db.run(Rt)),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_fts"),this.db.run("COMMIT")}catch(s){throw this.db.run("ROLLBACK"),u.error("DB","Failed to scope FTS update triggers / drop user_prompts_fts, rolled back",{},s instanceof Error?s:new Error(String(s))),s}u.info("DB","Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts",{rescopedTriggers:e,droppedUserPromptsFts:t.length>0})}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}requeuePromptsDeadLetteredForSize(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60))return;let t="canonical content: body exceeds % UTF-8 bytes";this.db.transaction(()=>{let s=this.db.prepare(`
        UPDATE user_prompts SET synced_at = NULL
        WHERE synced_at = -1 AND origin_device_id IS NULL
          AND CAST(id AS TEXT) IN (
            SELECT origin_local_id FROM sync_dead_letter
            WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
          )
      `).run(t);this.db.prepare(`
        DELETE FROM sync_dead_letter WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
      `).run(t),s.changes>0&&u.info("DB","Re-queued prompts quarantined for size before the cloud-sync prompt clamp",{prompts:s.changes}),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(60,new Date().toISOString())})()}ensureSessionProjectKeySourceColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="project_key_source")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN project_key_source TEXT"),u.debug("DB","Added project_key_source column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(59,new Date().toISOString())}ensureSessionCwdColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="cwd")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN cwd TEXT"),u.debug("DB","Added cwd column to sdk_sessions table (#2864)")),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_cwd ON sdk_sessions(cwd)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(53,new Date().toISOString())}ensureProjectNocaseIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase ON observations(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase ON observations(merged_into_project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase ON session_summaries(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase ON session_summaries(merged_into_project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase ON sdk_sessions(project COLLATE NOCASE)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(55,new Date().toISOString())}ensureAdvisorCallsTable(){this.db.run(`
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
    `).run(e.sessionDbId,e.contentSessionId,e.project,e.platformSource,e.toolUseId,e.advisorModel??null,e.cwd??null,e.lastUserMessage??null,e.transcriptPath??null,e.transcriptByteOffset??null,e.advice,e.occurredAtEpoch,t.toISOString(),t.getTime());return s.changes>0?{id:Number(s.lastInsertRowid),inserted:!0}:{id:this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(e.toolUseId)?.id??0,inserted:!1}}getAdvisorCalls(e,t,s,r){let o="SELECT * FROM advisor_calls",i=[],a=[];s?(a.push("project = ?"),i.push(s)):(a.push("project != ?"),i.push(oe)),r&&(a.push("platform_source = ?"),i.push(r)),o+=` WHERE ${a.join(" AND ")}`,o+=" ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?",i.push(t+1,e);let _=this.db.prepare(o).all(...i);return{items:_.slice(0,t),hasMore:_.length>t,offset:e,limit:t}}getAdvisorCallById(e){return this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(e)??null}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="agent_type"),r=t.some(i=>i.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(_=>_.name==="agent_type"),a=o.some(_=>_.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw u.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),r}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="memory_session_id"),r=t.some(o=>o.name==="content_hash");if(!s||!r){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw u.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),u.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){let s=this.db.prepare(`
      SELECT memory_session_id
      FROM sdk_sessions
      WHERE id = ?
    `).get(e);!s||s.memory_session_id===t||this.db.transaction(()=>{this.db.prepare(`
        UPDATE sdk_sessions
        SET memory_session_id = ?
        WHERE id = ?
      `).run(t,e),this.db.prepare(`
        UPDATE tool_uses
        SET memory_session_id = ?
        WHERE session_db_id = ?
      `).run(t,e),t&&this.requeuePromptSync(e)})()}enqueueMutationOp(e,t){if(!this.syncOpsEnabled)return;let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let r=s.target;r?.origin_device_id===null&&(r.origin_device_id="self")}Et(s),t.op==="set_prompt_session"&&this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(t.target?.origin_device_id??null,String(t.target?.origin_local_id??"")),this.cachedStatement(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,Ne.randomUUID)(),String(e),JSON.stringify(t),Date.now())}requeuePromptSync(e){if(!this.syncOpsEnabled)return;let t=this.cachedStatement(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let r=this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(r.length===0)return;let o=this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);for(let i of r){let a=ke(i.sync_rev);o.run(a,i.id),this.enqueueMutationOp(a,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:i.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s,t,e)}reopenCompletedSession(e){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', completed_at = NULL, completed_at_epoch = NULL
      WHERE id = ? AND status = 'completed'
    `).run(e)}ensureMemorySessionIdRegistered(e,t,s){let r=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!r)throw new Error(`Session ${e} not found in sdk_sessions`);return r.memory_session_id===null?(this.db.transaction(()=>{this.db.prepare(`
          UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
        `).run(t,e),this.requeuePromptSync(e)})(),u.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,newId:t})):r.memory_session_id!==t&&u.debug("DB","Keeping the registered memory_session_id",{sessionDbId:e,registered:r.memory_session_id,offered:t}),typeof s=="number"&&r.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e),r.memory_session_id??t}getProjectReadKeys(e){return Xt(this.db,e)}getAllProjects(e){let t=e?f(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,r=[oe];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",r.push(g,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${g}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${g}'), project
      ORDER BY latest_epoch DESC
    `).all(oe),t=[],s=new Set,r=Object.create(null);for(let i of e){let a=f(i.platform_source);r[a]||(r[a]=[]),r[a].includes(i.project)||r[a].push(i.project),s.has(i.project)||(s.add(i.project),t.push(i.project))}let o=zt(Object.keys(r));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getSessionCatalog(e={}){let t=Math.min(Math.max(Math.trunc(e.limit??No),1),Oo),s=Math.max(Math.trunc(e.offset??0),0),r=`
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${g}') as platform_source,
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
    `,o=[oe];e.project&&(r+=" AND s.project COLLATE NOCASE = ?",o.push(e.project)),e.platformSource&&(r+=` AND COALESCE(s.platform_source, '${g}') = ?`,o.push(f(e.platformSource))),r+=" ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?",o.push(t+1,s);let i=this.db.prepare(r).all(...o);return{sessions:i.slice(0,t),hasMore:i.length>t}}getUserPromptById(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${g}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ?
    `).get(e)}findRecentDuplicateUserPrompt(e,t,s,r){return en(this.db,e,ne(t),s,this.resolvePromptSessionDbId(e,r)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let r=[e],o="";return s&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?`,r.push(f(s))),r.push(t),this.db.prepare(`
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
        ${o}
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(...r)}getObservationsForSession(e,t){let s=[e],r="";return t&&(r=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?
        )
      `,s.push(f(t))),this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${r}
      ORDER BY created_at_epoch ASC
    `).all(...s)}getObservationById(e,t){return t?this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?
    `).get(e,f(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return ts(this.db,e)}linkToolUsesToObservation(e){return ss(this.db,e)}getToolUsesByIds(e,t={}){return rs(this.db,e,t)}queryToolUses(e={}){return os(this.db,e)}queryToolUseIndex(e={}){return is(this.db,e)}appendWorkStateEntry(e){let t=Ps(this.db,e);return ee({projects:[e.project]},"appendWorkStateEntry","additive",{kinds:["work_state"],workStateLists:[e.listName]}),t}setLocalSyncDeviceId(e){this.localSyncDeviceId=e}getLocalSyncDeviceId(){return this.localSyncDeviceId}getWorkStateEntries(e,t){return xs(Bs(this.db,this.getProjectReadKeys(e),t,this.localSyncDeviceId),e)}countToolUses(e={}){return _s(this.db,e)}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:r,type:o,concepts:i,files:a}=t,_=Nt(t.limit),E=$(t),d=s==="relevance",c=s==="date_asc"?"ASC":"DESC",S=d?"":`ORDER BY o.created_at_epoch ${c}, o.id ${c}`,l=_&&!d?"LIMIT ?":"",m=e.map(()=>"?").join(","),R=[...e],I=[];if(E.length>0){let p=X("o",E,{includeMerged:!0});I.push(p.sql),R.push(...p.params)}if(r&&(I.push(`COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?`),R.push(f(r))),o)if(Array.isArray(o)){let p=o.map(()=>"?").join(",");I.push(`o.type IN (${p})`),R.push(...o)}else I.push("o.type = ?"),R.push(o);if(i){let p=Array.isArray(i)?i:[i],D=`CASE WHEN json_valid(o.concepts) THEN CASE
        WHEN json_type(o.concepts) = 'array' THEN o.concepts
        WHEN json_type(o.concepts) = 'text' THEN json_array(json_extract(o.concepts, '$'))
        ELSE json_array(o.concepts) END ELSE json_array(o.concepts) END`,b=p.map(()=>`EXISTS (SELECT 1 FROM json_each(${D}) WHERE type = 'text' AND value = ?)`);b.length>0&&(R.push(...p),I.push(`(${b.join(" OR ")})`))}if(a){let p=Array.isArray(a)?a:[a],D=A=>`CASE WHEN json_valid(${A}) THEN CASE WHEN json_type(${A}) = 'array' THEN ${A} ELSE '[]' END ELSE '[]' END`,b=p.map(()=>`(EXISTS (SELECT 1 FROM json_each(${D("o.files_read")}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(${D("o.files_modified")}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\'))`);b.length>0&&(p.forEach(A=>{let P=A.replace(/\\/g,"/").replace(/[\\%_]/g,"\\$&");R.push(`%${P}%`,`%${P}%`)}),I.push(`(${b.join(" OR ")})`))}let F=I.length>0?`WHERE o.id IN (${m}) AND ${I.join(" AND ")}`:`WHERE o.id IN (${m})`;l&&R.push(_);let T=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${F}
      ${S}
      ${l}
    `).all(...R);if(!d)return T;let y=new Map(T.map(p=>[p.id,p])),k=e.map(p=>y.get(p)).filter(p=>!!p);return _?k.slice(0,_):k}getSummaryForSession(e,t){let s=[e],r="";return t&&(r=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${g}') = ?
        )
      `,s.push(f(t))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${r}
      ORDER BY created_at_epoch DESC, id DESC
      LIMIT 1
    `).get(...s)||null}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${g}') as platform_source,
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
    `).get(g,f(t),e)?.id??null}claimTelegramWrapup({platformSource:e,contentSessionId:t,project:s,routeKey:r,summaryCreatedAtEpoch:o}){let i=Date.now();return this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(f(e),t,s,r,o,i).changes===1?!0:this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(o,i,f(e),t,s,r,i-An).changes===1}markTelegramWrapupSent({platformSource:e,contentSessionId:t,project:s,routeKey:r}){this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(Date.now(),f(e),t,s,r)}releaseTelegramWrapupClaim({platformSource:e,contentSessionId:t,project:s,routeKey:r}){this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(f(e),t,s,r)}setSessionObservedMetadata(e,t,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(t||null,s||null,e)}getSdkSessionsBySessionIds(e,t=[]){if(e.length===0&&t.length===0)return[];let s=[...new Set(e),...new Set(t)],r=new Map;for(let o=0;o<s.length;o+=500){let i=s.slice(o,o+500),a=i.filter(c=>typeof c=="string"),_=i.filter(c=>typeof c=="number"),E=[];a.length&&E.push(`memory_session_id IN (${a.map(()=>"?").join(",")})`),_.length&&E.push(`id IN (SELECT session_db_id FROM user_prompts WHERE id IN (${_.map(()=>"?").join(",")}))`);let d=this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project,
               COALESCE(platform_source, '${g}') as platform_source,
               user_prompt, custom_title,
               started_at, started_at_epoch, completed_at, completed_at_epoch, status
        FROM sdk_sessions
        WHERE ${E.join(" OR ")}
        ORDER BY started_at_epoch DESC
      `);for(let c of d.all(...i))r.set(c.id,c)}return[...r.values()].sort((o,i)=>i.started_at_epoch-o.started_at_epoch)}getPromptNumberFromUserPrompts(e,t,s){let r=this.resolvePromptSessionDbId(e,t),o=r!==null?"session_db_id = ?":"content_session_id = ?",i=r!==null?r:e;return s!==void 0?this.db.prepare(`
        SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${o} AND created_at_epoch <= ?
      `).get(i,s).count:this.db.prepare(`
      SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${o}
    `).get(i).count}getLatestPromptTextFromUserPrompts(e,t){let s=this.resolvePromptSessionDbId(e,t),r=s!==null?"session_db_id = ?":"content_session_id = ?",o=s!==null?s:e;return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${r}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(o)?.prompt_text??null}getNewestCapturedActivityEpoch(){return this.db.prepare(`
      SELECT MAX(newest) AS newest FROM (
        SELECT MAX(created_at_epoch) AS newest FROM user_prompts WHERE origin_device_id IS NULL
        UNION ALL
        SELECT MAX(created_at_epoch) AS newest FROM tool_uses
      )
    `).get()?.newest??null}createSDKSession(e,t,s,r,o,i){let a=new Date,_=a.getTime(),E=o?f(o):g;if(this.isBeforeSessionDeletion(E,e,i))throw new Error("session_deleted");let d=ne(s);return r&&this.validateSetTitleMutation(e,E,r),this.db.transaction(()=>{let c=this.db.prepare(`
        SELECT id, platform_source
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
      `).get(g,E,e);if(c){if(t&&this.db.prepare(`
            UPDATE sdk_sessions SET project = ?
            WHERE id = ? AND (project IS NULL OR project = '' OR (project = 'unknown' AND cwd IS NULL))
          `).run(t,c.id),d&&d!==mt&&this.db.prepare(`
            UPDATE sdk_sessions SET user_prompt = ?
            WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
          `).run(d,c.id,mt),r){let l=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(c.id);l&&l.custom_title===null&&(this.db.prepare(`
              UPDATE sdk_sessions SET custom_title = ?
              WHERE id = ? AND custom_title IS NULL
            `).run(r,c.id),this.enqueueSetTitleOp(e,E,r))}return c.id}let S=this.db.prepare(`
        INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
      `).run(e,t,E,d,r||null,a.toISOString(),_);return r&&this.enqueueSetTitleOp(e,E,r),Number(S.lastInsertRowid)}).immediate()}setSessionCwd(e,t,s){t.trim()&&this.db.prepare("UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL").run(t,s??null,e)}getSessionCwd(e){return this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(e)?.cwd??null}enqueueSetTitleOp(e,t,s){let r=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",r)}validateSetTitleMutation(e,t,s){let r={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return Et(r),r}promptCommitted(e,t){if(this.db.inTransaction)return;let s=t===null?null:this.db.prepare("SELECT project FROM sdk_sessions WHERE id = ?").get(t);ee(s?{projects:[s.project]}:"all",e,"additive",{kinds:["prompt"]})}saveUserPrompt(e,t,s,r,o,i,a){let _=new Date(a??Date.now()),E=_.getTime(),d=ne(s),c=this.resolvePromptSessionDbId(e,r),l=this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id, native_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c,e,t,d,_.toISOString(),E,o??null,i??null);return this.promptCommitted("saveUserPrompt",c),l.lastInsertRowid}saveNativeUserPrompt(e,t,s,r,o=r,i={}){if(!s||s.length>256||/[\s\x00-\x1f\x7f]/.test(s))throw new Error("Invalid native prompt identity");let a=ne(r),_=(0,Ne.createHash)("sha256").update(Fe(o).trim()).digest("hex"),E=this.db.transaction(()=>{let d=this.db.prepare(`SELECT id, prompt_number, native_prompt_hash FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id = ?`).get(t,s);if(d){if(d.native_prompt_hash!==_)throw new Error("Native prompt identity was reused with different text");return{id:d.id,promptNumber:d.prompt_number,duplicate:!0}}let c=this.getPromptNumberFromUserPrompts(e,t)+1;return i.reopenSession!==!1&&this.reopenCompletedSession(t),{id:this.saveUserPrompt(e,c,a,t,s,_,i.createdAtEpoch),promptNumber:c,duplicate:!1}}).immediate();return E.duplicate||this.promptCommitted("saveNativeUserPrompt",t),E}importTranscriptUserPrompt(e){let t=ne(e.promptText);if(!t)return{reason:"private"};let s=f(e.platformSource);if(this.isBeforeSessionDeletion(s,e.contentSessionId,e.createdAtEpoch))return{reason:"deleted"};let o=this.db.prepare(`SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?`).get(g,s,e.contentSessionId)?.id;if(o!==void 0){let a=[t,...(e.hookTextVariants??[]).map(ne).filter(Boolean)],E=this.db.prepare(`SELECT id, created_at_epoch FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id IS NULL
          AND prompt_text IN (${a.map(()=>"?").join(", ")})
          AND ABS(created_at_epoch - ?) <= ?
        ORDER BY ABS(created_at_epoch - ?), id`).all(o,...a,e.createdAtEpoch,e.hookMatchWindowMs,e.createdAtEpoch).find(d=>!e.claimedHookRowIds.has(d.id));if(E)return e.claimedHookRowIds.add(E.id),{reason:"recorded-by-hook",hookRowId:E.id}}else{let a=new Date(e.createdAtEpoch).toISOString(),_=this.db.prepare(`INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'completed')`).run(e.contentSessionId,e.project,s,t,a,e.createdAtEpoch,a,e.createdAtEpoch);o=Number(_.lastInsertRowid)}return{reason:this.saveNativeUserPrompt(e.contentSessionId,o,`transcript:${e.nativePromptId}`,e.promptText,e.promptText,{createdAtEpoch:e.createdAtEpoch,reopenSession:!1}).duplicate?"already-imported":"new"}}listHookRecordedPrompts(e){return this.db.prepare(`SELECT up.id, COALESCE(NULLIF(s.platform_source, ''), ?) AS platformSource,
        s.content_session_id AS contentSessionId, s.project, s.cwd, up.prompt_text AS promptText, up.created_at_epoch AS createdAtEpoch
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
      WHERE up.created_at_epoch >= ? AND s.project != ?
        AND (up.native_prompt_id IS NULL OR up.native_prompt_id NOT LIKE 'transcript:%')
      ORDER BY up.created_at_epoch, up.id`).all(g,e,oe)}streamObservationTokenFields(){return He(this.db.prepare("SELECT title, subtitle, narrative, facts, discovery_tokens FROM observations ORDER BY id"))}getUserPrompt(e,t,s){let r=this.resolvePromptSessionDbId(e,s);return r!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(r,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}dedupConfig(){let e=ie.loadFromFile(Oe),t=(r,o)=>{let i=Number(e[r]);return Number.isFinite(i)?i:o},s=(r,o)=>Math.trunc(t(r,o));return{enabled:e.CLAUDE_MEM_DEDUP_ENABLED==="true",cosineThreshold:t("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD",.8),idfVetoDf:s("CLAUDE_MEM_DEDUP_IDF_VETO_DF",10),minSharedTokens:s("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS",2),maxScan:s("CLAUDE_MEM_DEDUP_MAX_SCAN",2e3),maxBackfillRows:s("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS",5e4),minProjectDocs:s("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS",10)}}listDedupCandidates(e,t=100,s){let r="SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ",o="(? IS NULL OR c.status = ?) ",i="ORDER BY c.score DESC, c.id DESC LIMIT ?",a=s??null;return e?this.db.prepare(`${r}WHERE c.project = ? AND ${o}${i}`).all(e,a,a,t):this.db.prepare(`${r}WHERE ${o}${i}`).all(a,a,t)}resolveDedupCandidate(e,t){return this.db.prepare("UPDATE observation_dedup_candidates SET status = ? WHERE id = ?").run(t,e).changes>0}isDedupEnabled(){return this.dedupConfig().enabled}runDedupScan(){return Qs(this.db,this.dedupConfig())}maintainDedupOnInsert(e,t,s,r){Ks(this.db,e,s),zs(this.db,e,r.minProjectDocs)&&Zs(this.db,e,t,s,r)}storeObservation(e,t,s,r,o=0,i,a,_={}){if(!st(s.title))throw new Error("storeObservation requires a non-empty title");let E=this.storeObservations(e,t,[s],null,r,o,i,a,_);return{id:E.observationIds[0],createdAtEpoch:E.createdAtEpoch,mergedIntoExisting:E.mergedIntoExisting[0]??!1}}storeSummary(e,t,s,r,o=0,i){let a=i??Date.now(),_=new Date(a).toISOString(),d=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,JSON.stringify(s.files_read??[]),JSON.stringify(s.files_edited??[]),s.notes,r||null,o,_,a);return ee({projects:[t]},"storeSummary"),{id:Number(d.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,r,o,i=0,a,_,E={}){let d=a??Date.now(),c=new Date(d).toISOString(),S=Jt(d),l=new Date(d),m=this.dedupConfig(),R=f(this.db.prepare("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(e)?.platform_source),F=this.db.transaction(()=>{let h=[],T=[],y=[],k=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),p=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let A of s){if(!st(A.title)){u.debug("DB","Skipping observation with empty title");continue}let P=Gt(e,A.title,A.narrative),Y=xe(t,R,A.title,Ae(A.agent_id,A.agent_type));if(m.enabled){let q=p.get(e,P);if(q){be(this.db,q.id,l),h.push(q.id),T.push(!1);continue}let Z=E.skipTitleDedup?null:Gs(this.db,t,Y);if(Z){this.db.prepare("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(Z.id),be(this.db,Z.id,l),h.push(Z.id),T.push(!0);continue}}let M=k.all(e,t,A.type,A.title,A.subtitle,JSON.stringify(A.facts),A.narrative,JSON.stringify(A.concepts),JSON.stringify(A.files_read),JSON.stringify(A.files_modified),o||null,i,A.agent_type??null,A.agent_id??null,P,c,d,_||null,A.metadata??null,Y,S.dates,S.lastReinforced)[0]??null;if(M){m.enabled&&this.maintainDedupOnInsert(t,M.id,A.title,m),this.indexObservationFiles(M.id,A.files_read,A.files_modified),h.push(M.id),T.push(!1),y.push(M.id);continue}let Q=p.get(e,P);if(!Q)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${P}`);be(this.db,Q.id,l),h.push(Q.id),T.push(!1)}let D=null,b=!1;if(r){let A=fn(s),P=r.files_read??A.files_read,Y=r.files_edited??A.files_edited,M=o?this.db.prepare(`SELECT id, request, investigated, learned, completed, next_steps,
                      files_read, files_edited, notes, discovery_tokens, sync_rev
               FROM session_summaries
               WHERE memory_session_id = ? AND prompt_number = ? AND origin_device_id IS NULL
               ORDER BY id DESC LIMIT 1`).get(e,o):void 0;if(M){let Q=r.request&&r.request.trim()?r.request:M.request??"",q=r.investigated&&r.investigated.trim()?r.investigated:M.investigated??"",Z=r.learned&&r.learned.trim()?r.learned:M.learned??"",bt=r.completed&&r.completed.trim()?r.completed:M.completed??"",Lt=r.next_steps??"",It=r.notes&&r.notes.trim()?r.notes:M.notes,Ct=[...new Set([...nt(M.files_read),...P])],Dt=[...new Set([...nt(M.files_edited),...Y])],Rn=Math.max(M.discovery_tokens??0,i),Nn=ke(M.sync_rev||"0");this.db.prepare(`
            UPDATE session_summaries SET
              request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ?,
              files_read = ?, files_edited = ?, notes = ?, discovery_tokens = ?,
              created_at = ?, created_at_epoch = ?,
              sync_rev = ?, synced_at = NULL
            WHERE id = ?
          `).run(Q,q,Z,bt,Lt,JSON.stringify(Ct),JSON.stringify(Dt),It,Rn,c,d,Nn,M.id),r.request=Q,r.investigated=q,r.learned=Z,r.completed=bt,r.next_steps=Lt,r.notes=It,r.files_read=Ct,r.files_edited=Dt,D=M.id,b=!0}else{let q=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,JSON.stringify(P),JSON.stringify(Y),r.notes,o||null,i,c,d);D=Number(q.lastInsertRowid)}}return E.committedToolUses?.toolUseIds.length&&this.markCommittedToolUses(E.committedToolUses),{observationIds:h,mergedIntoExisting:T,insertedObservationIds:y,summaryId:D,createdAtEpoch:d,summaryUpdated:b}})();return ee({projects:[t]},"storeObservations",F.summaryUpdated?"removal":"additive"),F}updateDiscoveryTokens(e,t,s){e.length===0&&t===null||this.db.transaction(()=>{let r=this.db.prepare(`UPDATE observations SET discovery_tokens = ?,
        synced_at = CASE WHEN discovery_tokens IS NOT ? THEN NULL ELSE synced_at END WHERE id = ?`);for(let o of e)r.run(s,s,o);t!==null&&this.db.prepare(`UPDATE session_summaries SET discovery_tokens = MAX(COALESCE(discovery_tokens, 0), ?),
          synced_at = CASE WHEN COALESCE(discovery_tokens, 0) < ? THEN NULL ELSE synced_at END WHERE id = ?`).run(s,s,t)})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:r}=t,o=Nt(t.limit),i=$(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",E=a?"":`ORDER BY ss.created_at_epoch ${_}, ss.id ${_}`,d=o&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),S=[...e],l=[];if(i.length>0){let T=X("ss",i,{includeMerged:!0});l.push(T.sql),S.push(...T.params)}r&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?`),S.push(f(r)));let m=l.length>0?`AND ${l.join(" AND ")}`:"";d&&S.push(o);let I=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${m}
      ${E}
      ${d}
    `).all(...S);if(!a)return I;let F=new Map(I.map(T=>[T.id,T])),h=e.map(T=>F.get(T)).filter(T=>!!T);return o?h.slice(0,o):h}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:r}=t,o=Nt(t.limit),i=$(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",E=a?"":`ORDER BY up.created_at_epoch ${_}, up.id ${_}`,d=o&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),S=[...e],l=[];if(i.length>0){let T=X("s",i,{includeMerged:!1});l.push(T.sql),S.push(...T.params)}r&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?`),S.push(f(r)));let m=l.length>0?`AND ${l.join(" AND ")}`:"";d&&S.push(o);let I=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${g}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${m}
      ${E}
      ${d}
    `).all(...S);if(!a)return I;let F=new Map(I.map(T=>[T.id,T])),h=e.map(T=>F.get(T)).filter(T=>!!T);return o?h.slice(0,o):h}getSearchScopeRowIds(e,t,s){let r=$(t),o=t.platformSource?f(t.platformSource):void 0,i=[e.observations&&{alias:"o",includeMerged:!0,from:"SELECT o.id FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id"},e.sessions&&{alias:"ss",includeMerged:!0,from:"SELECT ss.id FROM session_summaries ss LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id"},e.prompts&&{alias:"s",includeMerged:!1,from:"SELECT up.id FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id"}].filter(_=>!!_),a=new Set;for(let _ of i){let E=[],d=[];if(r.length>0){let m=X(_.alias,r,{includeMerged:_.includeMerged});E.push(m.sql),d.push(...m.params)}o&&(E.push(`COALESCE(NULLIF(s.platform_source, ''), '${g}') = ?`),d.push(o));let c=E.length>0?`WHERE ${E.join(" AND ")}`:"",S=this.db.prepare(`${_.from} ${c} LIMIT ?`),l;try{l=S.all(...d,s+1)}finally{S.finalize()}for(let m of l)a.add(m.id);if(a.size>s)return null}return[...a]}getTimelineAroundTimestamp(e,t=10,s=10,r,o,i){return this.getTimelineAroundObservation(null,e,t,s,r,o,i)}getTimelineAroundObservation(e,t,s=10,r=10,o,i,a){let _=i?f(i):void 0,E=$({project:o,projects:a}),d=(p,D,b=!1)=>{let A=[],P=[];if(E.length>0){let Y=X(p,E,{includeMerged:b});A.push(Y.sql),P.push(...Y.params)}return _&&(A.push(`COALESCE(NULLIF(${D}.platform_source, ''), '${g}') = ?`),P.push(_)),{clause:A.length>0?`AND ${A.join(" AND ")}`:"",params:P}},c=d("o","src",!0),S=d("ss","src",!0),l=d("s","s"),m,R;if(e!==null){let p=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) <= (?, ?) ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,D=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) >= (?, ?) ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let b=this.db.prepare(p).all(t,e,...c.params,s+1),A=this.db.prepare(D).all(t,e,...c.params,r+1);if(b.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};m=b.length>0?b[b.length-1].created_at_epoch:t,R=A.length>0?A[A.length-1].created_at_epoch:t}catch(b){return b instanceof Error?u.error("DB","Error getting boundary observations",{project:o},b):u.error("DB","Error getting boundary observations with non-Error",{},new Error(String(b))),{observations:[],sessions:[],prompts:[]}}}else{let p=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,D=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let b=this.db.prepare(p).all(t,...c.params,s),A=this.db.prepare(D).all(t,...c.params,r);m=b.length>0?b[b.length-1].created_at_epoch:t,R=A.length>0?A[A.length-1].created_at_epoch:t}catch(b){return b instanceof Error?u.error("DB","Error getting boundary timestamps",{project:o},b):u.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(b))),{observations:[],sessions:[],prompts:[]}}}for(let p of[{alias:"ss",from:"session_summaries ss LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id",scope:S},{alias:"up",from:"user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id",scope:l}])for(let D of[{comparison:"<",order:"DESC",depth:s},{comparison:">",order:"ASC",depth:r}]){if(D.depth===0)continue;let A=this.db.prepare(`
          SELECT ${p.alias}.created_at_epoch
          FROM ${p.from}
          WHERE ${p.alias}.created_at_epoch ${D.comparison} ? ${p.scope.clause}
          ORDER BY ${p.alias}.created_at_epoch ${D.order}
          LIMIT ?
        `).all(t,...p.scope.params,D.depth).at(-1)?.created_at_epoch??t;m=Math.min(m,A),R=Math.max(R,A)}let I=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${c.clause}
      ORDER BY o.created_at_epoch ASC, o.id ASC
    `,F=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${S.clause}
      ORDER BY ss.created_at_epoch ASC, ss.id ASC
    `,h=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${g}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${l.clause}
      ORDER BY up.created_at_epoch ASC, up.id ASC
    `,T=this.db.prepare(I).all(m,R,...c.params),y=this.db.prepare(F).all(m,R,...S.params),k=this.db.prepare(h).all(m,R,...l.params);return{observations:T,sessions:y.map(p=>({id:p.id,memory_session_id:p.memory_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:k.map(p=>({id:p.id,content_session_id:p.content_session_id,prompt_number:p.prompt_number,prompt_text:p.prompt_text,project:p.project,platform_source:p.platform_source,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}getOrCreateManualSession(e,t=g){return this.db.transaction(()=>{let s=f(t),r=`manual-${e}-${s}`,o=`manual-content-${e}-${s}`,i=this.db.prepare(`
        SELECT memory_session_id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?
      `).get(s,o);if(i)return i.memory_session_id;let _=this.db.prepare("SELECT 1 FROM deleted_memory_sessions WHERE memory_session_id = ?").get(r)?`${r}-${(0,Ne.randomUUID)()}`:r,E=this.getSessionDeletedAtEpochMs(s,o),d=new Date(Math.max(Date.now(),(E??-1)+1));return this.db.prepare(`
        INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `).run(_,o,e,s,d.toISOString(),d.getTime()),u.info("SESSION","Created manual session",{memorySessionId:_,project:e,platformSource:s}),_}).immediate()}close(){this.db.close()}cachedStatement(e){let t=this.statementCache.get(e);return t||(t=this.db.prepare(e),this.statementCache.set(e,t)),t}importSdkSession(e){let t=f(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);if(s)return{imported:!1,id:s.id};let r=e.custom_title??null;if(r!==null&&typeof r!="string")throw new TypeError("Imported custom_title must be a string or null");let o=this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);return this.db.transaction(()=>({imported:!0,id:o.run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,r,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}))()}importSessionSummary(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return u.warn("DB","Skipping imported session summary without memory_session_id",{project:typeof e?.project=="string"?e.project:null}),{imported:!1,id:0};let t=this.db.prepare(`SELECT id FROM session_summaries WHERE memory_session_id = ?
        AND request IS ? AND investigated IS ? AND learned IS ? AND completed IS ?
        AND next_steps IS ? AND files_read IS ? AND files_edited IS ? AND notes IS ?
        AND prompt_number IS ? AND created_at_epoch = ?`).get(e.memory_session_id,O(e.request),O(e.investigated),O(e.learned),O(e.completed),O(e.next_steps),O(e.files_read),O(e.files_edited),O(e.notes),e.prompt_number??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let r=this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch, merged_into_project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,O(e.request),O(e.investigated),O(e.learned),O(e.completed),O(e.next_steps),O(e.files_read),O(e.files_edited),O(e.notes),e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch,typeof e.merged_into_project=="string"?e.merged_into_project:null);return ee({projects:gn(e)},"importSessionSummary"),{imported:!0,id:r.lastInsertRowid}}importObservation(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return u.warn("DB","Skipping imported observation without memory_session_id",{title:typeof e?.title=="string"?e.title:null,type:typeof e?.type=="string"?e.type:null}),{imported:!1,id:0};let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND text IS ? AND type = ?
        AND title IS ? AND subtitle IS ? AND facts IS ? AND narrative IS ?
        AND concepts IS ? AND files_read IS ? AND files_modified IS ?
        AND prompt_number IS ? AND agent_type IS ?
        AND agent_id IS ? AND created_at_epoch = ?
    `).get(e.memory_session_id,O(e.text),e.type,O(e.title),O(e.subtitle),O(e.facts),O(e.narrative),O(e.concepts),O(e.files_read),O(e.files_modified),e.prompt_number??null,e.agent_type??null,e.agent_id??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};for(let i of["metadata","generated_by_model","reinforcement_dates","last_reinforced"])if(e[i]!=null&&typeof e[i]!="string")throw new TypeError(`Imported ${i} must be a string or null`);let s=e.occurrence_count??1;if(!Number.isSafeInteger(s)||s<1)throw new TypeError("Imported occurrence_count must be a positive safe integer");let r=this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch, merged_into_project,
        metadata, generated_by_model, occurrence_count, reinforcement_dates, last_reinforced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),o=this.db.transaction(()=>{let a=r.run(e.memory_session_id,e.project,O(e.text),e.type,O(e.title),O(e.subtitle),O(e.facts),O(e.narrative),O(e.concepts),O(e.files_read),O(e.files_modified),e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch,typeof e.merged_into_project=="string"?e.merged_into_project:null,e.metadata??null,e.generated_by_model??null,s,e.reinforcement_dates??null,e.last_reinforced??null).lastInsertRowid;return Vt(this.db,a,e.files_read,e.files_modified),a})();return ee({projects:gn(e)},"importObservation"),{imported:!0,id:o}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?f(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let c=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${g}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);c&&c.content_session_id===e.content_session_id&&(!s||f(c.platform_source)===s)&&(t=c.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let r=t!==null?"session_db_id = ?":"content_session_id = ?",o=t??e.content_session_id,i=e.native_prompt_id??null,_=(i===null?void 0:this.db.prepare(`
      SELECT id FROM user_prompts WHERE ${r} AND native_prompt_id = ?
    `).get(o,i))??this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${r} AND prompt_number = ? AND prompt_text IS ? AND created_at_epoch = ?
        ${i===null?"":"AND native_prompt_id IS NULL"}
    `).get(o,e.prompt_number,O(e.prompt_text),e.created_at_epoch);if(_)return{imported:!1,id:_.id};let d=this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch, native_prompt_id, native_prompt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,O(e.prompt_text),e.created_at,e.created_at_epoch,e.native_prompt_id??null,e.native_prompt_hash??null);return this.promptCommitted("importUserPrompt",t),{imported:!0,id:d.lastInsertRowid}}};0&&(module.exports={SessionStore,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
