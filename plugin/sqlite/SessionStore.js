var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var et=Object.defineProperty;var vn=Object.getOwnPropertyDescriptor;var Un=Object.getOwnPropertyNames;var wn=Object.prototype.hasOwnProperty;var kn=(n,e)=>{for(var t in e)et(n,t,{get:e[t],enumerable:!0})},xn=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Un(e))!wn.call(n,r)&&r!==t&&et(n,r,{get:()=>e[r],enumerable:!(s=vn(e,r))||s.enumerable});return n};var Fn=n=>xn(et({},"__esModule",{value:!0}),n);var Fo={};kn(Fo,{SessionStore:()=>Pt,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS:()=>Dn,rollupObservationFileLists:()=>Mn});module.exports=Fn(Fo);var Pn=new Set,Bn=0;function Z(n,e,t="additive",s){Bn++;for(let r of Pn)r({scope:n,reason:e,kind:t,...s?{changes:s}:{}})}var Ft=require("bun:sqlite"),Me=require("crypto");var C=require("path"),Yt=require("os"),ye=require("fs"),Jt=require("url");var Kt=require("fs"),Vt=require("os"),rt=require("path");var h=require("fs"),Ht=require("crypto"),x=require("path");var Hn=null;function Wn(n){return(Hn??process.stderr.write.bind(process.stderr))(n)}function _e(n){Wn(n)}var Ho=Promise.resolve();var tt=process.platform==="win32";function ge(n){return n.replace(/^\uFEFF/,"")}function st(n){return JSON.parse(ge(n))}function Ae(n){return st((0,h.readFileSync)(n,"utf-8"))}function $n(n){(0,h.existsSync)(n)||(0,h.mkdirSync)(n,{recursive:!0})}function Wt(n){try{return(0,h.realpathSync)(n)}catch(e){if(e.code!=="ENOENT")throw e;let t=(0,x.dirname)(n);return t===n?n:(0,x.join)(Wt(t),(0,x.basename)(n))}}function jn(n){let e=n,t=new Set;try{for(;(0,h.lstatSync)(e).isSymbolicLink();){let s=(0,x.resolve)(e);if(t.has(s))throw Object.assign(new Error(`Symlink loop at ${e}`),{code:"ELOOP"});t.add(s);try{return(0,h.realpathSync)(e)}catch(r){if(r.code!=="ENOENT")throw r;let o=r instanceof Error?r:new Error(String(r));_e(`claude-mem: realpathSync failed for ${e}, resolving symlink manually: ${o.message}
`);let i=(0,h.readlinkSync)(e);e=(0,x.resolve)(Wt((0,x.dirname)((0,x.resolve)(e))),i)}}}catch(s){if(s.code!=="ENOENT")throw s}return e}var Xn=new Set(["EPERM","EBUSY","EACCES"]),Bt=[10,20,40,80,160,320];function Gn(n){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,n)}function Kn(n,e,t=h.renameSync,s=tt){if(!s)return t(n,e);for(let r=0;;r++)try{t(n,e);return}catch(o){let i=o.code??"";if(r>=Bt.length||!Xn.has(i))throw o;Gn(Bt[r])}}function Vn(n,e,t={}){let s=jn(n);$n((0,x.dirname)(s));let r=(0,x.dirname)(s),o=(0,x.basename)(s),i=(0,x.join)(r,`.${o}.${process.pid}.${(0,Ht.randomBytes)(6).toString("hex")}.tmp`),a=t.mode;if(a===void 0)try{a=(0,h.statSync)(s).mode&511}catch{}let _;try{_=a!==void 0?(0,h.openSync)(i,"wx",a):(0,h.openSync)(i,"wx"),a!==void 0&&!tt&&(0,h.fchmodSync)(_,a);let d=0;for(;d<e.length;){let E=(0,h.writeSync)(_,e,d,e.length-d);if(E===0)throw new Error(`writeSync stalled at ${d}/${e.length} bytes`);d+=E}if((0,h.fsyncSync)(_),(0,h.closeSync)(_),_=void 0,Kn(i,s),!tt){let E;try{E=(0,h.openSync)(r,"r"),(0,h.fsyncSync)(E)}catch(c){let p=c instanceof Error?c:new Error(String(c));_e(`claude-mem: directory fsync failed for ${r}: ${p.message}
`)}finally{if(E!==void 0)try{(0,h.closeSync)(E)}catch{}}}}catch(d){if(_!==void 0)try{(0,h.closeSync)(_)}catch{}try{(0,h.unlinkSync)(i)}catch{}throw d}}function q(n,e,t={}){Vn(n,Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),t)}var $t=require("os"),jt=require("path");function $(n,e=process.platform,t=(0,$t.homedir)()){return typeof n!="string"||n.length===0?n:n==="~"?t:n.startsWith("~/")||e==="win32"&&n.startsWith("~\\")?(0,jt.join)(t,n.slice(2)):n}var Xt=n=>n!==null&&typeof n=="object"&&!Array.isArray(n);function nt(n){let e=n.env;return Xt(e)&&Object.keys(e).some(t=>t.startsWith("CLAUDE_MEM_"))?"nested":"flat"}function re(n){return nt(n)==="nested"?n.env:n}function Gt(n){return nt(n)!=="nested"?n:Object.fromEntries(Object.entries(n).filter(([e])=>!e.startsWith("CLAUDE_MEM_")))}function ot(){if(process.env.CLAUDE_MEM_DATA_DIR)return $(process.env.CLAUDE_MEM_DATA_DIR);let n=(0,rt.join)((0,Vt.homedir)(),".claude-mem"),e=(0,rt.join)(n,"settings.json");try{if((0,Kt.existsSync)(e)){let t=Ae(e);if(t===null||typeof t!="object"||Array.isArray(t))return n;let s=re(t);if(typeof s.CLAUDE_MEM_DATA_DIR=="string"&&s.CLAUDE_MEM_DATA_DIR)return $(s.CLAUDE_MEM_DATA_DIR)}}catch{}return n}function qn(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,C.dirname)((0,Jt.fileURLToPath)(__IMPORT_META_URL__))}var si=qn(),D=ot(),Yn=(0,C.join)((0,Yt.homedir)(),".claude"),Jn=process.env.CLAUDE_CONFIG_DIR||Yn,ni=(0,C.join)(Jn,"plugins","marketplaces","thedotmack"),zn=(0,C.join)(D,"logs"),ve=(0,C.join)(D,"settings.json"),zt="claude-mem.db";var it=(0,C.join)(D,zt),Qn=(0,C.join)(D,"observer-sessions"),de=(0,C.basename)(Qn);var qt=448;function at(n){if((0,ye.mkdirSync)(n,{recursive:!0,mode:qt}),process.platform!=="win32")try{(0,ye.chmodSync)(n,qt)}catch{}}var _t={dataDir:()=>D,workerPid:()=>(0,C.join)(D,"worker.pid"),workerHeartbeat:()=>(0,C.join)(D,"worker-heartbeat.json"),serverPid:()=>(0,C.join)(D,".server-beta.pid"),serverPort:()=>(0,C.join)(D,".server-beta.port"),serverRuntime:()=>(0,C.join)(D,".server-beta.runtime.json"),settings:()=>(0,C.join)(D,"settings.json"),database:()=>(0,C.join)(D,zt),backups:()=>(0,C.join)(D,"backups","auto"),pendingRestore:()=>(0,C.join)(D,"backups","restore-pending.json"),lastRestore:()=>(0,C.join)(D,"backups","last-restore.json"),chroma:()=>(0,C.join)(D,"chroma"),combinedCerts:()=>(0,C.join)(D,"combined_certs.pem"),transcriptsConfig:()=>(0,C.join)(D,"transcript-watch.json"),transcriptsState:()=>(0,C.join)(D,"transcript-watch-state.json"),corpora:()=>(0,C.join)(D,"corpora"),supervisorRegistry:()=>(0,C.join)(D,"supervisor.json"),envFile:()=>(0,C.join)(D,".env"),logsDir:()=>zn};var w=require("fs"),Ue=require("path");var Et=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Et||{}),dt=null;function Y(n){return n.replace(/\r/g,"\\r").replace(/\n/g,"\\n")}function Zn(n){return"  "+n.replace(/\r/g,"\\r").replace(/\n(?![ \t]+at )/g,"\\n")}var ct=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;logFileDate=null;logFd=null;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){let e=new Date().toISOString().split("T")[0];if(this.logFileInitialized&&this.logFileDate===e)return;let t=this.logFileDate!==e;this.closeLogFd(),this.logFileInitialized=!1,this.logFileDate=e;try{let s=_t.logsDir();(0,w.existsSync)(s)||(0,w.mkdirSync)(s,{recursive:!0}),this.logFilePath=(0,Ue.join)(s,`claude-mem-${e}.log`),this.logFileInitialized=!0}catch(s){t&&console.error("[LOGGER] Failed to initialize log file:",s instanceof Error?s.message:String(s)),this.logFilePath=null}}closeLogFd(){if(this.logFd!==null){try{(0,w.closeSync)(this.logFd)}catch{}this.logFd=null}}appendLine(e,t){if(this.logFd!==null){let s=!1;try{let r=(0,w.fstatSync)(this.logFd),o=(0,w.statSync)(e);s=r.ino===o.ino&&r.dev===o.dev}catch{}s||this.closeLogFd()}this.logFd===null&&((0,w.mkdirSync)((0,Ue.dirname)(e),{recursive:!0}),this.logFd=(0,w.openSync)(e,"a"));try{let s=Buffer.from(t,"utf8");for(;s.length>0;){let r=(0,w.writeSync)(this.logFd,s);if(r<=0)throw new Error("log write accepted 0 bytes");s=s.subarray(r)}}catch(s){throw this.closeLogFd(),s}}getLevel(){if(this.level===null)try{let e=_t.settings();if((0,w.existsSync)(e)){let s=(re(Ae(e)).CLAUDE_MEM_LOG_LEVEL||"INFO").toString().toUpperCase();this.level=Et[s]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}safeStringify(e,t,s=6){let r=new WeakSet,o=(i,a)=>{if(typeof i=="bigint")return`${i}n`;if(i===null||typeof i!="object")return i;let _=i.toJSON,d=typeof _=="function"?_.call(i):i;if(typeof d=="bigint")return`${d}n`;if(d===null||typeof d!="object")return d;if(r.has(d))return"[Circular]";if(a>=s)return Array.isArray(d)?"[Array]":"[Object]";r.add(d);try{if(Array.isArray(d))return d.map(c=>o(c,a+1));let E={};for(let c of Object.keys(d))try{E[c]=o(d[c],a+1)}catch{E[c]="[unreadable]"}return E}finally{r.delete(d)}};try{return JSON.stringify(o(e,0),null,t)??String(e)}catch{return Array.isArray(e)?`[${e.length} items]`:"[unserializable]"}}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?this.safeStringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(s===null)return e;if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${r} ${o}:${i}:${a}.${_}`}log(e,t,s,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Et[e].padEnd(5),_=t.padEnd(6),d="";r?.correlationId?d=`[${Y(String(r.correlationId))}] `:r?.sessionId&&(d=`[session-${Y(String(r.sessionId))}] `);let E="";o!=null&&(o instanceof Error?(E=` ${Y(o.message)}`,this.getLevel()===0&&o.stack&&(E+=`
${Zn(o.stack)}`)):this.getLevel()===0&&typeof o=="object"?E=`
`+this.safeStringify(o,2):E=" "+Y(this.formatData(o)));let c="";if(r){let{sessionId:g,memorySessionId:u,correlationId:R,...y}=r;Object.keys(y).length>0&&(c=` {${Object.entries(y).map(([T,L])=>typeof L!="object"||L===null||L instanceof Error||L instanceof Date?`${Y(T)}=${Y(String(L))}`:`${Y(T)}=${Y(Array.isArray(L)?this.safeStringify(L):this.formatData(L))}`).join(", ")}}`)}let p=`[${i}] [${a}] [${_}] ${d}${Y(s)}${c}${E}`;if(this.logFilePath)try{this.appendLine(this.logFilePath,p+`
`)}catch(g){let u=g instanceof Error?g:new Error(String(g));_e(`[LOGGER] Failed to write to log file: ${u.message}
${u.stack??""}
`)}else _e(p+`
`)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}setErrorSink(e){dt=e}error(e,t,s,r){this.log(3,e,t,s,r),this.routeErrorToSink(t,s,r)}routeErrorToSink(e,t,s){try{if(!dt||!(s instanceof Error))return;dt(s)}catch{}}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}},l=new ct;function j(n){let e=n.projects?.length?n.projects:n.project?[n.project]:[];return[...new Set(e.filter(t=>t.trim().length>0))]}function X(n,e,t){let s=e.map(()=>"?").join(",");return t.includeMerged?{sql:`(${n}.project COLLATE NOCASE IN (${s}) OR ${n}.merged_into_project COLLATE NOCASE IN (${s}))`,params:[...e,...e]}:{sql:`${n}.project COLLATE NOCASE IN (${s})`,params:[...e]}}function Qt(n,e){let t=j({projects:e});return t.length===0?[]:n.transaction(()=>{let s=new Set(t),r=i=>i.replace(/[A-Z]/g,a=>a.toLowerCase()),o=new Set(t.map(r));for(;;){let i=!1;for(let a of er(n,[...s])){s.add(a);let _=r(a);o.has(_)||(o.add(_),i=!0)}if(!i)return[...s]}})()}function er(n,e){let t=e.map((o,i)=>`?${i+1}`).join(","),s=[`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${t})`,`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${t})`,`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${t})`,`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${t})`,`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${t})`,`SELECT candidates.key FROM (
        SELECT project AS key FROM observations WHERE merged_into_project COLLATE NOCASE IN (${t})
        UNION
        SELECT project AS key FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${t})
      ) candidates
      WHERE candidates.key COLLATE NOCASE NOT IN (${t})
        AND NOT EXISTS (
        SELECT 1 FROM observations
        WHERE project COLLATE NOCASE = candidates.key AND rowid NOT IN (
          SELECT rowid FROM observations WHERE merged_into_project COLLATE NOCASE IN (${t})
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM session_summaries
        WHERE project COLLATE NOCASE = candidates.key AND rowid NOT IN (
          SELECT rowid FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${t})
        )
      )`],r=n.prepare(s.join(" UNION "));try{return r.all(...e).map(i=>i.key)}finally{r.finalize()}}var we=require("crypto");function lt(n){return typeof n=="string"&&n.trim()!==""}function es(n,e,t){let s=[n||"",e||"",t||""];return s.some(r=>r.includes("\0"))?"tuple-"+(0,we.createHash)("sha256").update(JSON.stringify(s)).digest("hex"):ut(n,e,t)}function ut(n,e,t){return(0,we.createHash)("sha256").update([n||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function Zt(n){if(typeof n!="string")return n??[];try{return JSON.parse(n)}catch{return n}}function Ee(n,e){return"details-"+(0,we.createHash)("sha256").update(JSON.stringify([n,e.type,e.subtitle??null,Zt(e.facts),Zt(e.concepts)])).digest("hex")}function pt(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[String(e)]}catch(e){return l.debug("DB","File list is not JSON; treating value as a single path",{value:n},e instanceof Error?e:new Error(String(e))),[n]}}function ts(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function ss(n,e,t,s){n.prepare("DELETE FROM observation_files WHERE observation_id = ?").run(e);let r=new Set([...ts(t),...ts(s)]);if(r.size===0)return;let o=n.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let i of r)o.run(i,e)}function ns(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function mt(n=new Date){return n.toISOString().slice(0,10)}function rs(n,e=new Date,t=10){let s=mt(e);if(n.includes(s))return n;let r=[...n,s];return r.length>t?r.slice(r.length-t):r}function os(n){let e=mt(new Date(n));return{dates:JSON.stringify([e]),lastReinforced:e}}function ce(n,e,t=new Date){let s=n.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(e);if(!s)return!1;let r=ns(s.reinforcement_dates),o=rs(r,t);return o===r?!1:(n.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(JSON.stringify(o),o[o.length-1],e),!0)}var _s=require("crypto");var S="claude";function tr(n){return n.trim().toLowerCase().replace(/\s+/g,"-")}function N(n){if(!n)return S;let e=tr(n);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e.includes("kimi")?"kimi":e==="pi-mono"?"pi":e==="agy"||e==="antigravity"||e.startsWith("antigravity-")?"antigravity-cli":e:S}function is(n){let e=["claude","codex","antigravity-cli","cursor","kimi"];return[...n].sort((t,s)=>{let r=e.indexOf(t),o=e.indexOf(s);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:t.localeCompare(s)})}var sr=new Set(["dumb_search","claude_mem_search","claude_mem_timeline","claude_mem_get_observations","mem_search","search","timeline","get_observations","get_summaries","get_tool_uses","session_start_context","observation_search","observation_context","memory_search","memory_context","get_review_stack","import_review_cards"]);function nr(n){if(!n.startsWith("mcp__"))return null;let e=n.split("__");if(e.length<3)return null;let t=e[1].toLowerCase();return!t.includes("claude-mem")&&!t.includes("claude_mem")&&!t.includes("mcp-search")&&!t.includes("mcp_search")&&!t.includes("cmem")?null:e.slice(2).join("__")}function Tt(n){if(!n)return!1;if(n.startsWith("memory_")||n==="claude_mem_search"||n==="claude_mem_timeline"||n==="claude_mem_get_observations"||n==="dumb_search"||n==="mem_search"||n==="get_summaries"||n==="get_review_stack"||n==="import_review_cards")return!0;let e=nr(n);return e!==null&&sr.has(e)}var rr=64*1024;function as(n,e=rr){let t=Buffer.byteLength(n,"utf8");if(t<=e)return n;let s=Buffer.allocUnsafe(e),r=s.write(n,"utf8");return`${s.subarray(0,r).toString("utf8")}\u2026[truncated: ${t} bytes]`}function or(n,e,t){return(0,_s.createHash)("sha256").update(n||"").update("\0").update(e||"").update("\0").update(t||"").digest("hex").slice(0,16)}function ds(n){n.run(`
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
      UNIQUE(platform_source, content_session_id, tool_use_id)
    )
  `),n.transaction(()=>{let e=n.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_uses'").get(),t=/UNIQUE\s*\(\s*content_session_id\s*,\s*tool_use_id\s*\)/i;if(!t.test(e.sql))return;let s=n.query(`SELECT sql FROM sqlite_master
      WHERE tbl_name = 'tool_uses' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all(),r=n.query("SELECT seq FROM sqlite_sequence WHERE name = 'tool_uses'").get();n.run(e.sql.replace(/^CREATE TABLE\s+(?:"tool_uses"|tool_uses)\s*\(/i,"CREATE TABLE tool_uses_platform_new (").replace(t,"UNIQUE(platform_source, content_session_id, tool_use_id)")),n.run("INSERT INTO tool_uses_platform_new SELECT * FROM tool_uses"),n.run("DROP TABLE tool_uses"),n.run("ALTER TABLE tool_uses_platform_new RENAME TO tool_uses");for(let o of s)n.run(o.sql);r&&n.run("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'tool_uses'",[r.seq])}).immediate(),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project_nocase_created ON tool_uses(project COLLATE NOCASE, created_at_epoch DESC, id DESC)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),n.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function Es(n,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||Tt(e.toolName))return null;let t=e.createdAtEpoch??Date.now(),s=new Date(t).toISOString(),r=or(e.toolName,e.toolInput,e.toolResponse),o=e.toolInput!=null?as(e.toolInput):null,i=e.toolResponse!=null?as(e.toolResponse):null,a=n.prepare(`
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
  `).all(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",N(e.platformSource),e.toolName,o,i,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,r,s,t)[0]??null;return a?a.id:null}function cs(n,e){let t=e.toolUseIds.filter(o=>typeof o=="string"&&o.length>0);if(t.length===0)return 0;let s=t.map(()=>"?").join(","),r=n.prepare(`
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
  `).run(e.observationId,e.memorySessionId??null,e.memorySessionId??null,e.contentSessionId,N(e.platformSource),...t,e.observationId);return Number(r.changes??0)}function ls(n){return n?{clause:`COALESCE(NULLIF(platform_source, ''), '${S}') = ?`,param:N(n)}:null}var ir=100;function us(n,e,t={}){let s=[],r=[];for(let c of e){if(typeof c=="number"&&Number.isInteger(c)){s.push(c);continue}if(typeof c=="string"&&c.trim().length>0){let p=Number(c);Number.isInteger(p)&&String(p)===c.trim()&&s.push(p),r.push(c.trim())}}if(s.length===0&&r.length===0)return[];let o=[],i=[];s.length>0&&(o.push(`id IN (${s.map(()=>"?").join(",")})`),i.push(...s)),r.length>0&&(o.push(`tool_use_id IN (${r.map(()=>"?").join(",")})`),i.push(...r));let a=[`(${o.join(" OR ")})`],_=j(t);if(_.length){let c=X("tool_uses",_,{includeMerged:!1});a.push(c.sql),i.push(...c.params)}t.contentSessionId&&(a.push("content_session_id = ?"),i.push(t.contentSessionId));let d=ls(t.platformSource);d&&(a.push(d.clause),i.push(d.param));let E=t.limit&&t.limit>0?Math.floor(t.limit):ir;return n.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    LIMIT ${E}
  `).all(...i)}function ps(n,e={}){return Ts(n,e,"*")}function ms(n,e={}){return Ts(n,e,`
    id, tool_use_id, tool_name, project, content_session_id, memory_session_id,
    platform_source, agent_id, agent_type, observation_id, or_generation_id,
    or_session_id, prompt_number, created_at, created_at_epoch,
    COALESCE(length(CAST(tool_input AS BLOB)), 0) AS tool_input_bytes,
    COALESCE(length(CAST(tool_response AS BLOB)), 0) AS tool_response_bytes
  `)}function Ts(n,e,t){let s=[],r=[];if(e.project&&(s.push("project COLLATE NOCASE = ?"),r.push(e.project)),e.contentSessionId&&(s.push("content_session_id = ?"),r.push(e.contentSessionId)),e.memorySessionId&&(s.push("memory_session_id = ?"),r.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(s.push("session_db_id = ?"),r.push(e.sessionDbId)),e.toolName){let E=Array.isArray(e.toolName)?e.toolName:[e.toolName];E.length>0&&(s.push(`tool_name IN (${E.map(()=>"?").join(",")})`),r.push(...E))}e.agentId&&(s.push("agent_id = ?"),r.push(e.agentId));let o=ls(e.platformSource);o&&(s.push(o.clause),r.push(o.param)),typeof e.dateStart=="number"&&(s.push("created_at_epoch >= ?"),r.push(e.dateStart)),typeof e.dateEnd=="number"&&(s.push("created_at_epoch <= ?"),r.push(e.dateEnd));let i=s.length>0?`WHERE ${s.join(" AND ")}`:"",a=e.orderBy==="date_asc"?"ASC":"DESC",_=Math.min(Math.max(Math.floor(e.limit??50),1),500),d=Math.max(Math.floor(e.offset??0),0);return n.prepare(`
    SELECT ${t} FROM tool_uses
    ${i}
    ORDER BY created_at_epoch ${a}, id ${a}
    LIMIT ${_} OFFSET ${d}
  `).all(...r)}function Ss(n,e={}){let t=[],s=[];e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let r=t.length>0?`WHERE ${t.join(" AND ")}`:"";return n.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${r}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...s)}function gs(n){n.run(`
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
  `),n.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_deliverables_session_copy ON deliverables(platform_source, content_session_id, bucket_path)"),n.run("CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project COLLATE NOCASE, created_at_epoch)"),n.run("CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at_epoch DESC)")}function As(n,e){let t=e.createdAtEpoch??Date.now(),s=n.prepare(`
    INSERT OR IGNORE INTO deliverables (
      project, content_session_id, platform_source, agent_id, title, kind, source_path, bucket_path, bytes, sha256,
      declared, list_name, field, tool_use_id, occurred_at_epoch, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.project,e.contentSessionId,e.platformSource,e.agentId??null,e.title,e.kind,e.sourcePath,e.bucketPath,e.bytes,e.sha256,e.declared?1:0,e.listName??null,e.field??null,e.toolUseId??null,e.occurredAtEpoch,new Date(t).toISOString(),t);if(s.changes>0){let o=Number(s.lastInsertRowid);return l.debug("DB","Deliverable recorded",{id:o,project:e.project,bucketPath:e.bucketPath}),{id:o,inserted:!0}}return e.declared&&n.prepare(`
      UPDATE deliverables SET declared = 1, title = ?, kind = ?, agent_id = ?,
        source_path = ?, list_name = ?, field = ?, tool_use_id = ?, occurred_at_epoch = ?
      WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ? AND declared = 0
    `).run(e.title,e.kind,e.agentId??null,e.sourcePath,e.listName??null,e.field??null,e.toolUseId??null,e.occurredAtEpoch,e.platformSource,e.contentSessionId,e.bucketPath),{id:n.prepare("SELECT id FROM deliverables WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ?").get(e.platformSource,e.contentSessionId,e.bucketPath)?.id??0,inserted:!1}}function fs(n,e){return!Number.isSafeInteger(e)||e<1?null:n.prepare("SELECT * FROM deliverables WHERE id = ?").get(e)??null}var $e=require("fs");var J=require("fs"),B=require("path"),fe=require("os");var ke={HEALTH_CHECK:3e3,API_REQUEST:3e4,SESSION_INIT_HOOK_CAP:15e3,SESSION_INIT_REQUEST:1e4,SESSION_INIT_REQUEST_MAX:14e3,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function ar(n=process.platform){return n==="win32"?8e3:5e3}function Rs(n=process.platform){return ke.SESSION_INIT_HOOK_CAP-ar(n)}function Ns(n){return process.platform==="win32"?Math.round(n*ke.WINDOWS_MULTIPLIER):n}var Us=require("util");var St={timeoutMs:6e5,maxOutputTokens:16e3};function Os(n){try{return new URL(n).hostname.toLowerCase()==="openrouter.ai"}catch{return!1}}var hs=require("crypto"),xe=require("fs"),bs=require("os"),oe=require("path");var _r=37700,dr=37877,Er="37777",cr=77,Ls=37954;function Is(){return process.env.CLAUDE_MEM_DATA_DIR||(0,oe.join)((0,bs.homedir)(),".claude-mem")}function Cs(n){let e=(0,oe.join)($(n),"settings.json");if(!(0,xe.existsSync)(e))return null;try{let t=JSON.parse((0,xe.readFileSync)(e,"utf8").replace(/^\uFEFF/,"")),s=t.env;return s&&typeof s=="object"&&!Array.isArray(s)&&Object.keys(s).some(r=>r.startsWith("CLAUDE_MEM_"))?s:t}catch{return null}}function lr(n){return Cs(n)?.CLAUDE_MEM_WORKER_PORT===Er}function ur(n){let e=Cs(n);return["CLAUDE_MEM_SERVER_URL","CLAUDE_MEM_SERVER_BETA_URL"].some(t=>{let s=e?.[t];if(typeof s!="string")return!1;try{return new URL(s).port===String(Ls)}catch{return!1}})}function Ds(n=Is(),e={}){let t=e.platform??process.platform,s=e.uid===void 0?typeof process.getuid=="function"?process.getuid():null:e.uid;if(s!==null)return(s%100+100)%100;if(t==="win32"&&lr(n))return cr;let r=$(n,t),o=t==="win32"?oe.win32.resolve(r):(0,oe.resolve)(r);return t==="win32"&&(o=o.toLowerCase()),(0,hs.createHash)("sha256").update(o,"utf8").digest().readUInt32BE(0)%100}function Fe(n,e){return _r+Ds(n,e)}function Pe(n=Is(),e={}){let t=e.platform??process.platform,s=e.uid===void 0?typeof process.getuid=="function"?process.getuid():null:e.uid;return t==="win32"&&s===null&&ur(n)?Ls:dr+Ds(n,e)}var pr="security_alert",mr="sync-hub.black-pond-afbb.workers.dev",Tr="ziczmqtpmaxbornfghye.supabase.co",Sr="https://sync.cmem.ai",gr=new Set(["xiaomi/mimo-v2-flash:free"]);function Ar(n){return typeof n=="boolean"?String(n):n}var fr=new Set(["claude-haiku-4-5-20251001","claude-haiku-4-5"]);function Rr(n){let e=process.env.CLAUDE_MEM_ENV_FILE??(0,B.join)((0,B.dirname)(n),".env");try{return(0,J.existsSync)(e)?!!(0,Us.parseEnv)(ge((0,J.readFileSync)(e,"utf-8"))).ANTHROPIC_BASE_URL:!1}catch{return!0}}function Nr(n,e){let t=n.CLAUDE_MEM_MODEL;return typeof t!="string"||!fr.has(t.trim())?!1:(typeof n.CLAUDE_MEM_CLAUDE_AUTH_METHOD=="string"?n.CLAUDE_MEM_CLAUDE_AUTH_METHOD.trim():"")!=="gateway"&&!Rr(e)}function Or(n){let e=n.CLAUDE_MEM_OPENROUTER_MODEL;if(typeof e!="string"||!gr.has(e.trim()))return!1;let t=typeof n.CLAUDE_MEM_OPENROUTER_BASE_URL=="string"?n.CLAUDE_MEM_OPENROUTER_BASE_URL.trim():"";return t===""||Os(t)}var Ms=18e4,ys=[{key:"CLAUDE_MEM_LLM_TIMEOUT_MS",legacy:"30000",markerTag:"llm-timeout-migrated-v1",unit:"ms",applyOnlyWhenSaved:!1},{key:"CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS",legacy:"30000",markerTag:"field-optimize-timeout-migrated-v1",unit:"ms",applyOnlyWhenSaved:!1},{key:"CLAUDE_MEM_MEDIA_CAPTURE_ENABLED",legacy:"false",markerTag:"media-capture-default-on-v1",unit:"",applyOnlyWhenSaved:!0},{key:"CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS",legacy:"400000",markerTag:"observer-max-conversation-chars-v1",unit:" chars",applyOnlyWhenSaved:!1}];function ws(n,e){return(0,B.join)((0,B.dirname)(n),`.${(0,B.basename)(n)}.${e.markerTag}`)}function gt(n,e){try{(0,J.writeFileSync)(ws(n,e),new Date().toISOString(),{encoding:"utf-8",mode:384})}catch{}}var vs=new Set;function hr(n){if(typeof n!="string")return null;let e=n.trim();if(e.length===0)return null;try{let t=new URL(e).hostname;if(t===mr||t===Tr)return Sr}catch{return null}return null}var le=class{static DEFAULTS={CLAUDE_MEM_SKILLS_DISABLED:"",CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED:"true",CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED:"true",CLAUDE_MEM_MEMORY_WATCH_ROOTS:"",CLAUDE_MEM_MODEL:"haiku",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES:"false",CLAUDE_MEM_CONTEXT_PROJECTS:"current",CLAUDE_MEM_WORKER_PORT:String(Fe()),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_URL:"",CLAUDE_MEM_WORKER_INGEST_TOKEN:"",CLAUDE_MEM_WORKER_INGEST_MAX_BYTES:"5242880",CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:"auto",CLAUDE_MEM_ALLOWED_ORIGINS:"",CLAUDE_MEM_PUBLIC_URL:"",CLAUDE_MEM_API_TIMEOUT_MS:String(Ns(ke.API_REQUEST)),CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS:String(Rs()),CLAUDE_MEM_HOOK_HANDOFF_TIMEOUT_MS:"250",CLAUDE_MEM_IDLE_EXIT_SEC:"0",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_SKIP_BASH_PATTERNS:"",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_CAPTURE_ADVISOR_CALLS:"false",CLAUDE_MEM_DELIVERABLES_ENABLED:"true",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_PROVIDER_BY_SOURCE:"",CLAUDE_MEM_OBSERVER_ENABLED:"true",CLAUDE_MEM_MEDIA_CAPTURE_ENABLED:"true",CLAUDE_MEM_MEDIA_INFERENCE_ENABLED:"false",CLAUDE_MEM_CODEX_MODEL:"",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"low",CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE:"8",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS:"32000",CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_API_KEYS:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-flash-latest",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_API_KEYS:"",CLAUDE_MEM_OPENROUTER_MODEL:"cohere/north-mini-code:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_TEMPERATURE:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_PRESET:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEYS:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"",CLAUDE_MEM_OPENAI_COMPAT_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_REASONING:"",CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER:"claude",CLAUDE_MEM_QUOTA_FALLBACK_MODEL:"",CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD:"",CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR:"0.95",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET:"0.92",CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE:"0.95",CLAUDE_MEM_DATA_DIR:(0,B.join)((0,fe.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:"",CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:"",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY:"true",CLAUDE_MEM_REINFORCE_ALPHA:"0",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_WORK_STATE_ENABLED:"true",CLAUDE_MEM_AUTO_CLEAR_ENABLED:"false",CLAUDE_MEM_AUTO_CLEAR_PERCENT:"40",CLAUDE_MEM_FILE_READ_GATE_ENABLED:"true",CLAUDE_MEM_LINE_ANCHORS_ENABLED:"false",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,B.join)((0,fe.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_CODEX_SUBAGENT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS:"100000",CLAUDE_MEM_OBSERVER_THINKING:"disabled",CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW:"",CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS:"4096",CLAUDE_MEM_OBSERVE_BARE_PROMPTS:"false",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_REDACT_ENABLED:"false",CLAUDE_MEM_REDACT_DISABLED_BUILTINS:"",CLAUDE_MEM_REDACT_CUSTOM_PATTERNS:"[]",CLAUDE_MEM_REDACT_LOG_MATCHES:"false",CLAUDE_MEM_REDACT_GENERIC_ENABLED:"false",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_PROJECT_ENVIRONMENTS:"[]",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_SEMANTIC_INJECT_FORMAT:"narrative",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS:"600000",CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS:"5000",CLAUDE_MEM_CHROMA_BACKFILL_PAUSE_RATIO:"1",CLAUDE_MEM_CHROMA_PROCESS_NICE:"10",CLAUDE_MEM_CHROMA_MAX_THREADS:"0",CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_SERVER_VECTOR_SEARCH:"auto",CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS:"",CLAUDE_MEM_EMBEDDING_MODEL:"all-MiniLM-L6-v2",CLAUDE_MEM_CHROMA_UVX_PATH:"",CLAUDE_MEM_SEARCH_RECENCY_DAYS:"90",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,fe.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING:"false",CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE:"40",CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS:"90000",CLAUDE_MEM_TEAMBRAIN_URL:"",CLAUDE_MEM_TEAMBRAIN_TEAM_ID:"",CLAUDE_MEM_LLM_TIMEOUT_MS:String(Ms),CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS:String(Ms),CLAUDE_MEM_LLM_STREAM_IDLE_TIMEOUT_MS:"90000",CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS:"120000",CLAUDE_MEM_LOCAL_API_TOKEN:"",CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST:"",CLAUDE_MEM_PRO_TRIAL_EMAIL:"",CLAUDE_MEM_PRO_TRIAL_AT:"",CLAUDE_MEM_PRO_TRIAL_STATE:"",CLAUDE_MEM_PRO_TRIAL_ENDS_AT:"",CLAUDE_MEM_ONLINE_SIGNUP_EMAIL:"",CLAUDE_MEM_ONLINE_SIGNUP_NOTE:"",CLAUDE_MEM_ONLINE_SIGNUP_AT:"",CLAUDE_MEM_ONLINE_SIGNUP_SENT:"",CLAUDE_MEM_PRO_PLAN:"",CLAUDE_MEM_PRO_FALLBACK_AT:"",CLAUDE_MEM_PRO_FALLBACK_MESSAGE:"",CLAUDE_MEM_PRO_FALLBACK_ACTION:"",CLAUDE_MEM_PRO_FALLBACK_URL:"",CLAUDE_MEM_PRO_MEMORY_KEY:"",CLAUDE_MEM_PRO_MEMORY_BASE_URL:"",CLAUDE_MEM_PRO_MEMORY_MODEL:"",CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH:"true",CLAUDE_MEM_WORK_VIEW_REFRESH_INTERVAL_MIN:"10",CLAUDE_MEM_WORK_VIEW_SHARED_STATE:"",CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER:"",CLAUDE_MEM_WORK_VIEW_COPY_MODEL:"",CLAUDE_MEM_WORK_VIEW_AGENT:"",CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL:"",CLAUDE_MEM_WORK_VIEW_CODEX_MODEL:"",CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL:"",CLAUDE_MEM_WORK_VIEW_OPENCODE_MODEL:"",CLAUDE_MEM_WORK_VIEW_API_MODEL:"",CLAUDE_MEM_WORK_VIEW_API_TIMEOUT_MS:String(St.timeoutMs),CLAUDE_MEM_WORK_VIEW_MAX_OUTPUT_TOKENS:String(St.maxOutputTokens),CLAUDE_MEM_CORPUS_AGENT:"",CLAUDE_MEM_API_AGENT_EXTRA_BODY:"",CLAUDE_MEM_WORK_VIEW_TEXT_LANGUAGE:"",CLAUDE_MEM_BACKUP_ENABLED:"false",CLAUDE_MEM_BACKUP_INTERVAL_HOURS:"24",CLAUDE_MEM_BACKUP_RETAIN_COUNT:"7",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED:"true",CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED:"false",CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES:"{}",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert,sensitive",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED:"false",CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_URL:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET:"",CLAUDE_MEM_NOTION_ENABLED:"false",CLAUDE_MEM_NOTION_TOKEN:"",CLAUDE_MEM_NOTION_DATABASE_ID:"",CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES:"true",CLAUDE_MEM_GROK_BOT_INJECT_ENABLED:"true",CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS:"*",CLAUDE_MEM_GROK_BOT_INJECT_TIER:"episode",CLAUDE_MEM_GROK_BOT_INJECT_WINDOW:"80",CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK:"house",CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE:"",CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT:"",CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS:"160",CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS:"1500",CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE:"",CLAUDE_MEM_CCS_ALIGN_ENABLED:"true",CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS:"ccs-align",CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS:"false",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(Fe())}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(Pe())}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(Pe())}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:"",CLAUDE_MEM_DEDUP_ENABLED:"false",CLAUDE_MEM_DEDUP_COSINE_THRESHOLD:"0.80",CLAUDE_MEM_DEDUP_IDF_VETO_DF:"10",CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS:"2",CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS:"10",CLAUDE_MEM_DEDUP_MAX_SCAN:"2000",CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS:"50000",CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED:"false",CLAUDE_MEM_TOOL_USES_RETENTION_DAYS:"0",CLAUDE_MEM_LOG_RETENTION_DAYS:"30",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_AUTO_UPDATE:"true",CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL:"",CLAUDE_MEM_PROJECT_NAME_SOURCE:"path"};static getAllDefaults(){return{...this.DEFAULTS}}static defaultsForSettingsPath(e){let t={...this.DEFAULTS},s=(0,B.dirname)(e),r=String(Fe(s)),o=process.env.CLAUDE_MEM_SERVER_PORT??String(Pe(s));return t.CLAUDE_MEM_WORKER_PORT=r,t.CLAUDE_MEM_QUEUE_REDIS_PREFIX=`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??r}`,t.CLAUDE_MEM_SERVER_URL=`http://127.0.0.1:${o}`,t.CLAUDE_MEM_SERVER_BETA_URL=`http://127.0.0.1:${o}`,t}static get(e){let t=process.env[e]??this.DEFAULTS[e];return e==="CLAUDE_MEM_WORKER_HOST"?this.normalizeWorkerHost(t):e==="CLAUDE_MEM_DATA_DIR"?$(t):t}static normalizeWorkerHost(e){return e==="localhost"?"127.0.0.1":e}static finalizeSettings(e,t){let s=t?this.applyEnvOverrides(e):e;s.CLAUDE_MEM_WORKER_HOST=this.normalizeWorkerHost(s.CLAUDE_MEM_WORKER_HOST);let r=s.CLAUDE_MEM_DATA_DIR?.trim();return r&&s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH===this.DEFAULTS.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH&&(s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH=(0,B.join)($(r),"transcript-watch.json")),s}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0,s={}){let r=s.warn??console.warn;try{let o=this.defaultsForSettingsPath(e);if(!(0,J.existsSync)(e)){if(!s.readOnly)try{q(e,o,{mode:384});for(let u of ys)gt(e,u);r("[SETTINGS] Created settings file with defaults:",e)}catch(u){r("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,u instanceof Error?u.message:String(u))}return this.finalizeSettings(o,t)}let i=(0,J.readFileSync)(e,"utf-8"),a=st(i),_=re(a),d=_!==a,E=Gt(a),c=d&&Object.keys(E).some(u=>u!=="env");if(d&&!c&&!s.readOnly)try{q(e,_,{mode:384}),r("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(u){r("[SETTINGS] Failed to auto-migrate settings file:",e,u instanceof Error?u.message:String(u))}if(_.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES===pr&&(_={..._,CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES},!s.readOnly))try{q(e,c?{...E,env:_}:_,{mode:384}),r("[SETTINGS] Migrated Telegram trigger types off the legacy default:",e)}catch(u){r("[SETTINGS] Failed to migrate Telegram trigger types:",e,u instanceof Error?u.message:String(u))}if(Nr(_,e)){let u=String(_.CLAUDE_MEM_MODEL).trim();if(_={..._,CLAUDE_MEM_MODEL:this.DEFAULTS.CLAUDE_MEM_MODEL},!s.readOnly)try{q(e,c?{...E,env:_}:_,{mode:384}),r(`[SETTINGS] Migrated Claude model off the pinned ${u} to ${this.DEFAULTS.CLAUDE_MEM_MODEL}:`,e)}catch(R){r("[SETTINGS] Failed to migrate the pinned Claude model:",e,R instanceof Error?R.message:String(R))}}if(Or(_)){let u=String(_.CLAUDE_MEM_OPENROUTER_MODEL).trim();if(_={..._,CLAUDE_MEM_OPENROUTER_MODEL:this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL},!s.readOnly)try{q(e,c?{...E,env:_}:_,{mode:384}),r(`[SETTINGS] Migrated OpenRouter model off the retired default ${u} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,e)}catch(R){r("[SETTINGS] Failed to migrate the retired OpenRouter model:",e,R instanceof Error?R.message:String(R))}}let p=hr(_.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);if(p!==null&&(_={..._,CLAUDE_MEM_CLOUD_SYNC_HUB_URL:p},!s.readOnly))try{q(e,c?{...E,env:_}:_,{mode:384}),r("[SETTINGS] Migrated cloud sync hub URL to",p,"from a retired hub host:",e)}catch(u){r("[SETTINGS] Failed to migrate cloud sync hub URL:",e,u instanceof Error?u.message:String(u))}for(let u of ys){if((0,J.existsSync)(ws(e,u)))continue;if(_[u.key]!==u.legacy){s.readOnly||gt(e,u);continue}if(s.readOnly&&u.applyOnlyWhenSaved)continue;let R=_;if(_={..._,[u.key]:this.DEFAULTS[u.key]},!s.readOnly)try{q(e,c?{...E,env:_}:_,{mode:384}),gt(e,u),r(`[SETTINGS] Migrated ${u.key} off the old ${u.legacy}${u.unit} default to ${this.DEFAULTS[u.key]}${u.unit}:`,e)}catch(y){u.applyOnlyWhenSaved&&(_=R);let v=`${u.key}\0${e}`;vs.has(v)||(vs.add(v),r(u.applyOnlyWhenSaved?`[SETTINGS] Failed to migrate ${u.key}; keeping the saved ${u.legacy} (reported once per process):`:`[SETTINGS] Failed to migrate ${u.key}; using the new default in memory (reported once per process):`,e,y instanceof Error?y.message:String(y)))}}let g={...o};for(let u of Object.keys(o))_[u]!==void 0&&(g[u]=Ar(_[u]));return this.finalizeSettings(g,t)}catch(o){r("[SETTINGS] Failed to load settings, using defaults:",e,o instanceof Error?o.message:String(o));let i=this.defaultsForSettingsPath(e);return this.finalizeSettings(i,t)}}};var Oe=String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`,ee=`(?=${Oe}{8})${Oe}*[A-Za-z]${Oe}*`,G=String.raw`(?:\\{0,3}["'])?`,U=String.raw`\s{0,8}`;function At(n){return new RegExp(`${n}${ee}`,"gi")}function ks(n){let e=n.replace(/\\.|[a-z]/g,t=>t.length===1?`[${t}${t.toUpperCase()}]`:t);return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${e}`}function We(n){return`(?<=${n}${G}${U}[=:]${U}${G})`}var Be=String.raw`(?:token|secret|api_key)`,He=String.raw`\\{0,3}["']`,ft=String.raw`(?<!\\)"`,br=String.raw`(?:^|[\s?&]|\\[nrt]|${ft})`,Lr=String.raw`(?:^|\n|\\n|${ft})[ \t]{0,8}(?:-[ \t]{1,8})?`,Ir=String.raw`(?:${He})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${ft})`,Cr=new RegExp([`${We(String.raw`\b\w*_${Be}`)}${ee}`,`(?<=${He}${Be}${He}${U}:${U}${He})${ee}`,`(?<=${br}${Be}=${G})${ee}(?!\\(|${Oe})`,String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${G})${ee}`,`(?<=${Lr}${Be}:[ \\t]{1,8}${G})${ee}(?=${Ir})`].join("|"),"gi"),Dr=String.raw`(?:(?<=\\[nrt])|\b)`;function Mr(n){let e=n.regex.source.replace(/(^|\||\(\?:)\\b/g,`$1${Dr}`);return{...n,regex:new RegExp(e,n.regex.flags)}}var yr=String.raw`[^\\\n\r"'\`<]`,vr=[{name:"cookie_header",regex:new RegExp(`(?<=(?:\\b(?:set-)?cookie)${G}${U}[=:]${U}(?:\\[${U})?${G})(?![ \\t])${yr}{4,}`,"gi")},{name:"url_credentials",regex:/(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi},{name:"aws_access_key",regex:/(?:AKIA|ASIA)[0-9A-Z]{16}/g},{name:"aws_secret_key",regex:new RegExp(`${We(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`,"gi")},{name:"aws_session_token",regex:new RegExp(`${We(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`,"gi")},{name:"github_pat",regex:/\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g},{name:"openai_key",regex:/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"anthropic_key",regex:/\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"slack_token",regex:/\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g},{name:"jwt",regex:/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g},{name:"private_key_pem",regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g},{name:"stripe_key",regex:/\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g},{name:"google_api_key",regex:/\bAIza[0-9A-Za-z_-]{35}(?!\w)/g},{name:"google_oauth_token",regex:/\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g},{name:"gitlab_token",regex:/\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g},{name:"huggingface_token",regex:/\bhf_[A-Za-z0-9]{30,}\b/g},{name:"npm_token",regex:/\bnpm_[A-Za-z0-9]{36}\b/g},{name:"docker_pat",regex:/\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g},{name:"linear_key",regex:/\blin_api_[A-Za-z0-9]{40}(?!\w)/g},{name:"notion_token",regex:/\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g},{name:"sendgrid_key",regex:/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g},{name:"digitalocean_token",regex:/\bdo[opr]_v1_[a-f0-9]{64}\b/g},{name:"shopify_token",regex:/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g},{name:"pypi_token",regex:/\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g},{name:"databricks_token",regex:/\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g},{name:"vault_token",regex:/\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g},{name:"nvidia_nim_key",regex:/\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g},{name:"runcrate_key",regex:/\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g},{name:"groq_key",regex:/\bgsk_[A-Za-z0-9]{52}(?!\w)/g},{name:"xai_key",regex:/\bxai-[A-Za-z0-9_]{80}(?!\w)/g},{name:"perplexity_key",regex:/\bpplx-[A-Za-z0-9]{48}(?!\w)/g},{name:"supabase_token",regex:/\bsbp_[a-f0-9]{40}(?!\w)/g},{name:"sentry_token",regex:/\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g},{name:"grafana_token",regex:/\b(?:glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?!\w)|glc_[A-Za-z0-9+\/]{32,400}={0,2}(?![\w+\/=]))/g},{name:"postman_key",regex:/\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}(?!\w)/g},{name:"pulumi_token",regex:/\bpul-[a-f0-9]{40}(?!\w)/g},{name:"doppler_token",regex:/\bdp\.pt\.[A-Za-z0-9]{43}(?!\w)/g},{name:"heroku_key",regex:/\bHRKU-AA[0-9A-Za-z_-]{58}(?![\w-])/g},{name:"atlassian_token",regex:/\bATATT3[A-Za-z0-9_=-]{186}(?![\w=-])/g},{name:"slack_webhook",regex:new RegExp(String.raw`(?<=${ks(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`,"g")},{name:"discord_webhook",regex:new RegExp(String.raw`(?<=${ks(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`,"g")},{name:"claude_mem_key",regex:/\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g}].map(Mr),Ur=[{name:"generic_password",regex:At(We(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`))},{name:"generic_token",regex:Cr},{name:"bearer_token",regex:At(`(?<=\\bAuthorization${G}${U}:${U}${G}Bearer${U})`)},{name:"basic_auth",regex:At(`(?<=\\bAuthorization${G}${U}:${U}${G}Basic${U})`)}],wr=1024*1024,kr="<redacted type='oversize'/>";function ue(n,e){if(!e.enabled||n.length===0)return{redacted:n,counts:{},oversize:!1};if(n.length>wr)return l.warn("REDACT","field exceeds the 1M-char redaction cap; replaced by an oversize marker",void 0,{inputLength:n.length}),{redacted:kr,counts:{oversize:1},oversize:!0};let t=new Set(e.disabledBuiltinPatterns??[]),s={},r=n,o=[];for(let a of e.customPatterns??[]){if(!a.name||a.name.length===0){l.warn("REDACT","custom pattern skipped: missing name",void 0,{pattern:a});continue}try{o.push({name:a.name,regex:new RegExp(a.regex,"g")})}catch(_){l.warn("REDACT","custom pattern skipped: invalid regex",{name:a.name},_ instanceof Error?_:new Error(String(_)))}}let i=[...o,...vr,...e.genericEnabled?Ur:[]];for(let a of i)t.has(a.name)||(a.regex.lastIndex=0,r=r.replace(a.regex,()=>(s[a.name]=(s[a.name]??0)+1,`<redacted type='${a.name}'/>`)));return e.logMatches&&Object.keys(s).length>0&&l.debug("REDACT","patterns matched",void 0,{counts:s}),{redacted:r,counts:s,oversize:!1}}function xr(n){if(!n||n.trim()==="")return[];try{let e=JSON.parse(n);return Array.isArray(e)?e.filter(t=>t&&typeof t.name=="string"&&typeof t.regex=="string"):(l.warn("REDACT","CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring"),[])}catch(e){return l.warn("REDACT","failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",void 0,e instanceof Error?e:new Error(String(e))),[]}}function Fr(n){return{enabled:n.CLAUDE_MEM_REDACT_ENABLED==="true",disabledBuiltinPatterns:(n.CLAUDE_MEM_REDACT_DISABLED_BUILTINS??"").split(",").map(e=>e.trim()).filter(Boolean),customPatterns:xr(n.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS??"[]"),logMatches:n.CLAUDE_MEM_REDACT_LOG_MATCHES==="true",genericEnabled:n.CLAUDE_MEM_REDACT_GENERIC_ENABLED==="true"}}var Re=null,xs=0,Pr=5e3,Ne=null,Fs=!1,Br={enabled:!0,disabledBuiltinPatterns:[],customPatterns:[],logMatches:!1},Hr=/"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;function Wr(n){if(!(0,$e.existsSync)(n))return null;try{return(0,$e.readFileSync)(n,"utf-8")}catch{return""}}function $r(n){if(n===null)return!1;try{let e=JSON.parse(ge(n));return e===null||typeof e!="object"||Array.isArray(e)}catch{return!0}}function jr(n,e,t){return process.env.CLAUDE_MEM_REDACT_ENABLED==="false"||!(Ne?.enabled===!0||Hr.test(e))?t:(Fs||(Fs=!0,l.warn("REDACT","settings.json could not be read; secret redaction stays on until it is repaired",{settingsPath:n,using:Ne?.enabled?"the last configuration that loaded":"the built-in patterns"})),Ne?.enabled?Ne:Br)}function he(n=ve){let e=Date.now();if(Re&&e-xs<Pr)return Re;let t=le.loadFromFile(n),s=Fr(t),r=s.enabled?null:Wr(n);return $r(r)?Re=jr(n,r,s):(Re=s,Ne=s),xs=e,Re}var Xr=/(?:password|passwd)$|\w_pwd$/i,Gr=/(?:^|_)(?:secret|token|api_key)$/i,Kr=new RegExp(`^${Oe}{8,}$`);function Vr(n,e,t){if(!t.genericEnabled)return null;let s=Xr.test(n)?"generic_password":Gr.test(n)?"generic_token":null;return!s||t.disabledBuiltinPatterns?.includes(s)||!Kr.test(e)||!/[A-Za-z]/.test(e)?null:`<redacted type='${s}'/>`}var Ps=/^(?:proxy-)?authorization$/i,qr=new RegExp(`^(${U}Bearer${U})${ee}`,"i");function Yr(n,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("bearer_token")||!Ps.test(n))return null;let s=qr.exec(e);return s?`${s[1]}<redacted type='bearer_token'/>${e.slice(s[0].length)}`:null}var Jr=new RegExp(`^(${U}Basic${U})${ee}`,"i");function zr(n,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("basic_auth")||!Ps.test(n))return null;let s=Jr.exec(e);return s?`${s[1]}<redacted type='basic_auth'/>${e.slice(s[0].length)}`:null}var Qr=/^(?:aws_session_token|SessionToken)$/i,Zr=/^[A-Za-z0-9/+=]{100,}$/;function eo(n,e,t){return t.disabledBuiltinPatterns?.includes("aws_session_token")||!Qr.test(n)||!Zr.test(e)?null:"<redacted type='aws_session_token'/>"}var to=/^(?:aws_secret_access_key|SecretAccessKey)$/i,so=/^[A-Za-z0-9/+=]{40}$/;function no(n,e,t){return t.disabledBuiltinPatterns?.includes("aws_secret_key")||!to.test(n)||!so.test(e)?null:"<redacted type='aws_secret_key'/>"}var Bs=/^(?:set-)?cookie$/i;function ro(n,e,t){return t.disabledBuiltinPatterns?.includes("cookie_header")||!Bs.test(n)||e.trim().length<4?null:"<redacted type='cookie_header'/>"}function Hs(n,e=he()){if(!e.enabled)return n;let t=(s,r)=>{if(typeof s=="string"){let o=r===void 0?null:ro(r,s,e);if(o)return o;let i=ue(s,e);return r===void 0||Object.keys(i.counts).length>0?i.redacted:eo(r,s,e)??no(r,s,e)??Yr(r,s,e)??zr(r,s,e)??Vr(r,s,e)??i.redacted}return Array.isArray(s)?s.map(o=>t(o,r!==void 0&&Bs.test(r)?r:void 0)):s!==null&&typeof s=="object"?Object.fromEntries(Object.entries(s).map(([o,i])=>[o,t(i,o)])):s};return t(n)}var oo=1024*1024,Rt="<redacted type='diagnostic_budget'/>";function Ws(n,e=he()){if(!e.enabled)return n;let t=5e4,s=(o,i=[])=>{if(!i.length)return ue(o,e).redacted;for(let a of i){let _=Hs({[a]:o},e)[a];if(_!==o)return _}return o},r=(o,i,a=[])=>{if(i>32||--t<0)return Rt;if(typeof o=="string"){if(o.length>oo)return ue(o,e).redacted;try{let _=JSON.parse(o);if(_!==null&&(typeof _=="object"||typeof _=="string")){let d=r(_,i+1,a),E=JSON.stringify(d);if(E!==JSON.stringify(_))return E}}catch{}return s(o,a)}if(Array.isArray(o))return o.length>t?Rt:o.map(_=>r(_,i+1,a));if(o&&typeof o=="object"){let _=Object.entries(o);return _.length>t?Rt:Object.fromEntries(_.map(([d,E])=>[s(d,a),r(E,i+1,[d,...a])]))}return o};return r(n,0)}var zi=Object.freeze({maxImagesPerEvent:4,maxSourceBytes:3145728,maxCanonicalBytes:3145728,maxEncodedCanonicalBytes:1048576,maxPixels:24e6,maxDimension:8192,conversionTimeoutSeconds:5,maxConcurrentConversions:1,maxDerivativeBytes:262144,maxDerivativeDimension:1536,maxInlineEncodedBytes:4194304,maxObservationRefs:32,maxLabelChars:64,maxManifestBytes:8192,maxProvenanceBytes:8192,maxSourceLocatorChars:4096,maxGatewayImageBytes:1048576,maxUploadBodyBytes:3211264,ownerQuotaBytes:26843545600});var js=4096;var io=new Set(["set_title","set_prompt_session","remap_project"]),ao=/^(?:0|[1-9][0-9]*)$/,Xs=18446744073709551615n;function k(n){let e=Ws(n);throw l.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:e}),new Error(`canonical content: ${e}`)}function Le(n,e={}){return typeof n!="string"||!ao.test(n)?k("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(n)>Xs&&k("decimal value exceeds uint64"),e.positive&&n==="0"&&k("decimal value must be positive"),n)}function Xe(n){let e=Le(n);return BigInt(e)===Xs&&k("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function _o(n){(n===null||typeof n!="object"||Array.isArray(n))&&k("mutation must be an object");let e=n;if((typeof e.op!="string"||!io.has(e.op))&&k("unsupported mutation op"),e.op==="set_title"){let o=be(e,["fields","op","target"],"set_title"),i=je(o.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");i.memory_session_id===void 0&&i.content_session_id===void 0&&k("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])i[_]!==void 0&&te(i[_],_);let a=be(o.fields,["custom_title"],"set_title.fields");te(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let o=be(e,["fields","op","target"],"set_prompt_session"),i=be(o.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");Eo(i.origin_device_id),Le(i.origin_local_id);let a=je(o.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");te(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&te(a[_],_);return}let t=be(e,["fields","op","where"],"remap_project"),s=je(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&te(s.project,"project"),s.memory_session_id!==void 0&&te(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&k("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&k("remap_project where is empty");let r=je(t.fields,["merged_into_project","project"],"remap_project.fields");r.project!==void 0&&te(r.project,"project"),r.merged_into_project!==void 0&&te(r.merged_into_project,"merged_into_project"),Object.keys(r).length===0&&k("remap_project fields are empty")}function Nt(n){_o(n)}function Eo(n){return typeof n!="string"||n.length===0||Buffer.byteLength(n,"utf8")>128?k(`origin_device_id must be a non-empty string of at most ${128} UTF-8 bytes`):n}function te(n,e){return typeof n!="string"||n.length===0||n.trim().length===0||Buffer.byteLength(n,"utf8")>js?k(`${e} must be a non-blank string of at most ${js} UTF-8 bytes`):n}function be(n,e,t){if(n===null||typeof n!="object"||Array.isArray(n))return k(`${t} must be an object`);let s=n,r=Object.keys(s).sort(),o=[...e].sort();return(r.length!==o.length||r.some((i,a)=>i!==o[a]))&&k(`${t} must contain exactly: ${o.join(", ")}`),s}function je(n,e,t){if(n===null||typeof n!="object"||Array.isArray(n))return k(`${t} must be an object`);let s=n,r=new Set(e),o=Object.keys(s).find(i=>!r.has(i));return o&&k(`${t} contains unknown field ${o}`),s}var Gs=n=>typeof n=="string"&&/^__my_work_v\d+:/.test(n),Ot=n=>`(COALESCE(${n}, '') GLOB '__my_work_v[0-9]*:*'
  AND substr(${n}, 12, instr(substr(${n}, 12), ':') - 1) NOT GLOB '*[^0-9]*')`;function Ks(n,e){let t=o=>o.replace(/[A-Z]/g,i=>i.toLowerCase()),s=new Set(e.map(t)),r=e.at(-1);return n.map(o=>r&&s.has(t(o.project))?{...o,scope_project:r}:o)}function Vs(n){n.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `),n.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)"),lo(n)}function lo(n){let e=new Set(n.query("PRAGMA table_info(work_state_entries)").all().map(t=>t.name));e.has("synced_at")||n.run("ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER"),e.has("origin_device_id")||n.run("ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT"),e.has("origin_local_id")||n.run("ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT"),e.has("sync_rev")||n.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'"),n.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL"),n.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `)}function qs(n,e){let t=e.createdAtEpoch??Date.now(),s=n.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(e.project,e.listName,JSON.stringify(e.fields),new Date(t).toISOString(),t),r=Number(s.lastInsertRowid);return l.debug("DB","Work state entry appended",{id:r,project:e.project,listName:e.listName}),r}function Ys(n,e,t,s=""){if(e.length===0||Gs(t))return[];let r=e.map(()=>"?").join(", "),o=t===void 0?"":" AND list_name = ?",i=n.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${r})${o}
      AND NOT (
        list_name GLOB '__my_work_v[0-9]*:*'
        AND substr(list_name, 12, instr(substr(list_name, 12), ':') - 1) NOT GLOB '*[^0-9]*'
      )
    ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)
  `);try{return i.all(...e,...t===void 0?[]:[t],s).map(_=>({..._,fields:JSON.parse(_.fields)}))}finally{i.finalize()}}var tn=require("crypto");function Ge(n){let e=(n??"").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu," ").replace(/\s+/g," ").trim();return/[\p{L}\p{N}]/u.test(e)?e:""}function Ke(n,e){let t=Ge(n);if(!t||t!==Ge(e))return!1;let s=r=>((r??"").normalize("NFC").toLowerCase().trim().replace(/^__([\s\S]*\s[\s\S]*)__$/u,"$1").match(/[\p{L}\p{N}\p{M}._/\\:@#=<>+~-]+/gu)??[]).map(o=>/^(?:\.+)$|[/\\]\.+$/u.test(o)?o:o.replace(/\.+$/u,"")).filter(o=>/^\.+$/u.test(o)||/[/\\]/.test(o)||/[\p{L}\p{N}]/u.test(o)&&(/[._@#=<>+~]/.test(o)||/[\p{L}\p{N}\p{M}]:+[\p{L}\p{N}\p{M}]/u.test(o)||/^[a-z]:$/u.test(o)));return JSON.stringify(s(n))===JSON.stringify(s(e))}function z(n){return(n??"").toLowerCase().trim().split(/\s+/).filter(Boolean)}var Js=!1;function pe(n,...e){return typeof n.iterate=="function"?n.iterate(...e):(Js||(Js=!0,l.warn("DB","bun:sqlite lacks Statement.iterate(); falling back to .all()",{bunVersion:typeof Bun<"u"?Bun.version:"unknown",requiredBunVersion:">=1.1.31",impact:"rows are materialized in memory; upgrade Bun to restore streaming"})),n.all(...e))}function ht(n,e){return Math.log(1+e/(n+.5))}function zs(n,e){return t=>ht(n(t),e)}function Qs(n,e){let t=new Map;for(let s of new Set(n))t.set(s,e(s));return t}function Zs(n,e,t){let s=Qs(n,t),r=Qs(e,t),o=0,i=0,a=0;for(let[_,d]of s){i+=d*d;let E=r.get(_);E!==void 0&&(o+=d*E)}for(let[,_]of r)a+=_*_;return i===0||a===0?0:o/Math.sqrt(i*a)}function en(n,e,t,s){let r=new Set(n),o=new Set(e);for(let i of r)if(!o.has(i)&&t(i)>s)return!0;for(let i of o)if(!r.has(i)&&t(i)>s)return!0;return!1}function bt(n,e,t,s){if(Ke(n,e))return{tier:"exact",method:"exact",score:1};let r=z(n),o=z(e),i=s.minSharedTokens??2,a=new Set(o),_=0;for(let E of new Set(r))a.has(E)&&_++;if(_<i)return{tier:"none",method:"none",score:0};let d=Zs(r,o,t);return d>=s.cosineThreshold&&!en(r,o,t,s.vetoThetaIdf)?{tier:"candidate",method:"idf_cosine",score:d}:{tier:"none",method:"none",score:d}}function me(n,e){return!!n&&!!e}function Ie(n,e,t,s=!1){let r=Ge(t);if(r==="")return null;let o=N(e),i=s?"subagent":"main";return(0,tn.createHash)("sha256").update(`${n}\0${o}\0${i}\0${r}`).digest("hex").slice(0,32)}function sn(n,e,t,s){if(t===null)return null;let r=n.prepare("SELECT id, title, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC");try{for(let o of pe(r,e,t)){let i=o;if(Ke(s,i.title))return{id:i.id,occurrence_count:i.occurrence_count,created_at_epoch:i.created_at_epoch}}return null}finally{r.finalize()}}function nn(n,e,t){let s=[...new Set(z(t))],r=n.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1");for(let o of s)r.run(e,o);n.prepare("INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1").run(e)}function rn(n,e){return ht(n+1,e)}function on(n,e){return n.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(e)?.doc_count??0}function an(n,e,t){let s=on(n,e),r=t===void 0?n.prepare("SELECT token, df FROM token_df WHERE project = ?").all(e):n.prepare("SELECT token, df FROM token_df WHERE project = ? AND token IN (SELECT value FROM json_each(?))").all(e,JSON.stringify([...new Set(t)])),o=new Map(r.map(i=>[i.token,i.df]));return{idfFn:zs(i=>o.get(i)??0,s),docCount:s}}function _n(n){return n.prepare("INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")}function dn(n,e,t){return on(n,e)>=t}function uo(n,e,t=Number.POSITIVE_INFINITY){return n.transaction(()=>{let s=n.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(e).c;if(s>t)return l.warn("DEDUP",`Skipping dedup backfill for project ${e}: ${s} rows exceeds cap ${t} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`),0;let r=n.prepare("SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?").all(e),o=n.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?"),i=n.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)"),a=new Map;for(let _ of r){o.run(Ie(e,_.platform_source,_.title,me(_.agent_id,_.agent_type)),_.id);for(let d of new Set(z(_.title)))a.set(d,(a.get(d)??0)+1)}n.prepare("DELETE FROM token_df WHERE project = ?").run(e);for(let[_,d]of a)i.run(e,_,d);return n.prepare("INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0").run(e,r.length,r.length),r.length}).immediate()}function po(n,e,t){let s=Math.trunc(t.maxBackfillRows),r=Number.isSafeInteger(s)&&s<Number.MAX_SAFE_INTEGER?Math.max(0,s)+1:-1,o=n.prepare("SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC LIMIT ?").all(e,r);if(o.length<2)return 0;if(o.length>t.maxBackfillRows)return l.warn("DEDUP",`Skipping dedup sweep for project ${e}: more than ${t.maxBackfillRows} rows`),0;let{idfFn:i,docCount:a}=an(n,e),_={cosineThreshold:t.cosineThreshold,vetoThetaIdf:rn(t.idfVetoDf,a),minSharedTokens:t.minSharedTokens},d=o.map(T=>new Set(z(T.title))),E=new Map;for(let T of d)for(let L of T)E.set(L,(E.get(L)??0)+1);let c=Math.max(2,Math.ceil(Math.sqrt(o.length))*4),p=new Map;d.forEach((T,L)=>{for(let m of T){let A=E.get(m);if(A<2||A>c)continue;let f=p.get(m);f||(f=[],p.set(m,f)),f.push(L)}});let g=_n(n),u=new Date().toISOString(),R=Date.now(),y=0,v=new Map;for(let T=0;T<o.length;T++){v.clear();for(let L of d[T]){let m=p.get(L);if(m)for(let A of m)A>T&&v.set(A,(v.get(A)??0)+1)}for(let[L,m]of v){if(m<t.minSharedTokens)continue;let A=bt(o[T].title,o[L].title,i,_);A.tier==="candidate"&&(y+=g.run(o[L].id,o[T].id,e,A.method,A.score,"pending",u,R).changes)}}return y}function En(n,e){return n.prepare("SELECT DISTINCT project FROM observations").all().map(s=>s.project).map(s=>{let r=uo(n,s,e.maxBackfillRows),o=po(n,s,e);return{project:s,docs:r,candidates:o}})}function cn(n,e,t,s,r){if(!s)return 0;let o=n.prepare("SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?").all(e,t,r.maxScan);if(o.length===0)return 0;let i=new Set(z(s));for(let u of o)for(let R of z(u.title))i.add(R);let{idfFn:a,docCount:_}=an(n,e,i),d={cosineThreshold:r.cosineThreshold,vetoThetaIdf:rn(r.idfVetoDf,_),minSharedTokens:r.minSharedTokens};o.length===r.maxScan&&l.debug("DEDUP",`Tier-1 scan hit MAX_SCAN=${r.maxScan} for project ${e}; older rows covered by dedup-scan`);let E=_n(n),c=new Date().toISOString(),p=Date.now(),g=0;for(let u of o){let R=bt(s,u.title,a,d);R.tier==="candidate"&&(g+=E.run(t,u.id,e,R.method,R.score,"pending",c,p).changes)}return g}function ln(n,e,t,s,r){let o=Date.now()-s,i=r!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=r??e;return n.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${S}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${i}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,t,o)??void 0}var Tn=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],mo=new Set(Tn),un=/<([A-Za-z_][A-Za-z0-9_-]*)/y,pn=/<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;function To(n){let e=Object.fromEntries(Tn.map(E=>[E,0]));if(!n.includes("<"))return{text:n,counts:e,total:0};let t=n.length,s=new Int32Array(t+1);s[t]=t;for(let E=t-1;E>=0;E--)s[E]=n.charCodeAt(E)===62?E:s[E+1];let r=new Map,o=[],i=0,a=0;for(;a<t;){if(n.charCodeAt(a)!==60){a+=1;continue}pn.lastIndex=a;let E=pn.exec(n);if(E){let p=E[1],g=r.get(p),u=g&&g.head<g.items.length?g.items[g.head]:void 0;u&&a>=u.attrEnd&&(g.head+=1,o.push([u.start,a+E[0].length]),e[p]+=1,i+=1),a+=E[0].length;continue}un.lastIndex=a;let c=un.exec(n);if(c&&mo.has(c[1])){let p=c[1],g=a+c[0].length,u={start:a,attrEnd:s[g]},R=r.get(p);R?R.items.push(u):r.set(p,{items:[u],head:0}),a=g;continue}a+=1}o.sort((E,c)=>E[0]-c[0]);let _="",d=0;for(let[E,c]of o)E>d&&(_+=n.slice(d,E)),c>d&&(d=c);return _+=n.slice(d),{text:_,counts:e,total:i}}var mn=100;function So(n){return go(n,To(n))}function go(n,{text:e,counts:t,total:s}){return s>mn&&l.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:mn,contentLength:n.length}),{stripped:ue(e.trim(),he()).redacted,counts:t}}function Ve(n){return So(n).stripped}var Ao=["task-notification"],Pa=new RegExp(`^\\s*<(${Ao.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Ba=256*1024;function Sn(n,e,t){let s=Math.min(n.length,Math.max(0,Math.floor(e))),r=Math.max(s,n.length-Math.max(0,Math.floor(t))),o=i=>{let a=n.charCodeAt(i-1),_=n.charCodeAt(i);return a>=55296&&a<=56319&&_>=56320&&_<=57343};return o(s)&&s--,o(r)&&r++,{head:n.slice(0,s),tail:n.slice(r)}}var Lt=4e3,It="[media prompt]";function ie(n){let e=Ve(n).trim();return e.length<=Lt?e:(l.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:e.length,storedLength:Lt}),`${Sn(e,Lt-1,0).head}\u2026`)}var fo=require("bun:sqlite");var gn=5e3,Ro=4194304,Ce=75;function An(n){let e=n.prepare("PRAGMA user_version");try{return e.get().user_version}finally{e.finalize()}}var qe=class extends Error{reason="schema_newer_than_binary";constructor(e){super(e),this.name="SchemaNewerThanBinaryError"}};function Ye(n,e){n.run(`PRAGMA busy_timeout = ${gn}`);let t=An(n);if(!(t<=e))throw new qe(`SQLite database has schema v${t}; this claude-mem knows up to schema v${e}. Upgrade claude-mem before opening this database.`)}function Ct(n,e){Ye(n,e),An(n)<e&&n.run(`PRAGMA user_version = ${e}`)}function fn(n,e){n.transaction(()=>Ct(n,e)).immediate()}function No(n){let e=n.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `);try{return e.get()!=null}finally{e.finalize()}}function Te(n,e,t){try{n.run(e)}catch(s){let r=s instanceof Error?s:new Error(String(s));throw l.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},r),s}}function Dt(n,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;Te(n,`PRAGMA busy_timeout = ${gn}`,"busy_timeout"),Te(n,"PRAGMA foreign_keys = ON","foreign_keys"),Te(n,"PRAGMA synchronous = NORMAL","synchronous"),Te(n,`PRAGMA journal_size_limit = ${Ro}`,"journal_size_limit"),s&&!No(n)&&Te(n,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&Te(n,"PRAGMA journal_mode = WAL","journal_mode")}function Mt(n){let e=`a.id IN (${n.candidateAttachmentIdsSql})
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
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${e})`]}var Je="SELECT event_key FROM media_events WHERE session_db_id=OLD.id",Oo=Mt({candidateAttachmentIdsSql:"SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id",eventRefsBeingRemovedSql:"0",observationLinksBeingRemovedSql:"l.observation_id=OLD.id"}),ho=Mt({candidateAttachmentIdsSql:`SELECT attachment_id FROM media_event_refs WHERE event_key IN (${Je})`,eventRefsBeingRemovedSql:`r.event_key IN (${Je})`,observationLinksBeingRemovedSql:"0"}),qa=Mt({candidateAttachmentIdsSql:"SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey",eventRefsBeingRemovedSql:"r.event_key=$eventKey",observationLinksBeingRemovedSql:"0"});function Rn(n){n.transaction(()=>{n.exec(`
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
    `),De(n,"media_attachments","origin","TEXT NOT NULL DEFAULT 'native'"),De(n,"media_attachments","upload_attempts","INTEGER NOT NULL DEFAULT 0"),De(n,"media_attachments","upload_retry_at","INTEGER NOT NULL DEFAULT 0"),De(n,"media_attachments","upload_error","TEXT"),n.exec("CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)"),De(n,"media_events","carry_prompt_number","INTEGER"),n.exec(`CREATE INDEX IF NOT EXISTS idx_media_events_carry ON media_events(session_db_id, carry_prompt_number)
      WHERE carry_prompt_number IS NOT NULL`),n.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${Oo.join(`;
        `)};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${ho.join(`;
        `)};
        DELETE FROM media_event_refs WHERE event_key IN (${Je});
        DELETE FROM media_event_results WHERE event_key IN (${Je});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);let e=new Date().toISOString();n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(69,e),n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(70,e),n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(71,e),n.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(72,e)})()}function De(n,e,t,s){n.prepare(`PRAGMA table_info(${e})`).all().some(o=>o.name===t)||n.exec(`ALTER TABLE ${e} ADD COLUMN ${t} ${s}`)}var yt="\\p{Script=Han}\\u31F0-\\u31FF\\uFF66-\\uFF9F\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF",Nn=new RegExp(`[${yt}]`,"u"),Ja=new RegExp(`[${yt}]+|[^\\s${yt}]+`,"gu");var s_=1440*60*1e3;var ze=n=>`(SELECT state = 'ready' OR ${n}.id <= cursor FROM tool_uses_search_schema WHERE id = 1)`,E_=`
CREATE TRIGGER tool_uses_fts_ai AFTER INSERT ON tool_uses WHEN ${ze("new")} BEGIN
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response) VALUES(new.id, new.tool_input, new.tool_response);
END;
CREATE TRIGGER tool_uses_fts_ad AFTER DELETE ON tool_uses WHEN ${ze("old")} BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    VALUES('delete', old.id, old.tool_input, old.tool_response);
END;
CREATE TRIGGER tool_uses_fts_au AFTER UPDATE OF id, tool_input, tool_response ON tool_uses
WHEN old.id IS NOT new.id OR old.tool_input IS NOT new.tool_input OR old.tool_response IS NOT new.tool_response BEGIN
  INSERT INTO tool_uses_fts(tool_uses_fts, rowid, tool_input, tool_response)
    SELECT 'delete', old.id, old.tool_input, old.tool_response WHERE ${ze("old")};
  INSERT INTO tool_uses_fts(rowid, tool_input, tool_response)
    SELECT new.id, new.tool_input, new.tool_response WHERE ${ze("new")};
END;`;var Do=require("bun:sqlite");var vt=`
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
`,Ut=`
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
`;var On=`(SELECT id, rev,
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
      END AS candidate FROM sync_outbox))`,Mo=`(SELECT * FROM ${On} ORDER BY id LIMIT 1)`;var Qe=n=>`CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.${n}') END`,yo={kind:"o.kind",localId:"o.origin_local_id",rev:"o.entity_rev",deleted:"o.deleted",project:Qe("project"),memory:Qe("memory_session_id"),content:Qe("content_session_id"),merged:Qe("merged_into_project")};var V_=Ot("list_name");function hn(n){n.run(`CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
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
    created_at_epoch INTEGER NOT NULL)`)}var bn=`CASE WHEN json_valid(o.concepts) THEN CASE
    WHEN json_type(o.concepts) = 'array' THEN o.concepts
    WHEN json_type(o.concepts) = 'text' THEN json_array(json_extract(o.concepts, '$'))
    ELSE json_array(o.concepts) END ELSE json_array(o.concepts) END`;var Dn=5*6e4,Ln=`
  CREATE TABLE IF NOT EXISTS sync_entity_heads (
    entity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_device_id TEXT NOT NULL,
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    updated_at_epoch INTEGER NOT NULL
  )`,In=`
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
  )`,Cn=`
  CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    through_rev TEXT NOT NULL,
    PRIMARY KEY (kind, origin_local_id)
  )`,b=n=>typeof n=="object"&&n!==null?JSON.stringify(n):n??null;function Mn(n){let e=[],t=[],s=new Set,r=new Set;for(let o of n){for(let i of o.files_read??[])!i||s.has(i)||(s.add(i),e.push(i));for(let i of o.files_modified??[])!i||r.has(i)||(r.add(i),t.push(i))}return{files_read:e,files_edited:t}}var Uo=200,wo=1e3,wt=`char(${[9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279].join(", ")})`,ko=56,xo=57;function kt(n){let e=Number(n);return Number.isSafeInteger(e)&&e>0?e:void 0}function xt(n){return typeof n.merged_into_project=="string"&&n.merged_into_project?[n.project,n.merged_into_project]:[n.project]}var Pt=class{db;syncOpsEnabled;statementCache=new Map;localSyncDeviceId="";constructor(e=it,t={}){this.syncOpsEnabled=t.syncOpsEnabled??!0,e instanceof Ft.Database?this.db=e:(e!==":memory:"&&at(D),this.db=new Ft.Database(e)),Ye(this.db,Ce),Dt(this.db),fn(this.db,Ce),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable(),this.ensureCommittedToolUsesTable(),this.ensureDeletedSessionCutoffTriggers(),this.ensureTelegramWrapupsTable(),this.addDedupTables(),this.refreshUnicodeTitleNormKeys(),this.ensureReinforcementColumns(),this.ensureSessionCwdColumn(),this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(),this.ensureProjectNocaseIndexes(),this.ensureAdvisorCallsTable(),this.ensureSessionProjectKeySourceColumn(),this.requeuePromptsDeadLetteredForSize(),this.ensureWorkStateTable(),this.ensureDeliverablesTable(),this.ensureHookSpoolConsumedTable(),this.ensureProjectRecencyIndexes(),this.ensureSessionCatalogRecencyIndex(),this.ensureMergedIntoProjectCoveringIndexes(),this.ensureNativePromptIdentity(),this.ensureObservationFileIndex(),Rn(this.db)}ensureObservationFileIndex(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 68").get())return;this.db.run(`CREATE TABLE IF NOT EXISTS observation_files (
        path TEXT NOT NULL,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        PRIMARY KEY (path, observation_id)
      )`),this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_files_observation ON observation_files(observation_id)");let e=t=>`SELECT o.id, je.value FROM observations o, json_each(o.${t}) je
         WHERE json_valid(o.${t}) AND json_type(o.${t}) = 'array' AND je.type = 'text'`;this.db.run(`INSERT OR IGNORE INTO observation_files(observation_id, path)
        ${e("files_read")} UNION ${e("files_modified")}`),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(68,new Date().toISOString())}).immediate()}indexObservationFiles(e,t,s){let r=new Set;for(let i of[...t,...s])typeof i=="string"&&i.length>0&&r.add(i);if(r.size===0)return;let o=this.cachedStatement("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let i of r)o.run(i,e)}ensureNativePromptIdentity(){this.db.transaction(()=>{let e=this.db.query("PRAGMA table_info(user_prompts)").all();for(let t of["native_prompt_id","native_prompt_hash"])e.some(s=>s.name===t)||this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${t} TEXT`);this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_native_identity
        ON user_prompts(session_db_id, native_prompt_id) WHERE native_prompt_id IS NOT NULL`),this.db.run(`CREATE INDEX IF NOT EXISTS idx_user_prompts_legacy_window
        ON user_prompts(session_db_id, created_at_epoch) WHERE native_prompt_id IS NULL`)}).immediate()}refreshUnicodeTitleNormKeys(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 65").get())return;let e=this.db.prepare(`SELECT o.id, o.project, o.title, o.agent_id, o.agent_type,
        s.platform_source FROM observations o LEFT JOIN sdk_sessions s
        ON s.memory_session_id = o.memory_session_id ORDER BY o.id`),t=this.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?");try{for(let s of pe(e)){let r=s;t.run(Ie(r.project,r.platform_source,r.title,me(r.agent_id,r.agent_type)),r.id)}this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(65,new Date().toISOString())}finally{e.finalize(),t.finalize()}}).immediate()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(r=>{if(r.unique!==1)return!1;let o=this.getIndexColumns(r.name);return o.length===t.length&&o.every((i,a)=>i===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let r=s?N(s):void 0;return r?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(S,r,e)?.id??null:this.db.prepare(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(ko,new Date().toISOString())}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),l.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(r){l.warn("DB","Failed to drop worker_pid column from pending_messages",{},r instanceof Error?r:new Error(String(r)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!t&&s&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${S}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let a=i instanceof Error?i:new Error(String(i));throw l.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),i}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let r=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&r&&!i)return;let a=r?`COALESCE(up.session_db_id, (
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw l.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),r}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(r=>r.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),l.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let t=this.db.query(`PRAGMA table_info(${e})`).all(),s=new Set(t.map(r=>r.name));s.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),l.debug("DB",`Added origin_device_id column to ${e} table`)),s.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),l.debug("DB",`Added origin_local_id column to ${e} table`)),s.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),l.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(i,a)=>this.db.query(`PRAGMA table_info(${i})`).all().find(_=>_.name===a),s=i=>i?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(i=>s(t(i.table,i.column))))return;this.db.transaction(()=>{for(let i of e){let a=this.db.query(`PRAGMA table_info(${i.table})`).all(),_=a.find(E=>E.name===i.column);if(!_)throw new Error(`schema v46: missing ${i.table}.${i.column}`);for(let E of pe(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${i.column}) AS storage_type,
                 CAST(${i.column} AS TEXT) AS revision
          FROM ${i.table}
        `))){let c=E;if(c.storage_type==="real")throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} is REAL and unrecoverably rounded`);if(c.storage_type!=="integer"&&c.storage_type!=="text")throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} has unsupported ${c.storage_type} storage`);try{Le(c.revision,{positive:!0})}catch{throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} is not a positive canonical uint64 revision`)}}if(s(_))continue;if(a.some(E=>E.name===i.temporary))throw new Error(`schema v46: unexpected temporary column ${i.table}.${i.temporary}`);this.db.run(`ALTER TABLE ${i.table} ADD COLUMN ${i.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${i.table} SET ${i.temporary} = CAST(${i.column} AS TEXT)`);let d=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${i.table}
          WHERE ${i.temporary} <> CAST(${i.column} AS TEXT)
          LIMIT 1
        `).get();if(d)throw new Error(`schema v46: failed to copy ${i.table}.${i.column} row ${d.row_id} exactly`);this.db.run(`ALTER TABLE ${i.table} DROP COLUMN ${i.column}`),this.db.run(`ALTER TABLE ${i.table} RENAME COLUMN ${i.temporary} TO ${i.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){hn(this.db),this.db.run(Ln),this.widenSyncKindCheck("sync_entity_heads",Ln),this.db.run(In),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(t=>t.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `)),this.widenSyncKindCheck("sync_content_outbox",In),this.db.run("CREATE INDEX IF NOT EXISTS idx_sync_content_outbox_kind_pending ON sync_content_outbox(kind, deleted DESC, id)"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}widenSyncKindCheck(e,t){let s=this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(e);if(!s||s.sql.includes("'work_state'"))return;let r=this.db.query(`PRAGMA table_info(${e})`).all().map(i=>i.name).join(", "),o=`${e}_pre_work_state`;this.db.transaction(()=>{this.db.run(`DROP TABLE IF EXISTS ${o}`),this.db.run(`ALTER TABLE ${e} RENAME TO ${o}`),this.db.run(t),this.db.run(`INSERT INTO ${e} (${r}) SELECT ${r} FROM ${o}`),this.db.run(`DROP TABLE ${o}`)}).immediate(),l.info("DB",`Rebuilt ${e} to admit the work_state sync kind`)}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],t=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!=null;this.db.run(Cn),this.widenSyncKindCheck("sync_launch_exclusions",Cn);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:E,kind:c}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${E}
            WHERE origin_device_id IS NULL
          `).run(c),this.db.prepare(`
            UPDATE ${E} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let d=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,d),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,d)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&t)return;let o=Date.parse(s.applied_at);if(!Number.isSafeInteger(o)||o<0)throw new Error(`schema v48: invalid v47 applied_at ${s.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:_}of e)this.db.prepare(`
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
      `);for(let o of r){if(o.origin_device_id!==null)continue;let i=Xe(o.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(i,o.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),l.debug("DB",`Normalized prefixed concept tags in ${t} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>s.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),l.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),l.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),l.warn("DB",`Created ${t} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(s=>s.table==="sdk_sessions"&&s.from==="memory_session_id"&&s.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,t,s){let r=this.db.query(`PRAGMA table_info(${e})`).all(),o=r.filter(i=>!s.includes(i.name));for(let i of o){let a=i.type?` ${i.type}`:"",_=i.dflt_value===null||i.dflt_value===void 0?"":` DEFAULT ${i.dflt_value}`;this.db.run(`ALTER TABLE ${t} ADD COLUMN "${i.name}"${a}${_}`),l.debug("DB",`Carried ${i.name} over the ${e} rebuild (#3849)`)}return r.map(i=>i.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}l.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let s=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],o=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!s.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `);for(let a of o){let _=a.type?` ${a.type}`:"",d=a.dflt_value===null||a.dflt_value===void 0?"":` DEFAULT ${a.dflt_value}`;this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${a.name}"${_}${d}`),l.debug("DB",`Carried ${a.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`)}let i=[...s,...o.map(a=>a.name)].map(a=>`"${a}"`).join(", ");this.db.run(`
      INSERT INTO session_summaries_new (${i})
      SELECT ${i}
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.recreateFtsTriggersIfIndexed("session_summaries"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),l.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}l.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),l.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}l.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.recreateFtsTriggersIfIndexed("observations"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),l.debug("DB","Successfully made observations.text nullable")}recreateFtsTriggersIfIndexed(e){let t=`${e}_fts`;this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(t).length>0&&(this.db.run(`INSERT INTO ${t}(${t}) VALUES('rebuild')`),this.db.run(e==="observations"?vt:Ut))}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}l.debug("DB","Creating user_prompts table"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),l.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){this.db.query("PRAGMA table_info(observations)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}l.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),l.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;l.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),_=a.some(E=>E.name===o);return a.some(E=>E.name===i)?!1:_?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),l.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(l.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?l.debug("DB",`Successfully renamed ${t} session ID columns`):l.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),l.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),t=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!t){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}l.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let s=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],r=`
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
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(r,s,o)),t&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(a,i,_)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),l.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(d){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),d instanceof Error?d:new Error(String(d))}}recreateObservationsWithCascade(e,t,s){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("observations","observations_new",t).map(i=>`"${i}"`).join(", ");this.db.run(`INSERT INTO observations_new (${o}) SELECT ${o} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.recreateFtsTriggersIfIndexed("observations")}recreateSessionSummariesWithCascade(e,t,s){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",t).map(i=>`"${i}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${o}) SELECT ${o} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.recreateFtsTriggersIfIndexed("session_summaries")}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),l.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),l.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&r||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),l.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${S}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(r=>r.name==="generated_by_model"),s=e.some(r=>r.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),t=e.some(r=>r.name==="observed_model"),s=e.some(r=>r.name==="observed_billing");t&&s||(t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){ds(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(75,new Date().toISOString())}ensureDeliverablesTable(){gs(this.db)}recordDeliverable(e){return As(this.db,e)}getDeliverable(e){return fs(this.db,e)}ensureWorkStateTable(){Vs(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(66,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(67,new Date().toISOString())}ensureProjectRecencyIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63,new Date().toISOString())}ensureSessionCatalogRecencyIndex(){this.db.run(`CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase_recent
      ON sdk_sessions(project COLLATE NOCASE, started_at_epoch DESC, id DESC)`)}ensureMergedIntoProjectCoveringIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_project ON observations(merged_into_project COLLATE NOCASE, project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_project ON session_summaries(merged_into_project COLLATE NOCASE, project)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(64,new Date().toISOString())}ensureHookSpoolConsumedTable(){this.db.run(`
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
    `).get(N(e),t,s)!=null}markSessionDeleted(e,t,s){let r=Date.now();this.db.prepare(`
      INSERT INTO deleted_content_sessions
        (platform_source, content_session_id, deleted_at_epoch_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(platform_source, content_session_id)
      DO UPDATE SET deleted_at_epoch_ms = MAX(deleted_at_epoch_ms, excluded.deleted_at_epoch_ms)
    `).run(N(e),t,r),s&&this.db.prepare(`
        INSERT OR IGNORE INTO deleted_memory_sessions
          (memory_session_id, deleted_at_epoch_ms)
        VALUES (?, ?)
      `).run(s,r)}isSessionDeleted(e,t){return this.getSessionDeletedAtEpochMs(e,t)!==null}getSessionDeletedAtEpochMs(e,t){return this.db.prepare(`
      SELECT deleted_at_epoch_ms FROM deleted_content_sessions
      WHERE platform_source = ? AND content_session_id = ?
    `).get(N(e),t)?.deleted_at_epoch_ms??null}isBeforeSessionDeletion(e,t,s){let r=this.getSessionDeletedAtEpochMs(e,t);return r===null?!1:!(typeof s=="number"&&Number.isFinite(s)&&s>r)}markCommittedToolUses(e){if(!e.contentSessionId)throw new Error("Committed tool uses require a content session");let t=this.cachedStatement(`
      INSERT OR IGNORE INTO committed_observation_tool_uses
      (platform_source, content_session_id, tool_use_id, committed_at_epoch_ms)
      VALUES (?, ?, ?, ?)
    `),s=N(e.platformSource),r=Date.now();this.db.transaction(()=>{for(let o of new Set(e.toolUseIds))o&&t.run(s,e.contentSessionId,o,r)})()}isHookSpoolEntryConsumed(e){return this.db.prepare("SELECT 1 FROM hook_spool_consumed WHERE entry_key = ?").get(e)!=null}markHookSpoolEntryConsumed(e,t){this.db.prepare("INSERT INTO hook_spool_consumed (entry_key, consumed_at_epoch_ms) VALUES (?, ?) ON CONFLICT(entry_key) DO UPDATE SET consumed_at_epoch_ms = excluded.consumed_at_epoch_ms").run(e,t)}clearHookSpoolEntryConsumed(e){this.db.prepare("DELETE FROM hook_spool_consumed WHERE entry_key = ?").run(e)}pruneHookSpoolConsumedMarkersBefore(e){this.db.prepare("DELETE FROM hook_spool_consumed WHERE consumed_at_epoch_ms < ?").run(e)}ensureTelegramWrapupsTable(){this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())}ensureReinforcementColumns(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(t=>t.name==="reinforcement_dates")||this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT"),e.some(t=>t.name==="last_reinforced")||this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(xo,new Date().toISOString())}dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(){let e=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map(s=>s.name),t=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();if(e.length>0||t.length>0){this.db.run("BEGIN TRANSACTION");try{e.includes("observations_au")&&(this.db.run("DROP TRIGGER observations_au"),this.db.run(vt)),e.includes("session_summaries_au")&&(this.db.run("DROP TRIGGER session_summaries_au"),this.db.run(Ut)),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_fts"),this.db.run("COMMIT")}catch(s){throw this.db.run("ROLLBACK"),l.error("DB","Failed to scope FTS update triggers / drop user_prompts_fts, rolled back",{},s instanceof Error?s:new Error(String(s))),s}l.info("DB","Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts",{rescopedTriggers:e,droppedUserPromptsFts:t.length>0})}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}requeuePromptsDeadLetteredForSize(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60))return;let t="canonical content: body exceeds % UTF-8 bytes";this.db.transaction(()=>{let s=this.db.prepare(`
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
    `),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_calls_tool_use ON advisor_calls(tool_use_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_session ON advisor_calls(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_project ON advisor_calls(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_project_nocase ON advisor_calls(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_occurred ON advisor_calls(occurred_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(58,new Date().toISOString())}recordAdvisorCall(e){let t=new Date,s=this.db.prepare(`
      INSERT OR IGNORE INTO advisor_calls
      (session_db_id, content_session_id, project, platform_source, tool_use_id, advisor_model, cwd, last_user_message, transcript_path, transcript_byte_offset, advice, occurred_at_epoch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sessionDbId,e.contentSessionId,e.project,e.platformSource,e.toolUseId,e.advisorModel??null,e.cwd??null,e.lastUserMessage??null,e.transcriptPath??null,e.transcriptByteOffset??null,e.advice,e.occurredAtEpoch,t.toISOString(),t.getTime());return s.changes>0?{id:Number(s.lastInsertRowid),inserted:!0}:{id:this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(e.toolUseId)?.id??0,inserted:!1}}getAdvisorCalls(e,t,s,r){let o="SELECT * FROM advisor_calls",i=[],a=[];s?(a.push("project COLLATE NOCASE = ?"),i.push(s)):(a.push("project != ?"),i.push(de)),r&&(a.push("platform_source = ?"),i.push(r)),o+=` WHERE ${a.join(" AND ")}`,o+=" ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?",i.push(t+1,e);let _=this.db.prepare(o).all(...i);return{items:_.slice(0,t),hasMore:_.length>t,offset:e,limit:t}}getAdvisorCallById(e){return this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(e)??null}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="agent_type"),r=t.some(i=>i.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(_=>_.name==="agent_type"),a=o.some(_=>_.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw l.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),r}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="memory_session_id"),r=t.some(o=>o.name==="content_hash");if(!s||!r){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw l.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),l.debug("DB","Added metadata column to observations table (#2116)")),this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_observations_source_fingerprint ON observations(
        project,
        CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceFingerprint') END,
        id DESC
      ) WHERE CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceFingerprint') END IS NOT NULL
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){let s=this.db.prepare(`
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
      `).run(t,e),t&&this.requeuePromptSync(e)})()}enqueueMutationOp(e,t){if(!this.syncOpsEnabled)return;let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let r=s.target;r?.origin_device_id===null&&(r.origin_device_id="self")}Nt(s),t.op==="set_prompt_session"&&this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(t.target?.origin_device_id??null,String(t.target?.origin_local_id??"")),this.cachedStatement(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,Me.randomUUID)(),String(e),JSON.stringify(t),Date.now())}requeuePromptSync(e){if(!this.syncOpsEnabled)return;let t=this.cachedStatement(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let r=this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(r.length===0)return;let o=this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);for(let i of r){let a=Xe(i.sync_rev);o.run(a,i.id),this.enqueueMutationOp(a,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:i.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
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
        `).run(t,e),this.requeuePromptSync(e)})(),l.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,newId:t})):r.memory_session_id!==t&&l.debug("DB","Keeping the registered memory_session_id",{sessionDbId:e,registered:r.memory_session_id,offered:t}),typeof s=="number"&&r.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e),r.memory_session_id??t}getProjectReadKeys(e){return Qt(this.db,e)}getAllProjects(e){let t=e?N(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,r=[de];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",r.push(S,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...r).map(i=>i.project)}getProjectCatalog(e=!1){let t=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${S}') as platform_source,
        project,
        ${e?"cwd,":""}
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${S}'), project${e?", cwd":""}
      ORDER BY latest_epoch DESC
    `).all(de),s=[],r=new Set,o=new Map,i=new Map;for(let _ of t){let d=N(_.platform_source),E=o.get(d);if(E||o.set(d,E=new Set),E.add(_.project),_.cwd){let c=i.get(_.project);c||i.set(_.project,c=new Set),c.add(_.cwd)}r.has(_.project)||(r.add(_.project),s.push(_.project))}let a=is([...o.keys()]);return{projects:s,sources:a,...e&&{checkoutPathsByProject:Object.fromEntries([...i].map(([_,d])=>[_,[...d]])),projectMerges:this.db.query(`
          SELECT project AS source, merged_into_project AS target FROM observations
          WHERE merged_into_project COLLATE NOCASE IS NOT NULL
          UNION
          SELECT project, merged_into_project FROM session_summaries
          WHERE merged_into_project COLLATE NOCASE IS NOT NULL
        `).all()},projectsBySource:Object.fromEntries(a.map(_=>[_,[...o.get(_)??[]]]))}}getSessionCatalog(e={}){let t=Math.min(Math.max(Math.trunc(e.limit??Uo),1),wo),s=Math.max(Math.trunc(e.offset??0),0),r=`
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source,
        s.custom_title,
        -- Newest summary with words: its time is the MAX among them, and id breaks a tie in the
        -- index's own rowid order. Same result as ORDER BY created_at_epoch DESC, id DESC LIMIT 1,
        -- without a per-session sort (the plan stays free of temp B-trees, which
        -- tests/sqlite/session-catalog-recency.test.ts checks).
        (
          SELECT TRIM(ss.request, ${wt})
          FROM session_summaries ss
          WHERE ss.memory_session_id = s.memory_session_id
            AND TRIM(ss.request, ${wt}) != ''
            AND ss.created_at_epoch = (
              SELECT MAX(newest.created_at_epoch)
              FROM session_summaries newest
              WHERE newest.memory_session_id = s.memory_session_id
                AND TRIM(newest.request, ${wt}) != ''
            )
          ORDER BY ss.id DESC
          LIMIT 1
        ) as summary_title,
        s.started_at_epoch,
        (
          (SELECT COUNT(*) FROM observations o WHERE o.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM session_summaries ss WHERE ss.memory_session_id = s.memory_session_id)
          + (SELECT COUNT(*) FROM user_prompts up WHERE up.session_db_id = s.id)
        ) as item_count
      FROM sdk_sessions s
      WHERE s.project IS NOT NULL AND s.project != ''
        AND s.project != ?
    `,o=[de];e.project&&(r+=" AND s.project COLLATE NOCASE = ?",o.push(e.project)),e.platformSource&&(r+=` AND COALESCE(s.platform_source, '${S}') = ?`,o.push(N(e.platformSource))),r+=" ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?",o.push(t+1,s);let i=this.db.prepare(r).all(...o);return{sessions:i.slice(0,t),hasMore:i.length>t}}getUserPromptById(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ?
    `).get(e)}findRecentDuplicateUserPrompt(e,t,s,r){return ln(this.db,e,ie(t),s,this.resolvePromptSessionDbId(e,r)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let r=this.getProjectReadKeys([e]),o=X("s",r.length?r:[e],{includeMerged:!1}),i=[...o.params],a="";return s&&(a=`AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`,i.push(N(s))),i.push(t),this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          EXISTS (SELECT 1 FROM session_summaries sum
            WHERE sum.memory_session_id = s.memory_session_id) as has_summary
        FROM sdk_sessions s
        WHERE ${o.sql} AND s.memory_session_id IS NOT NULL
        ${a}
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(...i)}getObservationsForSession(e,t){let s=[e],r="";return t&&(r=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?
        )
      `,s.push(N(t))),this.db.prepare(`
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
        AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?
    `).get(e,N(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return Es(this.db,e)}linkToolUsesToObservation(e){return cs(this.db,e)}getToolUsesByIds(e,t={}){return us(this.db,e,t)}queryToolUses(e={}){return ps(this.db,e)}queryToolUseIndex(e={}){return ms(this.db,e)}appendWorkStateEntry(e){let t=qs(this.db,e);return Z({projects:[e.project]},"appendWorkStateEntry","additive",{kinds:["work_state"],workStateLists:[e.listName]}),t}setLocalSyncDeviceId(e){this.localSyncDeviceId=e}getLocalSyncDeviceId(){return this.localSyncDeviceId}getWorkStateEntries(e,t){return Ks(Ys(this.db,this.getProjectReadKeys(e),t,this.localSyncDeviceId),e)}countToolUses(e={}){return Ss(this.db,e)}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:r,type:o,concepts:i,files:a}=t,_=kt(t.limit),d=j(t),E=s==="relevance",c=s==="date_asc"?"ASC":"DESC",p=E?"":`ORDER BY o.created_at_epoch ${c}, o.id ${c}`,g=_&&!E?"LIMIT ?":"",u=[JSON.stringify(e)],R=[];if(d.length>0){let A=X("o",d,{includeMerged:!0});R.push(A.sql),u.push(...A.params)}if(r&&(R.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),u.push(N(r))),o)if(Array.isArray(o)){let A=o.map(()=>"?").join(",");R.push(`o.type IN (${A})`),u.push(...o)}else R.push("o.type = ?"),u.push(o);if(i){let A=Array.isArray(i)?i:[i],f=A.map(()=>`EXISTS (SELECT 1 FROM json_each(${bn}) WHERE type = 'text' AND value = ?)`);f.length>0&&(u.push(...A),R.push(`(${f.join(" OR ")})`))}if(a){let A=Array.isArray(a)?a:[a],f=P=>`CASE WHEN json_valid(${P}) THEN CASE WHEN json_type(${P}) = 'array' THEN ${P} ELSE '[]' END ELSE '[]' END`,I=A.map(()=>`(EXISTS (SELECT 1 FROM json_each(${f("o.files_read")}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(${f("o.files_modified")}) WHERE type = 'text' AND replace(value, '\\', '/') LIKE ? ESCAPE '\\'))`);I.length>0&&(A.forEach(P=>{let O=P.replace(/\\/g,"/").replace(/[\\%_]/g,"\\$&");u.push(`%${O}%`,`%${O}%`)}),R.push(`(${I.join(" OR ")})`))}let y=R.length>0?`WHERE o.id IN (SELECT value FROM json_each(?)) AND ${R.join(" AND ")}`:"WHERE o.id IN (SELECT value FROM json_each(?))";g&&u.push(_);let T=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${y}
      ${p}
      ${g}
    `).all(...u);if(!E)return T;let L=new Map(T.map(A=>[A.id,A])),m=e.map(A=>L.get(A)).filter(A=>!!A);return _?m.slice(0,_):m}getSummaryForSession(e,t){let s=[e],r="";return t&&(r=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${S}') = ?
        )
      `,s.push(N(t))),this.db.prepare(`
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
    `).get(S,N(t),e)?.id??null}claimTelegramWrapup({platformSource:e,contentSessionId:t,project:s,routeKey:r,summaryCreatedAtEpoch:o}){let i=Date.now();return this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(N(e),t,s,r,o,i).changes===1?!0:this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(o,i,N(e),t,s,r,i-Dn).changes===1}markTelegramWrapupSent({platformSource:e,contentSessionId:t,project:s,routeKey:r}){this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(Date.now(),N(e),t,s,r)}releaseTelegramWrapupClaim({platformSource:e,contentSessionId:t,project:s,routeKey:r}){this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(N(e),t,s,r)}setSessionObservedMetadata(e,t,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(t||null,s||null,e)}getSdkSessionsBySessionIds(e,t=[]){if(e.length===0&&t.length===0)return[];let s=[...new Set(e),...new Set(t)],r=new Map;for(let o=0;o<s.length;o+=500){let i=s.slice(o,o+500),a=i.filter(c=>typeof c=="string"),_=i.filter(c=>typeof c=="number"),d=[];a.length&&d.push(`memory_session_id IN (${a.map(()=>"?").join(",")})`),_.length&&d.push(`id IN (SELECT session_db_id FROM user_prompts WHERE id IN (${_.map(()=>"?").join(",")}))`);let E=this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project,
               COALESCE(platform_source, '${S}') as platform_source,
               user_prompt, custom_title,
               started_at, started_at_epoch, completed_at, completed_at_epoch, status
        FROM sdk_sessions
        WHERE ${d.join(" OR ")}
        ORDER BY started_at_epoch DESC
      `);for(let c of E.all(...i))r.set(c.id,c)}return[...r.values()].sort((o,i)=>i.started_at_epoch-o.started_at_epoch)}getPromptNumberFromUserPrompts(e,t,s){let r=this.resolvePromptSessionDbId(e,t),o=r!==null?"session_db_id = ?":"content_session_id = ?",i=r!==null?r:e;return s!==void 0?this.db.prepare(`
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
    `).get()?.newest??null}createSDKSession(e,t,s,r,o,i){let a=new Date,_=a.getTime(),d=o?N(o):S;if(this.isBeforeSessionDeletion(d,e,i))throw new Error("session_deleted");let E=ie(s);return r&&this.validateSetTitleMutation(e,d,r),this.db.transaction(()=>{let c=this.db.prepare(`
        SELECT id, platform_source
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
      `).get(S,d,e);if(c){if(t&&this.db.prepare(`
            UPDATE sdk_sessions SET project = ?
            WHERE id = ? AND (project IS NULL OR project = '' OR (project = 'unknown' AND cwd IS NULL))
          `).run(t,c.id),E&&E!==It&&this.db.prepare(`
            UPDATE sdk_sessions SET user_prompt = ?
            WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
          `).run(E,c.id,It),r){let g=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(c.id);g&&g.custom_title===null&&(this.db.prepare(`
              UPDATE sdk_sessions SET custom_title = ?
              WHERE id = ? AND custom_title IS NULL
            `).run(r,c.id),this.enqueueSetTitleOp(e,d,r))}return c.id}let p=this.db.prepare(`
        INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
      `).run(e,t,d,E,r||null,a.toISOString(),_);return r&&this.enqueueSetTitleOp(e,d,r),Number(p.lastInsertRowid)}).immediate()}setSessionCwd(e,t,s){t.trim()&&this.db.prepare("UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL").run(t,s??null,e)}getSessionCwd(e){return this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(e)?.cwd??null}getRecordedFolderForConversation(e,t){let s=this.db.prepare("SELECT cwd FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?").get(e,t);return s?{sessionIsRecorded:!0,recordedFolder:s.cwd??null}:{sessionIsRecorded:!1,recordedFolder:null}}enqueueSetTitleOp(e,t,s){let r=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",r)}validateSetTitleMutation(e,t,s){let r={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return Nt(r),r}promptCommitted(e,t){if(this.db.inTransaction)return;let s=t===null?null:this.db.prepare("SELECT project FROM sdk_sessions WHERE id = ?").get(t);Z(s?{projects:[s.project]}:"all",e,"additive",{kinds:["prompt"]})}saveUserPrompt(e,t,s,r,o,i,a){let _=new Date(a??Date.now()),d=_.getTime(),E=ie(s),c=this.resolvePromptSessionDbId(e,r),g=this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id, native_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c,e,t,E,_.toISOString(),d,o??null,i??null);return this.promptCommitted("saveUserPrompt",c),g.lastInsertRowid}saveNativeUserPrompt(e,t,s,r,o=r,i={}){if(!s||s.length>256||/[\s\x00-\x1f\x7f]/.test(s))throw new Error("Invalid native prompt identity");let a=ie(r),_=(0,Me.createHash)("sha256").update(Ve(o).trim()).digest("hex"),d=this.db.transaction(()=>{let E=this.db.prepare(`SELECT id, prompt_number, native_prompt_hash FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id = ?`).get(t,s);if(E){if(E.native_prompt_hash!==_)throw new Error("Native prompt identity was reused with different text");return{id:E.id,promptNumber:E.prompt_number,duplicate:!0}}let c=this.getPromptNumberFromUserPrompts(e,t)+1;return i.reopenSession!==!1&&this.reopenCompletedSession(t),{id:this.saveUserPrompt(e,c,a,t,s,_,i.createdAtEpoch),promptNumber:c,duplicate:!1}}).immediate();return d.duplicate||this.promptCommitted("saveNativeUserPrompt",t),d}importTranscriptUserPrompt(e){let t=ie(e.promptText);if(!t)return{reason:"private"};let s=N(e.platformSource);if(this.isBeforeSessionDeletion(s,e.contentSessionId,e.createdAtEpoch))return{reason:"deleted"};let o=this.db.prepare(`SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?`).get(S,s,e.contentSessionId)?.id,i=`transcript:${e.nativePromptId}`,a=o!==void 0&&this.db.prepare(`SELECT 1 FROM user_prompts
      WHERE session_db_id = ? AND native_prompt_id = ?`).get(o,i);if(o!==void 0&&!a){let d=[t,...(e.hookTextVariants??[]).map(ie).filter(Boolean)],c=this.db.prepare(`SELECT id, created_at_epoch FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id IS NULL
          AND prompt_text IN (${d.map(()=>"?").join(", ")})
          AND ABS(created_at_epoch - ?) <= ?
        ORDER BY ABS(created_at_epoch - ?), id`).all(o,...d,e.createdAtEpoch,e.hookMatchWindowMs,e.createdAtEpoch).find(p=>!e.claimedHookRowIds.has(p.id));if(c)return e.claimedHookRowIds.add(c.id),{reason:"recorded-by-hook",hookRowId:c.id}}else if(o===void 0){let d=new Date(e.createdAtEpoch).toISOString(),E=this.db.prepare(`INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch, status)
        VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, 'completed')`).run(e.contentSessionId,e.project,s,d,e.createdAtEpoch,d,e.createdAtEpoch);o=Number(E.lastInsertRowid)}return{reason:this.saveNativeUserPrompt(e.contentSessionId,o,i,e.promptText,e.promptText,{createdAtEpoch:e.createdAtEpoch,reopenSession:!1}).duplicate?"already-imported":"new"}}listHookRecordedPrompts(e){return this.db.prepare(`SELECT up.id, COALESCE(NULLIF(s.platform_source, ''), ?) AS platformSource,
        s.content_session_id AS contentSessionId, s.project, s.cwd, up.prompt_text AS promptText, up.created_at_epoch AS createdAtEpoch
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
      WHERE up.created_at_epoch >= ? AND s.project != ?
        AND (up.native_prompt_id IS NULL OR up.native_prompt_id NOT LIKE 'transcript:%')
      ORDER BY up.created_at_epoch, up.id`).all(S,e,de)}streamObservationTokenFields(){return pe(this.db.prepare("SELECT title, subtitle, narrative, facts, discovery_tokens FROM observations ORDER BY id"))}getUserPrompt(e,t,s){let r=this.resolvePromptSessionDbId(e,s);return r!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(r,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}dedupConfig(){let e=le.loadFromFile(ve),t=(r,o)=>{let i=Number(e[r]);return Number.isFinite(i)?i:o},s=(r,o)=>Math.trunc(t(r,o));return{enabled:e.CLAUDE_MEM_DEDUP_ENABLED==="true",cosineThreshold:t("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD",.8),idfVetoDf:s("CLAUDE_MEM_DEDUP_IDF_VETO_DF",10),minSharedTokens:s("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS",2),maxScan:s("CLAUDE_MEM_DEDUP_MAX_SCAN",2e3),maxBackfillRows:s("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS",5e4),minProjectDocs:s("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS",10)}}listDedupCandidates(e,t=100,s){let r="SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ",o="(? IS NULL OR c.status = ?) ",i="ORDER BY c.score DESC, c.id DESC LIMIT ?",a=s??null,_=Number.isFinite(t)?Math.max(1,Math.trunc(t)):100;return e?this.db.prepare(`${r}WHERE c.project = ? AND ${o}${i}`).all(e,a,a,_):this.db.prepare(`${r}WHERE ${o}${i}`).all(a,a,_)}resolveDedupCandidate(e,t){return this.db.prepare("UPDATE observation_dedup_candidates SET status = ? WHERE id = ?").run(t,e).changes>0}isDedupEnabled(){return this.dedupConfig().enabled}runDedupScan(){return En(this.db,this.dedupConfig())}maintainDedupOnInsert(e,t,s,r){nn(this.db,e,s),dn(this.db,e,r.minProjectDocs)&&cn(this.db,e,t,s,r)}storeObservation(e,t,s,r,o=0,i,a,_={}){if(!lt(s.title))throw new Error("storeObservation requires a non-empty title");let d=this.storeObservations(e,t,[s],null,r,o,i,a,_);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch,mergedIntoExisting:d.mergedIntoExisting[0]??!1}}storeSummary(e,t,s,r,o=0,i){let a=i??Date.now(),_=new Date(a).toISOString(),E=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,JSON.stringify(s.files_read??[]),JSON.stringify(s.files_edited??[]),s.notes,r||null,o,_,a);return Z({projects:[t]},"storeSummary"),{id:Number(E.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,r,o,i=0,a,_,d={}){let E=a??Date.now(),c=new Date(E).toISOString(),p=os(E),g=new Date(E),u=this.dedupConfig(),R=N(this.cachedStatement("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(e)?.platform_source),v=this.db.transaction(()=>{let T=[],L=[],m=[],A=this.cachedStatement(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),f=this.cachedStatement("SELECT id, type, subtitle, facts, concepts FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let O of s){if(!lt(O.title)){l.debug("DB","Skipping observation with empty title");continue}let K=es(e,O.title,O.narrative);if(K.startsWith("tuple-")){let F=ut(e,O.title,O.narrative),W=Ee(F,O),ae=this.cachedStatement(`SELECT id, type, subtitle, facts, concepts FROM observations
            WHERE memory_session_id = ? AND content_hash IN (?, ?)
              AND title IS ? AND COALESCE(narrative, '') = ?
            ORDER BY content_hash = ? DESC`).all(e,F,W,O.title,O.narrative??"",W).find(Ze=>Ee(F,Ze)===W);if(ae){ce(this.db,ae.id,g),T.push(ae.id),L.push(!1);continue}}let Q=Ee(K,O),M=K,se=f.get(e,Q);if(se){ce(this.db,se.id,g),T.push(se.id),L.push(!1);continue}let ne=Ie(t,R,O.title,me(O.agent_id,O.agent_type));if(u.enabled){let F=f.get(e,M);if(F&&Ee(K,F)!==Q&&(M=Q,F=null),F){ce(this.db,F.id,g),T.push(F.id),L.push(!1);continue}let W=d.skipTitleDedup?null:sn(this.db,t,ne,O.title);if(W){this.cachedStatement("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(W.id),ce(this.db,W.id,g),T.push(W.id),L.push(!0);continue}}let Se=()=>A.all(e,t,O.type,O.title,O.subtitle,JSON.stringify(O.facts),O.narrative,JSON.stringify(O.concepts),JSON.stringify(O.files_read),JSON.stringify(O.files_modified),o||null,i,O.agent_type??null,O.agent_id??null,M,c,E,_||null,O.metadata??null,ne,p.dates,p.lastReinforced)[0]??null,H=Se(),V=H?null:f.get(e,M);if(V&&M===K&&Ee(K,V)!==Q&&(M=Q,H=Se(),V=H?null:f.get(e,M)),H){u.enabled&&this.maintainDedupOnInsert(t,H.id,O.title,u),this.indexObservationFiles(H.id,O.files_read,O.files_modified),T.push(H.id),L.push(!1),m.push(H.id);continue}if(!V)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${M}`);ce(this.db,V.id,g),T.push(V.id),L.push(!1)}let I=null,P=!1;if(r){let O=Mn(s),K=r.files_read??O.files_read,Q=r.files_edited??O.files_edited,M=o?this.cachedStatement(`SELECT id, request, investigated, learned, completed, next_steps,
                      files_read, files_edited, notes, discovery_tokens, sync_rev
               FROM session_summaries
               WHERE memory_session_id = ? AND prompt_number = ? AND origin_device_id IS NULL
               ORDER BY id DESC LIMIT 1`).get(e,o):void 0;if(M){let se=r.request&&r.request.trim()?r.request:M.request??"",ne=r.investigated&&r.investigated.trim()?r.investigated:M.investigated??"",Se=r.learned&&r.learned.trim()?r.learned:M.learned??"",H=r.completed&&r.completed.trim()?r.completed:M.completed??"",V=r.next_steps??"",F=r.notes&&r.notes.trim()?r.notes:M.notes,W=[...new Set([...pt(M.files_read),...K])],ae=[...new Set([...pt(M.files_edited),...Q])],Ze=Math.max(M.discovery_tokens??0,i),yn=Xe(M.sync_rev||"0");this.cachedStatement(`
            UPDATE session_summaries SET
              request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ?,
              files_read = ?, files_edited = ?, notes = ?, discovery_tokens = ?,
              created_at = ?, created_at_epoch = ?,
              sync_rev = ?, synced_at = NULL
            WHERE id = ?
          `).run(se,ne,Se,H,V,JSON.stringify(W),JSON.stringify(ae),F,Ze,c,E,yn,M.id),r.request=se,r.investigated=ne,r.learned=Se,r.completed=H,r.next_steps=V,r.notes=F,r.files_read=W,r.files_edited=ae,I=M.id,P=!0}else{let ne=this.cachedStatement(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,JSON.stringify(K),JSON.stringify(Q),r.notes,o||null,i,c,E);I=Number(ne.lastInsertRowid)}}return d.committedToolUses?.toolUseIds.length&&this.markCommittedToolUses(d.committedToolUses),{observationIds:T,mergedIntoExisting:L,insertedObservationIds:m,summaryId:I,createdAtEpoch:E,summaryUpdated:P}}).immediate();return Z({projects:[t]},"storeObservations",v.summaryUpdated?"removal":"additive"),v}updateDiscoveryTokens(e,t,s){if(e.length===0&&t===null)return;let r=new Set;this.db.transaction(()=>{let o=this.cachedStatement(`UPDATE observations SET discovery_tokens = ?,
        synced_at = CASE WHEN discovery_tokens IS NOT ? THEN NULL ELSE synced_at END
        WHERE id = ? AND discovery_tokens IS NOT ? RETURNING project, merged_into_project`);for(let i of e){let a=o.all(s,s,i,s);for(let _ of a)for(let d of xt(_))r.add(d)}t!==null&&this.cachedStatement(`UPDATE session_summaries SET discovery_tokens = MAX(COALESCE(discovery_tokens, 0), ?),
          synced_at = CASE WHEN COALESCE(discovery_tokens, 0) < ? THEN NULL ELSE synced_at END WHERE id = ?`).run(s,s,t)})(),r.size>0&&Z({projects:[...r]},"updateDiscoveryTokens")}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:r}=t,o=kt(t.limit),i=j(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",d=a?"":`ORDER BY ss.created_at_epoch ${_}, ss.id ${_}`,E=o&&!a?"LIMIT ?":"",c=[JSON.stringify(e)],p=[];if(i.length>0){let T=X("ss",i,{includeMerged:!0});p.push(T.sql),c.push(...T.params)}r&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),c.push(N(r)));let g=p.length>0?`AND ${p.join(" AND ")}`:"";E&&c.push(o);let R=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (SELECT value FROM json_each(?)) ${g}
      ${d}
      ${E}
    `).all(...c);if(!a)return R;let y=new Map(R.map(T=>[T.id,T])),v=e.map(T=>y.get(T)).filter(T=>!!T);return o?v.slice(0,o):v}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:r}=t,o=kt(t.limit),i=j(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",d=a?"":`ORDER BY up.created_at_epoch ${_}, up.id ${_}`,E=o&&!a?"LIMIT ?":"",c=[JSON.stringify(e)],p=[];if(i.length>0){let T=X("s",i,{includeMerged:!1});p.push(T.sql),c.push(...T.params)}r&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),c.push(N(r)));let g=p.length>0?`AND ${p.join(" AND ")}`:"";E&&c.push(o);let R=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (SELECT value FROM json_each(?)) ${g}
      ${d}
      ${E}
    `).all(...c);if(!a)return R;let y=new Map(R.map(T=>[T.id,T])),v=e.map(T=>y.get(T)).filter(T=>!!T);return o?v.slice(0,o):v}getSearchScopeRowIds(e,t,s){let r=j(t),o=t.platformSource?N(t.platformSource):void 0,i=[e.observations&&{alias:"o",includeMerged:!0,from:"SELECT o.id FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id"},e.sessions&&{alias:"ss",includeMerged:!0,from:"SELECT ss.id FROM session_summaries ss LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id"},e.prompts&&{alias:"s",includeMerged:!1,from:"SELECT up.id FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id"}].filter(_=>!!_),a=new Set;for(let _ of i){let d=[],E=[];if(r.length>0){let u=X(_.alias,r,{includeMerged:_.includeMerged});d.push(u.sql),E.push(...u.params)}o&&(d.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),E.push(o));let c=d.length>0?`WHERE ${d.join(" AND ")}`:"",p=this.db.prepare(`${_.from} ${c} LIMIT ?`),g;try{g=p.all(...E,s+1)}finally{p.finalize()}for(let u of g)a.add(u.id);if(a.size>s)return null}return[...a]}getTimelineAroundTimestamp(e,t=10,s=10,r,o,i){return this.getTimelineAroundObservation(null,e,t,s,r,o,i)}getTimelineAroundObservation(e,t,s=10,r=10,o,i,a){let _=i?N(i):void 0,d=j({project:o,projects:a}),E=(m,A,f=!1)=>{let I=[],P=[];if(d.length>0){let O=X(m,d,{includeMerged:f});I.push(O.sql),P.push(...O.params)}return _&&(I.push(`COALESCE(NULLIF(${A}.platform_source, ''), '${S}') = ?`),P.push(_)),{clause:I.length>0?`AND ${I.join(" AND ")}`:"",params:P}},c=E("o","src",!0),p=E("ss","src",!0),g=E("s","s"),u,R;if(e!==null){let m=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) <= (?, ?) ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,A=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) >= (?, ?) ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let f=this.db.prepare(m).all(t,e,...c.params,s+1),I=this.db.prepare(A).all(t,e,...c.params,r+1);if(f.length===0&&I.length===0)return{observations:[],sessions:[],prompts:[]};u=f.length>0?f[f.length-1].created_at_epoch:t,R=I.length>0?I[I.length-1].created_at_epoch:t}catch(f){return f instanceof Error?l.error("DB","Error getting boundary observations",{project:o},f):l.error("DB","Error getting boundary observations with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}else{let m=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${c.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,A=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${c.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let f=this.db.prepare(m).all(t,...c.params,s),I=this.db.prepare(A).all(t,...c.params,r);u=f.length>0?f[f.length-1].created_at_epoch:t,R=I.length>0?I[I.length-1].created_at_epoch:t}catch(f){return f instanceof Error?l.error("DB","Error getting boundary timestamps",{project:o},f):l.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}for(let m of[{alias:"ss",from:"session_summaries ss LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id",scope:p},{alias:"up",from:"user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id",scope:g}])for(let A of[{comparison:"<",order:"DESC",depth:s},{comparison:">",order:"ASC",depth:r}]){if(A.depth===0)continue;let I=this.db.prepare(`
          SELECT ${m.alias}.created_at_epoch
          FROM ${m.from}
          WHERE ${m.alias}.created_at_epoch ${A.comparison} ? ${m.scope.clause}
          ORDER BY ${m.alias}.created_at_epoch ${A.order}
          LIMIT ?
        `).all(t,...m.scope.params,A.depth).at(-1)?.created_at_epoch??t;u=Math.min(u,I),R=Math.max(R,I)}let y=(m,A,f,I)=>this.db.prepare(`
      SELECT * FROM (
        SELECT ${m} FROM ${A}
        WHERE ${f}.created_at_epoch >= ? AND ${f}.created_at_epoch < ? ${I.clause}
        ORDER BY ${f}.created_at_epoch DESC, ${f}.id DESC LIMIT ?
      )
      UNION ALL
      SELECT ${m} FROM ${A}
      WHERE ${f}.created_at_epoch = ? ${I.clause}
      UNION ALL
      SELECT * FROM (
        SELECT ${m} FROM ${A}
        WHERE ${f}.created_at_epoch > ? AND ${f}.created_at_epoch <= ? ${I.clause}
        ORDER BY ${f}.created_at_epoch ASC, ${f}.id ASC LIMIT ?
      )
      ORDER BY created_at_epoch ASC, id ASC
    `).all(u,t,...I.params,s,t,...I.params,t,R,...I.params,r),v=y("o.*","observations o LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id","o",c),T=y("ss.*","session_summaries ss LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id","ss",p),L=y(`up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source`,"user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id","up",g);return{observations:v,sessions:T.map(m=>({id:m.id,memory_session_id:m.memory_session_id,project:m.project,request:m.request,completed:m.completed,next_steps:m.next_steps,created_at:m.created_at,created_at_epoch:m.created_at_epoch})),prompts:L.map(m=>({id:m.id,content_session_id:m.content_session_id,prompt_number:m.prompt_number,prompt_text:m.prompt_text,project:m.project,platform_source:m.platform_source,created_at:m.created_at,created_at_epoch:m.created_at_epoch}))}}getOrCreateManualSession(e,t=S){return this.db.transaction(()=>{let s=N(t),r=`manual-${e}-${s}`,o=`manual-content-${e}-${s}`,i=this.db.prepare(`
        SELECT memory_session_id FROM sdk_sessions WHERE platform_source = ? AND content_session_id = ?
      `).get(s,o);if(i)return i.memory_session_id;let a=this.db.prepare("SELECT memory_session_id, project, platform_source FROM sdk_sessions WHERE memory_session_id = ?").get(r);if(a?.project===e&&N(a.platform_source)===s)return a.memory_session_id;let d=this.db.prepare("SELECT 1 FROM deleted_memory_sessions WHERE memory_session_id = ?").get(r)||a?`${r}-${(0,Me.randomUUID)()}`:r,E=this.getSessionDeletedAtEpochMs(s,o),c=new Date(Math.max(Date.now(),(E??-1)+1));return this.db.prepare(`
        INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `).run(d,o,e,s,c.toISOString(),c.getTime()),l.info("SESSION","Created manual session",{memorySessionId:d,project:e,platformSource:s}),d}).immediate()}finalizeCachedStatements(){for(let e of this.statementCache.values())e.finalize();this.statementCache.clear()}close(){this.finalizeCachedStatements();try{this.db.close(!0)}catch(e){l.warn("DB","Strict close refused (statements outstanding on this Bun); falling back to lazy close",{},e),this.db.close(!1)}}cachedStatement(e){let t=this.statementCache.get(e);return t||(t=this.db.prepare(e),this.statementCache.set(e,t)),t}importSdkSession(e){let t=N(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);if(s)return{imported:!1,id:s.id};let r=e.custom_title??null;if(r!==null&&typeof r!="string")throw new TypeError("Imported custom_title must be a string or null");let o=this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);return this.db.transaction(()=>({imported:!0,id:o.run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,r,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}))()}importSessionSummary(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return l.warn("DB","Skipping imported session summary without memory_session_id",{project:typeof e?.project=="string"?e.project:null}),{imported:!1,id:0};let t=this.db.prepare(`SELECT id FROM session_summaries WHERE memory_session_id = ?
        AND request IS ? AND investigated IS ? AND learned IS ? AND completed IS ?
        AND next_steps IS ? AND files_read IS ? AND files_edited IS ? AND notes IS ?
        AND prompt_number IS ? AND created_at_epoch = ?`).get(e.memory_session_id,b(e.request),b(e.investigated),b(e.learned),b(e.completed),b(e.next_steps),b(e.files_read),b(e.files_edited),b(e.notes),e.prompt_number??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let r=this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch, merged_into_project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,b(e.request),b(e.investigated),b(e.learned),b(e.completed),b(e.next_steps),b(e.files_read),b(e.files_edited),b(e.notes),e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch,typeof e.merged_into_project=="string"?e.merged_into_project:null);return Z({projects:xt(e)},"importSessionSummary"),{imported:!0,id:r.lastInsertRowid}}importObservation(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return l.warn("DB","Skipping imported observation without memory_session_id",{title:typeof e?.title=="string"?e.title:null,type:typeof e?.type=="string"?e.type:null}),{imported:!1,id:0};let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND text IS ? AND type = ?
        AND title IS ? AND subtitle IS ? AND facts IS ? AND narrative IS ?
        AND concepts IS ? AND files_read IS ? AND files_modified IS ?
        AND prompt_number IS ? AND agent_type IS ?
        AND agent_id IS ? AND created_at_epoch = ?
    `).get(e.memory_session_id,b(e.text),e.type,b(e.title),b(e.subtitle),b(e.facts),b(e.narrative),b(e.concepts),b(e.files_read),b(e.files_modified),e.prompt_number??null,e.agent_type??null,e.agent_id??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};for(let i of["metadata","generated_by_model","reinforcement_dates","last_reinforced"])if(e[i]!=null&&typeof e[i]!="string")throw new TypeError(`Imported ${i} must be a string or null`);let s=e.occurrence_count??1;if(!Number.isSafeInteger(s)||s<1)throw new TypeError("Imported occurrence_count must be a positive safe integer");let r=this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch, merged_into_project,
        metadata, generated_by_model, occurrence_count, reinforcement_dates, last_reinforced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),o=this.db.transaction(()=>{let a=r.run(e.memory_session_id,e.project,b(e.text),e.type,b(e.title),b(e.subtitle),b(e.facts),b(e.narrative),b(e.concepts),b(e.files_read),b(e.files_modified),e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch,typeof e.merged_into_project=="string"?e.merged_into_project:null,e.metadata??null,e.generated_by_model??null,s,e.reinforcement_dates??null,e.last_reinforced??null).lastInsertRowid;ss(this.db,a,e.files_read,e.files_modified);let _=this.db.prepare(`SELECT o.title, o.agent_id, o.agent_type, s.platform_source
        FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
        WHERE o.id = ?`).get(a);this.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?").run(Ie(e.project,_.platform_source,_.title,me(_.agent_id,_.agent_type)),a);let d=this.dedupConfig();return d.enabled&&this.maintainDedupOnInsert(e.project,a,_.title,d),a})();return Z({projects:xt(e)},"importObservation"),{imported:!0,id:o}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?N(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let c=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${S}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);c&&c.content_session_id===e.content_session_id&&(!s||N(c.platform_source)===s)&&(t=c.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let r=t!==null?"session_db_id = ?":"content_session_id = ?",o=t??e.content_session_id,i=e.native_prompt_id??null,_=(i===null?void 0:this.db.prepare(`
      SELECT id FROM user_prompts WHERE ${r} AND native_prompt_id = ?
    `).get(o,i))??this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${r} AND prompt_number = ? AND prompt_text IS ? AND created_at_epoch = ?
        ${i===null?"":"AND native_prompt_id IS NULL"}
    `).get(o,e.prompt_number,b(e.prompt_text),e.created_at_epoch);if(_)return{imported:!1,id:_.id};let E=this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch, native_prompt_id, native_prompt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,b(e.prompt_text),e.created_at,e.created_at_epoch,e.native_prompt_id??null,e.native_prompt_hash??null);return this.promptCommitted("importUserPrompt",t),{imported:!0,id:E.lastInsertRowid}}};0&&(module.exports={SessionStore,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
