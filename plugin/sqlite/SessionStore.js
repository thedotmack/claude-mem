var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var Qe=Object.defineProperty;var Rn=Object.getOwnPropertyDescriptor;var fn=Object.getOwnPropertyNames;var Nn=Object.prototype.hasOwnProperty;var On=(r,e)=>{for(var t in e)Qe(r,t,{get:e[t],enumerable:!0})},hn=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of fn(e))!Nn.call(r,n)&&n!==t&&Qe(r,n,{get:()=>e[n],enumerable:!(s=Rn(e,n))||s.enumerable});return r};var bn=r=>hn(Qe({},"__esModule",{value:!0}),r);var No={};On(No,{SessionStore:()=>Ct,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS:()=>Tn,rollupObservationFileLists:()=>Sn});module.exports=bn(No);var Ln=new Set,In=0;function Z(r,e,t="additive",s){In++;for(let n of Ln)n({scope:r,reason:e,kind:t,...s?{changes:s}:{}})}var It=require("bun:sqlite"),ze=require("crypto");var C=require("path"),tt=require("os"),Ce=require("fs"),$t=require("url");var b=require("fs"),kt=require("crypto"),k=require("path");var Cn=null;function Dn(r){return(Cn??process.stderr.write.bind(process.stderr))(r)}function oe(r){Dn(r)}var bo=Promise.resolve();var Ze=process.platform==="win32";function le(r){return r.replace(/^\uFEFF/,"")}function et(r){return JSON.parse(le(r))}function ue(r){return et((0,b.readFileSync)(r,"utf-8"))}function Mn(r){(0,b.existsSync)(r)||(0,b.mkdirSync)(r,{recursive:!0})}function Ft(r){try{return(0,b.realpathSync)(r)}catch(e){if(e.code!=="ENOENT")throw e;let t=(0,k.dirname)(r);return t===r?r:(0,k.join)(Ft(t),(0,k.basename)(r))}}function yn(r){let e=r,t=new Set;try{for(;(0,b.lstatSync)(e).isSymbolicLink();){let s=(0,k.resolve)(e);if(t.has(s))throw Object.assign(new Error(`Symlink loop at ${e}`),{code:"ELOOP"});t.add(s);try{return(0,b.realpathSync)(e)}catch(n){if(n.code!=="ENOENT")throw n;let o=n instanceof Error?n:new Error(String(n));oe(`claude-mem: realpathSync failed for ${e}, resolving symlink manually: ${o.message}
`);let i=(0,b.readlinkSync)(e);e=(0,k.resolve)(Ft((0,k.dirname)((0,k.resolve)(e))),i)}}}catch(s){if(s.code!=="ENOENT")throw s}return e}var vn=new Set(["EPERM","EBUSY","EACCES"]),wt=[10,20,40,80,160,320];function Un(r){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,r)}function wn(r,e,t=b.renameSync,s=Ze){if(!s)return t(r,e);for(let n=0;;n++)try{t(r,e);return}catch(o){let i=o.code??"";if(n>=wt.length||!vn.has(i))throw o;Un(wt[n])}}function kn(r,e,t={}){let s=yn(r);Mn((0,k.dirname)(s));let n=(0,k.dirname)(s),o=(0,k.basename)(s),i=(0,k.join)(n,`.${o}.${process.pid}.${(0,kt.randomBytes)(6).toString("hex")}.tmp`),a=t.mode;if(a===void 0)try{a=(0,b.statSync)(s).mode&511}catch{}let _;try{_=a!==void 0?(0,b.openSync)(i,"w",a):(0,b.openSync)(i,"w"),a!==void 0&&!Ze&&(0,b.fchmodSync)(_,a);let d=0;for(;d<e.length;){let E=(0,b.writeSync)(_,e,d,e.length-d);if(E===0)throw new Error(`writeSync stalled at ${d}/${e.length} bytes`);d+=E}if((0,b.fsyncSync)(_),(0,b.closeSync)(_),_=void 0,wn(i,s),!Ze){let E;try{E=(0,b.openSync)(n,"r"),(0,b.fsyncSync)(E)}catch(c){let m=c instanceof Error?c:new Error(String(c));oe(`claude-mem: directory fsync failed for ${n}: ${m.message}
`)}finally{if(E!==void 0)try{(0,b.closeSync)(E)}catch{}}}}catch(d){if(_!==void 0)try{(0,b.closeSync)(_)}catch{}try{(0,b.unlinkSync)(i)}catch{}throw d}}function X(r,e,t={}){kn(r,Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),t)}var Fn=r=>r!==null&&typeof r=="object"&&!Array.isArray(r);function xt(r){let e=r.env;return Fn(e)&&Object.keys(e).some(t=>t.startsWith("CLAUDE_MEM_"))?"nested":"flat"}function ie(r){return xt(r)==="nested"?r.env:r}function Pt(r){return xt(r)!=="nested"?r:Object.fromEntries(Object.entries(r).filter(([e])=>!e.startsWith("CLAUDE_MEM_")))}var Bt=require("os"),Ht=require("path");function H(r,e=process.platform,t=(0,Bt.homedir)()){return typeof r!="string"||r.length===0?r:r==="~"?t:r.startsWith("~/")||e==="win32"&&r.startsWith("~\\")?(0,Ht.join)(t,r.slice(2)):r}function xn(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,C.dirname)((0,$t.fileURLToPath)(__IMPORT_META_URL__))}var xo=xn();function Pn(){if(process.env.CLAUDE_MEM_DATA_DIR)return H(process.env.CLAUDE_MEM_DATA_DIR);let r=(0,C.join)((0,tt.homedir)(),".claude-mem"),e=(0,C.join)(r,"settings.json");try{if((0,Ce.existsSync)(e)){let t=ue(e);if(t===null||typeof t!="object"||Array.isArray(t))return r;let s=ie(t);if(typeof s.CLAUDE_MEM_DATA_DIR=="string"&&s.CLAUDE_MEM_DATA_DIR)return H(s.CLAUDE_MEM_DATA_DIR)}}catch{}return r}var D=Pn(),Bn=(0,C.join)((0,tt.homedir)(),".claude"),Hn=process.env.CLAUDE_CONFIG_DIR||Bn,Po=(0,C.join)(Hn,"plugins","marketplaces","thedotmack"),$n=(0,C.join)(D,"logs"),De=(0,C.join)(D,"settings.json"),Xt="claude-mem.db";var Me=(0,C.join)(D,Xt),Xn=(0,C.join)(D,"observer-sessions"),ae=(0,C.basename)(Xn);function ye(r){(0,Ce.mkdirSync)(r,{recursive:!0})}var st={dataDir:()=>D,workerPid:()=>(0,C.join)(D,"worker.pid"),workerHeartbeat:()=>(0,C.join)(D,"worker-heartbeat.json"),serverPid:()=>(0,C.join)(D,".server-beta.pid"),serverPort:()=>(0,C.join)(D,".server-beta.port"),serverRuntime:()=>(0,C.join)(D,".server-beta.runtime.json"),settings:()=>(0,C.join)(D,"settings.json"),database:()=>(0,C.join)(D,Xt),backups:()=>(0,C.join)(D,"backups","auto"),pendingRestore:()=>(0,C.join)(D,"backups","restore-pending.json"),lastRestore:()=>(0,C.join)(D,"backups","last-restore.json"),chroma:()=>(0,C.join)(D,"chroma"),combinedCerts:()=>(0,C.join)(D,"combined_certs.pem"),transcriptsConfig:()=>(0,C.join)(D,"transcript-watch.json"),transcriptsState:()=>(0,C.join)(D,"transcript-watch-state.json"),corpora:()=>(0,C.join)(D,"corpora"),supervisorRegistry:()=>(0,C.join)(D,"supervisor.json"),envFile:()=>(0,C.join)(D,".env"),logsDir:()=>$n};var U=require("fs"),ve=require("path");var rt=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(rt||{}),nt=null;function W(r){return r.replace(/\r/g,"\\r").replace(/\n/g,"\\n")}function Wn(r){return"  "+r.replace(/\r/g,"\\r").replace(/\n(?![ \t]+at )/g,"\\n")}var ot=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;logFileDate=null;logFd=null;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){let e=new Date().toISOString().split("T")[0];if(this.logFileInitialized&&this.logFileDate===e)return;let t=this.logFileDate!==e;this.closeLogFd(),this.logFileInitialized=!1,this.logFileDate=e;try{let s=st.logsDir();(0,U.existsSync)(s)||(0,U.mkdirSync)(s,{recursive:!0}),this.logFilePath=(0,ve.join)(s,`claude-mem-${e}.log`),this.logFileInitialized=!0}catch(s){t&&console.error("[LOGGER] Failed to initialize log file:",s instanceof Error?s.message:String(s)),this.logFilePath=null}}closeLogFd(){if(this.logFd!==null){try{(0,U.closeSync)(this.logFd)}catch{}this.logFd=null}}appendLine(e,t){if(this.logFd!==null){let s=!1;try{let n=(0,U.fstatSync)(this.logFd),o=(0,U.statSync)(e);s=n.ino===o.ino&&n.dev===o.dev}catch{}s||this.closeLogFd()}this.logFd===null&&((0,U.mkdirSync)((0,ve.dirname)(e),{recursive:!0}),this.logFd=(0,U.openSync)(e,"a"));try{let s=Buffer.from(t,"utf8");for(;s.length>0;){let n=(0,U.writeSync)(this.logFd,s);if(n<=0)throw new Error("log write accepted 0 bytes");s=s.subarray(n)}}catch(s){throw this.closeLogFd(),s}}getLevel(){if(this.level===null)try{let e=st.settings();if((0,U.existsSync)(e)){let s=(ie(ue(e)).CLAUDE_MEM_LOG_LEVEL||"INFO").toString().toUpperCase();this.level=rt[s]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}safeStringify(e,t,s=6){let n=new WeakSet,o=(i,a)=>{if(typeof i=="bigint")return`${i}n`;if(i===null||typeof i!="object")return i;let _=i.toJSON,d=typeof _=="function"?_.call(i):i;if(typeof d=="bigint")return`${d}n`;if(d===null||typeof d!="object")return d;if(n.has(d))return"[Circular]";if(a>=s)return Array.isArray(d)?"[Array]":"[Object]";n.add(d);try{if(Array.isArray(d))return d.map(c=>o(c,a+1));let E={};for(let c of Object.keys(d))try{E[c]=o(d[c],a+1)}catch{E[c]="[unreadable]"}return E}finally{n.delete(d)}};try{return JSON.stringify(o(e,0),null,t)??String(e)}catch{return Array.isArray(e)?`[${e.length} items]`:"[unserializable]"}}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?this.safeStringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(s===null)return e;if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${o}:${i}:${a}.${_}`}log(e,t,s,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=rt[e].padEnd(5),_=t.padEnd(6),d="";n?.correlationId?d=`[${W(String(n.correlationId))}] `:n?.sessionId&&(d=`[session-${W(String(n.sessionId))}] `);let E="";o!=null&&(o instanceof Error?(E=` ${W(o.message)}`,this.getLevel()===0&&o.stack&&(E+=`
${Wn(o.stack)}`)):this.getLevel()===0&&typeof o=="object"?E=`
`+this.safeStringify(o,2):E=" "+W(this.formatData(o)));let c="";if(n){let{sessionId:u,memorySessionId:p,correlationId:N,...R}=n;Object.keys(R).length>0&&(c=` {${Object.entries(R).map(([O,T])=>typeof T!="object"||T===null||T instanceof Error||T instanceof Date?`${W(O)}=${W(String(T))}`:`${W(O)}=${W(Array.isArray(T)?this.safeStringify(T):this.formatData(T))}`).join(", ")}}`)}let m=`[${i}] [${a}] [${_}] ${d}${W(s)}${c}${E}`;if(this.logFilePath)try{this.appendLine(this.logFilePath,m+`
`)}catch(u){let p=u instanceof Error?u:new Error(String(u));oe(`[LOGGER] Failed to write to log file: ${p.message}
${p.stack??""}
`)}else oe(m+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}setErrorSink(e){nt=e}error(e,t,s,n){this.log(3,e,t,s,n),this.routeErrorToSink(t,s,n)}routeErrorToSink(e,t,s){try{if(!nt||!(s instanceof Error))return;nt(s)}catch{}}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}},l=new ot;function B(r){let e=r.projects?.length?r.projects:r.project?[r.project]:[];return[...new Set(e.filter(t=>t.trim().length>0))]}function $(r,e,t){let s=e.map(()=>"?").join(",");return t.includeMerged?{sql:`(${r}.project COLLATE NOCASE IN (${s}) OR ${r}.merged_into_project COLLATE NOCASE IN (${s}))`,params:[...e,...e]}:{sql:`${r}.project COLLATE NOCASE IN (${s})`,params:[...e]}}var jn=4;function Wt(r,e){let t=B({projects:e});if(t.length===0)return[];let s=t.map(()=>"?").join(","),n=[[`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${s})`,1],[`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${s})`,1],[`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${s})`,1],[`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${s})`,1],[`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${s})`,1],[`SELECT candidates.key FROM (
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
      )`,jn]],o=r.prepare(n.map(([i])=>i).join(" UNION "));try{let i=o.all(...n.flatMap(([,a])=>Array(a).fill(t).flat()));return[...new Set([...t,...i.map(a=>a.key)])]}finally{o.finalize()}}var jt=require("crypto");function it(r){return typeof r=="string"&&r.trim()!==""}function Gt(r,e,t){return(0,jt.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function at(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[String(e)]}catch(e){return l.debug("DB","File list is not JSON; treating value as a single path",{value:r},e instanceof Error?e:new Error(String(e))),[r]}}function Kt(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function Vt(r,e,t,s){r.prepare("DELETE FROM observation_files WHERE observation_id = ?").run(e);let n=new Set([...Kt(t),...Kt(s)]);if(n.size===0)return;let o=r.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let i of n)o.run(i,e)}function Yt(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function _t(r=new Date){return r.toISOString().slice(0,10)}function qt(r,e=new Date,t=10){let s=_t(e);if(r.includes(s))return r;let n=[...r,s];return n.length>t?n.slice(n.length-t):n}function Jt(r){let e=_t(new Date(r));return{dates:JSON.stringify([e]),lastReinforced:e}}function Ue(r,e,t=new Date){let s=r.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(e);if(!s)return!1;let n=Yt(s.reinforcement_dates),o=qt(n,t);return o===n?!1:(r.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(JSON.stringify(o),o[o.length-1],e),!0)}var Zt=require("crypto");var S="claude";function Gn(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function h(r){if(!r)return S;let e=Gn(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e.includes("kimi")?"kimi":e==="pi-mono"?"pi":e==="agy"||e==="antigravity"||e.startsWith("antigravity-")?"antigravity-cli":e:S}function zt(r){let e=["claude","codex","antigravity-cli","cursor","kimi"];return[...r].sort((t,s)=>{let n=e.indexOf(t),o=e.indexOf(s);return n!==-1||o!==-1?n===-1?1:o===-1?-1:n-o:t.localeCompare(s)})}var Kn=new Set(["dumb_search","claude_mem_search","claude_mem_timeline","claude_mem_get_observations","mem_search","search","timeline","get_observations","get_summaries","get_tool_uses","session_start_context","observation_search","observation_context","memory_search","memory_context"]);function Vn(r){if(!r.startsWith("mcp__"))return null;let e=r.split("__");if(e.length<3)return null;let t=e[1].toLowerCase();return!t.includes("claude-mem")&&!t.includes("claude_mem")&&!t.includes("mcp-search")&&!t.includes("mcp_search")&&!t.includes("cmem")?null:e.slice(2).join("__")}function dt(r){if(!r)return!1;if(r.startsWith("memory_")||r==="claude_mem_search"||r==="claude_mem_timeline"||r==="claude_mem_get_observations"||r==="dumb_search"||r==="mem_search"||r==="get_summaries")return!0;let e=Vn(r);return e!==null&&Kn.has(e)}var Yn=64*1024;function Qt(r,e=Yn){let t=Buffer.byteLength(r,"utf8");if(t<=e)return r;let s=Buffer.from(r,"utf8"),n=e;for(;n>0&&(s[n]&192)===128;)n--;return`${s.subarray(0,n).toString("utf8")}\u2026[truncated: ${t} bytes]`}function qn(r,e,t){return(0,Zt.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function es(r){r.run(`
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
  `),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project_nocase_created ON tool_uses(project COLLATE NOCASE, created_at_epoch DESC, id DESC)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function ts(r,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||dt(e.toolName))return null;let t=e.createdAtEpoch??Date.now(),s=new Date(t).toISOString(),n=qn(e.toolName,e.toolInput,e.toolResponse),o=e.toolInput!=null?Qt(e.toolInput):null,i=e.toolResponse!=null?Qt(e.toolResponse):null,a=r.prepare(`
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
  `).get(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",h(e.platformSource),e.toolName,o,i,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,n,s,t);return a?a.id:null}function ss(r,e){let t=e.toolUseIds.filter(o=>typeof o=="string"&&o.length>0);if(t.length===0)return 0;let s=t.map(()=>"?").join(","),n=r.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = CASE WHEN observation_id IS NULL
          THEN COALESCE(?, memory_session_id)
          ELSE COALESCE(memory_session_id, ?)
        END
    WHERE content_session_id = ?
      AND tool_use_id IN (${s})
      AND (observation_id IS NULL OR observation_id = ?)
  `).run(e.observationId,e.memorySessionId??null,e.memorySessionId??null,e.contentSessionId,...t,e.observationId);return Number(n.changes??0)}function ns(r){return r?{clause:`COALESCE(NULLIF(platform_source, ''), '${S}') = ?`,param:h(r)}:null}var Jn=100;function rs(r,e,t={}){let s=[],n=[];for(let E of e){if(typeof E=="number"&&Number.isInteger(E)){s.push(E);continue}if(typeof E=="string"&&E.trim().length>0){let c=Number(E);Number.isInteger(c)&&String(c)===E.trim()&&s.push(c),n.push(E.trim())}}if(s.length===0&&n.length===0)return[];let o=[],i=[];s.length>0&&(o.push(`id IN (${s.map(()=>"?").join(",")})`),i.push(...s)),n.length>0&&(o.push(`tool_use_id IN (${n.map(()=>"?").join(",")})`),i.push(...n));let a=[`(${o.join(" OR ")})`];t.project&&(a.push("project COLLATE NOCASE = ?"),i.push(t.project)),t.contentSessionId&&(a.push("content_session_id = ?"),i.push(t.contentSessionId));let _=ns(t.platformSource);_&&(a.push(_.clause),i.push(_.param));let d=t.limit&&t.limit>0?Math.floor(t.limit):Jn;return r.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    LIMIT ${d}
  `).all(...i)}function os(r,e={}){let t=[],s=[];if(e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.memorySessionId&&(t.push("memory_session_id = ?"),s.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(t.push("session_db_id = ?"),s.push(e.sessionDbId)),e.toolName){let d=Array.isArray(e.toolName)?e.toolName:[e.toolName];d.length>0&&(t.push(`tool_name IN (${d.map(()=>"?").join(",")})`),s.push(...d))}e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId));let n=ns(e.platformSource);n&&(t.push(n.clause),s.push(n.param)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let o=t.length>0?`WHERE ${t.join(" AND ")}`:"",i=e.orderBy==="date_asc"?"ASC":"DESC",a=Math.min(Math.max(Math.floor(e.limit??50),1),500),_=Math.max(Math.floor(e.offset??0),0);return r.prepare(`
    SELECT * FROM tool_uses
    ${o}
    ORDER BY created_at_epoch ${i}, id ${i}
    LIMIT ${a} OFFSET ${_}
  `).all(...s)}function is(r,e={}){let t=[],s=[];e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let n=t.length>0?`WHERE ${t.join(" AND ")}`:"";return r.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${n}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...s)}function as(r){r.run(`
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
  `),r.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_deliverables_session_copy ON deliverables(platform_source, content_session_id, bucket_path)"),r.run("CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project COLLATE NOCASE, created_at_epoch)"),r.run("CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at_epoch DESC)")}function _s(r,e){let t=e.createdAtEpoch??Date.now(),s=r.prepare(`
    INSERT OR IGNORE INTO deliverables (
      project, content_session_id, platform_source, agent_id, title, kind, source_path, bucket_path, bytes, sha256,
      declared, list_name, field, tool_use_id, occurred_at_epoch, created_at, created_at_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.project,e.contentSessionId,e.platformSource,e.agentId??null,e.title,e.kind,e.sourcePath,e.bucketPath,e.bytes,e.sha256,e.declared?1:0,e.listName??null,e.field??null,e.toolUseId??null,e.occurredAtEpoch,new Date(t).toISOString(),t);if(s.changes>0){let o=Number(s.lastInsertRowid);return l.debug("DB","Deliverable recorded",{id:o,project:e.project,bucketPath:e.bucketPath}),{id:o,inserted:!0}}return{id:r.prepare("SELECT id FROM deliverables WHERE platform_source = ? AND content_session_id = ? AND bucket_path = ?").get(e.platformSource,e.contentSessionId,e.bucketPath)?.id??0,inserted:!1}}function ds(r,e){return!Number.isSafeInteger(e)||e<1?null:r.prepare("SELECT * FROM deliverables WHERE id = ?").get(e)??null}var $e=require("fs");var j=require("fs"),P=require("path"),pe=require("os");var we={HEALTH_CHECK:3e3,API_REQUEST:3e4,SESSION_INIT_HOOK_CAP:15e3,SESSION_INIT_REQUEST:1e4,SESSION_INIT_REQUEST_MAX:14e3,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function zn(r=process.platform){return r==="win32"?8e3:5e3}function Es(r=process.platform){return we.SESSION_INIT_HOOK_CAP-zn(r)}function cs(r){return process.platform==="win32"?Math.round(r*we.WINDOWS_MULTIPLIER):r}var Ns=require("util");function ls(r){try{return new URL(r).hostname.toLowerCase()==="openrouter.ai"}catch{return!1}}var us=require("crypto"),ke=require("fs"),ps=require("os"),ee=require("path");var Qn=37700,Zn=37877,er="37777",tr=77,ms=37954;function Ts(){return process.env.CLAUDE_MEM_DATA_DIR||(0,ee.join)((0,ps.homedir)(),".claude-mem")}function Ss(r){let e=(0,ee.join)(H(r),"settings.json");if(!(0,ke.existsSync)(e))return null;try{let t=JSON.parse((0,ke.readFileSync)(e,"utf8").replace(/^\uFEFF/,"")),s=t.env;return s&&typeof s=="object"&&!Array.isArray(s)&&Object.keys(s).some(n=>n.startsWith("CLAUDE_MEM_"))?s:t}catch{return null}}function sr(r){return Ss(r)?.CLAUDE_MEM_WORKER_PORT===er}function nr(r){let e=Ss(r);return["CLAUDE_MEM_SERVER_URL","CLAUDE_MEM_SERVER_BETA_URL"].some(t=>{let s=e?.[t];if(typeof s!="string")return!1;try{return new URL(s).port===String(ms)}catch{return!1}})}function gs(r=Ts(),e={}){let t=e.platform??process.platform,s=e.uid===void 0?typeof process.getuid=="function"?process.getuid():null:e.uid;if(s!==null)return(s%100+100)%100;if(t==="win32"&&sr(r))return tr;let n=H(r,t),o=t==="win32"?ee.win32.resolve(n):(0,ee.resolve)(n);return t==="win32"&&(o=o.toLowerCase()),(0,us.createHash)("sha256").update(o,"utf8").digest().readUInt32BE(0)%100}function Fe(r,e){return Qn+gs(r,e)}function xe(r=Ts(),e={}){let t=e.platform??process.platform,s=e.uid===void 0?typeof process.getuid=="function"?process.getuid():null:e.uid;return t==="win32"&&s===null&&nr(r)?ms:Zn+gs(r,e)}var rr="security_alert",or="sync-hub.black-pond-afbb.workers.dev",ir="ziczmqtpmaxbornfghye.supabase.co",ar="https://sync.cmem.ai",_r=new Set(["xiaomi/mimo-v2-flash:free"]);function dr(r){return typeof r=="boolean"?String(r):r}var Er=new Set(["claude-haiku-4-5-20251001","claude-haiku-4-5"]);function cr(r){let e=process.env.CLAUDE_MEM_ENV_FILE??(0,P.join)((0,P.dirname)(r),".env");try{return(0,j.existsSync)(e)?!!(0,Ns.parseEnv)(le((0,j.readFileSync)(e,"utf-8"))).ANTHROPIC_BASE_URL:!1}catch{return!0}}function lr(r,e){let t=r.CLAUDE_MEM_MODEL;return typeof t!="string"||!Er.has(t.trim())?!1:(typeof r.CLAUDE_MEM_CLAUDE_AUTH_METHOD=="string"?r.CLAUDE_MEM_CLAUDE_AUTH_METHOD.trim():"")!=="gateway"&&!cr(e)}function ur(r){let e=r.CLAUDE_MEM_OPENROUTER_MODEL;if(typeof e!="string"||!_r.has(e.trim()))return!1;let t=typeof r.CLAUDE_MEM_OPENROUTER_BASE_URL=="string"?r.CLAUDE_MEM_OPENROUTER_BASE_URL.trim():"";return t===""||ls(t)}var As=18e4,Rs=[{key:"CLAUDE_MEM_LLM_TIMEOUT_MS",legacy:"30000",markerTag:"llm-timeout-migrated-v1"},{key:"CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS",legacy:"30000",markerTag:"field-optimize-timeout-migrated-v1"}];function Os(r,e){return(0,P.join)((0,P.dirname)(r),`.${(0,P.basename)(r)}.${e.markerTag}`)}function Et(r,e){try{(0,j.writeFileSync)(Os(r,e),new Date().toISOString(),{encoding:"utf-8",mode:384})}catch{}}var fs=new Set;function pr(r){if(typeof r!="string")return null;let e=r.trim();if(e.length===0)return null;try{let t=new URL(e).hostname;if(t===or||t===ir)return ar}catch{return null}return null}var _e=class{static DEFAULTS={CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED:"true",CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED:"true",CLAUDE_MEM_MEMORY_WATCH_ROOTS:"",CLAUDE_MEM_MODEL:"haiku",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES:"false",CLAUDE_MEM_CONTEXT_PROJECTS:"current",CLAUDE_MEM_WORKER_PORT:String(Fe()),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_URL:"",CLAUDE_MEM_WORKER_INGEST_TOKEN:"",CLAUDE_MEM_WORKER_INGEST_MAX_BYTES:"5242880",CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:"auto",CLAUDE_MEM_ALLOWED_ORIGINS:"",CLAUDE_MEM_PUBLIC_URL:"",CLAUDE_MEM_API_TIMEOUT_MS:String(cs(we.API_REQUEST)),CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS:String(Es()),CLAUDE_MEM_IDLE_EXIT_SEC:"0",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_SKIP_BASH_PATTERNS:"",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_CAPTURE_ADVISOR_CALLS:"false",CLAUDE_MEM_DELIVERABLES_ENABLED:"true",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_PROVIDER_BY_SOURCE:"",CLAUDE_MEM_OBSERVER_ENABLED:"true",CLAUDE_MEM_MEDIA_CAPTURE_ENABLED:"false",CLAUDE_MEM_MEDIA_INFERENCE_ENABLED:"false",CLAUDE_MEM_CODEX_MODEL:"",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"low",CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE:"8",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS:"32000",CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_API_KEYS:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-flash-latest",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_API_KEYS:"",CLAUDE_MEM_OPENROUTER_MODEL:"cohere/north-mini-code:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_TEMPERATURE:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_PRESET:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEYS:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"",CLAUDE_MEM_OPENAI_COMPAT_REASONING:"",CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE:"1",CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER:"claude",CLAUDE_MEM_QUOTA_FALLBACK_MODEL:"",CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD:"",CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR:"0.95",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET:"0.92",CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE:"0.95",CLAUDE_MEM_DATA_DIR:(0,P.join)((0,pe.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:"",CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:"",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY:"true",CLAUDE_MEM_REINFORCE_ALPHA:"0",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_WORK_STATE_ENABLED:"true",CLAUDE_MEM_FILE_READ_GATE_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,P.join)((0,pe.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_CODEX_SUBAGENT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS:"400000",CLAUDE_MEM_OBSERVER_THINKING:"disabled",CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW:"",CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS:"4096",CLAUDE_MEM_OBSERVE_BARE_PROMPTS:"false",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_REDACT_ENABLED:"false",CLAUDE_MEM_REDACT_DISABLED_BUILTINS:"",CLAUDE_MEM_REDACT_CUSTOM_PATTERNS:"[]",CLAUDE_MEM_REDACT_LOG_MATCHES:"false",CLAUDE_MEM_REDACT_GENERIC_ENABLED:"false",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_PROJECT_ENVIRONMENTS:"[]",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_SEMANTIC_INJECT_FORMAT:"narrative",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS:"600000",CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS:"5000",CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_SERVER_VECTOR_SEARCH:"auto",CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS:"",CLAUDE_MEM_EMBEDDING_MODEL:"all-MiniLM-L6-v2",CLAUDE_MEM_CHROMA_UVX_PATH:"",CLAUDE_MEM_SEARCH_RECENCY_DAYS:"90",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,pe.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_CLOUD_SYNC_KEEP_PULLING:"false",CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE:"40",CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS:"90000",CLAUDE_MEM_TEAMBRAIN_URL:"",CLAUDE_MEM_TEAMBRAIN_TEAM_ID:"",CLAUDE_MEM_LLM_TIMEOUT_MS:String(As),CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS:String(As),CLAUDE_MEM_LLM_STREAM_IDLE_TIMEOUT_MS:"90000",CLAUDE_MEM_WORKER_HEARTBEAT_STALE_MS:"120000",CLAUDE_MEM_TV_TOKEN:"",CLAUDE_MEM_PRO_TRIAL_EMAIL:"",CLAUDE_MEM_PRO_TRIAL_AT:"",CLAUDE_MEM_PRO_TRIAL_STATE:"",CLAUDE_MEM_PRO_TRIAL_ENDS_AT:"",CLAUDE_MEM_PRO_PLAN:"",CLAUDE_MEM_PRO_FALLBACK_AT:"",CLAUDE_MEM_PRO_FALLBACK_MESSAGE:"",CLAUDE_MEM_PRO_FALLBACK_ACTION:"",CLAUDE_MEM_PRO_FALLBACK_URL:"",CLAUDE_MEM_PRO_MEMORY_KEY:"",CLAUDE_MEM_PRO_MEMORY_BASE_URL:"",CLAUDE_MEM_PRO_MEMORY_MODEL:"",CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH:"true",CLAUDE_MEM_WORK_VIEW_REFRESH_INTERVAL_MIN:"10",CLAUDE_MEM_WORK_VIEW_SHARED_STATE:"false",CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER:"",CLAUDE_MEM_WORK_VIEW_COPY_MODEL:"",CLAUDE_MEM_WORK_VIEW_CLAUDE_MODEL:"",CLAUDE_MEM_WORK_VIEW_CODEX_MODEL:"",CLAUDE_MEM_WORK_VIEW_GEMINI_MODEL:"",CLAUDE_MEM_BACKUP_ENABLED:"false",CLAUDE_MEM_BACKUP_INTERVAL_HOURS:"24",CLAUDE_MEM_BACKUP_RETAIN_COUNT:"7",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED:"true",CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED:"false",CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES:"{}",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert,sensitive",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED:"true",CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS:"521e962d-2ec3-4488-bfbc-54d5209ce118,95601360-61f7-4fd9-bb3a-2c976b2b85c0",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_URL:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET:"",CLAUDE_MEM_NOTION_ENABLED:"false",CLAUDE_MEM_NOTION_TOKEN:"",CLAUDE_MEM_NOTION_DATABASE_ID:"",CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES:"true",CLAUDE_MEM_GROK_BOT_INJECT_ENABLED:"true",CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS:"*",CLAUDE_MEM_GROK_BOT_INJECT_TIER:"episode",CLAUDE_MEM_GROK_BOT_INJECT_WINDOW:"80",CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK:"house",CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE:"",CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT:"",CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS:"160",CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS:"1500",CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE:"",CLAUDE_MEM_CCS_ALIGN_ENABLED:"true",CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS:"ccs-align",CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS:"false",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(Fe())}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(xe())}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(xe())}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:"",CLAUDE_MEM_DEDUP_ENABLED:"false",CLAUDE_MEM_DEDUP_COSINE_THRESHOLD:"0.80",CLAUDE_MEM_DEDUP_IDF_VETO_DF:"10",CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS:"2",CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS:"10",CLAUDE_MEM_DEDUP_MAX_SCAN:"2000",CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS:"50000",CLAUDE_MEM_TOOL_USES_RETENTION_DAYS:"0",CLAUDE_MEM_LOG_RETENTION_DAYS:"30",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_PROJECT_NAME_SOURCE:"path"};static getAllDefaults(){return{...this.DEFAULTS}}static defaultsForSettingsPath(e){let t={...this.DEFAULTS},s=(0,P.dirname)(e),n=String(Fe(s)),o=process.env.CLAUDE_MEM_SERVER_PORT??String(xe(s));return t.CLAUDE_MEM_WORKER_PORT=n,t.CLAUDE_MEM_QUEUE_REDIS_PREFIX=`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??n}`,t.CLAUDE_MEM_SERVER_URL=`http://127.0.0.1:${o}`,t.CLAUDE_MEM_SERVER_BETA_URL=`http://127.0.0.1:${o}`,t}static get(e){let t=process.env[e]??this.DEFAULTS[e];return e==="CLAUDE_MEM_WORKER_HOST"?this.normalizeWorkerHost(t):e==="CLAUDE_MEM_DATA_DIR"?H(t):t}static normalizeWorkerHost(e){return e==="localhost"?"127.0.0.1":e}static finalizeSettings(e,t){let s=t?this.applyEnvOverrides(e):e;s.CLAUDE_MEM_WORKER_HOST=this.normalizeWorkerHost(s.CLAUDE_MEM_WORKER_HOST);let n=s.CLAUDE_MEM_DATA_DIR?.trim();return n&&s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH===this.DEFAULTS.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH&&(s.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH=(0,P.join)(H(n),"transcript-watch.json")),s}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0,s={}){try{let n=this.defaultsForSettingsPath(e);if(!(0,j.existsSync)(e)){if(!s.readOnly)try{X(e,n,{mode:384});for(let u of Rs)Et(e,u);console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(u){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,u instanceof Error?u.message:String(u))}return this.finalizeSettings(n,t)}let o=(0,j.readFileSync)(e,"utf-8"),i=et(o),a=ie(i),_=a!==i,d=Pt(i),E=_&&Object.keys(d).some(u=>u!=="env");if(_&&!E&&!s.readOnly)try{X(e,a,{mode:384}),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(u){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,u instanceof Error?u.message:String(u))}if(a.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES===rr&&(a={...a,CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES},!s.readOnly))try{X(e,E?{...d,env:a}:a,{mode:384}),console.warn("[SETTINGS] Migrated Telegram trigger types off the legacy default:",e)}catch(u){console.warn("[SETTINGS] Failed to migrate Telegram trigger types:",e,u instanceof Error?u.message:String(u))}if(lr(a,e)){let u=String(a.CLAUDE_MEM_MODEL).trim();if(a={...a,CLAUDE_MEM_MODEL:this.DEFAULTS.CLAUDE_MEM_MODEL},!s.readOnly)try{X(e,E?{...d,env:a}:a,{mode:384}),console.warn(`[SETTINGS] Migrated Claude model off the pinned ${u} to ${this.DEFAULTS.CLAUDE_MEM_MODEL}:`,e)}catch(p){console.warn("[SETTINGS] Failed to migrate the pinned Claude model:",e,p instanceof Error?p.message:String(p))}}if(ur(a)){let u=String(a.CLAUDE_MEM_OPENROUTER_MODEL).trim();if(a={...a,CLAUDE_MEM_OPENROUTER_MODEL:this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL},!s.readOnly)try{X(e,E?{...d,env:a}:a,{mode:384}),console.warn(`[SETTINGS] Migrated OpenRouter model off the retired default ${u} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,e)}catch(p){console.warn("[SETTINGS] Failed to migrate the retired OpenRouter model:",e,p instanceof Error?p.message:String(p))}}let c=pr(a.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);if(c!==null&&(a={...a,CLAUDE_MEM_CLOUD_SYNC_HUB_URL:c},!s.readOnly))try{X(e,E?{...d,env:a}:a,{mode:384}),console.warn("[SETTINGS] Migrated cloud sync hub URL to",c,"from a retired hub host:",e)}catch(u){console.warn("[SETTINGS] Failed to migrate cloud sync hub URL:",e,u instanceof Error?u.message:String(u))}for(let u of Rs)if(!(0,j.existsSync)(Os(e,u))){if(a[u.key]!==u.legacy){s.readOnly||Et(e,u);continue}if(a={...a,[u.key]:this.DEFAULTS[u.key]},!s.readOnly)try{X(e,E?{...d,env:a}:a,{mode:384}),Et(e,u),console.warn(`[SETTINGS] Migrated ${u.key} off the old ${u.legacy}ms default to ${this.DEFAULTS[u.key]}ms:`,e)}catch(p){let N=`${u.key}\0${e}`;fs.has(N)||(fs.add(N),console.warn(`[SETTINGS] Failed to migrate ${u.key}; using the new default in memory (reported once per process):`,e,p instanceof Error?p.message:String(p)))}}let m={...n};for(let u of Object.keys(n))a[u]!==void 0&&(m[u]=dr(a[u]));return this.finalizeSettings(m,t)}catch(n){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,n instanceof Error?n.message:String(n));let o=this.defaultsForSettingsPath(e);return this.finalizeSettings(o,t)}}};var Se=String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`,q=`(?=${Se}{8})${Se}*[A-Za-z]${Se}*`,G=String.raw`(?:\\{0,3}["'])?`,x=String.raw`\s{0,8}`;function ct(r){return new RegExp(`${r}${q}`,"gi")}function hs(r){let e=r.replace(/\\.|[a-z]/g,t=>t.length===1?`[${t}${t.toUpperCase()}]`:t);return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${e}`}function He(r){return`(?<=${r}${G}${x}[=:]${x}${G})`}var Pe=String.raw`(?:token|secret|api_key)`,Be=String.raw`\\{0,3}["']`,lt=String.raw`(?<!\\)"`,mr=String.raw`(?:^|[\s?&]|\\[nrt]|${lt})`,Tr=String.raw`(?:^|\n|\\n|${lt})[ \t]{0,8}(?:-[ \t]{1,8})?`,Sr=String.raw`(?:${Be})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${lt})`,gr=new RegExp([`${He(String.raw`\b\w*_${Pe}`)}${q}`,`(?<=${Be}${Pe}${Be}${x}:${x}${Be})${q}`,`(?<=${mr}${Pe}=${G})${q}(?!\\(|${Se})`,String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${G})${q}`,`(?<=${Tr}${Pe}:[ \\t]{1,8}${G})${q}(?=${Sr})`].join("|"),"gi"),Ar=[{name:"url_credentials",regex:/(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi},{name:"aws_access_key",regex:/(?:AKIA|ASIA)[0-9A-Z]{16}/g},{name:"aws_secret_key",regex:new RegExp(`${He(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`,"gi")},{name:"aws_session_token",regex:new RegExp(`${He(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`,"gi")},{name:"github_pat",regex:/\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g},{name:"openai_key",regex:/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"anthropic_key",regex:/\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g},{name:"slack_token",regex:/\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g},{name:"jwt",regex:/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g},{name:"private_key_pem",regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g},{name:"stripe_key",regex:/\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g},{name:"google_api_key",regex:/\bAIza[0-9A-Za-z_-]{35}(?!\w)/g},{name:"google_oauth_token",regex:/\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g},{name:"gitlab_token",regex:/\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g},{name:"huggingface_token",regex:/\bhf_[A-Za-z0-9]{30,}\b/g},{name:"npm_token",regex:/\bnpm_[A-Za-z0-9]{36}\b/g},{name:"docker_pat",regex:/\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g},{name:"linear_key",regex:/\blin_api_[A-Za-z0-9]{40}(?!\w)/g},{name:"notion_token",regex:/\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g},{name:"sendgrid_key",regex:/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g},{name:"digitalocean_token",regex:/\bdo[opr]_v1_[a-f0-9]{64}\b/g},{name:"shopify_token",regex:/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g},{name:"pypi_token",regex:/\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g},{name:"databricks_token",regex:/\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g},{name:"vault_token",regex:/\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g},{name:"nvidia_nim_key",regex:/\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g},{name:"runcrate_key",regex:/\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g},{name:"groq_key",regex:/\bgsk_[A-Za-z0-9]{52}(?!\w)/g},{name:"xai_key",regex:/\bxai-[A-Za-z0-9_]{80}(?!\w)/g},{name:"perplexity_key",regex:new RegExp(String.raw`(?<=\\[nrt]|\b)pplx-[A-Za-z0-9]{48}(?!\w)`,"g")},{name:"supabase_token",regex:/\bsbp_[a-f0-9]{40}(?!\w)/g},{name:"sentry_token",regex:/\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g},{name:"slack_webhook",regex:new RegExp(String.raw`(?<=${hs(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`,"g")},{name:"discord_webhook",regex:new RegExp(String.raw`(?<=${hs(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`,"g")},{name:"claude_mem_key",regex:/\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g}],Rr=[{name:"generic_password",regex:ct(He(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`))},{name:"generic_token",regex:gr},{name:"bearer_token",regex:ct(`(?<=\\bAuthorization${G}${x}:${x}${G}Bearer${x})`)},{name:"basic_auth",regex:ct(`(?<=\\bAuthorization${G}${x}:${x}${G}Basic${x})`)}],fr=1024*1024,Nr="<redacted type='oversize'/>";function de(r,e){if(!e.enabled||r.length===0)return{redacted:r,counts:{},oversize:!1};if(r.length>fr)return l.warn("REDACT","field exceeds the 1M-char redaction cap; replaced by an oversize marker",void 0,{inputLength:r.length}),{redacted:Nr,counts:{oversize:1},oversize:!0};let t=new Set(e.disabledBuiltinPatterns??[]),s={},n=r,o=[];for(let a of e.customPatterns??[]){if(!a.name||a.name.length===0){l.warn("REDACT","custom pattern skipped: missing name",void 0,{pattern:a});continue}try{o.push({name:a.name,regex:new RegExp(a.regex,"g")})}catch(_){l.warn("REDACT","custom pattern skipped: invalid regex",{name:a.name},_ instanceof Error?_:new Error(String(_)))}}let i=[...o,...Ar,...e.genericEnabled?Rr:[]];for(let a of i)t.has(a.name)||(a.regex.lastIndex=0,n=n.replace(a.regex,()=>(s[a.name]=(s[a.name]??0)+1,`<redacted type='${a.name}'/>`)));return e.logMatches&&Object.keys(s).length>0&&l.debug("REDACT","patterns matched",void 0,{counts:s}),{redacted:n,counts:s,oversize:!1}}function Or(r){if(!r||r.trim()==="")return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>t&&typeof t.name=="string"&&typeof t.regex=="string"):(l.warn("REDACT","CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring"),[])}catch(e){return l.warn("REDACT","failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",void 0,e instanceof Error?e:new Error(String(e))),[]}}function hr(r){return{enabled:r.CLAUDE_MEM_REDACT_ENABLED==="true",disabledBuiltinPatterns:(r.CLAUDE_MEM_REDACT_DISABLED_BUILTINS??"").split(",").map(e=>e.trim()).filter(Boolean),customPatterns:Or(r.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS??"[]"),logMatches:r.CLAUDE_MEM_REDACT_LOG_MATCHES==="true",genericEnabled:r.CLAUDE_MEM_REDACT_GENERIC_ENABLED==="true"}}var me=null,bs=0,br=5e3,Te=null,Ls=!1,Lr={enabled:!0,disabledBuiltinPatterns:[],customPatterns:[],logMatches:!1},Ir=/"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;function Cr(r){if(!(0,$e.existsSync)(r))return null;try{return(0,$e.readFileSync)(r,"utf-8")}catch{return""}}function Dr(r){if(r===null)return!1;try{let e=JSON.parse(le(r));return e===null||typeof e!="object"||Array.isArray(e)}catch{return!0}}function Mr(r,e,t){return process.env.CLAUDE_MEM_REDACT_ENABLED==="false"||!(Te?.enabled===!0||Ir.test(e))?t:(Ls||(Ls=!0,l.warn("REDACT","settings.json could not be read; secret redaction stays on until it is repaired",{settingsPath:r,using:Te?.enabled?"the last configuration that loaded":"the built-in patterns"})),Te?.enabled?Te:Lr)}function ge(r=De){let e=Date.now();if(me&&e-bs<br)return me;let t=_e.loadFromFile(r),s=hr(t),n=s.enabled?null:Cr(r);return Dr(n)?me=Mr(r,n,s):(me=s,Te=s),bs=e,me}var yr=/(?:password|passwd)$|\w_pwd$/i,vr=/(?:^|_)(?:secret|token|api_key)$/i,Ur=new RegExp(`^${Se}{8,}$`);function wr(r,e,t){if(!t.genericEnabled)return null;let s=yr.test(r)?"generic_password":vr.test(r)?"generic_token":null;return!s||t.disabledBuiltinPatterns?.includes(s)||!Ur.test(e)||!/[A-Za-z]/.test(e)?null:`<redacted type='${s}'/>`}var Is=/^(?:proxy-)?authorization$/i,kr=new RegExp(`^(${x}Bearer${x})${q}`,"i");function Fr(r,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("bearer_token")||!Is.test(r))return null;let s=kr.exec(e);return s?`${s[1]}<redacted type='bearer_token'/>${e.slice(s[0].length)}`:null}var xr=new RegExp(`^(${x}Basic${x})${q}`,"i");function Pr(r,e,t){if(!t.genericEnabled||t.disabledBuiltinPatterns?.includes("basic_auth")||!Is.test(r))return null;let s=xr.exec(e);return s?`${s[1]}<redacted type='basic_auth'/>${e.slice(s[0].length)}`:null}var Br=/^(?:aws_session_token|SessionToken)$/i,Hr=/^[A-Za-z0-9/+=]{100,}$/;function $r(r,e,t){return t.disabledBuiltinPatterns?.includes("aws_session_token")||!Br.test(r)||!Hr.test(e)?null:"<redacted type='aws_session_token'/>"}var Xr=/^(?:aws_secret_access_key|SecretAccessKey)$/i,Wr=/^[A-Za-z0-9/+=]{40}$/;function jr(r,e,t){return t.disabledBuiltinPatterns?.includes("aws_secret_key")||!Xr.test(r)||!Wr.test(e)?null:"<redacted type='aws_secret_key'/>"}function Cs(r,e=ge()){if(!e.enabled)return r;let t=(s,n)=>{if(typeof s=="string"){let o=de(s,e);return n===void 0||Object.keys(o.counts).length>0?o.redacted:$r(n,s,e)??jr(n,s,e)??Fr(n,s,e)??Pr(n,s,e)??wr(n,s,e)??o.redacted}return Array.isArray(s)?s.map(o=>t(o)):s!==null&&typeof s=="object"?Object.fromEntries(Object.entries(s).map(([o,i])=>[o,t(i,o)])):s};return t(r)}var Gr=1024*1024,ut="<redacted type='diagnostic_budget'/>";function Ds(r,e=ge()){if(!e.enabled)return r;let t=5e4,s=(o,i=[])=>{if(!i.length)return de(o,e).redacted;for(let a of i){let _=Cs({[a]:o},e)[a];if(_!==o)return _}return o},n=(o,i,a=[])=>{if(i>32||--t<0)return ut;if(typeof o=="string"){if(o.length>Gr)return de(o,e).redacted;try{let _=JSON.parse(o);if(_!==null&&(typeof _=="object"||typeof _=="string")){let d=n(_,i+1,a),E=JSON.stringify(d);if(E!==JSON.stringify(_))return E}}catch{}return s(o,a)}if(Array.isArray(o))return o.length>t?ut:o.map(_=>n(_,i+1,a));if(o&&typeof o=="object"){let _=Object.entries(o);return _.length>t?ut:Object.fromEntries(_.map(([d,E])=>[s(d,a),n(E,i+1,[d,...a])]))}return o};return n(r,0)}var Ci=Object.freeze({maxImagesPerEvent:4,maxSourceBytes:3145728,maxCanonicalBytes:3145728,maxPixels:24e6,maxDimension:8192,conversionTimeoutSeconds:5,maxConcurrentConversions:1,maxDerivativeBytes:262144,maxDerivativeDimension:1536,maxInlineEncodedBytes:4194304,maxObservationRefs:32,maxLabelChars:64,maxManifestBytes:8192,maxProvenanceBytes:8192,maxSourceLocatorChars:4096,maxGatewayImageBytes:1048576,maxUploadBodyBytes:3211264,ownerQuotaBytes:268435456});var Ms=4096;var Kr=new Set(["set_title","set_prompt_session","remap_project"]),Vr=/^(?:0|[1-9][0-9]*)$/,ys=18446744073709551615n;function w(r){let e=Ds(r);throw l.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:e}),new Error(`canonical content: ${e}`)}function Re(r,e={}){return typeof r!="string"||!Vr.test(r)?w("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(r)>ys&&w("decimal value exceeds uint64"),e.positive&&r==="0"&&w("decimal value must be positive"),r)}function We(r){let e=Re(r);return BigInt(e)===ys&&w("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function Yr(r){(r===null||typeof r!="object"||Array.isArray(r))&&w("mutation must be an object");let e=r;if((typeof e.op!="string"||!Kr.has(e.op))&&w("unsupported mutation op"),e.op==="set_title"){let o=Ae(e,["fields","op","target"],"set_title"),i=Xe(o.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");i.memory_session_id===void 0&&i.content_session_id===void 0&&w("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])i[_]!==void 0&&J(i[_],_);let a=Ae(o.fields,["custom_title"],"set_title.fields");J(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let o=Ae(e,["fields","op","target"],"set_prompt_session"),i=Ae(o.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");qr(i.origin_device_id),Re(i.origin_local_id);let a=Xe(o.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");J(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&J(a[_],_);return}let t=Ae(e,["fields","op","where"],"remap_project"),s=Xe(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&J(s.project,"project"),s.memory_session_id!==void 0&&J(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&w("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&w("remap_project where is empty");let n=Xe(t.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&J(n.project,"project"),n.merged_into_project!==void 0&&J(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&w("remap_project fields are empty")}function pt(r){Yr(r)}function qr(r){return typeof r!="string"||r.length===0||Buffer.byteLength(r,"utf8")>128?w("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):r}function J(r,e){return typeof r!="string"||r.length===0||r.trim().length===0||Buffer.byteLength(r,"utf8")>Ms?w(`${e} must be a non-blank string of at most ${Ms} UTF-8 bytes`):r}function Ae(r,e,t){if(r===null||typeof r!="object"||Array.isArray(r))return w(`${t} must be an object`);let s=r,n=Object.keys(s).sort(),o=[...e].sort();return(n.length!==o.length||n.some((i,a)=>i!==o[a]))&&w(`${t} must contain exactly: ${o.join(", ")}`),s}function Xe(r,e,t){if(r===null||typeof r!="object"||Array.isArray(r))return w(`${t} must be an object`);let s=r,n=new Set(e),o=Object.keys(s).find(i=>!n.has(i));return o&&w(`${t} contains unknown field ${o}`),s}var vs=r=>typeof r=="string"&&/^__my_work_v\d+:/.test(r);function Us(r,e){let t=o=>o.replace(/[A-Z]/g,i=>i.toLowerCase()),s=new Set(e.map(t)),n=e.at(-1);return r.map(o=>n&&s.has(t(o.project))?{...o,scope_project:n}:o)}function ws(r){r.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `),r.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)"),zr(r)}function zr(r){let e=new Set(r.query("PRAGMA table_info(work_state_entries)").all().map(t=>t.name));e.has("synced_at")||r.run("ALTER TABLE work_state_entries ADD COLUMN synced_at INTEGER"),e.has("origin_device_id")||r.run("ALTER TABLE work_state_entries ADD COLUMN origin_device_id TEXT"),e.has("origin_local_id")||r.run("ALTER TABLE work_state_entries ADD COLUMN origin_local_id TEXT"),e.has("sync_rev")||r.run("ALTER TABLE work_state_entries ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'"),r.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_unsynced ON work_state_entries(id) WHERE synced_at IS NULL"),r.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_work_state_entries_origin
    ON work_state_entries(origin_device_id, origin_local_id)
    WHERE origin_device_id IS NOT NULL
  `)}function ks(r,e){let t=e.createdAtEpoch??Date.now(),s=r.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(e.project,e.listName,JSON.stringify(e.fields),new Date(t).toISOString(),t),n=Number(s.lastInsertRowid);return l.debug("DB","Work state entry appended",{id:n,project:e.project,listName:e.listName}),n}function Fs(r,e,t,s=""){if(e.length===0)return[];let n=e.map(()=>"?").join(", "),o=t===void 0?"":" AND list_name = ?",i=r.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${n})${o}
    ORDER BY created_at_epoch, COALESCE(origin_device_id, ?), COALESCE(CAST(origin_local_id AS INTEGER), id)
  `);try{return i.all(...e,...t===void 0?[]:[t],s).filter(_=>!vs(_.list_name)).map(_=>({..._,fields:JSON.parse(_.fields)}))}finally{i.finalize()}}var $s=require("crypto");function fe(r){let e=(r??"").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu," ").replace(/\s+/g," ").trim();return/[\p{L}\p{N}]/u.test(e)?e:""}function te(r){return(r??"").toLowerCase().trim().split(/\s+/).filter(Boolean)}function mt(r,e){return Math.log(1+e/(r+.5))}function xs(r,e){return t=>mt(r(t),e)}function Ps(r,e){let t=new Map;for(let s of new Set(r))t.set(s,e(s));return t}function Bs(r,e,t){let s=Ps(r,t),n=Ps(e,t),o=0,i=0,a=0;for(let[_,d]of s){i+=d*d;let E=n.get(_);E!==void 0&&(o+=d*E)}for(let[,_]of n)a+=_*_;return i===0||a===0?0:o/Math.sqrt(i*a)}function Hs(r,e,t,s){let n=new Set(r),o=new Set(e);for(let i of n)if(!o.has(i)&&t(i)>s)return!0;for(let i of o)if(!n.has(i)&&t(i)>s)return!0;return!1}function Tt(r,e,t,s){let n=fe(r);if(n!==""&&n===fe(e))return{tier:"exact",method:"exact",score:1};let o=te(r),i=te(e),a=s.minSharedTokens??2,_=new Set(i),d=0;for(let c of new Set(o))_.has(c)&&d++;if(d<a)return{tier:"none",method:"none",score:0};let E=Bs(o,i,t);return E>=s.cosineThreshold&&!Hs(o,i,t,s.vetoThetaIdf)?{tier:"candidate",method:"idf_cosine",score:E}:{tier:"none",method:"none",score:E}}function Ne(r,e){return!!r&&!!e}function je(r,e,t,s=!1){let n=fe(t);if(n==="")return null;let o=h(e),i=s?"subagent":"main";return(0,$s.createHash)("sha256").update(`${r}\0${o}\0${i}\0${n}`).digest("hex").slice(0,32)}function Xs(r,e,t){return t===null?null:r.prepare("SELECT id, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC LIMIT 1").get(e,t)??null}function Ws(r,e,t){let s=[...new Set(te(t))],n=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1");for(let o of s)n.run(e,o);r.prepare("INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1").run(e)}function js(r,e){return mt(r+1,e)}function Gs(r,e){return r.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(e)?.doc_count??0}function Ks(r,e){let t=Gs(r,e),s=r.prepare("SELECT token, df FROM token_df WHERE project = ?").all(e),n=new Map(s.map(o=>[o.token,o.df]));return{idfFn:xs(o=>n.get(o)??0,t),docCount:t}}function Vs(r){return r.prepare("INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")}function Ys(r,e,t){return Gs(r,e)>=t}function Qr(r,e,t=Number.POSITIVE_INFINITY){let s=r.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(e).c;if(s>t)return l.warn("DEDUP",`Skipping dedup backfill for project ${e}: ${s} rows exceeds cap ${t} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`),0;let n=r.prepare("SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?").all(e),o=r.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?"),i=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)");return r.transaction(()=>{let _=new Map;for(let d of n){o.run(je(e,d.platform_source,d.title,Ne(d.agent_id,d.agent_type)),d.id);for(let E of new Set(te(d.title)))_.set(E,(_.get(E)??0)+1)}r.prepare("DELETE FROM token_df WHERE project = ?").run(e);for(let[d,E]of _)i.run(e,d,E);r.prepare("INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0").run(e,n.length,n.length)})(),n.length}function Zr(r,e,t){let s=r.prepare("SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC").all(e);if(s.length<2)return 0;if(s.length>t.maxBackfillRows)return l.warn("DEDUP",`Skipping dedup sweep for project ${e}: ${s.length} rows exceeds cap ${t.maxBackfillRows}`),0;let{idfFn:n,docCount:o}=Ks(r,e),i={cosineThreshold:t.cosineThreshold,vetoThetaIdf:js(t.idfVetoDf,o),minSharedTokens:t.minSharedTokens},a=s.map(R=>new Set(te(R.title))),_=new Map;for(let R of a)for(let I of R)_.set(I,(_.get(I)??0)+1);let d=Math.max(2,Math.ceil(Math.sqrt(s.length))*4),E=new Map;a.forEach((R,I)=>{for(let O of R){let T=_.get(O);if(T<2||T>d)continue;let M=E.get(O);M||(M=[],E.set(O,M)),M.push(I)}});let c=new Map;for(let R of E.values())for(let I=0;I<R.length;I++)for(let O=I+1;O<R.length;O++){let T=`${R[I]}:${R[O]}`;c.set(T,(c.get(T)??0)+1)}let m=Vs(r),u=new Date().toISOString(),p=Date.now(),N=0;for(let[R,I]of c){if(I<t.minSharedTokens)continue;let[O,T]=R.split(":").map(Number),M=Tt(s[O].title,s[T].title,n,i);M.tier==="candidate"&&(N+=m.run(s[T].id,s[O].id,e,M.method,M.score,"pending",u,p).changes)}return N}function qs(r,e){return r.prepare("SELECT DISTINCT project FROM observations").all().map(s=>s.project).map(s=>{let n=Qr(r,s,e.maxBackfillRows),o=Zr(r,s,e);return{project:s,docs:n,candidates:o}})}function Js(r,e,t,s,n){if(!s)return 0;let{idfFn:o,docCount:i}=Ks(r,e),a={cosineThreshold:n.cosineThreshold,vetoThetaIdf:js(n.idfVetoDf,i),minSharedTokens:n.minSharedTokens},_=r.prepare("SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?").all(e,t,n.maxScan);_.length===n.maxScan&&l.debug("DEDUP",`Tier-1 scan hit MAX_SCAN=${n.maxScan} for project ${e}; older rows covered by dedup-scan`);let d=Vs(r),E=new Date().toISOString(),c=Date.now(),m=0;for(let u of _){let p=Tt(s,u.title,o,a);p.tier==="candidate"&&(m+=d.run(t,u.id,e,p.method,p.score,"pending",E,c).changes)}return m}function zs(r,e,t,s,n){let o=Date.now()-s,i=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return r.prepare(`
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
  `).get(a,t,o)??void 0}var tn=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],eo=new Set(tn),Qs=/<([A-Za-z_][A-Za-z0-9_-]*)/y,Zs=/<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;function to(r){let e=Object.fromEntries(tn.map(E=>[E,0]));if(!r.includes("<"))return{text:r,counts:e,total:0};let t=r.length,s=new Int32Array(t+1);s[t]=t;for(let E=t-1;E>=0;E--)s[E]=r.charCodeAt(E)===62?E:s[E+1];let n=new Map,o=[],i=0,a=0;for(;a<t;){if(r.charCodeAt(a)!==60){a+=1;continue}Zs.lastIndex=a;let E=Zs.exec(r);if(E){let m=E[1],u=n.get(m),p=u&&u.head<u.items.length?u.items[u.head]:void 0;p&&a>=p.attrEnd&&(u.head+=1,o.push([p.start,a+E[0].length]),e[m]+=1,i+=1),a+=E[0].length;continue}Qs.lastIndex=a;let c=Qs.exec(r);if(c&&eo.has(c[1])){let m=c[1],u=a+c[0].length,p={start:a,attrEnd:s[u]},N=n.get(m);N?N.items.push(p):n.set(m,{items:[p],head:0}),a=u;continue}a+=1}o.sort((E,c)=>E[0]-c[0]);let _="",d=0;for(let[E,c]of o)E>d&&(_+=r.slice(d,E)),c>d&&(d=c);return _+=r.slice(d),{text:_,counts:e,total:i}}var en=100;function so(r){return no(r,to(r))}function no(r,{text:e,counts:t,total:s}){return s>en&&l.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:en,contentLength:r.length}),{stripped:de(e.trim(),ge()).redacted,counts:t}}function Ge(r){return so(r).stripped}var ro=["task-notification"],da=new RegExp(`^\\s*<(${ro.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Ea=256*1024;var St=4e3,gt="[media prompt]";function se(r){let e=Ge(r).trim();return e.length<=St?e:(l.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:e.length,storedLength:St}),`${e.slice(0,St-1)}\u2026`)}var oo=require("bun:sqlite");var sn=5e3,io=4194304,ce=71;function nn(r){return r.prepare("PRAGMA user_version").get().user_version}var Oe=class extends Error{reason="schema_newer_than_binary";constructor(e){super(e),this.name="SchemaNewerThanBinaryError"}};function he(r,e){r.run(`PRAGMA busy_timeout = ${sn}`);let t=nn(r);if(!(t<=e))throw new Oe(`SQLite database has schema v${t}; this claude-mem knows up to schema v${e}. Upgrade claude-mem before opening this database.`)}function At(r,e){he(r,e),nn(r)<e&&r.run(`PRAGMA user_version = ${e}`)}function rn(r,e){r.transaction(()=>At(r,e)).immediate()}function ao(r){return r.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function Ee(r,e,t){try{r.run(e)}catch(s){let n=s instanceof Error?s:new Error(String(s));throw l.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},n),s}}function Ke(r,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;Ee(r,`PRAGMA busy_timeout = ${sn}`,"busy_timeout"),Ee(r,"PRAGMA foreign_keys = ON","foreign_keys"),Ee(r,"PRAGMA synchronous = NORMAL","synchronous"),Ee(r,`PRAGMA journal_size_limit = ${io}`,"journal_size_limit"),s&&!ao(r)&&Ee(r,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&Ee(r,"PRAGMA journal_mode = WAL","journal_mode")}var on=!1;function be(r,...e){return typeof r.iterate=="function"?r.iterate(...e):(on||(on=!0,l.warn("DB","bun:sqlite lacks Statement.iterate(); falling back to .all()",{bunVersion:typeof Bun<"u"?Bun.version:"unknown",requiredBunVersion:">=1.1.31",impact:"rows are materialized in memory; upgrade Bun to restore streaming"})),r.all(...e))}function Rt(r,e,t,s){try{let n=Number(s.limit);if(!Number.isInteger(n)||n<0)throw new Error("Page limit must be a non-negative integer");let o=Number(s.offset??0);if(!Number.isInteger(o))throw new Error("Page offset must be an integer");let i=[];if(n===0)return i;let a=Math.max(0,o);for(let _ of be(r,...e))if(t(_)){if(a>0){a--;continue}if(i.push(_),i.length===n)break}return i}finally{r.finalize()}}function ft(r){let e=`a.id IN (${r.candidateAttachmentIdsSql})
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
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${e})`]}var Ye="SELECT event_key FROM media_events WHERE session_db_id=OLD.id",_o=ft({candidateAttachmentIdsSql:"SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id",eventRefsBeingRemovedSql:"0",observationLinksBeingRemovedSql:"l.observation_id=OLD.id"}),Eo=ft({candidateAttachmentIdsSql:`SELECT attachment_id FROM media_event_refs WHERE event_key IN (${Ye})`,eventRefsBeingRemovedSql:`r.event_key IN (${Ye})`,observationLinksBeingRemovedSql:"0"}),Aa=ft({candidateAttachmentIdsSql:"SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey",eventRefsBeingRemovedSql:"r.event_key=$eventKey",observationLinksBeingRemovedSql:"0"});function an(r){r.transaction(()=>{r.exec(`
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
    `),Ve(r,"origin","TEXT NOT NULL DEFAULT 'native'"),Ve(r,"upload_attempts","INTEGER NOT NULL DEFAULT 0"),Ve(r,"upload_retry_at","INTEGER NOT NULL DEFAULT 0"),Ve(r,"upload_error","TEXT"),r.exec("CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)"),r.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${_o.join(`;
        `)};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${Eo.join(`;
        `)};
        DELETE FROM media_event_refs WHERE event_key IN (${Ye});
        DELETE FROM media_event_results WHERE event_key IN (${Ye});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);let e=new Date().toISOString();r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(69,e),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(70,e),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(71,e)})()}function Ve(r,e,t){r.prepare("PRAGMA table_info(media_attachments)").all().some(n=>n.name===e)||r.exec(`ALTER TABLE media_attachments ADD COLUMN ${e} ${t}`)}var bt=require("bun:sqlite");function ne(r){return r.replace(/\\/g,"/").replace(/\/+/g,"/").replace(/\/+$/,"")}function Nt(r,e){let t=ne(r),s=ne(e);if(t.startsWith(s+"/"))return!t.slice(s.length+1).includes("/");let n=s.split("/"),o=t.split("/");if(o.length<2)return s===""||s===".";let i=o.slice(0,-1).join("/"),a=o[o.length-1],_=/^([A-Za-z]:)?\//;if(!_.test(s)&&_.test(t)&&s!==""&&i.endsWith("/"+s))return a!=="";if(s.endsWith("/"+i)||s===i)return!a.includes("/");for(let d=0;d<n.length;d++)if(n.slice(d).join("/")===i)return!0;return!1}var qe=class extends Error{constructor(t,s=500,n,o){super(t);this.statusCode=s;this.code=n;this.details=o;this.name="AppError"}statusCode;code;details};var co=/^\d{4}-\d{2}-\d{2}$/,lo=/^(\d{4})-(\d{2})-(\d{2})/,uo=/^\d{5,}$/,po=1440*60*1e3;function re(r,e){if(typeof r=="number")return Ot(r,r,e);let t=r.trim();if(uo.test(t))return Ot(Number(t),r,e);let s=mo(t)?new Date(t).getTime():Number.NaN,n=Ot(s,r,e);return e==="end"&&co.test(t)?n+po-1:n}function mo(r){let e=lo.exec(r);if(!e)return!0;let[t,s,n]=e.slice(1).map(Number),o=new Date(0);return o.setUTCFullYear(t,s-1,n),o.getUTCFullYear()===t&&o.getUTCMonth()===s-1&&o.getUTCDate()===n}function Ot(r,e,t){if(Number.isNaN(new Date(r).getTime()))throw new qe(`Invalid date for the ${t} of the range: ${JSON.stringify(e)}. Use an ISO date such as 2025-01-31 or 2025-01-31T08:00:00Z.`,400,"INVALID_DATE");return r}var ht="\\p{Script=Han}\\u31F0-\\u31FF\\uFF66-\\uFF9F\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF",_n=["observations_ai","observations_ad","observations_au"],dn=["session_summaries_ai","session_summaries_ad","session_summaries_au"],Le=`
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
`,Ie=`
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
`,En=class r{db;constructor(e=Me,t={}){e instanceof bt.Database?this.db=e:(ye(D),this.db=new bt.Database(e)),he(this.db,ce),t.readOnly||Ke(this.db),this._fts5Available=this.isFts5Available(),t.readOnly||this.ensureFTSTables()}_fts5Available;ensureFTSTables(){let e=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),t=e.some(o=>o.name==="observations_fts"),s=e.some(o=>o.name==="session_summaries_fts");if(t&&s&&this.hasAllFtsTriggers(_n)&&this.hasAllFtsTriggers(dn))return;if(!this.isFts5Available()){l.warn("DB","FTS5 not available on this platform \u2014 skipping FTS table creation (search uses ChromaDB)");return}let n=t&&s;l.info("DB",n?"Converging FTS5 indexes and recreating missing sync triggers":"Creating FTS5 tables");try{this.db.transaction(()=>{At(this.db,ce);let o=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),i=!o.some(E=>E.name==="observations_fts"),a=!o.some(E=>E.name==="session_summaries_fts"),_=!i&&!this.hasAllFtsTriggers(_n),d=!a&&!this.hasAllFtsTriggers(dn);this.createFTSTablesAndTriggers(i,a),_&&(this.rebuildFtsIndex("observations_fts"),this.db.run(Le)),d&&(this.rebuildFtsIndex("session_summaries_fts"),this.db.run(Ie))}).immediate(),l.info("DB",n?"FTS5 indexes converged and sync triggers recreated":"FTS5 tables created successfully")}catch(o){if(o instanceof Oe)throw o;this._fts5Available=!1,l.warn("DB","FTS5 table creation failed \u2014 search will use ChromaDB and LIKE queries",{},o instanceof Error?o:void 0)}}hasAllFtsTriggers(e){let t=e.map(()=>"?").join(", ");return this.db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${t})`).all(...e).length===e.length}rebuildFtsIndex(e){this.db.run(`INSERT INTO ${e}(${e}) VALUES('rebuild')`)}isFts5Available(){try{return this.db.run("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(test_column)"),this.db.run("DROP TABLE temp._fts5_probe"),!0}catch(e){return l.debug("DB","FTS5 probe failed \u2014 FTS5 unavailable on this platform",void 0,e instanceof Error?e:new Error(String(e))),!1}}canReadFtsIndex(e){try{return this.db.prepare(`SELECT rowid FROM ${e} WHERE ${e} MATCH ? LIMIT 0`).all('"fts_read_probe"'),!0}catch{return!1}}createFTSTablesAndTriggers(e,t){e&&(this.db.run(`
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
      `),this.db.run(Le)),t&&(this.db.run(`
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
      `),this.db.run(Ie))}buildFilterClause(e,t,s="o"){let n=[],o=B(e);if(o.length>0){let i=$(s,o,{includeMerged:!0});n.push(i.sql),t.push(...i.params)}if(e.platformSource&&(n.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = ${s}.memory_session_id), ''), '${S}') = ?`),t.push(h(e.platformSource))),e.type)if(Array.isArray(e.type)){let i=e.type.map(()=>"?").join(",");n.push(`${s}.type IN (${i})`),t.push(...e.type)}else n.push(`${s}.type = ?`),t.push(e.type);if(e.dateRange){let{start:i,end:a}=e.dateRange;i&&(n.push(`${s}.created_at_epoch >= ?`),t.push(re(i,"start"))),a&&(n.push(`${s}.created_at_epoch <= ?`),t.push(re(a,"end")))}if(e.concepts){let i=Array.isArray(e.concepts)?e.concepts:[e.concepts],a=`${s}.concepts`,_=`CASE WHEN json_valid(${a}) THEN CASE
        WHEN json_type(${a}) = 'array' THEN ${a}
        WHEN json_type(${a}) = 'text' THEN json_array(json_extract(${a}, '$'))
        ELSE json_array(${a}) END ELSE json_array(${a}) END`,d=i.map(()=>`EXISTS (SELECT 1 FROM json_each(${_}) WHERE type = 'text' AND value = ?)`);d.length>0&&(n.push(`(${d.join(" OR ")})`),t.push(...i))}if(e.files){let i=Array.isArray(e.files)?e.files:[e.files],a=s==="s"?"files_edited":"files_modified",_=i.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${r.fileArrayJson(`${s}.files_read`)}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(${r.fileArrayJson(`${s}.${a}`)}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\')
        )`);_.length>0&&(n.push(`(${_.join(" OR ")})`),i.forEach(d=>{let E=d.replace(/[\\%_]/g,"\\$&");t.push(`%${E}%`,`%${E}%`)}))}return n.length>0?n.join(" AND "):""}static UNSEGMENTED_SCRIPT=new RegExp(`[${ht}]`,"u");static UNSEGMENTED_RUN=new RegExp(`[${ht}]+|[^\\s${ht}]+`,"gu");static MAX_SUBSTRING_TERMS=500;static buildSubstringClause(e,t){let s=[...new Set(e.match(r.UNSEGMENTED_RUN)??[])].slice(0,r.MAX_SUBSTRING_TERMS);s.length===0&&s.push(e);let n=[];return{clause:`(${s.map(i=>{let a=`%${i.replace(/[\\%_]/g,"\\$&")}%`;for(let _=0;_<t.length;_+=1)n.push(a);return`(${t.map(_=>`${_} LIKE ? ESCAPE '\\'`).join(" OR ")})`}).join(" AND ")})`,params:n}}static MIN_ANY_TERM_TOKENS=3;static buildFTSMatchQuery(e){let t=(e.match(/\S+/g)??[]).filter(s=>/[\p{L}\p{N}]/u.test(s));return t.length===0?`"${e.replace(/"/g,'""')}"`:t.map(s=>`"${s.replace(/"/g,'""')}"`).join(" AND ")}buildFTSAnyTermQuery(e,t){let s=(e.match(/\S+/g)??[]).filter(a=>/[\p{L}\p{N}]/u.test(a));if(s.length<r.MIN_ANY_TERM_TOKENS)return null;let n=this.termDocFrequency(t),o=[...e].length,i;return n?o<r.ANY_TERM_SHORT_PROMPT_CHARS?i=r.pickRareTokens(s,n,r.ANY_TERM_SHORT_PROMPT_CAP):o<r.ANY_TERM_MEDIUM_PROMPT_CHARS?i=r.pickRareTokens(s,n,r.ANY_TERM_MEDIUM_PROMPT_CAP):i=r.pickRareWords(e,n):i=r.dedupeTokens(s).slice(0,r.ANY_TERM_LONG_PROMPT_CAP),i.length===0?null:i.map(a=>`"${a.replace(/"/g,'""')}"`).join(" OR ")}static ANY_TERM_SHORT_PROMPT_CHARS=200;static ANY_TERM_MEDIUM_PROMPT_CHARS=600;static ANY_TERM_SHORT_PROMPT_CAP=40;static ANY_TERM_MEDIUM_PROMPT_CAP=60;static ANY_TERM_LONG_PROMPT_CAP=40;static ANY_TERM_COMMON_SHARE=.3;static ANY_TERM_MATCHING_DOCUMENT_BUDGET=1024;static ANY_TERM_LONG_PROMPT_MAX_SHARE=.02;static ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS=3;static ANY_TERM_CONTENT_TABLES={observations_fts:"observations",session_summaries_fts:"session_summaries"};vocabLookups=new Map;termDocFrequency(e){if(!this.vocabLookups.has(e)){let s=null;try{this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${e}_vocab USING fts5vocab(main, '${e}', 'row')`),s=this.db.prepare(`SELECT doc FROM temp.${e}_vocab WHERE term = ?`)}catch(n){l.debug("DB","FTS5 vocabulary unavailable; any-term queries are capped without frequencies",{ftsTable:e},n instanceof Error?n:void 0)}this.vocabLookups.set(e,s)}let t=this.vocabLookups.get(e);if(!t)return null;try{let s=r.ANY_TERM_CONTENT_TABLES[e],n=this.db.prepare(`SELECT count(*) AS n FROM ${s}`).get().n,o=new Map;return{rows:a=>{let _=a.toLowerCase().normalize("NFD").replace(new RegExp("\\p{Mn}","gu"),""),d=o.get(_);return d===void 0&&(d=t.get(_)?.doc??0,o.set(_,d)),d},total:n}}catch(s){return l.debug("DB","FTS5 vocabulary lookup failed; any-term queries are capped without frequencies",{ftsTable:e},s instanceof Error?s:void 0),this.vocabLookups.set(e,null),null}}static tokenRows(e,t){let s=e.match(/[\p{L}\p{N}]+/gu)??[];return s.length===0?0:Math.min(...s.map(n=>t.rows(n)))}static commonRowLimit(e,t){return Math.max(e*t,2)}static dedupeTokens(e){let t=new Set;return e.filter(s=>{let n=s.toLowerCase();return t.has(n)?!1:(t.add(n),!0)})}static pickRareTokens(e,t,s){let n=r.commonRowLimit(t.total,r.ANY_TERM_COMMON_SHARE),o=r.dedupeTokens(e),i=o.filter(c=>r.tokenRows(c,t)<n),a=i.length<=s?i:i.map(c=>({token:c,rows:r.tokenRows(c,t)})).sort((c,m)=>c.rows-m.rows).slice(0,s).map(c=>c.token);if(a.some(c=>r.tokenRows(c,t)>0))return a;let _=[...a],d=0,E=o.map(c=>({token:c,rows:r.tokenRows(c,t)})).filter(c=>c.rows>=n).sort((c,m)=>c.rows-m.rows);for(let{token:c,rows:m}of E){if(_.length===s)break;let u=/[^\x00-\x7F]/.test(c)?t.total:m;d+u>r.ANY_TERM_MATCHING_DOCUMENT_BUDGET||(_.push(c),d+=u)}return _}static pickRareWords(e,t){let s=r.commonRowLimit(t.total,r.ANY_TERM_LONG_PROMPT_MAX_SHARE),n=new Set((e.match(/[\p{L}\p{N}]+/gu)??[]).filter(i=>[...i].length>=r.ANY_TERM_LONG_PROMPT_MIN_WORD_CHARS).map(i=>i.toLowerCase())),o=[];for(let i of n){let a=t.rows(i);if(a>0&&a<s&&(o.push(i),o.length===r.ANY_TERM_LONG_PROMPT_CAP))break}return o}buildOrderClause(e="relevance",t=!0,s="observations_fts"){switch(e){case"relevance":return t?`ORDER BY ${s}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC, o.id DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC, o.id ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservationsBySubstring(e,t,s,n,o){let i=r.buildSubstringClause(e,["o.title","o.subtitle","o.narrative","o.text","o.facts","o.concepts"]),a=[],_=this.buildFilterClause(t,a,"o"),d=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${i.clause}
      ${_?"AND "+_:""}
      ${this.buildOrderClause(s,!1)}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(d).all(...i.params,...a,n,o)}searchSessionsBySubstring(e,t,s,n,o){let i=r.buildSubstringClause(e,["s.request","s.investigated","s.learned","s.completed","s.next_steps","s.notes"]),a={...t};delete a.type;let _=[],d=this.buildFilterClause(a,_,"s"),E=s==="date_asc"?"ORDER BY s.created_at_epoch ASC, s.id ASC":"ORDER BY s.created_at_epoch DESC, s.id DESC",c=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${i.clause}
      ${d?"AND "+d:""}
      ${E}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(c).all(...i.params,..._,n,o)}searchObservations(e,t={}){let s=[],{limit:n=50,offset:o=0,orderBy:i="relevance",...a}=t;if(!e){let _=this.buildFilterClause(a,s,"o");if(!_)return[];let d=this.buildOrderClause(i,!1),E=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${_}
        ${d}
        LIMIT ? OFFSET ?
      `;return s.push(n,o),this.db.prepare(E).all(...s)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchObservationsBySubstring(e,a,i,n,o);if(this._fts5Available||this.canReadFtsIndex("observations_fts")){let _=this.buildFilterClause(a,s,"o"),d=this.buildOrderClause(i,!0,"observations_fts"),E=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        JOIN observations_fts ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
        ${_?"AND "+_:""}
        ${d}
        LIMIT ? OFFSET ?
      `;s.unshift(r.buildFTSMatchQuery(e));let c;try{c=this.db.prepare(E).all(...s,n,o)}catch(u){throw l.warn("DB","FTS5 observation search failed",{},u instanceof Error?u:void 0),u}if(c.length>0||o>0&&this.db.prepare(E).all(...s,1,0).length>0)return c;let m=this.searchObservationsBySubstring(e,a,i,n,o);return m.length>0||o>0&&this.searchObservationsBySubstring(e,a,i,1,0).length>0?m:this.searchFtsAnyTerm(E,e,s,n,o,"observations_fts")??m}return this.searchObservationsBySubstring(e,a,i,n,o)}searchSessions(e,t={}){let s=[],{limit:n=50,offset:o=0,orderBy:i="relevance",...a}=t;if(!e){let _={...a};delete _.type;let d=this.buildFilterClause(_,s,"s");if(!d)return[];let c=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${d}
        ${i==="date_asc"?"ORDER BY s.created_at_epoch ASC, s.id ASC":"ORDER BY s.created_at_epoch DESC, s.id DESC"}
        LIMIT ? OFFSET ?
      `;return s.push(n,o),this.db.prepare(c).all(...s)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchSessionsBySubstring(e,a,i,n,o);if(this._fts5Available||this.canReadFtsIndex("session_summaries_fts")){let _={...a};delete _.type;let d=this.buildFilterClause(_,s,"s"),E=i==="date_asc"?"ORDER BY s.created_at_epoch ASC, s.id ASC":i==="date_desc"?"ORDER BY s.created_at_epoch DESC, s.id DESC":"ORDER BY session_summaries_fts.rank ASC",c=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id
        WHERE session_summaries_fts MATCH ?
        ${d?"AND "+d:""}
        ${E}
        LIMIT ? OFFSET ?
      `;s.unshift(r.buildFTSMatchQuery(e));let m;try{m=this.db.prepare(c).all(...s,n,o)}catch(p){throw l.warn("DB","FTS5 session search failed",{},p instanceof Error?p:void 0),p}if(m.length>0||o>0&&this.db.prepare(c).all(...s,1,0).length>0)return m;let u=this.searchSessionsBySubstring(e,a,i,n,o);return u.length>0||o>0&&this.searchSessionsBySubstring(e,a,i,1,0).length>0?u:this.searchFtsAnyTerm(c,e,s,n,o,"session_summaries_fts")??u}return this.searchSessionsBySubstring(e,a,i,n,o)}searchFtsAnyTerm(e,t,s,n,o,i){let a=this.buildFTSAnyTermQuery(t,i);if(!a)return null;let _=[a,...s.slice(1)],d=this.db.prepare(e).all(..._,n,o);return d.length>0||o>0&&this.db.prepare(e).all(..._,1,0).length>0?d:null}findByConcept(e,t={}){let s=[],{limit:n=50,offset:o=0,orderBy:i="date_desc",...a}=t,_={...a,concepts:e},d=this.buildFilterClause(_,s,"o"),E=this.buildOrderClause(i,!1),c=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${d}
      ${E}
      LIMIT ? OFFSET ?
    `;return s.push(n,o),this.db.prepare(c).all(...s)}hasDirectChildFile(e,t){let s=n=>{if(!n)return!1;try{let o=JSON.parse(n);if(Array.isArray(o))return o.some(i=>typeof i=="string"&&Nt(i,t))}catch(o){l.debug("DB",`Failed to parse files JSON for observation ${e.id}`,void 0,o instanceof Error?o:void 0)}return!1};return s(e.files_modified)||s(e.files_read)}hasDirectChildFileSession(e,t){let s=n=>{if(!n)return!1;try{let o=JSON.parse(n);if(Array.isArray(o))return o.some(i=>typeof i=="string"&&Nt(i,t))}catch(o){l.debug("DB",`Failed to parse files JSON for session summary ${e.id}`,void 0,o instanceof Error?o:void 0)}return!1};return s(e.files_read)||s(e.files_edited)}static filePathPatterns(e,t){if(t&&ne(e)===".")return["%"];let s=_=>_.replace(/[\\%_]/g,"\\$&"),n=[e,ne(e),ne(e).replaceAll("/","\\")],o=[...new Set(n)].map(_=>`%${s(_)}%`);if(!t||!/^([A-Za-z]:)?[\\/]/.test(e))return o;let i=ne(e).split("/").filter(_=>_.length>0),a=/^[A-Za-z]:$/.test(i[0]??"")?1:0;for(let _=a;_<i.length;_+=1){let d=i.slice(_);o.push(`${s(d.join("/")+"/")}%`),o.push(`${s(d.join("\\")+"\\")}%`)}return o}static fileArrayJson(e){return`CASE WHEN json_valid(${e}) THEN CASE WHEN json_type(${e}) = 'array' THEN ${e} ELSE '[]' END ELSE '[]' END`}static jsonArrayLikeClause(e,t){let s=Array.from({length:t},()=>"type = 'text' AND value LIKE ? ESCAPE '\\'").join(" OR ");return`(${e.map(n=>`EXISTS (SELECT 1 FROM json_each(${r.fileArrayJson(n)}) WHERE ${s})`).join(" OR ")})`}findByFile(e,t={}){let s=[],{limit:n=50,offset:o=0,orderBy:i="date_desc",isFolder:a=!1,..._}=t;delete _.files;let d=a?"":"LIMIT ? OFFSET ?",E=r.filePathPatterns(e,a),c=this.buildFilterClause(_,s,"o");s.push(...E,...E);let m=[c,r.jsonArrayLikeClause(["o.files_read","o.files_modified"],E.length)].filter(Boolean).join(" AND "),u=`${this.buildOrderClause(i,!1)}, o.id ${i==="date_asc"?"ASC":"DESC"}`,p=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${m}
      ${u}
      ${d}
    `;a||s.push(n,o);let N=this.db.prepare(p),R=a?Rt(N,s,f=>this.hasDirectChildFile(f,e),{limit:n,offset:o}):N.all(...s),I=[],O={..._};delete O.type;let T=[],M=B(O);if(M.length>0){let f=$("s",M,{includeMerged:!0});T.push(f.sql),I.push(...f.params)}if(O.platformSource&&(T.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = s.memory_session_id), ''), '${S}') = ?`),I.push(h(O.platformSource))),O.dateRange){let{start:f,end:A}=O.dateRange;f&&(T.push("s.created_at_epoch >= ?"),I.push(re(f,"start"))),A&&(T.push("s.created_at_epoch <= ?"),I.push(re(A,"end")))}T.push(r.jsonArrayLikeClause(["s.files_read","s.files_edited"],E.length)),I.push(...E,...E);let K=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${T.join(" AND ")}
      ORDER BY s.created_at_epoch ${i==="date_asc"?"ASC":"DESC"}
      ${d}
    `;a||I.push(n,o);let g=this.db.prepare(K),v=a?Rt(g,I,f=>this.hasDirectChildFileSession(f,e),{limit:n,offset:o}):g.all(...I);return{observations:R,sessions:v}}findByType(e,t={}){let s=[],{limit:n=50,offset:o=0,orderBy:i="date_desc",...a}=t,_={...a,type:e},d=this.buildFilterClause(_,s,"o"),E=this.buildOrderClause(i,!1),c=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${d}
      ${E}
      LIMIT ? OFFSET ?
    `;return s.push(n,o),this.db.prepare(c).all(...s)}searchUserPrompts(e,t={}){let s=[],{limit:n=20,offset:o=0,orderBy:i="relevance",...a}=t,_=[],d=B(a);if(d.length>0){let p=$("s",d,{includeMerged:!1});_.push(p.sql),s.push(...p.params)}if(a.platformSource&&(_.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),s.push(h(a.platformSource))),a.dateRange){let{start:p,end:N}=a.dateRange;p&&(_.push("up.created_at_epoch >= ?"),s.push(re(p,"start"))),N&&(_.push("up.created_at_epoch <= ?"),s.push(re(N,"end")))}if(!e){if(_.length===0)return[];let p=`WHERE ${_.join(" AND ")}`,R=`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        ${p}
        ${i==="date_asc"?"ORDER BY up.created_at_epoch ASC, up.id ASC":"ORDER BY up.created_at_epoch DESC, up.id DESC"}
        LIMIT ? OFFSET ?
      `;return s.push(n,o),this.db.prepare(R).all(...s)}let E=e.replace(/[\\%_]/g,"\\$&");_.push("up.prompt_text LIKE ? ESCAPE '\\'"),s.push(`%${E}%`);let c=`WHERE ${_.join(" AND ")}`,u=`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ${c}
      ${i==="date_asc"?"ORDER BY up.created_at_epoch ASC, up.id ASC":"ORDER BY up.created_at_epoch DESC, up.id DESC"}
      LIMIT ? OFFSET ?
    `;return s.push(n,o),this.db.prepare(u).all(...s)}close(){this.db.close()}};var cn=`(SELECT id, rev,
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
      END AS candidate FROM sync_outbox))`,To=`(SELECT * FROM ${cn} ORDER BY id LIMIT 1)`;var Je=r=>`CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.${r}') END`,So={kind:"o.kind",localId:"o.origin_local_id",rev:"o.entity_rev",deleted:"o.deleted",project:Je("project"),memory:Je("memory_session_id"),content:Je("content_session_id"),merged:Je("merged_into_project")};function ln(r){r.run(`CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
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
    created_at_epoch INTEGER NOT NULL)`)}var Tn=5*6e4,un=`
  CREATE TABLE IF NOT EXISTS sync_entity_heads (
    entity_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_device_id TEXT NOT NULL,
    origin_local_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL,
    operation_sha256 TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    updated_at_epoch INTEGER NOT NULL
  )`,pn=`
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
  )`,mn=`
  CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt', 'work_state')),
    origin_local_id TEXT NOT NULL,
    through_rev TEXT NOT NULL,
    PRIMARY KEY (kind, origin_local_id)
  )`,L=r=>typeof r=="object"&&r!==null?JSON.stringify(r):r??null;function Sn(r){let e=[],t=[],s=new Set,n=new Set;for(let o of r){for(let i of o.files_read??[])!i||s.has(i)||(s.add(i),e.push(i));for(let i of o.files_modified??[])!i||n.has(i)||(n.add(i),t.push(i))}return{files_read:e,files_edited:t}}var go=200,Ao=1e3,Ro=56,fo=57;function Lt(r){let e=Number(r);return Number.isSafeInteger(e)&&e>0?e:void 0}var Ct=class{db;syncOpsEnabled;statementCache=new Map;localSyncDeviceId="";constructor(e=Me,t={}){this.syncOpsEnabled=t.syncOpsEnabled??!0,e instanceof It.Database?this.db=e:(e!==":memory:"&&ye(D),this.db=new It.Database(e)),he(this.db,ce),Ke(this.db),rn(this.db,ce),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable(),this.ensureTelegramWrapupsTable(),this.addDedupTables(),this.refreshUnicodeTitleNormKeys(),this.ensureReinforcementColumns(),this.ensureSessionCwdColumn(),this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(),this.ensureProjectNocaseIndexes(),this.ensureAdvisorCallsTable(),this.ensureSessionProjectKeySourceColumn(),this.requeuePromptsDeadLetteredForSize(),this.ensureWorkStateTable(),this.ensureDeliverablesTable(),this.ensureHookSpoolConsumedTable(),this.ensureProjectRecencyIndexes(),this.ensureMergedIntoProjectCoveringIndexes(),this.ensureNativePromptIdentity(),this.ensureObservationFileIndex(),an(this.db)}ensureObservationFileIndex(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 68").get())return;this.db.run(`CREATE TABLE IF NOT EXISTS observation_files (
        path TEXT NOT NULL,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        PRIMARY KEY (path, observation_id)
      )`),this.db.run("CREATE INDEX IF NOT EXISTS idx_observation_files_observation ON observation_files(observation_id)");let e=t=>`SELECT o.id, je.value FROM observations o, json_each(o.${t}) je
         WHERE json_valid(o.${t}) AND json_type(o.${t}) = 'array' AND je.type = 'text'`;this.db.run(`INSERT OR IGNORE INTO observation_files(observation_id, path)
        ${e("files_read")} UNION ${e("files_modified")}`),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(68,new Date().toISOString())}).immediate()}indexObservationFiles(e,t,s){let n=new Set;for(let i of[...t,...s])typeof i=="string"&&i.length>0&&n.add(i);if(n.size===0)return;let o=this.db.prepare("INSERT OR IGNORE INTO observation_files(path, observation_id) VALUES (?, ?)");for(let i of n)o.run(i,e)}ensureNativePromptIdentity(){this.db.transaction(()=>{let e=this.db.query("PRAGMA table_info(user_prompts)").all();for(let t of["native_prompt_id","native_prompt_hash"])e.some(s=>s.name===t)||this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${t} TEXT`);this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_native_identity
        ON user_prompts(session_db_id, native_prompt_id) WHERE native_prompt_id IS NOT NULL`)}).immediate()}refreshUnicodeTitleNormKeys(){this.db.transaction(()=>{if(this.db.query("SELECT version FROM schema_versions WHERE version = 65").get())return;let e=this.db.prepare(`SELECT o.id, o.project, o.title, o.agent_id, o.agent_type,
        s.platform_source FROM observations o LEFT JOIN sdk_sessions s
        ON s.memory_session_id = o.memory_session_id ORDER BY o.id`),t=this.db.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?");try{for(let s of be(e)){let n=s;t.run(je(n.project,n.platform_source,n.title,Ne(n.agent_id,n.agent_type)),n.id)}this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(65,new Date().toISOString())}finally{e.finalize(),t.finalize()}}).immediate()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let o=this.getIndexColumns(n.name);return o.length===t.length&&o.every((i,a)=>i===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let n=s?h(s):void 0;return n?this.db.prepare(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(Ro,new Date().toISOString())}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),l.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){l.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!t&&s&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),this.db.run(`
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
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&n&&!i)return;let a=n?`COALESCE(up.session_db_id, (
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw l.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(i,a)=>this.db.query(`PRAGMA table_info(${i})`).all().find(_=>_.name===a),s=i=>i?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(i=>s(t(i.table,i.column))))return;this.db.transaction(()=>{for(let i of e){let a=this.db.query(`PRAGMA table_info(${i.table})`).all(),_=a.find(E=>E.name===i.column);if(!_)throw new Error(`schema v46: missing ${i.table}.${i.column}`);for(let E of be(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${i.column}) AS storage_type,
                 CAST(${i.column} AS TEXT) AS revision
          FROM ${i.table}
        `))){let c=E;if(c.storage_type==="real")throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} is REAL and unrecoverably rounded`);if(c.storage_type!=="integer"&&c.storage_type!=="text")throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} has unsupported ${c.storage_type} storage`);try{Re(c.revision,{positive:!0})}catch{throw new Error(`schema v46: ${i.table}.${i.column} row ${c.row_id} is not a positive canonical uint64 revision`)}}if(s(_))continue;if(a.some(E=>E.name===i.temporary))throw new Error(`schema v46: unexpected temporary column ${i.table}.${i.temporary}`);this.db.run(`ALTER TABLE ${i.table} ADD COLUMN ${i.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${i.table} SET ${i.temporary} = CAST(${i.column} AS TEXT)`);let d=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${i.table}
          WHERE ${i.temporary} <> CAST(${i.column} AS TEXT)
          LIMIT 1
        `).get();if(d)throw new Error(`schema v46: failed to copy ${i.table}.${i.column} row ${d.row_id} exactly`);this.db.run(`ALTER TABLE ${i.table} DROP COLUMN ${i.column}`),this.db.run(`ALTER TABLE ${i.table} RENAME COLUMN ${i.temporary} TO ${i.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){ln(this.db),this.db.run(un),this.widenSyncKindCheck("sync_entity_heads",un),this.db.run(pn),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(t=>t.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `)),this.widenSyncKindCheck("sync_content_outbox",pn),this.db.run("CREATE INDEX IF NOT EXISTS idx_sync_content_outbox_kind_pending ON sync_content_outbox(kind, deleted DESC, id)"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}widenSyncKindCheck(e,t){let s=this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(e);if(!s||s.sql.includes("'work_state'"))return;let n=this.db.query(`PRAGMA table_info(${e})`).all().map(i=>i.name).join(", "),o=`${e}_pre_work_state`;this.db.transaction(()=>{this.db.run(`DROP TABLE IF EXISTS ${o}`),this.db.run(`ALTER TABLE ${e} RENAME TO ${o}`),this.db.run(t),this.db.run(`INSERT INTO ${e} (${n}) SELECT ${n} FROM ${o}`),this.db.run(`DROP TABLE ${o}`)}).immediate(),l.info("DB",`Rebuilt ${e} to admit the work_state sync kind`)}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],t=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!==void 0;this.db.run(mn),this.widenSyncKindCheck("sync_launch_exclusions",mn);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:E,kind:c}of e)this.db.prepare(`
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
        `).run(_,o);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}normalizeConceptTags(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49))return;let t=0;this.db.transaction(()=>{let n=this.db.prepare(`
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
      `);for(let o of n){if(o.origin_device_id!==null)continue;let i=We(o.sync_rev);this.db.prepare(`
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
    `),l.warn("DB",`Created ${t} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(s=>s.table==="sdk_sessions"&&s.from==="memory_session_id"&&s.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,t,s){let n=this.db.query(`PRAGMA table_info(${e})`).all(),o=n.filter(i=>!s.includes(i.name));for(let i of o){let a=i.type?` ${i.type}`:"",_=i.dflt_value===null||i.dflt_value===void 0?"":` DEFAULT ${i.dflt_value}`;this.db.run(`ALTER TABLE ${t} ADD COLUMN "${i.name}"${a}${_}`),l.debug("DB",`Carried ${i.name} over the ${e} rebuild (#3849)`)}return n.map(i=>i.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}l.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let s=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],o=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!s.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.recreateFtsTriggersIfIndexed("observations"),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),l.debug("DB","Successfully made observations.text nullable")}recreateFtsTriggersIfIndexed(e){let t=`${e}_fts`;this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(t).length>0&&(this.db.run(`INSERT INTO ${t}(${t}) VALUES('rebuild')`),this.db.run(e==="observations"?Le:Ie))}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}l.debug("DB","Creating user_prompts table"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),l.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;l.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),_=a.some(E=>E.name===o);return a.some(E=>E.name===i)?!1:_?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),l.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(l.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?l.debug("DB",`Successfully renamed ${t} session ID columns`):l.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),l.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),t=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!t){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}l.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let s=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],n=`
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
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(n,s,o)),t&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(a,i,_)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),l.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(d){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),d instanceof Error?d:new Error(String(d))}}recreateObservationsWithCascade(e,t,s){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("observations","observations_new",t).map(i=>`"${i}"`).join(", ");this.db.run(`INSERT INTO observations_new (${o}) SELECT ${o} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.recreateFtsTriggersIfIndexed("observations")}recreateSessionSummariesWithCascade(e,t,s){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",t).map(i=>`"${i}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${o}) SELECT ${o} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.recreateFtsTriggersIfIndexed("session_summaries")}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),l.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),l.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),l.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${S}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),s=e.some(n=>n.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),t=e.some(n=>n.name==="observed_model"),s=e.some(n=>n.name==="observed_billing");t&&s||(t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){es(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString())}ensureDeliverablesTable(){as(this.db)}recordDeliverable(e){return _s(this.db,e)}getDeliverable(e){return ds(this.db,e)}ensureWorkStateTable(){ws(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(66,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(67,new Date().toISOString())}ensureProjectRecencyIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63,new Date().toISOString())}ensureMergedIntoProjectCoveringIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_project ON observations(merged_into_project COLLATE NOCASE, project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_project ON session_summaries(merged_into_project COLLATE NOCASE, project)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(64,new Date().toISOString())}ensureHookSpoolConsumedTable(){this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())}ensureReinforcementColumns(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(t=>t.name==="reinforcement_dates")||this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT"),e.some(t=>t.name==="last_reinforced")||this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(fo,new Date().toISOString())}dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(){let e=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map(s=>s.name),t=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();if(e.length>0||t.length>0){this.db.run("BEGIN TRANSACTION");try{e.includes("observations_au")&&(this.db.run("DROP TRIGGER observations_au"),this.db.run(Le)),e.includes("session_summaries_au")&&(this.db.run("DROP TRIGGER session_summaries_au"),this.db.run(Ie)),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_fts"),this.db.run("COMMIT")}catch(s){throw this.db.run("ROLLBACK"),l.error("DB","Failed to scope FTS update triggers / drop user_prompts_fts, rolled back",{},s instanceof Error?s:new Error(String(s))),s}l.info("DB","Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts",{rescopedTriggers:e,droppedUserPromptsFts:t.length>0})}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}requeuePromptsDeadLetteredForSize(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60))return;let t="canonical content: body exceeds % UTF-8 bytes";this.db.transaction(()=>{let s=this.db.prepare(`
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
    `).run(e.sessionDbId,e.contentSessionId,e.project,e.platformSource,e.toolUseId,e.advisorModel??null,e.cwd??null,e.lastUserMessage??null,e.transcriptPath??null,e.transcriptByteOffset??null,e.advice,e.occurredAtEpoch,t.toISOString(),t.getTime());return s.changes>0?{id:Number(s.lastInsertRowid),inserted:!0}:{id:this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(e.toolUseId)?.id??0,inserted:!1}}getAdvisorCalls(e,t,s,n){let o="SELECT * FROM advisor_calls",i=[],a=[];s?(a.push("project = ?"),i.push(s)):(a.push("project != ?"),i.push(ae)),n&&(a.push("platform_source = ?"),i.push(n)),o+=` WHERE ${a.join(" AND ")}`,o+=" ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?",i.push(t+1,e);let _=this.db.prepare(o).all(...i);return{items:_.slice(0,t),hasMore:_.length>t,offset:e,limit:t}}getAdvisorCallById(e){return this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(e)??null}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="agent_type"),n=t.some(i=>i.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(_=>_.name==="agent_type"),a=o.some(_=>_.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw l.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="memory_session_id"),n=t.some(o=>o.name==="content_hash");if(!s||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw l.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
      `).run(t,e)})(),t&&this.requeuePromptSync(e))}enqueueMutationOp(e,t){if(!this.syncOpsEnabled)return;let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let n=s.target;n?.origin_device_id===null&&(n.origin_device_id="self")}pt(s),t.op==="set_prompt_session"&&this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(t.target?.origin_device_id??null,String(t.target?.origin_local_id??"")),this.cachedStatement(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,ze.randomUUID)(),String(e),JSON.stringify(t),Date.now())}requeuePromptSync(e){if(!this.syncOpsEnabled)return;let t=this.cachedStatement(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let n=this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length===0)return;let o=this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);for(let i of n){let a=We(i.sync_rev);o.run(a,i.id),this.enqueueMutationOp(a,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:i.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
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
      `).run(s,e),n.memory_session_id??t}getProjectReadKeys(e){return Wt(this.db,e)}getAllProjects(e){let t=e?h(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[ae];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",n.push(S,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...n).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${S}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${S}'), project
      ORDER BY latest_epoch DESC
    `).all(ae),t=[],s=new Set,n={};for(let i of e){let a=h(i.platform_source);n[a]||(n[a]=[]),n[a].includes(i.project)||n[a].push(i.project),s.has(i.project)||(s.add(i.project),t.push(i.project))}let o=zt(Object.keys(n));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,n[i]||[]]))}}getSessionCatalog(e={}){let t=Math.min(Math.max(Math.trunc(e.limit??go),1),Ao),s=Math.max(Math.trunc(e.offset??0),0),n=`
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
    `,o=[ae];e.project&&(n+=" AND s.project COLLATE NOCASE = ?",o.push(e.project)),e.platformSource&&(n+=` AND COALESCE(s.platform_source, '${S}') = ?`,o.push(h(e.platformSource))),n+=" ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?",o.push(t+1,s);let i=this.db.prepare(n).all(...o);return{sessions:i.slice(0,t),hasMore:i.length>t}}getUserPromptById(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ?
    `).get(e)}findRecentDuplicateUserPrompt(e,t,s,n){return zs(this.db,e,se(t),s,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let n=[e],o="";return s&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`,n.push(h(s))),n.push(t),this.db.prepare(`
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
    `).all(...n)}getObservationsForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?
        )
      `,s.push(h(t))),this.db.prepare(`
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
    `).get(e,h(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return ts(this.db,e)}linkToolUsesToObservation(e){return ss(this.db,e)}getToolUsesByIds(e,t={}){return rs(this.db,e,t)}queryToolUses(e={}){return os(this.db,e)}appendWorkStateEntry(e){let t=ks(this.db,e);return Z({projects:[e.project]},"appendWorkStateEntry","additive",{kinds:["work_state"],workStateLists:[e.listName]}),t}setLocalSyncDeviceId(e){this.localSyncDeviceId=e}getLocalSyncDeviceId(){return this.localSyncDeviceId}getWorkStateEntries(e,t){return Us(Fs(this.db,this.getProjectReadKeys(e),t,this.localSyncDeviceId),e)}countToolUses(e={}){return is(this.db,e)}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n,type:o,concepts:i,files:a}=t,_=Lt(t.limit),d=B(t),E=s==="relevance",c=s==="date_asc"?"ASC":"DESC",m=E?"":`ORDER BY o.created_at_epoch ${c}, o.id ${c}`,u=_&&!E?"LIMIT ?":"",p=e.map(()=>"?").join(","),N=[...e],R=[];if(d.length>0){let g=$("o",d,{includeMerged:!0});R.push(g.sql),N.push(...g.params)}if(n&&(R.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),N.push(h(n))),o)if(Array.isArray(o)){let g=o.map(()=>"?").join(",");R.push(`o.type IN (${g})`),N.push(...o)}else R.push("o.type = ?"),N.push(o);if(i){let g=Array.isArray(i)?i:[i],v=`CASE WHEN json_valid(o.concepts) THEN CASE
        WHEN json_type(o.concepts) = 'array' THEN o.concepts
        WHEN json_type(o.concepts) = 'text' THEN json_array(json_extract(o.concepts, '$'))
        ELSE json_array(o.concepts) END ELSE json_array(o.concepts) END`,f=g.map(()=>`EXISTS (SELECT 1 FROM json_each(${v}) WHERE type = 'text' AND value = ?)`);f.length>0&&(N.push(...g),R.push(`(${f.join(" OR ")})`))}if(a){let g=Array.isArray(a)?a:[a],v=A=>`CASE WHEN json_valid(${A}) THEN CASE WHEN json_type(${A}) = 'array' THEN ${A} ELSE '[]' END ELSE '[]' END`,f=g.map(()=>`(EXISTS (SELECT 1 FROM json_each(${v("o.files_read")}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(${v("o.files_modified")}) WHERE type = 'text' AND value LIKE ? ESCAPE '\\'))`);f.length>0&&(g.forEach(A=>{let F=A.replace(/[\\%_]/g,"\\$&");N.push(`%${F}%`,`%${F}%`)}),R.push(`(${f.join(" OR ")})`))}let I=R.length>0?`WHERE o.id IN (${p}) AND ${R.join(" AND ")}`:`WHERE o.id IN (${p})`;u&&N.push(_);let T=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${I}
      ${m}
      ${u}
    `).all(...N);if(!E)return T;let M=new Map(T.map(g=>[g.id,g])),K=e.map(g=>M.get(g)).filter(g=>!!g);return _?K.slice(0,_):K}getSummaryForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${S}') = ?
        )
      `,s.push(h(t))),this.db.prepare(`
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
    `).get(S,h(t),e)?.id??null}claimTelegramWrapup({platformSource:e,contentSessionId:t,project:s,routeKey:n,summaryCreatedAtEpoch:o}){let i=Date.now();return this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(h(e),t,s,n,o,i).changes===1?!0:this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(o,i,h(e),t,s,n,i-Tn).changes===1}markTelegramWrapupSent({platformSource:e,contentSessionId:t,project:s,routeKey:n}){this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(Date.now(),h(e),t,s,n)}releaseTelegramWrapupClaim({platformSource:e,contentSessionId:t,project:s,routeKey:n}){this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(h(e),t,s,n)}setSessionObservedMetadata(e,t,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(t||null,s||null,e)}getSdkSessionsBySessionIds(e,t=[]){if(e.length===0&&t.length===0)return[];let s=[...new Set(e),...new Set(t)],n=new Map;for(let o=0;o<s.length;o+=500){let i=s.slice(o,o+500),a=i.filter(c=>typeof c=="string"),_=i.filter(c=>typeof c=="number"),d=[];a.length&&d.push(`memory_session_id IN (${a.map(()=>"?").join(",")})`),_.length&&d.push(`id IN (SELECT session_db_id FROM user_prompts WHERE id IN (${_.map(()=>"?").join(",")}))`);let E=this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project,
               COALESCE(platform_source, '${S}') as platform_source,
               user_prompt, custom_title,
               started_at, started_at_epoch, completed_at, completed_at_epoch, status
        FROM sdk_sessions
        WHERE ${d.join(" OR ")}
        ORDER BY started_at_epoch DESC
      `);for(let c of E.all(...i))n.set(c.id,c)}return[...n.values()].sort((o,i)=>i.started_at_epoch-o.started_at_epoch)}getPromptNumberFromUserPrompts(e,t,s){let n=this.resolvePromptSessionDbId(e,t),o=n!==null?"session_db_id = ?":"content_session_id = ?",i=n!==null?n:e;return s!==void 0?this.db.prepare(`
        SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${o} AND created_at_epoch <= ?
      `).get(i,s).count:this.db.prepare(`
      SELECT COALESCE(MAX(prompt_number), 0) as count FROM user_prompts WHERE ${o}
    `).get(i).count}getLatestPromptTextFromUserPrompts(e,t){let s=this.resolvePromptSessionDbId(e,t),n=s!==null?"session_db_id = ?":"content_session_id = ?",o=s!==null?s:e;return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${n}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(o)?.prompt_text??null}createSDKSession(e,t,s,n,o){let i=new Date,a=i.getTime(),_=o?h(o):S,d=se(s);n&&this.validateSetTitleMutation(e,_,n);let E=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(S,_,e);if(E){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '' OR (project = 'unknown' AND cwd IS NULL))
        `).run(t,E.id),d&&d!==gt&&this.db.prepare(`
          UPDATE sdk_sessions SET user_prompt = ?
          WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
        `).run(d,E.id,gt),n){let m=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(E.id);m&&m.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,E.id),this.enqueueSetTitleOp(e,_,n))}return E.id}let c=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,_,d,n||null,i.toISOString(),a);return n&&this.enqueueSetTitleOp(e,_,n),Number(c.lastInsertRowid)}setSessionCwd(e,t,s){t.trim()&&this.db.prepare("UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL").run(t,s??null,e)}getSessionCwd(e){return this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(e)?.cwd??null}enqueueSetTitleOp(e,t,s){let n=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,t,s){let n={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return pt(n),n}promptCommitted(e,t){if(this.db.inTransaction)return;let s=t===null?null:this.db.prepare("SELECT project FROM sdk_sessions WHERE id = ?").get(t);Z(s?{projects:[s.project]}:"all",e,"additive",{kinds:["prompt"]})}saveUserPrompt(e,t,s,n,o,i,a){let _=new Date(a??Date.now()),d=_.getTime(),E=se(s),c=this.resolvePromptSessionDbId(e,n),u=this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id, native_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c,e,t,E,_.toISOString(),d,o??null,i??null);return this.promptCommitted("saveUserPrompt",c),u.lastInsertRowid}saveNativeUserPrompt(e,t,s,n,o=n,i={}){if(!s||s.length>256||/[\s\x00-\x1f\x7f]/.test(s))throw new Error("Invalid native prompt identity");let a=se(n),_=(0,ze.createHash)("sha256").update(Ge(o).trim()).digest("hex"),d=this.db.transaction(()=>{let E=this.db.prepare(`SELECT id, prompt_number, native_prompt_hash FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id = ?`).get(t,s);if(E){if(E.native_prompt_hash!==_)throw new Error("Native prompt identity was reused with different text");return{id:E.id,promptNumber:E.prompt_number,duplicate:!0}}let c=this.getPromptNumberFromUserPrompts(e,t)+1;return i.reopenSession!==!1&&this.reopenCompletedSession(t),{id:this.saveUserPrompt(e,c,a,t,s,_,i.createdAtEpoch),promptNumber:c,duplicate:!1}}).immediate();return d.duplicate||this.promptCommitted("saveNativeUserPrompt",t),d}importTranscriptUserPrompt(e){let t=se(e.promptText);if(!t)return{reason:"private"};let s=h(e.platformSource),o=this.db.prepare(`SELECT id FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ? AND content_session_id = ?`).get(S,s,e.contentSessionId)?.id;if(o!==void 0){let a=[t,...(e.hookTextVariants??[]).map(se).filter(Boolean)],d=this.db.prepare(`SELECT id, created_at_epoch FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id IS NULL
          AND prompt_text IN (${a.map(()=>"?").join(", ")})
          AND ABS(created_at_epoch - ?) <= ?
        ORDER BY ABS(created_at_epoch - ?), id`).all(o,...a,e.createdAtEpoch,e.hookMatchWindowMs,e.createdAtEpoch).find(E=>!e.claimedHookRowIds.has(E.id));if(d)return e.claimedHookRowIds.add(d.id),{reason:"recorded-by-hook",hookRowId:d.id}}else{let a=new Date(e.createdAtEpoch).toISOString(),_=this.db.prepare(`INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch, status)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'completed')`).run(e.contentSessionId,e.project,s,t,a,e.createdAtEpoch,a,e.createdAtEpoch);o=Number(_.lastInsertRowid)}return{reason:this.saveNativeUserPrompt(e.contentSessionId,o,`transcript:${e.nativePromptId}`,e.promptText,e.promptText,{createdAtEpoch:e.createdAtEpoch,reopenSession:!1}).duplicate?"already-imported":"new"}}listHookRecordedPrompts(e){return this.db.prepare(`SELECT up.id, COALESCE(NULLIF(s.platform_source, ''), ?) AS platformSource,
        s.content_session_id AS contentSessionId, s.project, s.cwd, up.prompt_text AS promptText, up.created_at_epoch AS createdAtEpoch
      FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
      WHERE up.created_at_epoch >= ? AND s.project != ?
        AND (up.native_prompt_id IS NULL OR up.native_prompt_id NOT LIKE 'transcript:%')
      ORDER BY up.created_at_epoch, up.id`).all(S,e,ae)}streamObservationTokenFields(){return be(this.db.prepare("SELECT title, subtitle, narrative, facts, discovery_tokens FROM observations ORDER BY id"))}getUserPrompt(e,t,s){let n=this.resolvePromptSessionDbId(e,s);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}dedupConfig(){let e=_e.loadFromFile(De),t=(n,o)=>{let i=Number(e[n]);return Number.isFinite(i)?i:o},s=(n,o)=>Math.trunc(t(n,o));return{enabled:e.CLAUDE_MEM_DEDUP_ENABLED==="true",cosineThreshold:t("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD",.8),idfVetoDf:s("CLAUDE_MEM_DEDUP_IDF_VETO_DF",10),minSharedTokens:s("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS",2),maxScan:s("CLAUDE_MEM_DEDUP_MAX_SCAN",2e3),maxBackfillRows:s("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS",5e4),minProjectDocs:s("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS",10)}}listDedupCandidates(e,t=100,s){let n="SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ",o="(? IS NULL OR c.status = ?) ",i="ORDER BY c.score DESC, c.id DESC LIMIT ?",a=s??null;return e?this.db.prepare(`${n}WHERE c.project = ? AND ${o}${i}`).all(e,a,a,t):this.db.prepare(`${n}WHERE ${o}${i}`).all(a,a,t)}resolveDedupCandidate(e,t){return this.db.prepare("UPDATE observation_dedup_candidates SET status = ? WHERE id = ?").run(t,e).changes>0}isDedupEnabled(){return this.dedupConfig().enabled}runDedupScan(){return qs(this.db,this.dedupConfig())}maintainDedupOnInsert(e,t,s,n){Ws(this.db,e,s),Ys(this.db,e,n.minProjectDocs)&&Js(this.db,e,t,s,n)}storeObservation(e,t,s,n,o=0,i,a,_={}){if(!it(s.title))throw new Error("storeObservation requires a non-empty title");let d=this.storeObservations(e,t,[s],null,n,o,i,a,_);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch,mergedIntoExisting:d.mergedIntoExisting[0]??!1}}storeSummary(e,t,s,n,o=0,i){let a=i??Date.now(),_=new Date(a).toISOString(),E=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,JSON.stringify(s.files_read??[]),JSON.stringify(s.files_edited??[]),s.notes,n||null,o,_,a);return Z({projects:[t]},"storeSummary"),{id:Number(E.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,o,i=0,a,_,d={}){let E=a??Date.now(),c=new Date(E).toISOString(),m=Jt(E),u=new Date(E),p=this.dedupConfig(),N=h(this.db.prepare("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(e)?.platform_source),I=this.db.transaction(()=>{let O=[],T=[],M=[],K=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),g=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let A of s){if(!it(A.title)){l.debug("DB","Skipping observation with empty title");continue}let F=Gt(e,A.title,A.narrative),V=je(t,N,A.title,Ne(A.agent_id,A.agent_type));if(p.enabled){let Y=g.get(e,F);if(Y){Ue(this.db,Y.id,u),O.push(Y.id),T.push(!1);continue}let Q=d.skipTitleDedup?null:Xs(this.db,t,V);if(Q){this.db.prepare("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(Q.id),Ue(this.db,Q.id,u),O.push(Q.id),T.push(!0);continue}}let y=K.get(e,t,A.type,A.title,A.subtitle,JSON.stringify(A.facts),A.narrative,JSON.stringify(A.concepts),JSON.stringify(A.files_read),JSON.stringify(A.files_modified),o||null,i,A.agent_type??null,A.agent_id??null,F,c,E,_||null,A.metadata??null,V,m.dates,m.lastReinforced);if(y){p.enabled&&this.maintainDedupOnInsert(t,y.id,A.title,p),this.indexObservationFiles(y.id,A.files_read,A.files_modified),O.push(y.id),T.push(!1),M.push(y.id);continue}let z=g.get(e,F);if(!z)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${F}`);Ue(this.db,z.id,u),O.push(z.id),T.push(!1)}let v=null,f=!1;if(n){let A=Sn(s),F=n.files_read??A.files_read,V=n.files_edited??A.files_edited,y=o?this.db.prepare(`SELECT id, request, investigated, learned, completed, next_steps,
                      files_read, files_edited, notes, discovery_tokens, sync_rev
               FROM session_summaries
               WHERE memory_session_id = ? AND prompt_number = ? AND origin_device_id IS NULL
               ORDER BY id DESC LIMIT 1`).get(e,o):void 0;if(y){let z=n.request&&n.request.trim()?n.request:y.request??"",Y=n.investigated&&n.investigated.trim()?n.investigated:y.investigated??"",Q=n.learned&&n.learned.trim()?n.learned:y.learned??"",Dt=n.completed&&n.completed.trim()?n.completed:y.completed??"",Mt=n.next_steps??"",yt=n.notes&&n.notes.trim()?n.notes:y.notes,vt=[...new Set([...at(y.files_read),...F])],Ut=[...new Set([...at(y.files_edited),...V])],gn=Math.max(y.discovery_tokens??0,i),An=We(y.sync_rev||"0");this.db.prepare(`
            UPDATE session_summaries SET
              request = ?, investigated = ?, learned = ?, completed = ?, next_steps = ?,
              files_read = ?, files_edited = ?, notes = ?, discovery_tokens = ?,
              created_at = ?, created_at_epoch = ?,
              sync_rev = ?, synced_at = NULL
            WHERE id = ?
          `).run(z,Y,Q,Dt,Mt,JSON.stringify(vt),JSON.stringify(Ut),yt,gn,c,E,An,y.id),n.request=z,n.investigated=Y,n.learned=Q,n.completed=Dt,n.next_steps=Mt,n.notes=yt,n.files_read=vt,n.files_edited=Ut,v=y.id,f=!0}else{let Y=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,JSON.stringify(F),JSON.stringify(V),n.notes,o||null,i,c,E);v=Number(Y.lastInsertRowid)}}return{observationIds:O,mergedIntoExisting:T,insertedObservationIds:M,summaryId:v,createdAtEpoch:E,summaryUpdated:f}})();return Z({projects:[t]},"storeObservations"),I}updateDiscoveryTokens(e,t,s){e.length===0&&t===null||this.db.transaction(()=>{let n=this.db.prepare("UPDATE observations SET discovery_tokens = ? WHERE id = ?");for(let o of e)n.run(s,o);t!==null&&this.db.prepare("UPDATE session_summaries SET discovery_tokens = MAX(COALESCE(discovery_tokens, 0), ?) WHERE id = ?").run(s,t)})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n}=t,o=Lt(t.limit),i=B(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",d=a?"":`ORDER BY ss.created_at_epoch ${_}, ss.id ${_}`,E=o&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),m=[...e],u=[];if(i.length>0){let T=$("ss",i,{includeMerged:!0});u.push(T.sql),m.push(...T.params)}n&&(u.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),m.push(h(n)));let p=u.length>0?`AND ${u.join(" AND ")}`:"";E&&m.push(o);let R=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${p}
      ${d}
      ${E}
    `).all(...m);if(!a)return R;let I=new Map(R.map(T=>[T.id,T])),O=e.map(T=>I.get(T)).filter(T=>!!T);return o?O.slice(0,o):O}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n}=t,o=Lt(t.limit),i=B(t),a=s==="relevance",_=s==="date_asc"?"ASC":"DESC",d=a?"":`ORDER BY up.created_at_epoch ${_}, up.id ${_}`,E=o&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),m=[...e],u=[];if(i.length>0){let T=$("s",i,{includeMerged:!1});u.push(T.sql),m.push(...T.params)}n&&(u.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),m.push(h(n)));let p=u.length>0?`AND ${u.join(" AND ")}`:"";E&&m.push(o);let R=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${p}
      ${d}
      ${E}
    `).all(...m);if(!a)return R;let I=new Map(R.map(T=>[T.id,T])),O=e.map(T=>I.get(T)).filter(T=>!!T);return o?O.slice(0,o):O}getSearchScopeRowIds(e,t,s){let n=B(t),o=t.platformSource?h(t.platformSource):void 0,i=[e.observations&&{alias:"o",includeMerged:!0,from:"SELECT o.id FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id"},e.sessions&&{alias:"ss",includeMerged:!0,from:"SELECT ss.id FROM session_summaries ss LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id"},e.prompts&&{alias:"s",includeMerged:!1,from:"SELECT up.id FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id"}].filter(_=>!!_),a=new Set;for(let _ of i){let d=[],E=[];if(n.length>0){let p=$(_.alias,n,{includeMerged:_.includeMerged});d.push(p.sql),E.push(...p.params)}o&&(d.push(`COALESCE(NULLIF(s.platform_source, ''), '${S}') = ?`),E.push(o));let c=d.length>0?`WHERE ${d.join(" AND ")}`:"",m=this.db.prepare(`${_.from} ${c} LIMIT ?`),u;try{u=m.all(...E,s+1)}finally{m.finalize()}for(let p of u)a.add(p.id);if(a.size>s)return null}return[...a]}getTimelineAroundTimestamp(e,t=10,s=10,n,o,i){return this.getTimelineAroundObservation(null,e,t,s,n,o,i)}getTimelineAroundObservation(e,t,s=10,n=10,o,i,a){let _=i?h(i):void 0,d=B({project:o,projects:a}),E=(g,v,f=!1)=>{let A=[],F=[];if(d.length>0){let V=$(g,d,{includeMerged:f});A.push(V.sql),F.push(...V.params)}return _&&(A.push(`COALESCE(NULLIF(${v}.platform_source, ''), '${S}') = ?`),F.push(_)),{clause:A.length>0?`AND ${A.join(" AND ")}`:"",params:F}},c=E("o","src",!0),m=E("ss","src",!0),u=E("s","s"),p,N;if(e!==null){let g=`
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
      `;try{let f=this.db.prepare(g).all(t,e,...c.params,s+1),A=this.db.prepare(v).all(t,e,...c.params,n+1);if(f.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};p=f.length>0?f[f.length-1].created_at_epoch:t,N=A.length>0?A[A.length-1].created_at_epoch:t}catch(f){return f instanceof Error?l.error("DB","Error getting boundary observations",{project:o},f):l.error("DB","Error getting boundary observations with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}else{let g=`
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
      `;try{let f=this.db.prepare(g).all(t,...c.params,s),A=this.db.prepare(v).all(t,...c.params,n);p=f.length>0?f[f.length-1].created_at_epoch:t,N=A.length>0?A[A.length-1].created_at_epoch:t}catch(f){return f instanceof Error?l.error("DB","Error getting boundary timestamps",{project:o},f):l.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}let R=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${c.clause}
      ORDER BY o.created_at_epoch ASC, o.id ASC
    `,I=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${m.clause}
      ORDER BY ss.created_at_epoch ASC, ss.id ASC
    `,O=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${u.clause}
      ORDER BY up.created_at_epoch ASC, up.id ASC
    `,T=this.db.prepare(R).all(p,N,...c.params),M=this.db.prepare(I).all(p,N,...m.params),K=this.db.prepare(O).all(p,N,...u.params);return{observations:T,sessions:M.map(g=>({id:g.id,memory_session_id:g.memory_session_id,project:g.project,request:g.request,completed:g.completed,next_steps:g.next_steps,created_at:g.created_at,created_at_epoch:g.created_at_epoch})),prompts:K.map(g=>({id:g.id,content_session_id:g.content_session_id,prompt_number:g.prompt_number,prompt_text:g.prompt_text,project:g.project,platform_source:g.platform_source,created_at:g.created_at,created_at_epoch:g.created_at_epoch}))}}getOrCreateManualSession(e,t=S){let s=h(t),n=`manual-${e}-${s}`,o=`manual-content-${e}-${s}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(n))return n;let a=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(n,o,e,s,a.toISOString(),a.getTime()),l.info("SESSION","Created manual session",{memorySessionId:n,project:e,platformSource:s}),n}close(){this.db.close()}cachedStatement(e){let t=this.statementCache.get(e);return t||(t=this.db.prepare(e),this.statementCache.set(e,t)),t}importSdkSession(e){let t=h(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);if(s)return{imported:!1,id:s.id};let n=e.custom_title??null;if(n!==null&&typeof n!="string")throw new TypeError("Imported custom_title must be a string or null");let o=this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);return this.db.transaction(()=>({imported:!0,id:o.run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,n,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}))()}importSessionSummary(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return l.warn("DB","Skipping imported session summary without memory_session_id",{project:typeof e?.project=="string"?e.project:null}),{imported:!1,id:0};let t=this.db.prepare(`SELECT id FROM session_summaries WHERE memory_session_id = ?
        AND request IS ? AND investigated IS ? AND learned IS ? AND completed IS ?
        AND next_steps IS ? AND files_read IS ? AND files_edited IS ? AND notes IS ?
        AND prompt_number IS ? AND created_at_epoch = ?`).get(e.memory_session_id,L(e.request),L(e.investigated),L(e.learned),L(e.completed),L(e.next_steps),L(e.files_read),L(e.files_edited),L(e.notes),e.prompt_number??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let n=this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,L(e.request),L(e.investigated),L(e.learned),L(e.completed),L(e.next_steps),L(e.files_read),L(e.files_edited),L(e.notes),e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch);return Z({projects:[e.project]},"importSessionSummary"),{imported:!0,id:n.lastInsertRowid}}importObservation(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return l.warn("DB","Skipping imported observation without memory_session_id",{title:typeof e?.title=="string"?e.title:null,type:typeof e?.type=="string"?e.type:null}),{imported:!1,id:0};let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND text IS ? AND type = ?
        AND title IS ? AND subtitle IS ? AND facts IS ? AND narrative IS ?
        AND concepts IS ? AND files_read IS ? AND files_modified IS ?
        AND prompt_number IS ? AND agent_type IS ?
        AND agent_id IS ? AND created_at_epoch = ?
    `).get(e.memory_session_id,L(e.text),e.type,L(e.title),L(e.subtitle),L(e.facts),L(e.narrative),L(e.concepts),L(e.files_read),L(e.files_modified),e.prompt_number??null,e.agent_type??null,e.agent_id??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let s=this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),n=this.db.transaction(()=>{let i=s.run(e.memory_session_id,e.project,L(e.text),e.type,L(e.title),L(e.subtitle),L(e.facts),L(e.narrative),L(e.concepts),L(e.files_read),L(e.files_modified),e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid;return Vt(this.db,i,e.files_read,e.files_modified),i})();return Z({projects:[e.project]},"importObservation"),{imported:!0,id:n}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?h(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${S}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!s||h(a.platform_source)===s)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);if(n)return{imported:!1,id:n.id};let i=this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch, native_prompt_id, native_prompt_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,L(e.prompt_text),e.created_at,e.created_at_epoch,e.native_prompt_id??null,e.native_prompt_hash??null);return this.promptCommitted("importUserPrompt",t),{imported:!0,id:i.lastInsertRowid}}};0&&(module.exports={SessionStore,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
