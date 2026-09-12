var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var G=Object.defineProperty;var Ce=Object.getOwnPropertyDescriptor;var ve=Object.getOwnPropertyNames;var De=Object.prototype.hasOwnProperty;var Ue=(i,e)=>{for(var s in e)G(i,s,{get:e[s],enumerable:!0})},we=(i,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of ve(e))!De.call(i,n)&&n!==s&&G(i,n,{get:()=>e[n],enumerable:!(t=Ce(e,n))||t.enumerable});return i};var xe=i=>we(G({},"__esModule",{value:!0}),i);var rs={};Ue(rs,{SessionStore:()=>Z,rollupObservationFileLists:()=>ye});module.exports=xe(rs);var z=require("bun:sqlite"),Le=require("crypto");var b=require("path"),j=require("os"),U=require("fs"),te=require("url");var Me=null;function Fe(i){return(Me??process.stderr.write.bind(process.stderr))(i)}function F(i){Fe(i)}var _s=process.platform==="win32";function Xe(i){return i.replace(/^\uFEFF/,"")}function X(i){return JSON.parse(Xe(i))}var ee=require("os"),se=require("path");function k(i,e=process.platform,s=(0,ee.homedir)()){return typeof i!="string"||i.length===0?i:i==="~"?s:i.startsWith("~/")||e==="win32"&&i.startsWith("~\\")?(0,se.join)(s,i.slice(2)):i}function ke(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,b.dirname)((0,te.fileURLToPath)(__IMPORT_META_URL__))}var Es=ke();function $e(){if(process.env.CLAUDE_MEM_DATA_DIR)return k(process.env.CLAUDE_MEM_DATA_DIR);let i=(0,b.join)((0,j.homedir)(),".claude-mem"),e=(0,b.join)(i,"settings.json");try{if((0,U.existsSync)(e)){let s=X((0,U.readFileSync)(e,"utf-8")),t=s.env??s;if(t.CLAUDE_MEM_DATA_DIR)return k(t.CLAUDE_MEM_DATA_DIR)}}catch{}return i}var h=$e(),Pe=(0,b.join)((0,j.homedir)(),".claude"),Be=process.env.CLAUDE_CONFIG_DIR||Pe,Ts=(0,b.join)(Be,"plugins","marketplaces","thedotmack"),Ge=(0,b.join)(h,"logs"),bs=(0,b.join)(h,"settings.json"),ne="claude-mem.db";var oe=(0,b.join)(h,ne),je=(0,b.join)(h,"observer-sessions"),H=(0,b.basename)(je);function re(i){(0,U.mkdirSync)(i,{recursive:!0})}var W={dataDir:()=>h,workerPid:()=>(0,b.join)(h,"worker.pid"),serverPid:()=>(0,b.join)(h,".server-beta.pid"),serverPort:()=>(0,b.join)(h,".server-beta.port"),serverRuntime:()=>(0,b.join)(h,".server-beta.runtime.json"),settings:()=>(0,b.join)(h,"settings.json"),database:()=>(0,b.join)(h,ne),chroma:()=>(0,b.join)(h,"chroma"),combinedCerts:()=>(0,b.join)(h,"combined_certs.pem"),transcriptsConfig:()=>(0,b.join)(h,"transcript-watch.json"),transcriptsState:()=>(0,b.join)(h,"transcript-watch-state.json"),corpora:()=>(0,b.join)(h,"corpora"),supervisorRegistry:()=>(0,b.join)(h,"supervisor.json"),envFile:()=>(0,b.join)(h,".env"),logsDir:()=>Ge};var v=require("fs"),ie=require("path");var V=(r=>(r[r.DEBUG=0]="DEBUG",r[r.INFO=1]="INFO",r[r.WARN=2]="WARN",r[r.ERROR=3]="ERROR",r[r.SILENT=4]="SILENT",r))(V||{}),q=null,Y=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=W.logsDir();(0,v.existsSync)(e)||(0,v.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,ie.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=W.settings();if((0,v.existsSync)(e)){let s=(0,v.readFileSync)(e,"utf-8"),n=(X(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=V[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),r=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${n} ${r}:${o}:${a}.${d}`}log(e,s,t,n,r){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),a=V[e].padEnd(5),d=s.padEnd(6),u="";n?.correlationId?u=`[${n.correlationId}] `:n?.sessionId&&(u=`[session-${n.sessionId}] `);let l="";if(r!=null)if(r instanceof Error)l=this.getLevel()===0?`
${r.message}
${r.stack}`:` ${r.message}`;else if(this.getLevel()===0&&typeof r=="object")try{l=`
`+JSON.stringify(r,null,2)}catch{l=" "+this.formatData(r)}else l=" "+this.formatData(r);let p="";if(n){let{sessionId:I,memorySessionId:A,correlationId:S,...E}=n;Object.keys(E).length>0&&(p=` {${Object.entries(E).map(([g,C])=>`${g}=${C}`).join(", ")}}`)}let T=`[${o}] [${a}] [${d}] ${u}${t}${p}${l}`;if(this.logFilePath)try{(0,v.appendFileSync)(this.logFilePath,T+`
`,"utf8")}catch(I){let A=I instanceof Error?I:new Error(String(I));F(`[LOGGER] Failed to write to log file: ${A.message}
${A.stack??""}
`)}else F(T+`
`)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}setErrorSink(e){q=e}error(e,s,t,n){this.log(3,e,s,t,n),this.routeErrorToSink(s,t,n)}routeErrorToSink(e,s,t){try{if(!q||!(t instanceof Error))return;q(t)}catch{}}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}},_=new Y;var ae=require("crypto");function de(i,e,s){return(0,ae.createHash)("sha256").update([i||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}var le=require("crypto");var c="claude";function He(i){return i.trim().toLowerCase().replace(/\s+/g,"-")}function R(i){if(!i)return c;let e=He(i);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:c}function _e(i){let e=["claude","codex","cursor"];return[...i].sort((s,t)=>{let n=e.indexOf(s),r=e.indexOf(t);return n!==-1||r!==-1?n===-1?1:r===-1?-1:n-r:s.localeCompare(t)})}var We=64*1024,qe=new Set(["search","timeline","get_observations","get_tool_uses","session_start_context","observation_search"]);function Ve(i){if(!i)return!1;if(i.startsWith("memory_"))return!0;if(!i.startsWith("mcp__"))return!1;let e=i.split("__");if(e.length<3)return!1;let s=e[1].toLowerCase(),t=e.slice(2).join("__");return(s.includes("claude-mem")||s.includes("claude_mem")||s.includes("mcp-search")||s.includes("cmem"))&&qe.has(t)}function ue(i,e=We){let s=Buffer.byteLength(i,"utf8");if(s<=e)return i;let t=Buffer.from(i,"utf8"),n=e;for(;n>0&&(t[n]&192)===128;)n--;return`${t.subarray(0,n).toString("utf8")}\u2026[truncated: ${s} bytes]`}function Ye(i,e,s){return(0,le.createHash)("sha256").update([i||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}function ce(i){i.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${c}',
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
  `),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),i.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function pe(i,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||Ve(e.toolName))return null;let s=e.createdAtEpoch??Date.now(),t=new Date(s).toISOString(),n=Ye(e.toolName,e.toolInput,e.toolResponse),r=e.toolInput!=null?ue(e.toolInput):null,o=e.toolResponse!=null?ue(e.toolResponse):null,a=i.prepare(`
    INSERT INTO tool_uses (
      tool_use_id, content_session_id, memory_session_id, session_db_id, project,
      platform_source, tool_name, tool_input, tool_response, cwd, prompt_number,
      agent_type, agent_id, or_generation_id, or_session_id, content_hash,
      created_at, created_at_epoch
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_session_id, tool_use_id) DO UPDATE SET
      memory_session_id = COALESCE(excluded.memory_session_id, tool_uses.memory_session_id),
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
  `).get(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",R(e.platformSource),e.toolName,r,o,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,n,t,s);return a?a.id:null}function me(i,e){let s=e.toolUseIds.filter(r=>typeof r=="string"&&r.length>0);if(s.length===0)return 0;let t=s.map(()=>"?").join(","),n=i.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = COALESCE(?, memory_session_id)
    WHERE content_session_id = ?
      AND tool_use_id IN (${t})
  `).run(e.observationId,e.memorySessionId??null,e.contentSessionId,...s);return Number(n.changes??0)}function Ee(i){return i?{clause:`COALESCE(NULLIF(platform_source, ''), '${c}') = ?`,param:R(i)}:null}function Te(i,e,s={}){let t=[],n=[];for(let l of e){if(typeof l=="number"&&Number.isInteger(l)){t.push(l);continue}if(typeof l=="string"&&l.trim().length>0){let p=Number(l);Number.isInteger(p)&&String(p)===l.trim()&&t.push(p),n.push(l.trim())}}if(t.length===0&&n.length===0)return[];let r=[],o=[];t.length>0&&(r.push(`id IN (${t.map(()=>"?").join(",")})`),o.push(...t)),n.length>0&&(r.push(`tool_use_id IN (${n.map(()=>"?").join(",")})`),o.push(...n));let a=[`(${r.join(" OR ")})`];s.project&&(a.push("project = ?"),o.push(s.project)),s.contentSessionId&&(a.push("content_session_id = ?"),o.push(s.contentSessionId));let d=Ee(s.platformSource);d&&(a.push(d.clause),o.push(d.param));let u=s.limit&&s.limit>0?`LIMIT ${Math.floor(s.limit)}`:"";return i.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    ${u}
  `).all(...o)}function be(i,e={}){let s=[],t=[];if(e.project&&(s.push("project = ?"),t.push(e.project)),e.contentSessionId&&(s.push("content_session_id = ?"),t.push(e.contentSessionId)),e.memorySessionId&&(s.push("memory_session_id = ?"),t.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(s.push("session_db_id = ?"),t.push(e.sessionDbId)),e.toolName){let u=Array.isArray(e.toolName)?e.toolName:[e.toolName];u.length>0&&(s.push(`tool_name IN (${u.map(()=>"?").join(",")})`),t.push(...u))}e.agentId&&(s.push("agent_id = ?"),t.push(e.agentId));let n=Ee(e.platformSource);n&&(s.push(n.clause),t.push(n.param)),typeof e.dateStart=="number"&&(s.push("created_at_epoch >= ?"),t.push(e.dateStart)),typeof e.dateEnd=="number"&&(s.push("created_at_epoch <= ?"),t.push(e.dateEnd));let r=s.length>0?`WHERE ${s.join(" AND ")}`:"",o=e.orderBy==="date_asc"?"ASC":"DESC",a=Math.min(Math.max(Math.floor(e.limit??50),1),500),d=Math.max(Math.floor(e.offset??0),0);return i.prepare(`
    SELECT * FROM tool_uses
    ${r}
    ORDER BY created_at_epoch ${o}, id ${o}
    LIMIT ${a} OFFSET ${d}
  `).all(...t)}function ge(i,e={}){let s=[],t=[];e.project&&(s.push("project = ?"),t.push(e.project)),e.contentSessionId&&(s.push("content_session_id = ?"),t.push(e.contentSessionId)),e.agentId&&(s.push("agent_id = ?"),t.push(e.agentId)),typeof e.dateStart=="number"&&(s.push("created_at_epoch >= ?"),t.push(e.dateStart)),typeof e.dateEnd=="number"&&(s.push("created_at_epoch <= ?"),t.push(e.dateEnd));let n=s.length>0?`WHERE ${s.join(" AND ")}`:"";return i.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${n}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...t)}function fe(i,e,s,t,n){let r=Date.now()-t,o=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return i.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${c}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${o}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,s,r)??void 0}var he=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],Se=new RegExp(`<(${he.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g");var Ne=100;function Ke(i){let e=Object.fromEntries(he.map(n=>[n,0]));Se.lastIndex=0;let s=0,t=i.replace(Se,(n,r)=>(e[r]=(e[r]??0)+1,s+=1,""));return s>Ne&&_.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:Ne,contentLength:i.length}),{stripped:t.trim(),counts:e}}function Ie(i){return Ke(i).stripped}var Je=["task-notification"],Us=new RegExp(`^\\s*<(${Je.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),ws=256*1024;var K=4e3;function $(i){let e=i.trim(),t=Ie(i).trim()||e;return t.length<=K?t:(_.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:t.length,storedLength:K}),`${t.slice(0,K-1)}\u2026`)}var Qe=require("bun:sqlite");var ze=5e3,Ze=4194304;function es(i){return i.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function w(i,e,s){try{i.run(e)}catch(t){let n=t instanceof Error?t:new Error(String(t));throw _.warn("DB",`Failed to apply SQLite pragma ${s}`,{sql:e},n),t}}function Re(i,e={}){let{enableWal:s=!0,enableIncrementalAutoVacuum:t=!0}=e;w(i,`PRAGMA busy_timeout = ${ze}`,"busy_timeout"),w(i,"PRAGMA foreign_keys = ON","foreign_keys"),w(i,"PRAGMA synchronous = NORMAL","synchronous"),w(i,`PRAGMA journal_size_limit = ${Ze}`,"journal_size_limit"),t&&!es(i)&&w(i,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),s&&w(i,"PRAGMA journal_mode = WAL","journal_mode")}var Oe=4096;var ss=new Set(["set_title","set_prompt_session","remap_project"]),ts=/^(?:0|[1-9][0-9]*)$/,Ae=18446744073709551615n;function L(i){throw _.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:i}),new Error(`canonical content: ${i}`)}function B(i,e={}){return typeof i!="string"||!ts.test(i)?L("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(i)>Ae&&L("decimal value exceeds uint64"),e.positive&&i==="0"&&L("decimal value must be positive"),i)}function J(i){let e=B(i);return BigInt(e)===Ae&&L("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function ns(i){(i===null||typeof i!="object"||Array.isArray(i))&&L("mutation must be an object");let e=i;if((typeof e.op!="string"||!ss.has(e.op))&&L("unsupported mutation op"),e.op==="set_title"){let r=x(e,["fields","op","target"],"set_title"),o=P(r.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");o.memory_session_id===void 0&&o.content_session_id===void 0&&L("set_title target requires a session identifier");for(let d of["memory_session_id","content_session_id","platform_source"])o[d]!==void 0&&D(o[d],d);let a=x(r.fields,["custom_title"],"set_title.fields");D(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let r=x(e,["fields","op","target"],"set_prompt_session"),o=x(r.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");os(o.origin_device_id),B(o.origin_local_id);let a=P(r.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");D(a.memory_session_id,"memory_session_id");for(let d of["content_session_id","platform_source","project"])a[d]!==void 0&&D(a[d],d);return}let s=x(e,["fields","op","where"],"remap_project"),t=P(s.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");t.project!==void 0&&D(t.project,"project"),t.memory_session_id!==void 0&&D(t.memory_session_id,"memory_session_id"),t.merged_into_project_is_null!==void 0&&t.merged_into_project_is_null!==!0&&L("merged_into_project_is_null may only be true"),Object.keys(t).length===0&&L("remap_project where is empty");let n=P(s.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&D(n.project,"project"),n.merged_into_project!==void 0&&D(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&L("remap_project fields are empty")}function Q(i){ns(i)}function os(i){return typeof i!="string"||i.length===0||Buffer.byteLength(i,"utf8")>128?L("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):i}function D(i,e){return typeof i!="string"||i.length===0||i.trim().length===0||Buffer.byteLength(i,"utf8")>Oe?L(`${e} must be a non-blank string of at most ${Oe} UTF-8 bytes`):i}function x(i,e,s){if(i===null||typeof i!="object"||Array.isArray(i))return L(`${s} must be an object`);let t=i,n=Object.keys(t).sort(),r=[...e].sort();return(n.length!==r.length||n.some((o,a)=>o!==r[a]))&&L(`${s} must contain exactly: ${r.join(", ")}`),t}function P(i,e,s){if(i===null||typeof i!="object"||Array.isArray(i))return L(`${s} must be an object`);let t=i,n=new Set(e),r=Object.keys(t).find(o=>!n.has(o));return r&&L(`${s} contains unknown field ${r}`),t}function ye(i){let e=[],s=[],t=new Set,n=new Set;for(let r of i){for(let o of r.files_read??[])!o||t.has(o)||(t.add(o),e.push(o));for(let o of r.files_modified??[])!o||n.has(o)||(n.add(o),s.push(o))}return{files_read:e,files_edited:s}}var Z=class{db;syncOpsEnabled;constructor(e=oe,s={}){this.syncOpsEnabled=s.syncOpsEnabled??!0,e instanceof z.Database?this.db=e:(e!==":memory:"&&re(h),this.db=new z.Database(e)),Re(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(s=>s.name)}hasUniqueIndexOnColumns(e,s){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let r=this.getIndexColumns(n.name);return r.length===s.length&&r.every((o,a)=>o===s[a])})}resolvePromptSessionDbId(e,s,t){if(s!==void 0)return s;let n=t?R(t):void 0;return n?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(c,n,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${c}')
        WHEN '${c}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),t=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!t)){if(t)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),_.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){_.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),s=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),t=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),r=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source");if(!(e&&!s&&t&&r)){if(r||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${c}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${c}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),s){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let a=o instanceof Error?o:new Error(String(o));throw _.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),o}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${c}',
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
        COALESCE(NULLIF(platform_source, ''), '${c}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(u=>u.name==="session_db_id"),o=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(u=>u.table==="sdk_sessions"&&u.from==="content_session_id");if(e&&n&&!o)return;let a=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,d=n?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${c}')
            WHEN '${c}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${c}')
            WHEN '${c}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,d,a),this.db.run("COMMIT")}catch(u){this.db.run("ROLLBACK");let l=u instanceof Error?u:new Error(String(u));throw _.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},l),u}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,s,t){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
        ${s},
        up.content_session_id,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),t&&(this.db.run(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;

        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END;

        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let t=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&t)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let r=n instanceof Error?n:new Error(String(n));throw _.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},r),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(n=>n.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),_.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let s=this.db.query(`PRAGMA table_info(${e})`).all(),t=new Set(s.map(n=>n.name));t.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),_.debug("DB",`Added origin_device_id column to ${e} table`)),t.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),_.debug("DB",`Added origin_local_id column to ${e} table`)),t.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),_.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(s=>s.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],s=(o,a)=>this.db.query(`PRAGMA table_info(${o})`).all().find(d=>d.name===a),t=o=>o?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(o=>t(s(o.table,o.column))))return;this.db.transaction(()=>{for(let o of e){let a=this.db.query(`PRAGMA table_info(${o.table})`).all(),d=a.find(l=>l.name===o.column);if(!d)throw new Error(`schema v46: missing ${o.table}.${o.column}`);for(let l of this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${o.column}) AS storage_type,
                 CAST(${o.column} AS TEXT) AS revision
          FROM ${o.table}
        `).iterate()){let p=l;if(p.storage_type==="real")throw new Error(`schema v46: ${o.table}.${o.column} row ${p.row_id} is REAL and unrecoverably rounded`);if(p.storage_type!=="integer"&&p.storage_type!=="text")throw new Error(`schema v46: ${o.table}.${o.column} row ${p.row_id} has unsupported ${p.storage_type} storage`);try{B(p.revision,{positive:!0})}catch{throw new Error(`schema v46: ${o.table}.${o.column} row ${p.row_id} is not a positive canonical uint64 revision`)}}if(t(d))continue;if(a.some(l=>l.name===o.temporary))throw new Error(`schema v46: unexpected temporary column ${o.table}.${o.temporary}`);this.db.run(`ALTER TABLE ${o.table} ADD COLUMN ${o.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${o.table} SET ${o.temporary} = CAST(${o.column} AS TEXT)`);let u=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${o.table}
          WHERE ${o.temporary} <> CAST(${o.column} AS TEXT)
          LIMIT 1
        `).get();if(u)throw new Error(`schema v46: failed to copy ${o.table}.${o.column} row ${u.row_id} exactly`);this.db.run(`ALTER TABLE ${o.table} DROP COLUMN ${o.column}`),this.db.run(`ALTER TABLE ${o.table} RENAME COLUMN ${o.temporary} TO ${o.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){this.db.run(`
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
    `),new Set(this.db.query("PRAGMA table_info(sync_content_outbox)").all().map(s=>s.name)).has("deleted")||(this.db.run("ALTER TABLE sync_content_outbox ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(44,new Date().toISOString()),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(45,new Date().toISOString())}initializeSyncHubLaunchBaseline(){let e=[{table:"observations",kind:"observation"},{table:"session_summaries",kind:"summary"},{table:"user_prompts",kind:"prompt"}],s=this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = 'sync_launch_exclusions'
    `).get()!==void 0;this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_launch_exclusions (
        kind TEXT NOT NULL CHECK (kind IN ('observation', 'summary', 'prompt')),
        origin_local_id TEXT NOT NULL,
        through_rev TEXT NOT NULL,
        PRIMARY KEY (kind, origin_local_id)
      )
    `);let t=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!t){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:l,kind:p}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${l}
            WHERE origin_device_id IS NULL
          `).run(p),this.db.prepare(`
            UPDATE ${l} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let u=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,u),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,u)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&s)return;let r=Date.parse(t.applied_at);if(!Number.isSafeInteger(r)||r<0)throw new Error(`schema v48: invalid v47 applied_at ${t.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:d}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(d,r);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}normalizeConceptTags(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49))return;let s=0;this.db.transaction(()=>{let n=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, origin_device_id, CAST(sync_rev AS TEXT) AS sync_rev
        FROM observations
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `).all();s=n.length,this.db.run(`
        UPDATE observations
        SET concepts = (
          SELECT json_group_array(
            CASE WHEN instr(value, ':') > 0
                 THEN trim(substr(value, 1, instr(value, ':') - 1))
                 ELSE value END)
          FROM json_each(observations.concepts))
        WHERE concepts LIKE '%:%' AND json_valid(concepts)
      `);for(let r of n){if(r.origin_device_id!==null)continue;let o=J(r.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,r.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),_.debug("DB",`Normalized prefixed concept tags in ${s} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),s=this.db.query("PRAGMA table_info(pending_messages)").all(),t=new Set(s.map(o=>o.name)),r=["retry_count","failed_at_epoch","completed_at_epoch"].filter(o=>t.has(o));if(!(e&&r.length===0)){if(r.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let o of r)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${o}`),_.debug("DB",`Dropped dead column ${o} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK"),_.warn("DB","Failed to drop dead columns from pending_messages",{},o instanceof Error?o:new Error(String(o)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),_.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),_.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}repairOrphanedSessionParents(e){let s=this.db.prepare(`
      SELECT COUNT(DISTINCT c.memory_session_id) AS n
      FROM ${e} c
      WHERE c.memory_session_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sdk_sessions s WHERE s.memory_session_id = c.memory_session_id)
    `).get().n;s!==0&&(this.db.run(`
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
    `),_.warn("DB",`Created ${s} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(t=>t.table==="sdk_sessions"&&t.from==="memory_session_id"&&t.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,s,t){let n=this.db.query(`PRAGMA table_info(${e})`).all(),r=n.filter(o=>!t.includes(o.name));for(let o of r){let a=o.type?` ${o.type}`:"",d=o.dflt_value===null||o.dflt_value===void 0?"":` DEFAULT ${o.dflt_value}`;this.db.run(`ALTER TABLE ${s} ADD COLUMN "${o.name}"${a}${d}`),_.debug("DB",`Carried ${o.name} over the ${e} rebuild (#3849)`)}return n.map(o=>o.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}_.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let t=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],r=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!t.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `);for(let a of r){let d=a.type?` ${a.type}`:"",u=a.dflt_value===null||a.dflt_value===void 0?"":` DEFAULT ${a.dflt_value}`;this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${a.name}"${d}${u}`),_.debug("DB",`Carried ${a.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`)}let o=[...t,...r.map(a=>a.name)].map(a=>`"${a}"`).join(", ");this.db.run(`
      INSERT INTO session_summaries_new (${o})
      SELECT ${o}
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),_.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}_.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),_.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}_.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),_.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}_.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `);let t=`
      CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
        prompt_text,
        content='user_prompts',
        content_rowid='id'
      );
    `,n=`
      CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;

      CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;

      CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, new.prompt_text);
      END;
    `;try{this.db.run(t),this.db.run(n)}catch(r){r instanceof Error?_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},r):_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(r))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(r=>r.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}_.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),_.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;_.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(n,r,o)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(l=>l.name===r);return a.some(l=>l.name===o)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${r} TO ${o}`),_.debug("DB",`Renamed ${n}.${r} to ${o}`),!0):(_.warn("DB",`Column ${r} not found in ${n}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?_.debug("DB",`Successfully renamed ${s} session ID columns`):_.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),_.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),s=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!s){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}_.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let t=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],n=`
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
    `,r=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,o=`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END;

      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END;
    `,a=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","discovery_tokens","created_at","created_at_epoch"],d=`
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
    `,u=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,l=`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
      END;

      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
      END;
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(n,t,r,o)),s&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(d,a,u,l)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),_.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(p){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),p instanceof Error?p:new Error(String(p))}}recreateObservationsWithCascade(e,s,t,n){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("observations","observations_new",s).map(d=>`"${d}"`).join(", ");this.db.run(`INSERT INTO observations_new (${o}) SELECT ${o} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,s,t,n){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",s).map(d=>`"${d}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${o}) SELECT ${o} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),_.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&t||(t||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),_.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&n||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${c}'`),_.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${c}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(n=>n.name==="generated_by_model"),t=e.some(n=>n.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),s=e.some(n=>n.name==="observed_model"),t=e.some(n=>n.name==="observed_billing");s&&t||(s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){ce(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(o=>o.name==="agent_type"),n=s.some(o=>o.name==="agent_id");t||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let r=this.db.query("PRAGMA table_info(pending_messages)").all();if(r.length>0){let o=r.some(d=>d.name==="agent_type"),a=r.some(d=>d.name==="agent_id");o||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let r=n instanceof Error?n:new Error(String(n));throw _.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},r),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(r=>r.name==="memory_session_id"),n=s.some(r=>r.name==="content_hash");if(!t||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw _.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},o),r}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),_.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,s){let t=this.db.prepare(`
      SELECT memory_session_id
      FROM sdk_sessions
      WHERE id = ?
    `).get(e);!t||t.memory_session_id===s||(this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(s,e),s&&this.requeuePromptSync(e))}enqueueMutationOp(e,s){if(!this.syncOpsEnabled)return;let t=JSON.parse(JSON.stringify(s));if(t.op==="set_prompt_session"){let n=t.target;n?.origin_device_id===null&&(n.origin_device_id="self")}Q(t),s.op==="set_prompt_session"&&this.db.prepare(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(s.target?.origin_device_id??null,String(s.target?.origin_local_id??"")),this.db.prepare(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,Le.randomUUID)(),String(e),JSON.stringify(s),Date.now())}requeuePromptSync(e){if(!this.syncOpsEnabled)return;let s=this.db.prepare(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!s?.memory_session_id)return;this.db.transaction(()=>{let n=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length!==0)for(let r of n){let o=J(r.sync_rev);this.db.prepare(`
          UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,r.id),this.enqueueMutationOp(o,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:r.id},fields:{memory_session_id:s.memory_session_id,project:s.project,content_session_id:s.content_session_id,platform_source:s.platform_source}})}})()}markSessionCompleted(e){let s=Date.now(),t=new Date(s).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t,s,e)}ensureMemorySessionIdRegistered(e,s,t){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);return n.memory_session_id===null?(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),this.requeuePromptSync(e),_.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,newId:s})):n.memory_session_id!==s&&_.debug("DB","Keeping the registered memory_session_id",{sessionDbId:e,registered:n.memory_session_id,offered:s}),typeof t=="number"&&n.worker_port!==t&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(t,e),n.memory_session_id??s}getAllProjects(e){let s=e?R(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[H];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",n.push(c,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...n).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${c}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${c}'), project
      ORDER BY latest_epoch DESC
    `).all(H),s=[],t=new Set,n={};for(let o of e){let a=R(o.platform_source);n[a]||(n[a]=[]),n[a].includes(o.project)||n[a].push(o.project),t.has(o.project)||(t.add(o.project),s.push(o.project))}let r=_e(Object.keys(n));return{projects:s,sources:r,projectsBySource:Object.fromEntries(r.map(o=>[o,n[o]||[]]))}}getLatestUserPrompt(e,s){let t=this.resolvePromptSessionDbId(e,s),n=t!==null?"up.session_db_id = ?":"up.content_session_id = ?",r=t!==null?t:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${c}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${n}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(r)}findRecentDuplicateUserPrompt(e,s,t,n){return fe(this.db,e,$(s),t,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,s=3,t){let n=[e],r="";return t&&(r=`AND COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`,n.push(R(t))),n.push(s),this.db.prepare(`
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
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        ${r}
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(...n)}getObservationsForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?
        )
      `,t.push(R(s))),this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch ASC
    `).all(...t)}getObservationById(e,s){return s?this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?
    `).get(e,R(s))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return pe(this.db,e)}linkToolUsesToObservation(e){return me(this.db,e)}getToolUsesByIds(e,s={}){return Te(this.db,e,s)}queryToolUses(e={}){return be(this.db,e)}countToolUses(e={}){return ge(this.db,e)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:r,platformSource:o,type:a,concepts:d,files:u}=s,l=t==="relevance",p=l?"":`ORDER BY o.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,T=n&&!l?`LIMIT ${n}`:"",I=e.map(()=>"?").join(","),A=[...e],S=[];if(r&&(S.push("(o.project = ? OR o.merged_into_project = ?)"),A.push(r,r)),o&&(S.push(`COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`),A.push(R(o))),a)if(Array.isArray(a)){let N=a.map(()=>"?").join(",");S.push(`o.type IN (${N})`),A.push(...a)}else S.push("o.type = ?"),A.push(a);if(d){let N=Array.isArray(d)?d:[d],f=N.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");A.push(...N),S.push(`(${f.join(" OR ")})`)}if(u){let N=Array.isArray(u)?u:[u],f=N.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");N.forEach(O=>{A.push(`%${O}%`,`%${O}%`)}),S.push(`(${f.join(" OR ")})`)}let E=S.length>0?`WHERE o.id IN (${I}) AND ${S.join(" AND ")}`:`WHERE o.id IN (${I})`,g=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${E}
      ${p}
      ${T}
    `).all(...A);if(!l)return g;let C=new Map(g.map(N=>[N.id,N])),m=e.map(N=>C.get(N)).filter(N=>!!N);return n?m.slice(0,n):m}getSummaryForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${c}') = ?
        )
      `,t.push(R(s))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(...t)||null}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${c}') as platform_source,
             user_prompt, custom_title, status,
             observed_model, observed_billing
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}setSessionObservedMetadata(e,s,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(s||null,t||null,e)}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${c}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e,s){let t=this.resolvePromptSessionDbId(e,s);return t!==null?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(t).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}getLatestPromptTextFromUserPrompts(e,s){let t=this.resolvePromptSessionDbId(e,s),n=t!==null?"session_db_id = ?":"content_session_id = ?",r=t!==null?t:e;return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${n}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(r)?.prompt_text??null}createSDKSession(e,s,t,n,r){let o=new Date,a=o.getTime(),d=r?R(r):c,u=$(t);n&&this.validateSetTitleMutation(e,d,n);let l=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(c,d,e);if(l){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(s,l.id),n){let T=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(l.id);T&&T.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,l.id),this.enqueueSetTitleOp(e,d,n))}return l.id}let p=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,d,u,n||null,o.toISOString(),a);return n&&this.enqueueSetTitleOp(e,d,n),Number(p.lastInsertRowid)}enqueueSetTitleOp(e,s,t){let n=this.validateSetTitleMutation(e,s,t);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,s,t){let n={op:"set_title",target:{content_session_id:e,platform_source:s},fields:{custom_title:t}};return Q(n),n}saveUserPrompt(e,s,t,n){let r=new Date,o=r.getTime(),a=$(t),d=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d,e,s,a,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,s,t){let n=this.resolvePromptSessionDbId(e,t);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,s)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,r=0,o,a){if(!t.title||t.title.trim()==="")throw new Error("storeObservation requires a non-empty title");let d=this.storeObservations(e,s,[t],null,n,r,o,a);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch}}storeSummary(e,s,t,n,r=0,o){let a=o??Date.now(),d=new Date(a).toISOString(),l=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,JSON.stringify(t.files_read??[]),JSON.stringify(t.files_edited??[]),t.notes,n||null,r,d,a);return{id:Number(l.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,t,n,r,o=0,a,d){let u=a??Date.now(),l=new Date(u).toISOString();return this.db.transaction(()=>{let T=[],I=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),A=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let E of t){if(!E.title||E.title.trim()===""){_.debug("DB","Skipping observation with empty title");continue}let y=de(e,E.title,E.narrative),g=I.get(e,s,E.type,E.title,E.subtitle,JSON.stringify(E.facts),E.narrative,JSON.stringify(E.concepts),JSON.stringify(E.files_read),JSON.stringify(E.files_modified),r||null,o,E.agent_type??null,E.agent_id??null,y,l,u,d||null,E.metadata??null);if(g){T.push(g.id);continue}let C=A.get(e,y);if(!C)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${y}`);T.push(C.id)}let S=null;if(n){let E=ye(t),y=n.files_read??E.files_read,g=n.files_edited??E.files_edited,m=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,n.request,n.investigated,n.learned,n.completed,n.next_steps,JSON.stringify(y),JSON.stringify(g),n.notes,r||null,o,l,u);S=Number(m.lastInsertRowid)}return{observationIds:T,summaryId:S,createdAtEpoch:u}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:r,platformSource:o}=s,a=t==="relevance",d=a?"":`ORDER BY ss.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,u=n&&!a?`LIMIT ${n}`:"",l=e.map(()=>"?").join(","),p=[...e],T=[];r&&(T.push("(ss.project = ? OR ss.merged_into_project = ?)"),p.push(r,r)),o&&(T.push(`COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`),p.push(R(o)));let I=T.length>0?`AND ${T.join(" AND ")}`:"",S=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${l}) ${I}
      ${d}
      ${u}
    `).all(...p);if(!a)return S;let E=new Map(S.map(g=>[g.id,g])),y=e.map(g=>E.get(g)).filter(g=>!!g);return n?y.slice(0,n):y}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:r,platformSource:o}=s,a=t==="relevance",d=a?"":`ORDER BY up.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,u=n&&!a?`LIMIT ${n}`:"",l=e.map(()=>"?").join(","),p=[...e],T=[];r&&(T.push("s.project = ?"),p.push(r)),o&&(T.push(`COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`),p.push(R(o)));let I=T.length>0?`AND ${T.join(" AND ")}`:"",S=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${c}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${l}) ${I}
      ${d}
      ${u}
    `).all(...p);if(!a)return S;let E=new Map(S.map(g=>[g.id,g])),y=e.map(g=>E.get(g)).filter(g=>!!g);return n?y.slice(0,n):y}getTimelineAroundTimestamp(e,s=10,t=10,n,r){return this.getTimelineAroundObservation(null,e,s,t,n,r)}getTimelineAroundObservation(e,s,t=10,n=10,r,o){let a=o?R(o):void 0,d=(m,N,f=!1)=>{let O=[],M=[];return r&&(f?(O.push(`(${m}.project = ? OR ${m}.merged_into_project = ?)`),M.push(r,r)):(O.push(`${m}.project = ?`),M.push(r))),a&&(O.push(`COALESCE(NULLIF(${N}.platform_source, ''), '${c}') = ?`),M.push(a)),{clause:O.length>0?`AND ${O.join(" AND ")}`:"",params:M}},u=d("o","src",!0),l=d("ss","src",!0),p=d("s","s"),T,I;if(e!==null){let m=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${u.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,N=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${u.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let f=this.db.prepare(m).all(e,...u.params,t+1),O=this.db.prepare(N).all(e,...u.params,n+1);if(f.length===0&&O.length===0)return{observations:[],sessions:[],prompts:[]};T=f.length>0?f[f.length-1].created_at_epoch:s,I=O.length>0?O[O.length-1].created_at_epoch:s}catch(f){return f instanceof Error?_.error("DB","Error getting boundary observations",{project:r},f):_.error("DB","Error getting boundary observations with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}else{let m=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${u.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,N=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${u.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let f=this.db.prepare(m).all(s,...u.params,t),O=this.db.prepare(N).all(s,...u.params,n+1);if(f.length===0&&O.length===0)return{observations:[],sessions:[],prompts:[]};T=f.length>0?f[f.length-1].created_at_epoch:s,I=O.length>0?O[O.length-1].created_at_epoch:s}catch(f){return f instanceof Error?_.error("DB","Error getting boundary timestamps",{project:r},f):_.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}let A=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${u.clause}
      ORDER BY o.created_at_epoch ASC
    `,S=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${l.clause}
      ORDER BY ss.created_at_epoch ASC
    `,E=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${c}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${p.clause}
      ORDER BY up.created_at_epoch ASC
    `,y=this.db.prepare(A).all(T,I,...u.params),g=this.db.prepare(S).all(T,I,...l.params),C=this.db.prepare(E).all(T,I,...p.params);return{observations:y,sessions:g.map(m=>({id:m.id,memory_session_id:m.memory_session_id,project:m.project,request:m.request,completed:m.completed,next_steps:m.next_steps,created_at:m.created_at,created_at_epoch:m.created_at_epoch})),prompts:C.map(m=>({id:m.id,content_session_id:m.content_session_id,prompt_number:m.prompt_number,prompt_text:m.prompt_text,project:m.project,platform_source:m.platform_source,created_at:m.created_at,created_at_epoch:m.created_at_epoch}))}}getOrCreateManualSession(e,s=c){let t=`manual-${e}`,n=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return s&&s!==c&&this.db.prepare("UPDATE sdk_sessions SET platform_source = ? WHERE memory_session_id = ?").run(s,t),t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,n,e,c,o.toISOString(),o.getTime()),_.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let s=R(e.platform_source),t=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(s,e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,s,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let s=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=null,t=e.platform_source?R(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${c}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!t||R(a.platform_source)===t)&&(s=a.id)}s===null&&(s=this.resolvePromptSessionDbId(e.content_session_id,void 0,t));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${s!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(s??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(s,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};0&&(module.exports={SessionStore,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
