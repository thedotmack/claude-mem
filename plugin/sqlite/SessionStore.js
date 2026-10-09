var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var Ce=Object.defineProperty;var rs=Object.getOwnPropertyDescriptor;var os=Object.getOwnPropertyNames;var is=Object.prototype.hasOwnProperty;var as=(r,e)=>{for(var t in e)Ce(r,t,{get:e[t],enumerable:!0})},_s=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of os(e))!is.call(r,n)&&n!==t&&Ce(r,n,{get:()=>e[n],enumerable:!(s=rs(e,n))||s.enumerable});return r};var Es=r=>_s(Ce({},"__esModule",{value:!0}),r);var dn={};as(dn,{SessionStore:()=>Je,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS:()=>ss,rollupObservationFileLists:()=>ns});module.exports=Es(dn);var ds=new Set;function $(r,e,t="additive"){for(let s of ds)s({scope:r,reason:e,kind:t})}var qe=require("bun:sqlite"),Ne=require("crypto");var h=require("path"),he=require("os"),ae=require("fs"),st=require("url");var C=require("fs"),ze=require("crypto"),F=require("path");var cs=null;function us(r){return(cs??process.stderr.write.bind(process.stderr))(r)}function W(r){us(r)}var ln=Promise.resolve();var ls=process.platform==="win32";function Le(r){return r.replace(/^\uFEFF/,"")}function Ie(r){return JSON.parse(Le(r))}function z(r){return Ie((0,C.readFileSync)(r,"utf-8"))}function ps(r){(0,C.existsSync)(r)||(0,C.mkdirSync)(r,{recursive:!0})}function P(r,e,t={}){let s=r;try{if((0,C.lstatSync)(r).isSymbolicLink())try{s=(0,C.realpathSync)(r)}catch(c){let d=c instanceof Error?c:new Error(String(c));W(`claude-mem: realpathSync failed for ${r}, resolving symlink manually: ${d.message}
`);let l=(0,C.readlinkSync)(r);s=(0,F.resolve)((0,F.dirname)(r),l)}}catch(c){let d=c.code;if(d!=="ENOENT"&&d!=="ENOTDIR")throw c}ps((0,F.dirname)(s));let n=(0,F.dirname)(s),i=(0,F.basename)(s),o=(0,F.join)(n,`.${i}.${process.pid}.${(0,ze.randomBytes)(6).toString("hex")}.tmp`),a=Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),_=t.mode;if(_===void 0)try{_=(0,C.statSync)(s).mode&511}catch{}let E;try{E=_!==void 0?(0,C.openSync)(o,"w",_):(0,C.openSync)(o,"w");let c=0;for(;c<a.length;){let d=(0,C.writeSync)(E,a,c,a.length-c);if(d===0)throw new Error(`writeSync stalled at ${c}/${a.length} bytes`);c+=d}if((0,C.fsyncSync)(E),(0,C.closeSync)(E),E=void 0,(0,C.renameSync)(o,s),!ls){let d;try{d=(0,C.openSync)(n,"r"),(0,C.fsyncSync)(d)}catch(l){let O=l instanceof Error?l:new Error(String(l));W(`claude-mem: directory fsync failed for ${n}: ${O.message}
`)}finally{if(d!==void 0)try{(0,C.closeSync)(d)}catch{}}}}catch(c){if(E!==void 0)try{(0,C.closeSync)(E)}catch{}try{(0,C.unlinkSync)(o)}catch{}throw c}}var ms=r=>r!==null&&typeof r=="object"&&!Array.isArray(r);function Qe(r){let e=r.env;return ms(e)&&Object.keys(e).some(t=>t.startsWith("CLAUDE_MEM_"))?"nested":"flat"}function K(r){return Qe(r)==="nested"?r.env:r}function Ze(r){return Qe(r)!=="nested"?r:Object.fromEntries(Object.entries(r).filter(([e])=>!e.startsWith("CLAUDE_MEM_")))}var et=require("os"),tt=require("path");function ie(r,e=process.platform,t=(0,et.homedir)()){return typeof r!="string"||r.length===0?r:r==="~"?t:r.startsWith("~/")||e==="win32"&&r.startsWith("~\\")?(0,tt.join)(t,r.slice(2)):r}function Ts(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,h.dirname)((0,st.fileURLToPath)(__IMPORT_META_URL__))}var Cn=Ts();function Ss(){if(process.env.CLAUDE_MEM_DATA_DIR)return ie(process.env.CLAUDE_MEM_DATA_DIR);let r=(0,h.join)((0,he.homedir)(),".claude-mem"),e=(0,h.join)(r,"settings.json");try{if((0,ae.existsSync)(e)){let t=z(e);if(t===null||typeof t!="object"||Array.isArray(t))return r;let s=K(t);if(typeof s.CLAUDE_MEM_DATA_DIR=="string"&&s.CLAUDE_MEM_DATA_DIR)return ie(s.CLAUDE_MEM_DATA_DIR)}}catch{}return r}var M=Ss(),As=(0,h.join)((0,he.homedir)(),".claude"),Os=process.env.CLAUDE_CONFIG_DIR||As,Ln=(0,h.join)(Os,"plugins","marketplaces","thedotmack"),gs=(0,h.join)(M,"logs"),_e=(0,h.join)(M,"settings.json"),nt="claude-mem.db";var Ee=(0,h.join)(M,nt),Rs=(0,h.join)(M,"observer-sessions"),Q=(0,h.basename)(Rs);function de(r){(0,ae.mkdirSync)(r,{recursive:!0})}var De={dataDir:()=>M,workerPid:()=>(0,h.join)(M,"worker.pid"),serverPid:()=>(0,h.join)(M,".server-beta.pid"),serverPort:()=>(0,h.join)(M,".server-beta.port"),serverRuntime:()=>(0,h.join)(M,".server-beta.runtime.json"),settings:()=>(0,h.join)(M,"settings.json"),database:()=>(0,h.join)(M,nt),chroma:()=>(0,h.join)(M,"chroma"),combinedCerts:()=>(0,h.join)(M,"combined_certs.pem"),transcriptsConfig:()=>(0,h.join)(M,"transcript-watch.json"),transcriptsState:()=>(0,h.join)(M,"transcript-watch-state.json"),corpora:()=>(0,h.join)(M,"corpora"),supervisorRegistry:()=>(0,h.join)(M,"supervisor.json"),envFile:()=>(0,h.join)(M,".env"),logsDir:()=>gs};var X=require("fs"),rt=require("path");var Ue=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(Ue||{}),Me=null,ye=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;logFileDate=null;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){let e=new Date().toISOString().split("T")[0];if(!(this.logFileInitialized&&this.logFileDate===e)){this.logFileInitialized=!0,this.logFileDate=e;try{let t=De.logsDir();(0,X.existsSync)(t)||(0,X.mkdirSync)(t,{recursive:!0}),this.logFilePath=(0,rt.join)(t,`claude-mem-${e}.log`)}catch(t){console.error("[LOGGER] Failed to initialize log file:",t instanceof Error?t.message:String(t)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=De.settings();if((0,X.existsSync)(e)){let s=(K(z(e)).CLAUDE_MEM_LOG_LEVEL||"INFO").toString().toUpperCase();this.level=Ue[s]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}safeStringify(e,t,s=6){let n=new WeakSet,i=(o,a)=>{if(typeof o=="bigint")return`${o}n`;if(o===null||typeof o!="object")return o;let _=o.toJSON,E=typeof _=="function"?_.call(o):o;if(typeof E=="bigint")return`${E}n`;if(E===null||typeof E!="object")return E;if(n.has(E))return"[Circular]";if(a>=s)return Array.isArray(E)?"[Array]":"[Object]";n.add(E);try{if(Array.isArray(E))return E.map(d=>i(d,a+1));let c={};for(let d of Object.keys(E))try{c[d]=i(E[d],a+1)}catch{c[d]="[unreadable]"}return c}finally{n.delete(E)}};try{return JSON.stringify(i(e,0),null,t)??String(e)}catch{return Array.isArray(e)?`[${e.length} items]`:"[unserializable]"}}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?this.safeStringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${i}:${o}:${a}.${_}`}log(e,t,s,n,i){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),a=Ue[e].padEnd(5),_=t.padEnd(6),E="";n?.correlationId?E=`[${n.correlationId}] `:n?.sessionId&&(E=`[session-${n.sessionId}] `);let c="";i!=null&&(i instanceof Error?c=this.getLevel()===0?`
${i.message}
${i.stack}`:` ${i.message}`:this.getLevel()===0&&typeof i=="object"?c=`
`+this.safeStringify(i,2):c=" "+this.formatData(i));let d="";if(n){let{sessionId:O,memorySessionId:L,correlationId:I,...R}=n;Object.keys(R).length>0&&(d=` {${Object.entries(R).map(([m,N])=>typeof N!="object"||N===null||N instanceof Error||N instanceof Date?`${m}=${N}`:`${m}=${Array.isArray(N)?this.safeStringify(N):this.formatData(N)}`).join(", ")}}`)}let l=`[${o}] [${a}] [${_}] ${E}${s}${d}${c}`;if(this.logFilePath)try{(0,X.appendFileSync)(this.logFilePath,l+`
`,"utf8")}catch(O){let L=O instanceof Error?O:new Error(String(O));W(`[LOGGER] Failed to write to log file: ${L.message}
${L.stack??""}
`)}else W(l+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}setErrorSink(e){Me=e}error(e,t,s,n){this.log(3,e,t,s,n),this.routeErrorToSink(t,s,n)}routeErrorToSink(e,t,s){try{if(!Me||!(s instanceof Error))return;Me(s)}catch{}}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}},u=new ye;function w(r){let e=r.projects?.length?r.projects:r.project?[r.project]:[];return[...new Set(e.map(t=>t.trim()).filter(Boolean))]}function x(r,e,t){let s=e.map(()=>"?").join(",");return t.includeMerged?{sql:`(${r}.project COLLATE NOCASE IN (${s}) OR ${r}.merged_into_project COLLATE NOCASE IN (${s}))`,params:[...e,...e]}:{sql:`${r}.project COLLATE NOCASE IN (${s})`,params:[...e]}}function ot(r,e){let t=w({projects:e});if(t.length===0)return[];let s=t.map(()=>"?").join(","),n=[`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${s})`,`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${s})`,`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${s})`,`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${s})`,`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${s})`,`SELECT project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${s})`,`SELECT project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${s})`],i=r.prepare(n.join(" UNION ")).all(...n.flatMap(()=>t));return[...new Set([...t,...i.map(o=>o.key)])]}var it=require("crypto");function ve(r){return typeof r=="string"&&r.trim()!==""}function at(r,e,t){return(0,it.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function _t(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>typeof t=="string"&&t.length>0):[]}catch{return[]}}function Fe(r=new Date){return r.toISOString().slice(0,10)}function Et(r,e=new Date,t=10){let s=Fe(e);if(r.includes(s))return r;let n=[...r,s];return n.length>t?n.slice(n.length-t):n}function dt(r){let e=Fe(new Date(r));return{dates:JSON.stringify([e]),lastReinforced:e}}function ce(r,e,t=new Date){let s=r.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(e);if(!s)return!1;let n=_t(s.reinforcement_dates),i=Et(n,t);return i===n?!1:(r.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(JSON.stringify(i),i[i.length-1],e),!0)}var lt=require("crypto");var p="claude";function fs(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function b(r){if(!r)return p;let e=fs(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e.includes("kimi")?"kimi":e==="pi-mono"?"pi":e==="agy"||e==="antigravity"||e.startsWith("antigravity-")?"antigravity-cli":e:p}function ct(r){let e=["claude","codex","antigravity-cli","cursor","kimi"];return[...r].sort((t,s)=>{let n=e.indexOf(t),i=e.indexOf(s);return n!==-1||i!==-1?n===-1?1:i===-1?-1:n-i:t.localeCompare(s)})}var Ns=new Set(["mem_search","search","timeline","get_observations","get_summaries","get_tool_uses","session_start_context","observation_search","observation_context","memory_search","memory_context"]);function bs(r){if(!r.startsWith("mcp__"))return null;let e=r.split("__");if(e.length<3)return null;let t=e[1].toLowerCase();return!t.includes("claude-mem")&&!t.includes("claude_mem")&&!t.includes("mcp-search")&&!t.includes("mcp_search")&&!t.includes("cmem")?null:e.slice(2).join("__")}function we(r){if(!r)return!1;if(r.startsWith("memory_")||r==="mem_search"||r==="get_summaries")return!0;let e=bs(r);return e!==null&&Ns.has(e)}var Cs=64*1024;function ut(r,e=Cs){let t=Buffer.byteLength(r,"utf8");if(t<=e)return r;let s=Buffer.from(r,"utf8"),n=e;for(;n>0&&(s[n]&192)===128;)n--;return`${s.subarray(0,n).toString("utf8")}\u2026[truncated: ${t} bytes]`}function Ls(r,e,t){return(0,lt.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function pt(r){r.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${p}',
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
  `),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project_nocase_created ON tool_uses(project COLLATE NOCASE, created_at_epoch DESC, id DESC)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function mt(r,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||we(e.toolName))return null;let t=e.createdAtEpoch??Date.now(),s=new Date(t).toISOString(),n=Ls(e.toolName,e.toolInput,e.toolResponse),i=e.toolInput!=null?ut(e.toolInput):null,o=e.toolResponse!=null?ut(e.toolResponse):null,a=r.prepare(`
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
  `).get(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",b(e.platformSource),e.toolName,i,o,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,n,s,t);return a?a.id:null}function Tt(r,e){let t=e.toolUseIds.filter(i=>typeof i=="string"&&i.length>0);if(t.length===0)return 0;let s=t.map(()=>"?").join(","),n=r.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = CASE WHEN observation_id IS NULL
          THEN COALESCE(?, memory_session_id)
          ELSE COALESCE(memory_session_id, ?)
        END
    WHERE content_session_id = ?
      AND tool_use_id IN (${s})
      AND (observation_id IS NULL OR observation_id = ?)
  `).run(e.observationId,e.memorySessionId??null,e.memorySessionId??null,e.contentSessionId,...t,e.observationId);return Number(n.changes??0)}function St(r){return r?{clause:`COALESCE(NULLIF(platform_source, ''), '${p}') = ?`,param:b(r)}:null}function At(r,e,t={}){let s=[],n=[];for(let c of e){if(typeof c=="number"&&Number.isInteger(c)){s.push(c);continue}if(typeof c=="string"&&c.trim().length>0){let d=Number(c);Number.isInteger(d)&&String(d)===c.trim()&&s.push(d),n.push(c.trim())}}if(s.length===0&&n.length===0)return[];let i=[],o=[];s.length>0&&(i.push(`id IN (${s.map(()=>"?").join(",")})`),o.push(...s)),n.length>0&&(i.push(`tool_use_id IN (${n.map(()=>"?").join(",")})`),o.push(...n));let a=[`(${i.join(" OR ")})`];t.project&&(a.push("project COLLATE NOCASE = ?"),o.push(t.project)),t.contentSessionId&&(a.push("content_session_id = ?"),o.push(t.contentSessionId));let _=St(t.platformSource);_&&(a.push(_.clause),o.push(_.param));let E=t.limit&&t.limit>0?`LIMIT ${Math.floor(t.limit)}`:"";return r.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    ${E}
  `).all(...o)}function Ot(r,e={}){let t=[],s=[];if(e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.memorySessionId&&(t.push("memory_session_id = ?"),s.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(t.push("session_db_id = ?"),s.push(e.sessionDbId)),e.toolName){let E=Array.isArray(e.toolName)?e.toolName:[e.toolName];E.length>0&&(t.push(`tool_name IN (${E.map(()=>"?").join(",")})`),s.push(...E))}e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId));let n=St(e.platformSource);n&&(t.push(n.clause),s.push(n.param)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let i=t.length>0?`WHERE ${t.join(" AND ")}`:"",o=e.orderBy==="date_asc"?"ASC":"DESC",a=Math.min(Math.max(Math.floor(e.limit??50),1),500),_=Math.max(Math.floor(e.offset??0),0);return r.prepare(`
    SELECT * FROM tool_uses
    ${i}
    ORDER BY created_at_epoch ${o}, id ${o}
    LIMIT ${a} OFFSET ${_}
  `).all(...s)}function gt(r,e={}){let t=[],s=[];e.project&&(t.push("project COLLATE NOCASE = ?"),s.push(e.project)),e.contentSessionId&&(t.push("content_session_id = ?"),s.push(e.contentSessionId)),e.agentId&&(t.push("agent_id = ?"),s.push(e.agentId)),typeof e.dateStart=="number"&&(t.push("created_at_epoch >= ?"),s.push(e.dateStart)),typeof e.dateEnd=="number"&&(t.push("created_at_epoch <= ?"),s.push(e.dateEnd));let n=t.length>0?`WHERE ${t.join(" AND ")}`:"";return r.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${n}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...s)}function Rt(r){r.run(`
    CREATE TABLE IF NOT EXISTS work_state_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      list_name TEXT NOT NULL,
      fields TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `),r.run("CREATE INDEX IF NOT EXISTS idx_work_state_entries_project ON work_state_entries(project COLLATE NOCASE, list_name, id)")}function ft(r,e){let t=e.createdAtEpoch??Date.now(),s=r.prepare(`
    INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?)
  `).run(e.project,e.listName,JSON.stringify(e.fields),new Date(t).toISOString(),t),n=Number(s.lastInsertRowid);return u.debug("DB","Work state entry appended",{id:n,project:e.project,listName:e.listName}),n}function Nt(r,e,t){if(e.length===0)return[];let s=e.map(()=>"?").join(", "),n=t===void 0?"":" AND list_name = ?";return r.prepare(`
    SELECT id, project, list_name, fields, created_at_epoch
    FROM work_state_entries
    WHERE project COLLATE NOCASE IN (${s})${n}
    ORDER BY id
  `).all(...e,...t===void 0?[]:[t]).map(o=>({...o,fields:JSON.parse(o.fields)}))}var G=require("fs"),k=require("path"),Z=require("os");var ue={HEALTH_CHECK:3e3,API_REQUEST:3e4,SESSION_INIT_HOOK_CAP:15e3,SESSION_INIT_REQUEST:1e4,SESSION_INIT_REQUEST_MAX:14e3,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function Is(r=process.platform){return r==="win32"?8e3:5e3}function bt(r=process.platform){return ue.SESSION_INIT_HOOK_CAP-Is(r)}function Ct(r){return process.platform==="win32"?Math.round(r*ue.WINDOWS_MULTIPLIER):r}function Lt(r){try{return new URL(r).hostname.toLowerCase()==="openrouter.ai"}catch{return!1}}var hs="security_alert",Ds="sync-hub.black-pond-afbb.workers.dev",Ms="ziczmqtpmaxbornfghye.supabase.co",Us="https://sync.cmem.ai",ys=new Set(["xiaomi/mimo-v2-flash:free"]);function vs(r){let e=r.CLAUDE_MEM_OPENROUTER_MODEL;if(typeof e!="string"||!ys.has(e.trim()))return!1;let t=typeof r.CLAUDE_MEM_OPENROUTER_BASE_URL=="string"?r.CLAUDE_MEM_OPENROUTER_BASE_URL.trim():"";return t===""||Lt(t)}var It=18e4,ht=[{key:"CLAUDE_MEM_LLM_TIMEOUT_MS",legacy:"30000",markerTag:"llm-timeout-migrated-v1"},{key:"CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS",legacy:"30000",markerTag:"field-optimize-timeout-migrated-v1"}];function Mt(r,e){return(0,k.join)((0,k.dirname)(r),`.${(0,k.basename)(r)}.${e.markerTag}`)}function Pe(r,e){try{(0,G.writeFileSync)(Mt(r,e),new Date().toISOString(),{encoding:"utf-8",mode:384})}catch{}}var Dt=new Set;function Fs(r){if(typeof r!="string")return null;let e=r.trim();if(e.length===0)return null;try{let t=new URL(e).hostname;if(t===Ds||t===Ms)return Us}catch{return null}return null}var Y=class{static DEFAULTS={CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED:"true",CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED:"true",CLAUDE_MEM_MEMORY_WATCH_ROOTS:"",CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES:"false",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_INGEST_TOKEN:"",CLAUDE_MEM_HOOK_SPOOL_TRANSPORT:"auto",CLAUDE_MEM_ALLOWED_ORIGINS:"",CLAUDE_MEM_PUBLIC_URL:"",CLAUDE_MEM_API_TIMEOUT_MS:String(Ct(ue.API_REQUEST)),CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS:String(bt()),CLAUDE_MEM_IDLE_EXIT_SEC:"0",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_SKIP_BASH_PATTERNS:"",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_CAPTURE_ADVISOR_CALLS:"false",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CODEX_MODEL:"",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"low",CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE:"8",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS:"32000",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_API_KEYS:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-flash-latest",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_API_KEYS:"",CLAUDE_MEM_OPENROUTER_MODEL:"cohere/north-mini-code:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_PRESET:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEYS:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"",CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER:"",CLAUDE_MEM_QUOTA_FALLBACK_MODEL:"",CLAUDE_MEM_QUOTA_THRESHOLD_FIVE_HOUR:"0.95",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_OPUS:"0.93",CLAUDE_MEM_QUOTA_THRESHOLD_SEVEN_DAY_SONNET:"0.92",CLAUDE_MEM_QUOTA_THRESHOLD_OVERAGE:"0.95",CLAUDE_MEM_DATA_DIR:(0,k.join)((0,Z.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:"",CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:"",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY:"true",CLAUDE_MEM_REINFORCE_ALPHA:"0",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FILE_READ_GATE_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,k.join)((0,Z.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_CODEX_SUBAGENT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS:"400000",CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW:"",CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS:"4096",CLAUDE_MEM_OBSERVE_BARE_PROMPTS:"false",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_REDACT_ENABLED:"false",CLAUDE_MEM_REDACT_DISABLED_BUILTINS:"",CLAUDE_MEM_REDACT_CUSTOM_PATTERNS:"[]",CLAUDE_MEM_REDACT_LOG_MATCHES:"false",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_PROJECT_ENVIRONMENTS:"[]",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS:"600000",CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS:"5000",CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,Z.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE:"40",CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS:"90000",CLAUDE_MEM_LLM_TIMEOUT_MS:String(It),CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS:String(It),CLAUDE_MEM_TV_TOKEN:"",CLAUDE_MEM_PRO_TRIAL_EMAIL:"",CLAUDE_MEM_PRO_TRIAL_AT:"",CLAUDE_MEM_PRO_TRIAL_STATE:"",CLAUDE_MEM_PRO_TRIAL_ENDS_AT:"",CLAUDE_MEM_PRO_PLAN:"",CLAUDE_MEM_PRO_FALLBACK_AT:"",CLAUDE_MEM_PRO_FALLBACK_MESSAGE:"",CLAUDE_MEM_PRO_FALLBACK_ACTION:"",CLAUDE_MEM_PRO_FALLBACK_URL:"",CLAUDE_MEM_PRO_MEMORY_KEY:"",CLAUDE_MEM_PRO_MEMORY_BASE_URL:"",CLAUDE_MEM_PRO_MEMORY_MODEL:"",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED:"true",CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED:"false",CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES:"{}",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert,sensitive",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED:"true",CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS:"521e962d-2ec3-4488-bfbc-54d5209ce118,95601360-61f7-4fd9-bb3a-2c976b2b85c0",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_URL:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET:"",CLAUDE_MEM_GROK_BOT_INJECT_ENABLED:"true",CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS:"*",CLAUDE_MEM_GROK_BOT_INJECT_TIER:"episode",CLAUDE_MEM_GROK_BOT_INJECT_WINDOW:"80",CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK:"house",CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE:"",CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT:"",CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS:"160",CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS:"1500",CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE:"",CLAUDE_MEM_CCS_ALIGN_ENABLED:"true",CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS:"ccs-align",CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS:"false",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:"",CLAUDE_MEM_DEDUP_ENABLED:"false",CLAUDE_MEM_DEDUP_COSINE_THRESHOLD:"0.80",CLAUDE_MEM_DEDUP_IDF_VETO_DF:"10",CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS:"2",CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS:"10",CLAUDE_MEM_DEDUP_MAX_SCAN:"2000",CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS:"50000",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_PROJECT_NAME_SOURCE:"path"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){let t=process.env[e]??this.DEFAULTS[e];return e==="CLAUDE_MEM_WORKER_HOST"?this.normalizeWorkerHost(t):t}static normalizeWorkerHost(e){return e==="localhost"?"127.0.0.1":e}static finalizeSettings(e,t){let s=t?this.applyEnvOverrides(e):e;return s.CLAUDE_MEM_WORKER_HOST=this.normalizeWorkerHost(s.CLAUDE_MEM_WORKER_HOST),s}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0){try{if(!(0,G.existsSync)(e)){let d=this.getAllDefaults();try{P(e,d,{mode:384});for(let l of ht)Pe(e,l);console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(l){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,l instanceof Error?l.message:String(l))}return this.finalizeSettings(d,t)}let s=(0,G.readFileSync)(e,"utf-8"),n=Ie(s),i=K(n),o=i!==n,a=Ze(n),_=o&&Object.keys(a).some(d=>d!=="env");if(o&&!_)try{P(e,i,{mode:384}),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(d){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,d instanceof Error?d.message:String(d))}if(i.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES===hs){i={...i,CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES};try{P(e,_?{...a,env:i}:i,{mode:384}),console.warn("[SETTINGS] Migrated Telegram trigger types off the legacy default:",e)}catch(d){console.warn("[SETTINGS] Failed to migrate Telegram trigger types:",e,d instanceof Error?d.message:String(d))}}if(vs(i)){let d=String(i.CLAUDE_MEM_OPENROUTER_MODEL).trim();i={...i,CLAUDE_MEM_OPENROUTER_MODEL:this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL};try{P(e,_?{...a,env:i}:i,{mode:384}),console.warn(`[SETTINGS] Migrated OpenRouter model off the retired default ${d} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,e)}catch(l){console.warn("[SETTINGS] Failed to migrate the retired OpenRouter model:",e,l instanceof Error?l.message:String(l))}}let E=Fs(i.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);if(E!==null){i={...i,CLAUDE_MEM_CLOUD_SYNC_HUB_URL:E};try{P(e,_?{...a,env:i}:i,{mode:384}),console.warn("[SETTINGS] Migrated cloud sync hub URL to",E,"from a retired hub host:",e)}catch(d){console.warn("[SETTINGS] Failed to migrate cloud sync hub URL:",e,d instanceof Error?d.message:String(d))}}for(let d of ht)if(!(0,G.existsSync)(Mt(e,d))){if(i[d.key]!==d.legacy){Pe(e,d);continue}i={...i,[d.key]:this.DEFAULTS[d.key]};try{P(e,_?{...a,env:i}:i,{mode:384}),Pe(e,d),console.warn(`[SETTINGS] Migrated ${d.key} off the old ${d.legacy}ms default to ${this.DEFAULTS[d.key]}ms:`,e)}catch(l){let O=`${d.key}\0${e}`;Dt.has(O)||(Dt.add(O),console.warn(`[SETTINGS] Failed to migrate ${d.key}; using the new default in memory (reported once per process):`,e,l instanceof Error?l.message:String(l)))}}let c={...this.DEFAULTS};for(let d of Object.keys(this.DEFAULTS))i[d]!==void 0&&(c[d]=i[d]);return this.finalizeSettings(c,t)}catch(s){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,s instanceof Error?s.message:String(s));let n=this.getAllDefaults();return this.finalizeSettings(n,t)}}};var wt=require("crypto");function ee(r){return(r??"").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim()}function H(r){return(r??"").toLowerCase().trim().split(/\s+/).filter(Boolean)}function le(r,e){return Math.log(1+e/(r+.5))}function Ut(r,e){return t=>le(r(t),e)}function yt(r,e){let t=new Map;for(let s of new Set(r))t.set(s,e(s));return t}function vt(r,e,t){let s=yt(r,t),n=yt(e,t),i=0,o=0,a=0;for(let[_,E]of s){o+=E*E;let c=n.get(_);c!==void 0&&(i+=E*c)}for(let[,_]of n)a+=_*_;return o===0||a===0?0:i/Math.sqrt(o*a)}function Ft(r,e,t,s){let n=new Set(r),i=new Set(e);for(let o of n)if(!i.has(o)&&t(o)>s)return!0;for(let o of i)if(!n.has(o)&&t(o)>s)return!0;return!1}function xe(r,e,t,s){let n=ee(r);if(n!==""&&n===ee(e))return{tier:"exact",method:"exact",score:1};let i=H(r),o=H(e),a=s.minSharedTokens??2,_=new Set(o),E=0;for(let d of new Set(i))_.has(d)&&E++;if(E<a)return{tier:"none",method:"none",score:0};let c=vt(i,o,t);return c>=s.cosineThreshold&&!Ft(i,o,t,s.vetoThetaIdf)?{tier:"candidate",method:"idf_cosine",score:c}:{tier:"none",method:"none",score:c}}function pe(r,e){return!!r&&!!e}function ke(r,e,t,s=!1){let n=ee(t);if(n==="")return null;let i=b(e),o=s?"subagent":"main";return(0,wt.createHash)("sha256").update(`${r}\0${i}\0${o}\0${n}`).digest("hex").slice(0,32)}function Pt(r,e,t){return t===null?null:r.prepare("SELECT id, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC LIMIT 1").get(e,t)??null}function xt(r,e,t){let s=[...new Set(H(t))],n=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1");for(let i of s)n.run(e,i);r.prepare("INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1").run(e)}function kt(r,e){return r.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(e)?.doc_count??0}function Bt(r,e){let t=kt(r,e),s=r.prepare("SELECT token, df FROM token_df WHERE project = ?").all(e),n=new Map(s.map(i=>[i.token,i.df]));return{idfFn:Ut(i=>n.get(i)??0,t),docCount:t}}function Xt(r){return r.prepare("INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")}function Gt(r,e,t){return kt(r,e)>=t}function ws(r,e,t=Number.POSITIVE_INFINITY){let s=r.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(e).c;if(s>t)return u.warn("DEDUP",`Skipping dedup backfill for project ${e}: ${s} rows exceeds cap ${t} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`),0;let n=r.prepare("SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?").all(e),i=r.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?"),o=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)");return r.transaction(()=>{let _=new Map;for(let E of n){i.run(ke(e,E.platform_source,E.title,pe(E.agent_id,E.agent_type)),E.id);for(let c of new Set(H(E.title)))_.set(c,(_.get(c)??0)+1)}r.prepare("DELETE FROM token_df WHERE project = ?").run(e);for(let[E,c]of _)o.run(e,E,c);r.prepare("INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0").run(e,n.length,n.length)})(),n.length}function Ps(r,e,t){let s=r.prepare("SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC").all(e);if(s.length<2)return 0;if(s.length>t.maxBackfillRows)return u.warn("DEDUP",`Skipping dedup sweep for project ${e}: ${s.length} rows exceeds cap ${t.maxBackfillRows}`),0;let{idfFn:n,docCount:i}=Bt(r,e),o={cosineThreshold:t.cosineThreshold,vetoThetaIdf:le(t.idfVetoDf,i),minSharedTokens:t.minSharedTokens},a=s.map(R=>new Set(H(R.title))),_=new Map;for(let R of a)for(let g of R)_.set(g,(_.get(g)??0)+1);let E=Math.max(2,Math.ceil(Math.sqrt(s.length))*4),c=new Map;a.forEach((R,g)=>{for(let m of R){let N=_.get(m);if(N<2||N>E)continue;let A=c.get(m);A||(A=[],c.set(m,A)),A.push(g)}});let d=new Map;for(let R of c.values())for(let g=0;g<R.length;g++)for(let m=g+1;m<R.length;m++){let N=`${R[g]}:${R[m]}`;d.set(N,(d.get(N)??0)+1)}let l=Xt(r),O=new Date().toISOString(),L=Date.now(),I=0;for(let[R,g]of d){if(g<t.minSharedTokens)continue;let[m,N]=R.split(":").map(Number),A=xe(s[m].title,s[N].title,n,o);A.tier==="candidate"&&(I+=l.run(s[N].id,s[m].id,e,A.method,A.score,"pending",O,L).changes)}return I}function Ht(r,e){return r.prepare("SELECT DISTINCT project FROM observations").all().map(s=>s.project).map(s=>{let n=ws(r,s,e.maxBackfillRows),i=Ps(r,s,e);return{project:s,docs:n,candidates:i}})}function jt(r,e,t,s,n){if(!s)return 0;let{idfFn:i,docCount:o}=Bt(r,e),a={cosineThreshold:n.cosineThreshold,vetoThetaIdf:le(n.idfVetoDf,o),minSharedTokens:n.minSharedTokens},_=r.prepare("SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?").all(e,t,n.maxScan);_.length===n.maxScan&&u.debug("DEDUP",`Tier-1 scan hit MAX_SCAN=${n.maxScan} for project ${e}; older rows covered by dedup-scan`);let E=Xt(r),c=new Date().toISOString(),d=Date.now(),l=0;for(let O of _){let L=xe(s,O.title,i,a);L.tier==="candidate"&&(l+=E.run(t,O.id,e,L.method,L.score,"pending",c,d).changes)}return l}function $t(r,e,t,s,n){let i=Date.now()-s,o=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return r.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${p}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${o}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,t,i)??void 0}var me=require("fs");var xs=[{name:"aws_access_key",regex:/AKIA[0-9A-Z]{16}/g},{name:"aws_secret_key",regex:/(?<=AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g},{name:"github_pat",regex:/\bgh[oprs]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g},{name:"openai_key",regex:/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g},{name:"anthropic_key",regex:/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g},{name:"slack_token",regex:/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g},{name:"jwt",regex:/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g},{name:"private_key_pem",regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g},{name:"stripe_key",regex:/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g},{name:"google_api_key",regex:/\bAIza[0-9A-Za-z_-]{35}\b/g},{name:"claude_mem_key",regex:/\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g}],ks=1024*1024,Bs="<redacted type='oversize'/>";function Yt(r,e){if(!e.enabled||r.length===0)return{redacted:r,counts:{},oversize:!1};if(r.length>ks)return u.warn("REDACT","field exceeds the 1M-char redaction cap; replaced by an oversize marker",void 0,{inputLength:r.length}),{redacted:Bs,counts:{oversize:1},oversize:!0};let t=new Set(e.disabledBuiltinPatterns??[]),s={},n=r,i=[];for(let a of e.customPatterns??[]){if(!a.name||a.name.length===0){u.warn("REDACT","custom pattern skipped: missing name",void 0,{pattern:a});continue}try{i.push({name:a.name,regex:new RegExp(a.regex,"g")})}catch(_){u.warn("REDACT","custom pattern skipped: invalid regex",{name:a.name},_ instanceof Error?_:new Error(String(_)))}}let o=[...i,...xs];for(let a of o)t.has(a.name)||(a.regex.lastIndex=0,n=n.replace(a.regex,()=>(s[a.name]=(s[a.name]??0)+1,`<redacted type='${a.name}'/>`)));return e.logMatches&&Object.keys(s).length>0&&u.debug("REDACT","patterns matched",void 0,{counts:s}),{redacted:n,counts:s,oversize:!1}}function Xs(r){if(!r||r.trim()==="")return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(t=>t&&typeof t.name=="string"&&typeof t.regex=="string"):(u.warn("REDACT","CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring"),[])}catch(e){return u.warn("REDACT","failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",void 0,e instanceof Error?e:new Error(String(e))),[]}}function Gs(r){return{enabled:r.CLAUDE_MEM_REDACT_ENABLED==="true",disabledBuiltinPatterns:(r.CLAUDE_MEM_REDACT_DISABLED_BUILTINS??"").split(",").map(e=>e.trim()).filter(Boolean),customPatterns:Xs(r.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS??"[]"),logMatches:r.CLAUDE_MEM_REDACT_LOG_MATCHES==="true"}}var te=null,Wt=0,Hs=5e3,se=null,Kt=!1,js={enabled:!0,disabledBuiltinPatterns:[],customPatterns:[],logMatches:!1},$s=/"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;function Ws(r){if(!(0,me.existsSync)(r))return null;try{return(0,me.readFileSync)(r,"utf-8")}catch{return""}}function Ks(r){if(r===null)return!1;try{let e=JSON.parse(Le(r));return e===null||typeof e!="object"||Array.isArray(e)}catch{return!0}}function Ys(r,e,t){return process.env.CLAUDE_MEM_REDACT_ENABLED==="false"||!(se?.enabled===!0||$s.test(e))?t:(Kt||(Kt=!0,u.warn("REDACT","settings.json could not be read; secret redaction stays on until it is repaired",{settingsPath:r,using:se?.enabled?"the last configuration that loaded":"the built-in patterns"})),se?.enabled?se:js)}function Vt(r=_e){let e=Date.now();if(te&&e-Wt<Hs)return te;let t=Y.loadFromFile(r),s=Gs(t),n=s.enabled?null:Ws(r);return Ks(n)?te=Ys(r,n,s):(te=s,se=s),Wt=e,te}var zt=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],qt=new RegExp(`<(${zt.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g");var Jt=100;function Vs(r){let e=Object.fromEntries(zt.map(i=>[i,0]));qt.lastIndex=0;let t=0,s=r.replace(qt,(i,o)=>(e[o]=(e[o]??0)+1,t+=1,""));return t>Jt&&u.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:t,maxAllowed:Jt,contentLength:r.length}),{stripped:Yt(s.trim(),Vt()).redacted,counts:e}}function Te(r){return Vs(r).stripped}var qs=["task-notification"],hr=new RegExp(`^\\s*<(${qs.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Dr=256*1024;var Be=4e3,Xe="[media prompt]";function ne(r){let e=r.trim(),s=Te(r).trim()||e;return s.length<=Be?s:(u.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:s.length,storedLength:Be}),`${s.slice(0,Be-1)}\u2026`)}var Js=require("bun:sqlite");var zs=5e3,Qs=4194304;function Zs(r){return r.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function V(r,e,t){try{r.run(e)}catch(s){let n=s instanceof Error?s:new Error(String(s));throw u.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},n),s}}function Se(r,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;V(r,`PRAGMA busy_timeout = ${zs}`,"busy_timeout"),V(r,"PRAGMA foreign_keys = ON","foreign_keys"),V(r,"PRAGMA synchronous = NORMAL","synchronous"),V(r,`PRAGMA journal_size_limit = ${Qs}`,"journal_size_limit"),s&&!Zs(r)&&V(r,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&V(r,"PRAGMA journal_mode = WAL","journal_mode")}var Qt=!1;function Ge(r,...e){return typeof r.iterate=="function"?r.iterate(...e):(Qt||(Qt=!0,u.warn("DB","bun:sqlite lacks Statement.iterate(); falling back to .all()",{bunVersion:typeof Bun<"u"?Bun.version:"unknown",requiredBunVersion:">=1.1.31",impact:"rows are materialized in memory; upgrade Bun to restore streaming"})),r.all(...e))}function He(r,e,t,s){try{let n=Number(s.limit);if(!Number.isInteger(n)||n<0)throw new Error("Page limit must be a non-negative integer");let i=Number(s.offset??0);if(!Number.isInteger(i))throw new Error("Page offset must be an integer");let o=[];if(n===0)return o;let a=Math.max(0,i);for(let _ of Ge(r,...e))if(t(_)){if(a>0){a--;continue}if(o.push(_),o.length===n)break}return o}finally{r.finalize()}}var We=require("bun:sqlite");function Ae(r){return r.replace(/\\/g,"/").replace(/\/+/g,"/").replace(/\/+$/,"")}function je(r,e){let t=Ae(r),s=Ae(e);if(t.startsWith(s+"/"))return!t.slice(s.length+1).includes("/");let n=s.split("/"),i=t.split("/");if(i.length<2)return s===""||s===".";let o=i.slice(0,-1).join("/"),a=i[i.length-1];if(s.endsWith("/"+o)||s===o)return!a.includes("/");for(let _=0;_<n.length;_++)if(n.slice(_).join("/")===o)return!0;return!1}var en=/^\d{4}-\d{2}-\d{2}$/;function j(r,e){if(typeof r=="number")return r;let t=new Date(r).getTime();return e==="end"&&en.test(r.trim())?t+864e5-1:t}var $e="\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF",Oe=`
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
`,ge=`
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
`,Zt=class r{db;constructor(e=Ee){e instanceof We.Database?this.db=e:(de(M),this.db=new We.Database(e)),Se(this.db),this._fts5Available=this.isFts5Available(),this.ensureFTSTables()}_fts5Available;ensureFTSTables(){let e=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),t=e.some(n=>n.name==="observations_fts"),s=e.some(n=>n.name==="session_summaries_fts");if(!(t&&s)){if(!this.isFts5Available()){u.warn("DB","FTS5 not available on this platform \u2014 skipping FTS table creation (search uses ChromaDB)");return}u.info("DB","Creating FTS5 tables");try{this.db.transaction(()=>{let n=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),i=!n.some(a=>a.name==="observations_fts"),o=!n.some(a=>a.name==="session_summaries_fts");this.createFTSTablesAndTriggers(i,o)}).immediate(),u.info("DB","FTS5 tables created successfully")}catch(n){this._fts5Available=!1,u.warn("DB","FTS5 table creation failed \u2014 search will use ChromaDB and LIKE queries",{},n instanceof Error?n:void 0)}}}isFts5Available(){try{return this.db.run("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(test_column)"),this.db.run("DROP TABLE temp._fts5_probe"),!0}catch(e){return u.debug("DB","FTS5 probe failed \u2014 FTS5 unavailable on this platform",void 0,e instanceof Error?e:new Error(String(e))),!1}}canReadFtsIndex(e){try{return this.db.prepare(`SELECT rowid FROM ${e} WHERE ${e} MATCH ? LIMIT 0`).all('"fts_read_probe"'),!0}catch{return!1}}createFTSTablesAndTriggers(e,t){e&&(this.db.run(`
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
      `),this.db.run(Oe)),t&&(this.db.run(`
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
      `),this.db.run(ge))}buildFilterClause(e,t,s="o"){let n=[],i=w(e);if(i.length>0){let o=x(s,i,{includeMerged:!0});n.push(o.sql),t.push(...o.params)}if(e.platformSource&&(n.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = ${s}.memory_session_id), ''), '${p}') = ?`),t.push(b(e.platformSource))),e.type)if(Array.isArray(e.type)){let o=e.type.map(()=>"?").join(",");n.push(`${s}.type IN (${o})`),t.push(...e.type)}else n.push(`${s}.type = ?`),t.push(e.type);if(e.dateRange){let{start:o,end:a}=e.dateRange;o&&(n.push(`${s}.created_at_epoch >= ?`),t.push(j(o,"start"))),a&&(n.push(`${s}.created_at_epoch <= ?`),t.push(j(a,"end")))}if(e.concepts){let o=Array.isArray(e.concepts)?e.concepts:[e.concepts],a=o.map(()=>`EXISTS (SELECT 1 FROM json_each(${s}.concepts) WHERE value = ?)`);a.length>0&&(n.push(`(${a.join(" OR ")})`),t.push(...o))}if(e.files){let o=Array.isArray(e.files)?e.files:[e.files],a=o.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${s}.files_read) WHERE value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(${s}.files_modified) WHERE value LIKE ? ESCAPE '\\')
        )`);a.length>0&&(n.push(`(${a.join(" OR ")})`),o.forEach(_=>{let E=_.replace(/[\\%_]/g,"\\$&");t.push(`%${E}%`,`%${E}%`)}))}return n.length>0?n.join(" AND "):""}static UNSEGMENTED_SCRIPT=new RegExp(`[${$e}]`);static UNSEGMENTED_RUN=new RegExp(`[${$e}]+|[^\\s${$e}]+`,"g");static MAX_SUBSTRING_TERMS=500;static buildSubstringClause(e,t){let s=[...new Set(e.match(r.UNSEGMENTED_RUN)??[])].slice(0,r.MAX_SUBSTRING_TERMS);s.length===0&&s.push(e);let n=[];return{clause:`(${s.map(o=>{let a=`%${o.replace(/[\\%_]/g,"\\$&")}%`;for(let _=0;_<t.length;_+=1)n.push(a);return`(${t.map(_=>`${_} LIKE ? ESCAPE '\\'`).join(" OR ")})`}).join(" AND ")})`,params:n}}static buildFTSMatchQuery(e){let t=(e.match(/\S+/g)??[]).filter(s=>/[\p{L}\p{N}]/u.test(s));return t.length===0?`"${e.replace(/"/g,'""')}"`:t.map(s=>`"${s.replace(/"/g,'""')}"`).join(" AND ")}buildOrderClause(e="relevance",t=!0,s="observations_fts"){switch(e){case"relevance":return t?`ORDER BY ${s}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservationsBySubstring(e,t,s,n,i){let o=r.buildSubstringClause(e,["o.title","o.subtitle","o.narrative","o.text","o.facts","o.concepts"]),a=[],_=this.buildFilterClause(t,a,"o"),E=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${o.clause}
      ${_?"AND "+_:""}
      ${this.buildOrderClause(s,!1)}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(E).all(...o.params,...a,n,i)}searchSessionsBySubstring(e,t,s,n,i){let o=r.buildSubstringClause(e,["s.request","s.investigated","s.learned","s.completed","s.next_steps","s.notes"]),a={...t};delete a.type;let _=[],E=this.buildFilterClause(a,_,"s"),c=s==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC",d=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${o.clause}
      ${E?"AND "+E:""}
      ${c}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(d).all(...o.params,..._,n,i)}searchObservations(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="relevance",...a}=t;if(!e){let _=this.buildFilterClause(a,s,"o");if(!_)return[];let E=this.buildOrderClause(o,!1),c=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${_}
        ${E}
        LIMIT ? OFFSET ?
      `;return s.push(n,i),this.db.prepare(c).all(...s)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchObservationsBySubstring(e,a,o,n,i);if(this._fts5Available||this.canReadFtsIndex("observations_fts")){let _=this.buildFilterClause(a,s,"o"),E=this.buildOrderClause(o,!0,"observations_fts"),c=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        JOIN observations_fts ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
        ${_?"AND "+_:""}
        ${E}
        LIMIT ? OFFSET ?
      `;s.unshift(r.buildFTSMatchQuery(e));let d;try{d=this.db.prepare(c).all(...s,n,i)}catch(l){throw u.warn("DB","FTS5 observation search failed",{},l instanceof Error?l:void 0),l}return d.length>0||i>0&&this.db.prepare(c).all(...s,1,0).length>0?d:this.searchObservationsBySubstring(e,a,o,n,i)}return this.searchObservationsBySubstring(e,a,o,n,i)}searchSessions(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="relevance",...a}=t;if(!e){let _={...a};delete _.type;let E=this.buildFilterClause(_,s,"s");if(!E)return[];let d=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${E}
        ${o==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC"}
        LIMIT ? OFFSET ?
      `;return s.push(n,i),this.db.prepare(d).all(...s)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchSessionsBySubstring(e,a,o,n,i);if(this._fts5Available||this.canReadFtsIndex("session_summaries_fts")){let _={...a};delete _.type;let E=this.buildFilterClause(_,s,"s"),c=o==="date_asc"?"ORDER BY s.created_at_epoch ASC":o==="date_desc"?"ORDER BY s.created_at_epoch DESC":"ORDER BY session_summaries_fts.rank ASC",d=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id
        WHERE session_summaries_fts MATCH ?
        ${E?"AND "+E:""}
        ${c}
        LIMIT ? OFFSET ?
      `;s.unshift(r.buildFTSMatchQuery(e));let l;try{l=this.db.prepare(d).all(...s,n,i)}catch(O){throw u.warn("DB","FTS5 session search failed",{},O instanceof Error?O:void 0),O}return l.length>0||i>0&&this.db.prepare(d).all(...s,1,0).length>0?l:this.searchSessionsBySubstring(e,a,o,n,i)}return this.searchSessionsBySubstring(e,a,o,n,i)}findByConcept(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",...a}=t,_={...a,concepts:e},E=this.buildFilterClause(_,s,"o"),c=this.buildOrderClause(o,!1),d=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${E}
      ${c}
      LIMIT ? OFFSET ?
    `;return s.push(n,i),this.db.prepare(d).all(...s)}hasDirectChildFile(e,t){let s=n=>{if(!n)return!1;try{let i=JSON.parse(n);if(Array.isArray(i))return i.some(o=>je(o,t))}catch(i){u.debug("DB",`Failed to parse files JSON for observation ${e.id}`,void 0,i instanceof Error?i:void 0)}return!1};return s(e.files_modified)||s(e.files_read)}hasDirectChildFileSession(e,t){let s=n=>{if(!n)return!1;try{let i=JSON.parse(n);if(Array.isArray(i))return i.some(o=>je(o,t))}catch(i){u.debug("DB",`Failed to parse files JSON for session summary ${e.id}`,void 0,i instanceof Error?i:void 0)}return!1};return s(e.files_read)||s(e.files_edited)}static filePathPatterns(e,t){let s=a=>a.replace(/[\\%_]/g,"\\$&"),n=[`%${s(e)}%`];if(!t||!/^([A-Za-z]:)?[\\/]/.test(e))return n;let i=Ae(e).split("/").filter(a=>a.length>0),o=/^[A-Za-z]:$/.test(i[0]??"")?1:0;for(let a=o;a<i.length;a+=1){let _=i.slice(a);n.push(`${s(_.join("/")+"/")}%`),e.includes("\\")&&n.push(`${s(_.join("\\")+"\\")}%`)}return n}static jsonArrayLikeClause(e,t){let s=Array.from({length:t},()=>"value LIKE ? ESCAPE '\\'").join(" OR ");return`(${e.map(n=>`EXISTS (SELECT 1 FROM json_each(${n}) WHERE ${s})`).join(" OR ")})`}findByFile(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",isFolder:a=!1,..._}=t;delete _.files;let E=a?"":"LIMIT ? OFFSET ?",c=r.filePathPatterns(e,a),d=this.buildFilterClause(_,s,"o");s.push(...c,...c);let l=[d,r.jsonArrayLikeClause(["o.files_read","o.files_modified"],c.length)].filter(Boolean).join(" AND "),O=`${this.buildOrderClause(o,!1)}, o.id ${o==="date_asc"?"ASC":"DESC"}`,L=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${l}
      ${O}
      ${E}
    `;a||s.push(n,i);let I=this.db.prepare(L),R=a?He(I,s,D=>this.hasDirectChildFile(D,e),{limit:n,offset:i}):I.all(...s),g=[],m={..._};delete m.type;let N=[],A=w(m);if(A.length>0){let D=x("s",A,{includeMerged:!0});N.push(D.sql),g.push(...D.params)}if(m.platformSource&&(N.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = s.memory_session_id), ''), '${p}') = ?`),g.push(b(m.platformSource))),m.dateRange){let{start:D,end:v}=m.dateRange;D&&(N.push("s.created_at_epoch >= ?"),g.push(j(D,"start"))),v&&(N.push("s.created_at_epoch <= ?"),g.push(j(v,"end")))}N.push(r.jsonArrayLikeClause(["s.files_read","s.files_edited"],c.length)),g.push(...c,...c);let y=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${N.join(" AND ")}
      ORDER BY s.created_at_epoch ${o==="date_asc"?"ASC":"DESC"}
      ${E}
    `;a||g.push(n,i);let T=this.db.prepare(y),S=a?He(T,g,D=>this.hasDirectChildFileSession(D,e),{limit:n,offset:i}):T.all(...g);return{observations:R,sessions:S}}findByType(e,t={}){let s=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",...a}=t,_={...a,type:e},E=this.buildFilterClause(_,s,"o"),c=this.buildOrderClause(o,!1),d=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${E}
      ${c}
      LIMIT ? OFFSET ?
    `;return s.push(n,i),this.db.prepare(d).all(...s)}searchUserPrompts(e,t={}){let s=[],{limit:n=20,offset:i=0,orderBy:o="relevance",...a}=t,_=[],E=w(a);if(E.length>0){let L=x("s",E,{includeMerged:!1});_.push(L.sql),s.push(...L.params)}if(a.platformSource&&(_.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),s.push(b(a.platformSource))),a.dateRange){let{start:L,end:I}=a.dateRange;L&&(_.push("up.created_at_epoch >= ?"),s.push(j(L,"start"))),I&&(_.push("up.created_at_epoch <= ?"),s.push(j(I,"end")))}if(!e){if(_.length===0)return[];let L=`WHERE ${_.join(" AND ")}`,R=`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        ${L}
        ${o==="date_asc"?"ORDER BY up.created_at_epoch ASC":"ORDER BY up.created_at_epoch DESC"}
        LIMIT ? OFFSET ?
      `;return s.push(n,i),this.db.prepare(R).all(...s)}let c=e.replace(/[\\%_]/g,"\\$&");_.push("up.prompt_text LIKE ? ESCAPE '\\'"),s.push(`%${c}%`);let d=`WHERE ${_.join(" AND ")}`,O=`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ${d}
      ${o==="date_asc"?"ORDER BY up.created_at_epoch ASC":"ORDER BY up.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;return s.push(n,i),this.db.prepare(O).all(...s)}close(){this.db.close()}};var es=4096;var tn=new Set(["set_title","set_prompt_session","remap_project"]),sn=/^(?:0|[1-9][0-9]*)$/,ts=18446744073709551615n;function U(r){throw u.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:r}),new Error(`canonical content: ${r}`)}function fe(r,e={}){return typeof r!="string"||!sn.test(r)?U("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(r)>ts&&U("decimal value exceeds uint64"),e.positive&&r==="0"&&U("decimal value must be positive"),r)}function Ke(r){let e=fe(r);return BigInt(e)===ts&&U("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function nn(r){(r===null||typeof r!="object"||Array.isArray(r))&&U("mutation must be an object");let e=r;if((typeof e.op!="string"||!tn.has(e.op))&&U("unsupported mutation op"),e.op==="set_title"){let i=re(e,["fields","op","target"],"set_title"),o=Re(i.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");o.memory_session_id===void 0&&o.content_session_id===void 0&&U("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])o[_]!==void 0&&B(o[_],_);let a=re(i.fields,["custom_title"],"set_title.fields");B(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let i=re(e,["fields","op","target"],"set_prompt_session"),o=re(i.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");rn(o.origin_device_id),fe(o.origin_local_id);let a=Re(i.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");B(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&B(a[_],_);return}let t=re(e,["fields","op","where"],"remap_project"),s=Re(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&B(s.project,"project"),s.memory_session_id!==void 0&&B(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&U("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&U("remap_project where is empty");let n=Re(t.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&B(n.project,"project"),n.merged_into_project!==void 0&&B(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&U("remap_project fields are empty")}function Ye(r){nn(r)}function rn(r){return typeof r!="string"||r.length===0||Buffer.byteLength(r,"utf8")>128?U("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):r}function B(r,e){return typeof r!="string"||r.length===0||r.trim().length===0||Buffer.byteLength(r,"utf8")>es?U(`${e} must be a non-blank string of at most ${es} UTF-8 bytes`):r}function re(r,e,t){if(r===null||typeof r!="object"||Array.isArray(r))return U(`${t} must be an object`);let s=r,n=Object.keys(s).sort(),i=[...e].sort();return(n.length!==i.length||n.some((o,a)=>o!==i[a]))&&U(`${t} must contain exactly: ${i.join(", ")}`),s}function Re(r,e,t){if(r===null||typeof r!="object"||Array.isArray(r))return U(`${t} must be an object`);let s=r,n=new Set(e),i=Object.keys(s).find(o=>!n.has(o));return i&&U(`${t} contains unknown field ${i}`),s}var ss=5*6e4,f=r=>typeof r=="object"&&r!==null?JSON.stringify(r):r??null;function ns(r){let e=[],t=[],s=new Set,n=new Set;for(let i of r){for(let o of i.files_read??[])!o||s.has(o)||(s.add(o),e.push(o));for(let o of i.files_modified??[])!o||n.has(o)||(n.add(o),t.push(o))}return{files_read:e,files_edited:t}}var on=200,an=1e3,_n=56,En=57;function Ve(r){let e=Number(r);return Number.isSafeInteger(e)&&e>0?e:void 0}var Je=class{db;syncOpsEnabled;statementCache=new Map;constructor(e=Ee,t={}){this.syncOpsEnabled=t.syncOpsEnabled??!0,e instanceof qe.Database?this.db=e:(e!==":memory:"&&de(M),this.db=new qe.Database(e)),Se(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable(),this.ensureTelegramWrapupsTable(),this.addDedupTables(),this.ensureReinforcementColumns(),this.ensureSessionCwdColumn(),this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(),this.ensureProjectNocaseIndexes(),this.ensureAdvisorCallsTable(),this.ensureSessionProjectKeySourceColumn(),this.requeuePromptsDeadLetteredForSize(),this.ensureWorkStateTable(),this.ensureHookSpoolConsumedTable(),this.ensureProjectRecencyIndexes(),this.ensureMergedIntoProjectCoveringIndexes(),this.ensureNativePromptIdentity()}ensureNativePromptIdentity(){this.db.transaction(()=>{let e=this.db.query("PRAGMA table_info(user_prompts)").all();for(let t of["native_prompt_id","native_prompt_hash"])e.some(s=>s.name===t)||this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${t} TEXT`);this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_prompts_native_identity
        ON user_prompts(session_db_id, native_prompt_id) WHERE native_prompt_id IS NOT NULL`)}).immediate()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let i=this.getIndexColumns(n.name);return i.length===t.length&&i.every((o,a)=>o===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let n=s?b(s):void 0;return n?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(p,n,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${p}')
        WHEN '${p}' THEN 0
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(_n,new Date().toISOString())}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),u.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){u.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),i=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source");if(!(e&&!t&&s&&i)){if(i||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let a=o instanceof Error?o:new Error(String(o));throw u.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),o}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${p}',
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
        COALESCE(NULLIF(platform_source, ''), '${p}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),o=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&n&&!o)return;let a=n?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${p}')
            WHEN '${p}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${p}')
            WHEN '${p}' THEN 0
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let i=n instanceof Error?n:new Error(String(n));throw u.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},i),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(n=>n.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),u.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let t=this.db.query(`PRAGMA table_info(${e})`).all(),s=new Set(t.map(n=>n.name));s.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),u.debug("DB",`Added origin_device_id column to ${e} table`)),s.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),u.debug("DB",`Added origin_local_id column to ${e} table`)),s.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),u.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(o,a)=>this.db.query(`PRAGMA table_info(${o})`).all().find(_=>_.name===a),s=o=>o?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(o=>s(t(o.table,o.column))))return;this.db.transaction(()=>{for(let o of e){let a=this.db.query(`PRAGMA table_info(${o.table})`).all(),_=a.find(c=>c.name===o.column);if(!_)throw new Error(`schema v46: missing ${o.table}.${o.column}`);for(let c of Ge(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${o.column}) AS storage_type,
                 CAST(${o.column} AS TEXT) AS revision
          FROM ${o.table}
        `))){let d=c;if(d.storage_type==="real")throw new Error(`schema v46: ${o.table}.${o.column} row ${d.row_id} is REAL and unrecoverably rounded`);if(d.storage_type!=="integer"&&d.storage_type!=="text")throw new Error(`schema v46: ${o.table}.${o.column} row ${d.row_id} has unsupported ${d.storage_type} storage`);try{fe(d.revision,{positive:!0})}catch{throw new Error(`schema v46: ${o.table}.${o.column} row ${d.row_id} is not a positive canonical uint64 revision`)}}if(s(_))continue;if(a.some(c=>c.name===o.temporary))throw new Error(`schema v46: unexpected temporary column ${o.table}.${o.temporary}`);this.db.run(`ALTER TABLE ${o.table} ADD COLUMN ${o.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${o.table} SET ${o.temporary} = CAST(${o.column} AS TEXT)`);let E=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${o.table}
          WHERE ${o.temporary} <> CAST(${o.column} AS TEXT)
          LIMIT 1
        `).get();if(E)throw new Error(`schema v46: failed to copy ${o.table}.${o.column} row ${E.row_id} exactly`);this.db.run(`ALTER TABLE ${o.table} DROP COLUMN ${o.column}`),this.db.run(`ALTER TABLE ${o.table} RENAME COLUMN ${o.temporary} TO ${o.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_entity_heads (
        entity_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_device_id TEXT NOT NULL,
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        updated_at_epoch INTEGER NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_content_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        entity_rev TEXT NOT NULL,
        body TEXT NOT NULL,
        operation_sha256 TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(entity_id, entity_rev)
      )
    `),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(t=>t.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
        UPDATE sync_content_outbox
        SET deleted = CASE WHEN json_extract(body, '$.deleted') = 1 THEN 1 ELSE 0 END
      `)),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],t=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!==void 0;this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        through_rev TEXT NOT NULL,
        PRIMARY KEY (kind, origin_local_id)
      )
    `);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:c,kind:d}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${c}
            WHERE origin_device_id IS NULL
          `).run(d),this.db.prepare(`
            UPDATE ${c} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let E=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,E),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,E)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&t)return;let i=Date.parse(s.applied_at);if(!Number.isSafeInteger(i)||i<0)throw new Error(`schema v48: invalid v47 applied_at ${s.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:_}of e)this.db.prepare(`
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
      `);for(let i of n){if(i.origin_device_id!==null)continue;let o=Ke(i.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,i.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),u.debug("DB",`Normalized prefixed concept tags in ${t} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(o=>o.name)),i=["retry_count","failed_at_epoch","completed_at_epoch"].filter(o=>s.has(o));if(!(e&&i.length===0)){if(i.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let o of i)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${o}`),u.debug("DB",`Dropped dead column ${o} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK"),u.warn("DB","Failed to drop dead columns from pending_messages",{},o instanceof Error?o:new Error(String(o)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),u.warn("DB",`Created ${t} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(s=>s.table==="sdk_sessions"&&s.from==="memory_session_id"&&s.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,t,s){let n=this.db.query(`PRAGMA table_info(${e})`).all(),i=n.filter(o=>!s.includes(o.name));for(let o of i){let a=o.type?` ${o.type}`:"",_=o.dflt_value===null||o.dflt_value===void 0?"":` DEFAULT ${o.dflt_value}`;this.db.run(`ALTER TABLE ${t} ADD COLUMN "${o.name}"${a}${_}`),u.debug("DB",`Carried ${o.name} over the ${e} rebuild (#3849)`)}return n.map(o=>o.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}u.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let s=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],i=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!s.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `);for(let a of i){let _=a.type?` ${a.type}`:"",E=a.dflt_value===null||a.dflt_value===void 0?"":` DEFAULT ${a.dflt_value}`;this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${a.name}"${_}${E}`),u.debug("DB",`Carried ${a.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`)}let o=[...s,...i.map(a=>a.name)].map(a=>`"${a}"`).join(", ");this.db.run(`
      INSERT INTO session_summaries_new (${o})
      SELECT ${o}
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),u.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}u.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),u.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}u.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),u.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}u.debug("DB","Creating user_prompts table"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),u.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),u.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),u.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}u.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),u.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;u.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,i,o)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),_=a.some(c=>c.name===i);return a.some(c=>c.name===o)?!1:_?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${i} TO ${o}`),u.debug("DB",`Renamed ${n}.${i} to ${o}`),!0):(u.warn("DB",`Column ${i} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?u.debug("DB",`Successfully renamed ${t} session ID columns`):u.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),u.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),t=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!t){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}u.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let s=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],n=`
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
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(n,s,i,Oe)),t&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(a,o,_,ge)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),u.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(E){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),E instanceof Error?E:new Error(String(E))}}recreateObservationsWithCascade(e,t,s,n){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("observations","observations_new",t).map(_=>`"${_}"`).join(", ");this.db.run(`INSERT INTO observations_new (${o}) SELECT ${o} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,t,s,n){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",t).map(_=>`"${_}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${o}) SELECT ${o} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),u.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),u.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),u.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),s=e.some(n=>n.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),t=e.some(n=>n.name==="observed_model"),s=e.some(n=>n.name==="observed_billing");t&&s||(t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){pt(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString())}ensureWorkStateTable(){Rt(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61,new Date().toISOString())}ensureProjectRecencyIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase_recent ON observations(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_recent ON observations(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase_recent ON session_summaries(project COLLATE NOCASE, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_recent ON session_summaries(merged_into_project COLLATE NOCASE, created_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63,new Date().toISOString())}ensureMergedIntoProjectCoveringIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase_project ON observations(merged_into_project COLLATE NOCASE, project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase_project ON session_summaries(merged_into_project COLLATE NOCASE, project)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(64,new Date().toISOString())}ensureHookSpoolConsumedTable(){this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())}ensureReinforcementColumns(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(t=>t.name==="reinforcement_dates")||this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT"),e.some(t=>t.name==="last_reinforced")||this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(En,new Date().toISOString())}dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(){let e=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map(s=>s.name),t=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();if(e.length>0||t.length>0){this.db.run("BEGIN TRANSACTION");try{e.includes("observations_au")&&(this.db.run("DROP TRIGGER observations_au"),this.db.run(Oe)),e.includes("session_summaries_au")&&(this.db.run("DROP TRIGGER session_summaries_au"),this.db.run(ge)),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_fts"),this.db.run("COMMIT")}catch(s){throw this.db.run("ROLLBACK"),u.error("DB","Failed to scope FTS update triggers / drop user_prompts_fts, rolled back",{},s instanceof Error?s:new Error(String(s))),s}u.info("DB","Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts",{rescopedTriggers:e,droppedUserPromptsFts:t.length>0})}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}requeuePromptsDeadLetteredForSize(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60))return;let t="canonical content: body exceeds % UTF-8 bytes";this.db.transaction(()=>{let s=this.db.prepare(`
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
    `).run(e.sessionDbId,e.contentSessionId,e.project,e.platformSource,e.toolUseId,e.advisorModel??null,e.cwd??null,e.lastUserMessage??null,e.transcriptPath??null,e.transcriptByteOffset??null,e.advice,e.occurredAtEpoch,t.toISOString(),t.getTime());return s.changes>0?{id:Number(s.lastInsertRowid),inserted:!0}:{id:this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(e.toolUseId)?.id??0,inserted:!1}}getAdvisorCalls(e,t,s,n){let i="SELECT * FROM advisor_calls",o=[],a=[];s?(a.push("project = ?"),o.push(s)):(a.push("project != ?"),o.push(Q)),n&&(a.push("platform_source = ?"),o.push(n)),i+=` WHERE ${a.join(" AND ")}`,i+=" ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?",o.push(t+1,e);let _=this.db.prepare(i).all(...o);return{items:_.slice(0,t),hasMore:_.length>t,offset:e,limit:t}}getAdvisorCallById(e){return this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(e)??null}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="agent_type"),n=t.some(o=>o.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let i=this.db.query("PRAGMA table_info(pending_messages)").all();if(i.length>0){let o=i.some(_=>_.name==="agent_type"),a=i.some(_=>_.name==="agent_id");o||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let i=n instanceof Error?n:new Error(String(n));throw u.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},i),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="memory_session_id"),n=t.some(i=>i.name==="content_hash");if(!s||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let o=i instanceof Error?i:new Error(String(i));throw u.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},o),i}}dedupeObservationsByContentHash(){this.db.run(`
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
    `).get(e);!s||s.memory_session_id===t||(this.db.transaction(()=>{this.db.prepare(`
        UPDATE sdk_sessions
        SET memory_session_id = ?
        WHERE id = ?
      `).run(t,e),this.db.prepare(`
        UPDATE tool_uses
        SET memory_session_id = ?
        WHERE session_db_id = ?
      `).run(t,e)})(),t&&this.requeuePromptSync(e))}enqueueMutationOp(e,t){if(!this.syncOpsEnabled)return;let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let n=s.target;n?.origin_device_id===null&&(n.origin_device_id="self")}Ye(s),t.op==="set_prompt_session"&&this.cachedStatement(`
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
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let n=this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length===0)return;let i=this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);for(let o of n){let a=Ke(o.sync_rev);i.run(a,o.id),this.enqueueMutationOp(a,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:o.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
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
      `).run(t,e),this.requeuePromptSync(e),u.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,newId:t})):n.memory_session_id!==t&&u.debug("DB","Keeping the registered memory_session_id",{sessionDbId:e,registered:n.memory_session_id,offered:t}),typeof s=="number"&&n.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e),n.memory_session_id??t}getProjectReadKeys(e){return ot(this.db,e)}getAllProjects(e){let t=e?b(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[Q];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",n.push(p,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...n).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${p}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${p}'), project
      ORDER BY latest_epoch DESC
    `).all(Q),t=[],s=new Set,n={};for(let o of e){let a=b(o.platform_source);n[a]||(n[a]=[]),n[a].includes(o.project)||n[a].push(o.project),s.has(o.project)||(s.add(o.project),t.push(o.project))}let i=ct(Object.keys(n));return{projects:t,sources:i,projectsBySource:Object.fromEntries(i.map(o=>[o,n[o]||[]]))}}getSessionCatalog(e={}){let t=Math.min(Math.max(Math.trunc(e.limit??on),1),an),s=Math.max(Math.trunc(e.offset??0),0),n=`
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${p}') as platform_source,
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
    `,i=[Q];e.project&&(n+=" AND s.project = ?",i.push(e.project)),e.platformSource&&(n+=` AND COALESCE(s.platform_source, '${p}') = ?`,i.push(b(e.platformSource))),n+=" ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?",i.push(t+1,s);let o=this.db.prepare(n).all(...i);return{sessions:o.slice(0,t),hasMore:o.length>t}}getUserPromptById(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id = ?
    `).get(e)}findRecentDuplicateUserPrompt(e,t,s,n){return $t(this.db,e,ne(t),s,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let n=[e],i="";return s&&(i=`AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`,n.push(b(s))),n.push(t),this.db.prepare(`
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
            AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
        )
      `,s.push(b(t))),this.db.prepare(`
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
        AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
    `).get(e,b(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return mt(this.db,e)}linkToolUsesToObservation(e){return Tt(this.db,e)}getToolUsesByIds(e,t={}){return At(this.db,e,t)}queryToolUses(e={}){return Ot(this.db,e)}appendWorkStateEntry(e){let t=ft(this.db,e);return $({projects:[e.project]},"appendWorkStateEntry"),t}getWorkStateEntries(e,t){let s=Nt(this.db,this.getProjectReadKeys(e),t),n=a=>a.replace(/[A-Z]/g,_=>_.toLowerCase()),i=new Set(e.map(n)),o=e.at(-1);return s.map(a=>o&&i.has(n(a.project))?{...a,scope_project:o}:a)}countToolUses(e={}){return gt(this.db,e)}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n,type:i,concepts:o,files:a}=t,_=Ve(t.limit),E=w(t),c=s==="relevance",d=s==="date_asc"?"ASC":"DESC",l=c?"":`ORDER BY o.created_at_epoch ${d}, o.id ${d}`,O=_&&!c?"LIMIT ?":"",L=e.map(()=>"?").join(","),I=[...e],R=[];if(E.length>0){let T=x("o",E,{includeMerged:!0});R.push(T.sql),I.push(...T.params)}if(n&&(R.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),I.push(b(n))),i)if(Array.isArray(i)){let T=i.map(()=>"?").join(",");R.push(`o.type IN (${T})`),I.push(...i)}else R.push("o.type = ?"),I.push(i);if(o){let T=Array.isArray(o)?o:[o],S=T.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");I.push(...T),R.push(`(${S.join(" OR ")})`)}if(a){let T=Array.isArray(a)?a:[a],S=T.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ? ESCAPE '\\'))");T.forEach(D=>{let v=D.replace(/[\\%_]/g,"\\$&");I.push(`%${v}%`,`%${v}%`)}),R.push(`(${S.join(" OR ")})`)}let g=R.length>0?`WHERE o.id IN (${L}) AND ${R.join(" AND ")}`:`WHERE o.id IN (${L})`;O&&I.push(_);let N=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${g}
      ${l}
      ${O}
    `).all(...I);if(!c)return N;let A=new Map(N.map(T=>[T.id,T])),y=e.map(T=>A.get(T)).filter(T=>!!T);return _?y.slice(0,_):y}getSummaryForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${p}') = ?
        )
      `,s.push(b(t))),this.db.prepare(`
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
             COALESCE(platform_source, '${p}') as platform_source,
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
    `).get(p,b(t),e)?.id??null}claimTelegramWrapup({platformSource:e,contentSessionId:t,project:s,routeKey:n,summaryCreatedAtEpoch:i}){let o=Date.now();return this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(b(e),t,s,n,i,o).changes===1?!0:this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(i,o,b(e),t,s,n,o-ss).changes===1}markTelegramWrapupSent({platformSource:e,contentSessionId:t,project:s,routeKey:n}){this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(Date.now(),b(e),t,s,n)}releaseTelegramWrapupClaim({platformSource:e,contentSessionId:t,project:s,routeKey:n}){this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(b(e),t,s,n)}setSessionObservedMetadata(e,t,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(t||null,s||null,e)}getSdkSessionsBySessionIds(e,t=[]){if(e.length===0&&t.length===0)return[];let s=[...new Set(e),...new Set(t)],n=new Map;for(let i=0;i<s.length;i+=500){let o=s.slice(i,i+500),a=o.filter(d=>typeof d=="string"),_=o.filter(d=>typeof d=="number"),E=[];a.length&&E.push(`memory_session_id IN (${a.map(()=>"?").join(",")})`),_.length&&E.push(`id IN (SELECT session_db_id FROM user_prompts WHERE id IN (${_.map(()=>"?").join(",")}))`);let c=this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project,
               COALESCE(platform_source, '${p}') as platform_source,
               user_prompt, custom_title,
               started_at, started_at_epoch, completed_at, completed_at_epoch, status
        FROM sdk_sessions
        WHERE ${E.join(" OR ")}
        ORDER BY started_at_epoch DESC
      `);for(let d of c.all(...o))n.set(d.id,d)}return[...n.values()].sort((i,o)=>o.started_at_epoch-i.started_at_epoch)}getPromptNumberFromUserPrompts(e,t,s){let n=this.resolvePromptSessionDbId(e,t),i=n!==null?"session_db_id = ?":"content_session_id = ?",o=n!==null?n:e;return s!==void 0?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE ${i} AND created_at_epoch <= ?
      `).get(o,s).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE ${i}
    `).get(o).count}getLatestPromptTextFromUserPrompts(e,t){let s=this.resolvePromptSessionDbId(e,t),n=s!==null?"session_db_id = ?":"content_session_id = ?",i=s!==null?s:e;return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${n}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(i)?.prompt_text??null}createSDKSession(e,t,s,n,i){let o=new Date,a=o.getTime(),_=i?b(i):p,E=ne(s);n&&this.validateSetTitleMutation(e,_,n);let c=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(p,_,e);if(c){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(t,c.id),E&&E!==Xe&&this.db.prepare(`
          UPDATE sdk_sessions SET user_prompt = ?
          WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
        `).run(E,c.id,Xe),n){let l=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(c.id);l&&l.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,c.id),this.enqueueSetTitleOp(e,_,n))}return c.id}let d=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,_,E,n||null,o.toISOString(),a);return n&&this.enqueueSetTitleOp(e,_,n),Number(d.lastInsertRowid)}setSessionCwd(e,t,s){t.trim()&&this.db.prepare("UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL").run(t,s??null,e)}getSessionCwd(e){return this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(e)?.cwd??null}enqueueSetTitleOp(e,t,s){let n=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,t,s){let n={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return Ye(n),n}saveUserPrompt(e,t,s,n,i,o){let a=new Date,_=a.getTime(),E=ne(s),c=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, native_prompt_id, native_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(c,e,t,E,a.toISOString(),_,i??null,o??null).lastInsertRowid}saveNativeUserPrompt(e,t,s,n,i=n){if(!s||s.length>256||/[\s\x00-\x1f\x7f]/.test(s))throw new Error("Invalid native prompt identity");let o=ne(n),a=(0,Ne.createHash)("sha256").update(Te(i).trim()).digest("hex");return this.db.transaction(()=>{let _=this.db.prepare(`SELECT id, prompt_number, native_prompt_hash FROM user_prompts
        WHERE session_db_id = ? AND native_prompt_id = ?`).get(t,s);if(_){if(_.native_prompt_hash!==a)throw new Error("Native prompt identity was reused with different text");return{id:_.id,promptNumber:_.prompt_number,duplicate:!0}}let E=this.getPromptNumberFromUserPrompts(e,t)+1;return this.reopenCompletedSession(t),{id:this.saveUserPrompt(e,E,o,t,s,a),promptNumber:E,duplicate:!1}}).immediate()}getUserPrompt(e,t,s){let n=this.resolvePromptSessionDbId(e,s);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}dedupConfig(){let e=Y.loadFromFile(_e),t=(n,i)=>{let o=Number(e[n]);return Number.isFinite(o)?o:i},s=(n,i)=>Math.trunc(t(n,i));return{enabled:e.CLAUDE_MEM_DEDUP_ENABLED==="true",cosineThreshold:t("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD",.8),idfVetoDf:s("CLAUDE_MEM_DEDUP_IDF_VETO_DF",10),minSharedTokens:s("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS",2),maxScan:s("CLAUDE_MEM_DEDUP_MAX_SCAN",2e3),maxBackfillRows:s("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS",5e4),minProjectDocs:s("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS",10)}}listDedupCandidates(e,t=100){let s="SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ",n="ORDER BY c.score DESC, c.id DESC LIMIT ?";return e?this.db.prepare(`${s}WHERE c.project = ? ${n}`).all(e,t):this.db.prepare(`${s}${n}`).all(t)}isDedupEnabled(){return this.dedupConfig().enabled}runDedupScan(){return Ht(this.db,this.dedupConfig())}maintainDedupOnInsert(e,t,s,n){xt(this.db,e,s),Gt(this.db,e,n.minProjectDocs)&&jt(this.db,e,t,s,n)}storeObservation(e,t,s,n,i=0,o,a){if(!ve(s.title))throw new Error("storeObservation requires a non-empty title");let _=this.storeObservations(e,t,[s],null,n,i,o,a);return{id:_.observationIds[0],createdAtEpoch:_.createdAtEpoch,mergedIntoExisting:_.mergedIntoExisting[0]??!1}}storeSummary(e,t,s,n,i=0,o){let a=o??Date.now(),_=new Date(a).toISOString(),c=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,JSON.stringify(s.files_read??[]),JSON.stringify(s.files_edited??[]),s.notes,n||null,i,_,a);return $({projects:[t]},"storeSummary"),{id:Number(c.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,i,o=0,a,_){let E=a??Date.now(),c=new Date(E).toISOString(),d=dt(E),l=new Date(E),O=this.dedupConfig(),L=b(this.db.prepare("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(e)?.platform_source),R=this.db.transaction(()=>{let g=[],m=[],N=[],A=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),y=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let S of s){if(!ve(S.title)){u.debug("DB","Skipping observation with empty title");continue}let D=at(e,S.title,S.narrative),v=ke(t,L,S.title,pe(S.agent_id,S.agent_type));if(O.enabled){let be=y.get(e,D);if(be){ce(this.db,be.id,l),g.push(be.id),m.push(!1);continue}let oe=Pt(this.db,t,v);if(oe){this.db.prepare("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(oe.id),ce(this.db,oe.id,l),g.push(oe.id),m.push(!0);continue}}let q=A.get(e,t,S.type,S.title,S.subtitle,JSON.stringify(S.facts),S.narrative,JSON.stringify(S.concepts),JSON.stringify(S.files_read),JSON.stringify(S.files_modified),i||null,o,S.agent_type??null,S.agent_id??null,D,c,E,_||null,S.metadata??null,v,d.dates,d.lastReinforced);if(q){O.enabled&&this.maintainDedupOnInsert(t,q.id,S.title,O),g.push(q.id),m.push(!1),N.push(q.id);continue}let J=y.get(e,D);if(!J)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${D}`);ce(this.db,J.id,l),g.push(J.id),m.push(!1)}let T=null;if(n){let S=ns(s),D=n.files_read??S.files_read,v=n.files_edited??S.files_edited,J=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,JSON.stringify(D),JSON.stringify(v),n.notes,i||null,o,c,E);T=Number(J.lastInsertRowid)}return{observationIds:g,mergedIntoExisting:m,insertedObservationIds:N,summaryId:T,createdAtEpoch:E}})();return $({projects:[t]},"storeObservations"),R}updateDiscoveryTokens(e,t,s){e.length===0&&t===null||this.db.transaction(()=>{let n=this.db.prepare("UPDATE observations SET discovery_tokens = ? WHERE id = ?");for(let i of e)n.run(s,i);t!==null&&this.db.prepare("UPDATE session_summaries SET discovery_tokens = ? WHERE id = ?").run(s,t)})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n}=t,i=Ve(t.limit),o=w(t),a=s==="relevance",_=a?"":`ORDER BY ss.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,E=i&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),d=[...e],l=[];if(o.length>0){let m=x("ss",o,{includeMerged:!0});l.push(m.sql),d.push(...m.params)}n&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),d.push(b(n)));let O=l.length>0?`AND ${l.join(" AND ")}`:"";E&&d.push(i);let I=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${O}
      ${_}
      ${E}
    `).all(...d);if(!a)return I;let R=new Map(I.map(m=>[m.id,m])),g=e.map(m=>R.get(m)).filter(m=>!!m);return i?g.slice(0,i):g}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",platformSource:n}=t,i=Ve(t.limit),o=w(t),a=s==="relevance",_=a?"":`ORDER BY up.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,E=i&&!a?"LIMIT ?":"",c=e.map(()=>"?").join(","),d=[...e],l=[];if(o.length>0){let m=x("s",o,{includeMerged:!1});l.push(m.sql),d.push(...m.params)}n&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),d.push(b(n)));let O=l.length>0?`AND ${l.join(" AND ")}`:"";E&&d.push(i);let I=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${O}
      ${_}
      ${E}
    `).all(...d);if(!a)return I;let R=new Map(I.map(m=>[m.id,m])),g=e.map(m=>R.get(m)).filter(m=>!!m);return i?g.slice(0,i):g}getTimelineAroundTimestamp(e,t=10,s=10,n,i){return this.getTimelineAroundObservation(null,e,t,s,n,i)}getTimelineAroundObservation(e,t,s=10,n=10,i,o){let a=o?b(o):void 0,_=(A,y,T=!1)=>{let S=[],D=[];return i&&(T?(S.push(`(${A}.project COLLATE NOCASE = ? OR ${A}.merged_into_project COLLATE NOCASE = ?)`),D.push(i,i)):(S.push(`${A}.project COLLATE NOCASE = ?`),D.push(i))),a&&(S.push(`COALESCE(NULLIF(${y}.platform_source, ''), '${p}') = ?`),D.push(a)),{clause:S.length>0?`AND ${S.join(" AND ")}`:"",params:D}},E=_("o","src",!0),c=_("ss","src",!0),d=_("s","s"),l,O;if(e!==null){let A=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) <= (?, ?) ${E.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,y=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE (o.created_at_epoch, o.id) >= (?, ?) ${E.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let T=this.db.prepare(A).all(t,e,...E.params,s+1),S=this.db.prepare(y).all(t,e,...E.params,n+1);if(T.length===0&&S.length===0)return{observations:[],sessions:[],prompts:[]};l=T.length>0?T[T.length-1].created_at_epoch:t,O=S.length>0?S[S.length-1].created_at_epoch:t}catch(T){return T instanceof Error?u.error("DB","Error getting boundary observations",{project:i},T):u.error("DB","Error getting boundary observations with non-Error",{},new Error(String(T))),{observations:[],sessions:[],prompts:[]}}}else{let A=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${E.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,y=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${E.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let T=this.db.prepare(A).all(t,...E.params,s),S=this.db.prepare(y).all(t,...E.params,n);l=T.length>0?T[T.length-1].created_at_epoch:t,O=S.length>0?S[S.length-1].created_at_epoch:t}catch(T){return T instanceof Error?u.error("DB","Error getting boundary timestamps",{project:i},T):u.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(T))),{observations:[],sessions:[],prompts:[]}}}let L=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${E.clause}
      ORDER BY o.created_at_epoch ASC, o.id ASC
    `,I=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${c.clause}
      ORDER BY ss.created_at_epoch ASC, ss.id ASC
    `,R=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${d.clause}
      ORDER BY up.created_at_epoch ASC, up.id ASC
    `,g=this.db.prepare(L).all(l,O,...E.params),m=this.db.prepare(I).all(l,O,...c.params),N=this.db.prepare(R).all(l,O,...d.params);return{observations:g,sessions:m.map(A=>({id:A.id,memory_session_id:A.memory_session_id,project:A.project,request:A.request,completed:A.completed,next_steps:A.next_steps,created_at:A.created_at,created_at_epoch:A.created_at_epoch})),prompts:N.map(A=>({id:A.id,content_session_id:A.content_session_id,prompt_number:A.prompt_number,prompt_text:A.prompt_text,project:A.project,platform_source:A.platform_source,created_at:A.created_at,created_at_epoch:A.created_at_epoch}))}}getOrCreateManualSession(e,t=p){let s=`manual-${e}`,n=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return t&&t!==p&&this.db.prepare("UPDATE sdk_sessions SET platform_source = ? WHERE memory_session_id = ?").run(t,s),s;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,n,e,p,o.toISOString(),o.getTime()),u.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}close(){this.db.close()}cachedStatement(e){let t=this.statementCache.get(e);return t||(t=this.db.prepare(e),this.statementCache.set(e,t)),t}importSdkSession(e){let t=b(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);if(s)return{imported:!1,id:s.id};let n=e.custom_title??null;if(n!==null&&typeof n!="string")throw new TypeError("Imported custom_title must be a string or null");let i=this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);return this.db.transaction(()=>({imported:!0,id:i.run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,n,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}))()}importSessionSummary(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return u.warn("DB","Skipping imported session summary without memory_session_id",{project:typeof e?.project=="string"?e.project:null}),{imported:!1,id:0};let t=this.db.prepare(`SELECT id FROM session_summaries WHERE memory_session_id = ?
        AND request IS ? AND investigated IS ? AND learned IS ? AND completed IS ?
        AND next_steps IS ? AND files_read IS ? AND files_edited IS ? AND notes IS ?
        AND prompt_number IS ? AND created_at_epoch = ?`).get(e.memory_session_id,f(e.request),f(e.investigated),f(e.learned),f(e.completed),f(e.next_steps),f(e.files_read),f(e.files_edited),f(e.notes),e.prompt_number??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let n=this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,f(e.request),f(e.investigated),f(e.learned),f(e.completed),f(e.next_steps),f(e.files_read),f(e.files_edited),f(e.notes),e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch);return $({projects:[e.project]},"importSessionSummary"),{imported:!0,id:n.lastInsertRowid}}importObservation(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return u.warn("DB","Skipping imported observation without memory_session_id",{title:typeof e?.title=="string"?e.title:null,type:typeof e?.type=="string"?e.type:null}),{imported:!1,id:0};let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND text IS ? AND type = ?
        AND title IS ? AND subtitle IS ? AND facts IS ? AND narrative IS ?
        AND concepts IS ? AND files_read IS ? AND files_modified IS ?
        AND prompt_number IS ? AND agent_type IS ?
        AND agent_id IS ? AND created_at_epoch = ?
    `).get(e.memory_session_id,f(e.text),e.type,f(e.title),f(e.subtitle),f(e.facts),f(e.narrative),f(e.concepts),f(e.files_read),f(e.files_modified),e.prompt_number??null,e.agent_type??null,e.agent_id??null,e.created_at_epoch);if(t)return{imported:!1,id:t.id};let n=this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,f(e.text),e.type,f(e.title),f(e.subtitle),f(e.facts),f(e.narrative),f(e.concepts),f(e.files_read),f(e.files_modified),e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch);return $({projects:[e.project]},"importObservation"),{imported:!0,id:n.lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?b(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${p}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!s||b(a.platform_source)===s)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,f(e.prompt_text),e.created_at,e.created_at_epoch).lastInsertRowid}}};0&&(module.exports={SessionStore,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
