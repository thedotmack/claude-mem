var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");
var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);
var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;
"use strict";var Ne=Object.defineProperty;var Zt=Object.getOwnPropertyDescriptor;var es=Object.getOwnPropertyNames;var ts=Object.prototype.hasOwnProperty;var ss=(r,e)=>{for(var s in e)Ne(r,s,{get:e[s],enumerable:!0})},ns=(r,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of es(e))!ts.call(r,n)&&n!==s&&Ne(r,n,{get:()=>e[n],enumerable:!(t=Zt(e,n))||t.enumerable});return r};var rs=r=>ns(Ne({},"__esModule",{value:!0}),r);var on={};ss(on,{SessionStore:()=>We,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS:()=>zt,rollupObservationFileLists:()=>Qt});module.exports=rs(on);var je=require("bun:sqlite"),Jt=require("crypto");var h=require("path"),Ie=require("os"),re=require("fs"),ze=require("url");var N=require("fs"),Ke=require("crypto"),y=require("path");var os=null;function is(r){return(os??process.stderr.write.bind(process.stderr))(r)}function H(r){is(r)}var _n=Promise.resolve();var as=process.platform==="win32";function be(r){return r.replace(/^\uFEFF/,"")}function Le(r){return JSON.parse(be(r))}function q(r){return Le((0,N.readFileSync)(r,"utf-8"))}function _s(r){(0,N.existsSync)(r)||(0,N.mkdirSync)(r,{recursive:!0})}function w(r,e,s={}){let t=r;try{if((0,N.lstatSync)(r).isSymbolicLink())try{t=(0,N.realpathSync)(r)}catch(c){let d=c instanceof Error?c:new Error(String(c));H(`claude-mem: realpathSync failed for ${r}, resolving symlink manually: ${d.message}
`);let l=(0,N.readlinkSync)(r);t=(0,y.resolve)((0,y.dirname)(r),l)}}catch(c){let d=c.code;if(d!=="ENOENT"&&d!=="ENOTDIR")throw c}_s((0,y.dirname)(t));let n=(0,y.dirname)(t),i=(0,y.basename)(t),o=(0,y.join)(n,`.${i}.${process.pid}.${(0,Ke.randomBytes)(6).toString("hex")}.tmp`),a=Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),_=s.mode;if(_===void 0)try{_=(0,N.statSync)(t).mode&511}catch{}let E;try{E=_!==void 0?(0,N.openSync)(o,"w",_):(0,N.openSync)(o,"w");let c=0;for(;c<a.length;){let d=(0,N.writeSync)(E,a,c,a.length-c);if(d===0)throw new Error(`writeSync stalled at ${c}/${a.length} bytes`);c+=d}if((0,N.fsyncSync)(E),(0,N.closeSync)(E),E=void 0,(0,N.renameSync)(o,t),!as){let d;try{d=(0,N.openSync)(n,"r"),(0,N.fsyncSync)(d)}catch(l){let R=l instanceof Error?l:new Error(String(l));H(`claude-mem: directory fsync failed for ${n}: ${R.message}
`)}finally{if(d!==void 0)try{(0,N.closeSync)(d)}catch{}}}}catch(c){if(E!==void 0)try{(0,N.closeSync)(E)}catch{}try{(0,N.unlinkSync)(o)}catch{}throw c}}var Es=r=>r!==null&&typeof r=="object"&&!Array.isArray(r);function Ye(r){let e=r.env;return Es(e)&&Object.keys(e).some(s=>s.startsWith("CLAUDE_MEM_"))?"nested":"flat"}function j(r){return Ye(r)==="nested"?r.env:r}function Ve(r){return Ye(r)!=="nested"?r:Object.fromEntries(Object.entries(r).filter(([e])=>!e.startsWith("CLAUDE_MEM_")))}var qe=require("os"),Je=require("path");function ne(r,e=process.platform,s=(0,qe.homedir)()){return typeof r!="string"||r.length===0?r:r==="~"?s:r.startsWith("~/")||e==="win32"&&r.startsWith("~\\")?(0,Je.join)(s,r.slice(2)):r}function ds(){return typeof __CM_DIRNAME__<"u"?__CM_DIRNAME__:(0,h.dirname)((0,ze.fileURLToPath)(__IMPORT_META_URL__))}var fn=ds();function cs(){if(process.env.CLAUDE_MEM_DATA_DIR)return ne(process.env.CLAUDE_MEM_DATA_DIR);let r=(0,h.join)((0,Ie.homedir)(),".claude-mem"),e=(0,h.join)(r,"settings.json");try{if((0,re.existsSync)(e)){let s=q(e);if(s===null||typeof s!="object"||Array.isArray(s))return r;let t=j(s);if(typeof t.CLAUDE_MEM_DATA_DIR=="string"&&t.CLAUDE_MEM_DATA_DIR)return ne(t.CLAUDE_MEM_DATA_DIR)}}catch{}return r}var D=cs(),us=(0,h.join)((0,Ie.homedir)(),".claude"),ls=process.env.CLAUDE_CONFIG_DIR||us,On=(0,h.join)(ls,"plugins","marketplaces","thedotmack"),ps=(0,h.join)(D,"logs"),oe=(0,h.join)(D,"settings.json"),Qe="claude-mem.db";var ie=(0,h.join)(D,Qe),ms=(0,h.join)(D,"observer-sessions"),J=(0,h.basename)(ms);function ae(r){(0,re.mkdirSync)(r,{recursive:!0})}var Ce={dataDir:()=>D,workerPid:()=>(0,h.join)(D,"worker.pid"),serverPid:()=>(0,h.join)(D,".server-beta.pid"),serverPort:()=>(0,h.join)(D,".server-beta.port"),serverRuntime:()=>(0,h.join)(D,".server-beta.runtime.json"),settings:()=>(0,h.join)(D,"settings.json"),database:()=>(0,h.join)(D,Qe),chroma:()=>(0,h.join)(D,"chroma"),combinedCerts:()=>(0,h.join)(D,"combined_certs.pem"),transcriptsConfig:()=>(0,h.join)(D,"transcript-watch.json"),transcriptsState:()=>(0,h.join)(D,"transcript-watch-state.json"),corpora:()=>(0,h.join)(D,"corpora"),supervisorRegistry:()=>(0,h.join)(D,"supervisor.json"),envFile:()=>(0,h.join)(D,".env"),logsDir:()=>ps};var B=require("fs"),Ze=require("path");var De=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(De||{}),he=null,Me=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;logFileDate=null;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){let e=new Date().toISOString().split("T")[0];if(!(this.logFileInitialized&&this.logFileDate===e)){this.logFileInitialized=!0,this.logFileDate=e;try{let s=Ce.logsDir();(0,B.existsSync)(s)||(0,B.mkdirSync)(s,{recursive:!0}),this.logFilePath=(0,Ze.join)(s,`claude-mem-${e}.log`)}catch(s){console.error("[LOGGER] Failed to initialize log file:",s instanceof Error?s.message:String(s)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=Ce.settings();if((0,B.existsSync)(e)){let t=(j(q(e)).CLAUDE_MEM_LOG_LEVEL||"INFO").toString().toUpperCase();this.level=De[t]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}safeStringify(e,s,t=6){let n=new WeakSet,i=(o,a)=>{if(typeof o=="bigint")return`${o}n`;if(o===null||typeof o!="object")return o;let _=o.toJSON,E=typeof _=="function"?_.call(o):o;if(typeof E=="bigint")return`${E}n`;if(E===null||typeof E!="object")return E;if(n.has(E))return"[Circular]";if(a>=t)return Array.isArray(E)?"[Array]":"[Object]";n.add(E);try{if(Array.isArray(E))return E.map(d=>i(d,a+1));let c={};for(let d of Object.keys(E))try{c[d]=i(E[d],a+1)}catch{c[d]="[unreadable]"}return c}finally{n.delete(E)}};try{return JSON.stringify(i(e,0),null,s)??String(e)}catch{return Array.isArray(e)?`[${e.length} items]`:"[unserializable]"}}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?this.safeStringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${n} ${i}:${o}:${a}.${_}`}log(e,s,t,n,i){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),a=De[e].padEnd(5),_=s.padEnd(6),E="";n?.correlationId?E=`[${n.correlationId}] `:n?.sessionId&&(E=`[session-${n.sessionId}] `);let c="";i!=null&&(i instanceof Error?c=this.getLevel()===0?`
${i.message}
${i.stack}`:` ${i.message}`:this.getLevel()===0&&typeof i=="object"?c=`
`+this.safeStringify(i,2):c=" "+this.formatData(i));let d="";if(n){let{sessionId:R,memorySessionId:O,correlationId:L,...A}=n;Object.keys(A).length>0&&(d=` {${Object.entries(A).map(([T,C])=>typeof C!="object"||C===null||C instanceof Error||C instanceof Date?`${T}=${C}`:`${T}=${Array.isArray(C)?this.safeStringify(C):this.formatData(C)}`).join(", ")}}`)}let l=`[${o}] [${a}] [${_}] ${E}${t}${d}${c}`;if(this.logFilePath)try{(0,B.appendFileSync)(this.logFilePath,l+`
`,"utf8")}catch(R){let O=R instanceof Error?R:new Error(String(R));H(`[LOGGER] Failed to write to log file: ${O.message}
${O.stack??""}
`)}else H(l+`
`)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}setErrorSink(e){he=e}error(e,s,t,n){this.log(3,e,s,t,n),this.routeErrorToSink(s,t,n)}routeErrorToSink(e,s,t){try{if(!he||!(t instanceof Error))return;he(t)}catch{}}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}},u=new Me;function F(r){let e=r.projects?.length?r.projects:r.project?[r.project]:[];return[...new Set(e.map(s=>s.trim()).filter(Boolean))]}function P(r,e,s){let t=e.map(()=>"?").join(",");return s.includeMerged?{sql:`(${r}.project COLLATE NOCASE IN (${t}) OR ${r}.merged_into_project COLLATE NOCASE IN (${t}))`,params:[...e,...e]}:{sql:`${r}.project COLLATE NOCASE IN (${t})`,params:[...e]}}function et(r,e){let s=F({projects:e});if(s.length===0)return[];let t=s.map(()=>"?").join(","),n=[`SELECT project AS key FROM sdk_sessions WHERE project COLLATE NOCASE IN (${t})`,`SELECT project FROM observations WHERE project COLLATE NOCASE IN (${t})`,`SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${t})`,`SELECT project FROM session_summaries WHERE project COLLATE NOCASE IN (${t})`,`SELECT merged_into_project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${t})`,`SELECT project FROM observations WHERE merged_into_project COLLATE NOCASE IN (${t})`,`SELECT project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (${t})`],i=r.prepare(n.join(" UNION ")).all(...n.flatMap(()=>s));return[...new Set([...s,...i.map(o=>o.key)])]}var tt=require("crypto");function Ue(r){return typeof r=="string"&&r.trim()!==""}function st(r,e,s){return(0,tt.createHash)("sha256").update([r||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}function nt(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(s=>typeof s=="string"&&s.length>0):[]}catch{return[]}}function ye(r=new Date){return r.toISOString().slice(0,10)}function rt(r,e=new Date,s=10){let t=ye(e);if(r.includes(t))return r;let n=[...r,t];return n.length>s?n.slice(n.length-s):n}function ot(r){let e=ye(new Date(r));return{dates:JSON.stringify([e]),lastReinforced:e}}function _e(r,e,s=new Date){let t=r.prepare("SELECT reinforcement_dates FROM observations WHERE id = ?").get(e);if(!t)return!1;let n=nt(t.reinforcement_dates),i=rt(n,s);return i===n?!1:(r.prepare("UPDATE observations SET reinforcement_dates = ?, last_reinforced = ? WHERE id = ?").run(JSON.stringify(i),i[i.length-1],e),!0)}var _t=require("crypto");var m="claude";function Ts(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function g(r){if(!r)return m;let e=Ts(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e.includes("kimi")?"kimi":e==="agy"||e==="antigravity"||e.startsWith("antigravity-")?"antigravity-cli":e:m}function it(r){let e=["claude","codex","antigravity-cli","cursor","kimi"];return[...r].sort((s,t)=>{let n=e.indexOf(s),i=e.indexOf(t);return n!==-1||i!==-1?n===-1?1:i===-1?-1:n-i:s.localeCompare(t)})}var Ss=64*1024,Rs=new Set(["search","timeline","get_observations","get_tool_uses","session_start_context","observation_search"]);function As(r){if(!r)return!1;if(r.startsWith("memory_"))return!0;if(!r.startsWith("mcp__"))return!1;let e=r.split("__");if(e.length<3)return!1;let s=e[1].toLowerCase(),t=e.slice(2).join("__");return(s.includes("claude-mem")||s.includes("claude_mem")||s.includes("mcp-search")||s.includes("cmem"))&&Rs.has(t)}function at(r,e=Ss){let s=Buffer.byteLength(r,"utf8");if(s<=e)return r;let t=Buffer.from(r,"utf8"),n=e;for(;n>0&&(t[n]&192)===128;)n--;return`${t.subarray(0,n).toString("utf8")}\u2026[truncated: ${s} bytes]`}function fs(r,e,s){return(0,_t.createHash)("sha256").update([r||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}function Et(r){r.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${m}',
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
  `),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)"),r.run("CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)")}function dt(r,e){if(!e.toolUseId||!e.contentSessionId||!e.toolName||As(e.toolName))return null;let s=e.createdAtEpoch??Date.now(),t=new Date(s).toISOString(),n=fs(e.toolName,e.toolInput,e.toolResponse),i=e.toolInput!=null?at(e.toolInput):null,o=e.toolResponse!=null?at(e.toolResponse):null,a=r.prepare(`
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
  `).get(e.toolUseId,e.contentSessionId,e.memorySessionId??null,e.sessionDbId??null,e.project??"",g(e.platformSource),e.toolName,i,o,e.cwd??null,e.promptNumber??null,e.agentType??null,e.agentId??null,e.orGenerationId??null,e.orSessionId??null,n,t,s);return a?a.id:null}function ct(r,e){let s=e.toolUseIds.filter(i=>typeof i=="string"&&i.length>0);if(s.length===0)return 0;let t=s.map(()=>"?").join(","),n=r.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = COALESCE(?, memory_session_id)
    WHERE content_session_id = ?
      AND tool_use_id IN (${t})
  `).run(e.observationId,e.memorySessionId??null,e.contentSessionId,...s);return Number(n.changes??0)}function ut(r){return r?{clause:`COALESCE(NULLIF(platform_source, ''), '${m}') = ?`,param:g(r)}:null}function lt(r,e,s={}){let t=[],n=[];for(let c of e){if(typeof c=="number"&&Number.isInteger(c)){t.push(c);continue}if(typeof c=="string"&&c.trim().length>0){let d=Number(c);Number.isInteger(d)&&String(d)===c.trim()&&t.push(d),n.push(c.trim())}}if(t.length===0&&n.length===0)return[];let i=[],o=[];t.length>0&&(i.push(`id IN (${t.map(()=>"?").join(",")})`),o.push(...t)),n.length>0&&(i.push(`tool_use_id IN (${n.map(()=>"?").join(",")})`),o.push(...n));let a=[`(${i.join(" OR ")})`];s.project&&(a.push("project = ?"),o.push(s.project)),s.contentSessionId&&(a.push("content_session_id = ?"),o.push(s.contentSessionId));let _=ut(s.platformSource);_&&(a.push(_.clause),o.push(_.param));let E=s.limit&&s.limit>0?`LIMIT ${Math.floor(s.limit)}`:"";return r.prepare(`
    SELECT * FROM tool_uses
    WHERE ${a.join(" AND ")}
    ORDER BY created_at_epoch DESC
    ${E}
  `).all(...o)}function pt(r,e={}){let s=[],t=[];if(e.project&&(s.push("project = ?"),t.push(e.project)),e.contentSessionId&&(s.push("content_session_id = ?"),t.push(e.contentSessionId)),e.memorySessionId&&(s.push("memory_session_id = ?"),t.push(e.memorySessionId)),typeof e.sessionDbId=="number"&&(s.push("session_db_id = ?"),t.push(e.sessionDbId)),e.toolName){let E=Array.isArray(e.toolName)?e.toolName:[e.toolName];E.length>0&&(s.push(`tool_name IN (${E.map(()=>"?").join(",")})`),t.push(...E))}e.agentId&&(s.push("agent_id = ?"),t.push(e.agentId));let n=ut(e.platformSource);n&&(s.push(n.clause),t.push(n.param)),typeof e.dateStart=="number"&&(s.push("created_at_epoch >= ?"),t.push(e.dateStart)),typeof e.dateEnd=="number"&&(s.push("created_at_epoch <= ?"),t.push(e.dateEnd));let i=s.length>0?`WHERE ${s.join(" AND ")}`:"",o=e.orderBy==="date_asc"?"ASC":"DESC",a=Math.min(Math.max(Math.floor(e.limit??50),1),500),_=Math.max(Math.floor(e.offset??0),0);return r.prepare(`
    SELECT * FROM tool_uses
    ${i}
    ORDER BY created_at_epoch ${o}, id ${o}
    LIMIT ${a} OFFSET ${_}
  `).all(...t)}function mt(r,e={}){let s=[],t=[];e.project&&(s.push("project = ?"),t.push(e.project)),e.contentSessionId&&(s.push("content_session_id = ?"),t.push(e.contentSessionId)),e.agentId&&(s.push("agent_id = ?"),t.push(e.agentId)),typeof e.dateStart=="number"&&(s.push("created_at_epoch >= ?"),t.push(e.dateStart)),typeof e.dateEnd=="number"&&(s.push("created_at_epoch <= ?"),t.push(e.dateEnd));let n=s.length>0?`WHERE ${s.join(" AND ")}`:"";return r.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${n}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...t)}var X=require("fs"),x=require("path"),z=require("os");var Ee={HEALTH_CHECK:3e3,API_REQUEST:3e4,SESSION_INIT_HOOK_CAP:15e3,SESSION_INIT_REQUEST:1e4,SESSION_INIT_REQUEST_MAX:14e3,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function Os(r=process.platform){return r==="win32"?8e3:5e3}function Tt(r=process.platform){return Ee.SESSION_INIT_HOOK_CAP-Os(r)}function St(r){return process.platform==="win32"?Math.round(r*Ee.WINDOWS_MULTIPLIER):r}function Rt(r){try{return new URL(r).hostname.toLowerCase()==="openrouter.ai"}catch{return!1}}var gs="security_alert",Ns="sync-hub.black-pond-afbb.workers.dev",bs="https://sync.cmem.ai",Ls=new Set(["xiaomi/mimo-v2-flash:free"]);function Is(r){let e=r.CLAUDE_MEM_OPENROUTER_MODEL;if(typeof e!="string"||!Ls.has(e.trim()))return!1;let s=typeof r.CLAUDE_MEM_OPENROUTER_BASE_URL=="string"?r.CLAUDE_MEM_OPENROUTER_BASE_URL.trim():"";return s===""||Rt(s)}var At=18e4,ft=[{key:"CLAUDE_MEM_LLM_TIMEOUT_MS",legacy:"30000",markerTag:"llm-timeout-migrated-v1"},{key:"CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS",legacy:"30000",markerTag:"field-optimize-timeout-migrated-v1"}];function gt(r,e){return(0,x.join)((0,x.dirname)(r),`.${(0,x.basename)(r)}.${e.markerTag}`)}function ve(r,e){try{(0,X.writeFileSync)(gt(r,e),new Date().toISOString(),{encoding:"utf-8",mode:384})}catch{}}var Ot=new Set;function Cs(r){if(typeof r!="string")return null;let e=r.trim();if(e.length===0)return null;try{if(new URL(e).hostname===Ns)return bs}catch{return null}return null}var W=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES:"false",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_ALLOWED_ORIGINS:"",CLAUDE_MEM_PUBLIC_URL:"",CLAUDE_MEM_API_TIMEOUT_MS:String(St(Ee.API_REQUEST)),CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS:String(Tt()),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_SKIP_BASH_PATTERNS:"",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_CAPTURE_ADVISOR_CALLS:"false",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_MEDIA_CAPTURE_ENABLED:"false",CLAUDE_MEM_MEDIA_INFERENCE_ENABLED:"false",CLAUDE_MEM_CODEX_MODEL:"",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"low",CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE:"8",CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS:"32000",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_API_KEYS:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-flash-latest",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_API_KEYS:"",CLAUDE_MEM_OPENROUTER_MODEL:"cohere/north-mini-code:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENAI_COMPAT_PRESET:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_API_KEYS:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"",CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER:"",CLAUDE_MEM_QUOTA_FALLBACK_MODEL:"",CLAUDE_MEM_DATA_DIR:(0,x.join)((0,z.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CLAUDE_CONFIG_DIR:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:"",CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:"",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY:"true",CLAUDE_MEM_REINFORCE_ALPHA:"0",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,x.join)((0,z.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_CODEX_SUBAGENT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS:"400000",CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW:"",CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS:"4096",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_REDACT_ENABLED:"false",CLAUDE_MEM_REDACT_DISABLED_BUILTINS:"",CLAUDE_MEM_REDACT_CUSTOM_PATTERNS:"[]",CLAUDE_MEM_REDACT_LOG_MATCHES:"false",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_PROJECT_ENVIRONMENTS:"[]",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS:"600000",CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS:"5000",CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,z.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE:"40",CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS:"90000",CLAUDE_MEM_LLM_TIMEOUT_MS:String(At),CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS:String(At),CLAUDE_MEM_TV_TOKEN:"",CLAUDE_MEM_PRO_TRIAL_EMAIL:"",CLAUDE_MEM_PRO_TRIAL_AT:"",CLAUDE_MEM_PRO_TRIAL_STATE:"",CLAUDE_MEM_PRO_TRIAL_ENDS_AT:"",CLAUDE_MEM_PRO_PLAN:"",CLAUDE_MEM_PRO_FALLBACK_AT:"",CLAUDE_MEM_PRO_FALLBACK_MESSAGE:"",CLAUDE_MEM_PRO_FALLBACK_ACTION:"",CLAUDE_MEM_PRO_FALLBACK_URL:"",CLAUDE_MEM_PRO_MEMORY_KEY:"",CLAUDE_MEM_PRO_MEMORY_BASE_URL:"",CLAUDE_MEM_PRO_MEMORY_MODEL:"",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED:"true",CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED:"false",CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES:"{}",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert,sensitive",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED:"true",CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS:"521e962d-2ec3-4488-bfbc-54d5209ce118,95601360-61f7-4fd9-bb3a-2c976b2b85c0",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_URL:"",CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET:"",CLAUDE_MEM_GROK_BOT_INJECT_ENABLED:"true",CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS:"*",CLAUDE_MEM_GROK_BOT_INJECT_TIER:"episode",CLAUDE_MEM_GROK_BOT_INJECT_WINDOW:"80",CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK:"house",CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE:"",CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT:"",CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS:"160",CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS:"1500",CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE:"",CLAUDE_MEM_CCS_ALIGN_ENABLED:"true",CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS:"ccs-align",CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES:"decision,bugfix,security_alert,sensitive",CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS:"false",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:"",CLAUDE_MEM_DEDUP_ENABLED:"false",CLAUDE_MEM_DEDUP_COSINE_THRESHOLD:"0.80",CLAUDE_MEM_DEDUP_IDF_VETO_DF:"10",CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS:"2",CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS:"10",CLAUDE_MEM_DEDUP_MAX_SCAN:"2000",CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS:"50000",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_PROJECT_NAME_SOURCE:"path"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){let s=process.env[e]??this.DEFAULTS[e];return e==="CLAUDE_MEM_WORKER_HOST"?this.normalizeWorkerHost(s):s}static normalizeWorkerHost(e){return e==="localhost"?"127.0.0.1":e}static finalizeSettings(e,s){let t=s?this.applyEnvOverrides(e):e;return t.CLAUDE_MEM_WORKER_HOST=this.normalizeWorkerHost(t.CLAUDE_MEM_WORKER_HOST),t}static getInt(e){let s=this.get(e);return parseInt(s,10)}static applyEnvOverrides(e){let s={...e};for(let t of Object.keys(this.DEFAULTS))process.env[t]!==void 0&&(s[t]=process.env[t]);return s}static loadFromFile(e,s=!0){try{if(!(0,X.existsSync)(e)){let d=this.getAllDefaults();try{w(e,d,{mode:384});for(let l of ft)ve(e,l);console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(l){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,l instanceof Error?l.message:String(l))}return this.finalizeSettings(d,s)}let t=(0,X.readFileSync)(e,"utf-8"),n=Le(t),i=j(n),o=i!==n,a=Ve(n),_=o&&Object.keys(a).some(d=>d!=="env");if(o&&!_)try{w(e,i,{mode:384}),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(d){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,d instanceof Error?d.message:String(d))}if(i.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES===gs){i={...i,CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES};try{w(e,_?{...a,env:i}:i,{mode:384}),console.warn("[SETTINGS] Migrated Telegram trigger types off the legacy default:",e)}catch(d){console.warn("[SETTINGS] Failed to migrate Telegram trigger types:",e,d instanceof Error?d.message:String(d))}}if(Is(i)){let d=String(i.CLAUDE_MEM_OPENROUTER_MODEL).trim();i={...i,CLAUDE_MEM_OPENROUTER_MODEL:this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL};try{w(e,_?{...a,env:i}:i,{mode:384}),console.warn(`[SETTINGS] Migrated OpenRouter model off the retired default ${d} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,e)}catch(l){console.warn("[SETTINGS] Failed to migrate the retired OpenRouter model:",e,l instanceof Error?l.message:String(l))}}let E=Cs(i.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);if(E!==null){i={...i,CLAUDE_MEM_CLOUD_SYNC_HUB_URL:E};try{w(e,_?{...a,env:i}:i,{mode:384}),console.warn("[SETTINGS] Migrated cloud sync hub URL off the legacy workers.dev host:",e)}catch(d){console.warn("[SETTINGS] Failed to migrate cloud sync hub URL:",e,d instanceof Error?d.message:String(d))}}for(let d of ft)if(!(0,X.existsSync)(gt(e,d))){if(i[d.key]!==d.legacy){ve(e,d);continue}i={...i,[d.key]:this.DEFAULTS[d.key]};try{w(e,_?{...a,env:i}:i,{mode:384}),ve(e,d),console.warn(`[SETTINGS] Migrated ${d.key} off the old ${d.legacy}ms default to ${this.DEFAULTS[d.key]}ms:`,e)}catch(l){let R=`${d.key}\0${e}`;Ot.has(R)||(Ot.add(R),console.warn(`[SETTINGS] Failed to migrate ${d.key}; using the new default in memory (reported once per process):`,e,l instanceof Error?l.message:String(l)))}}let c={...this.DEFAULTS};for(let d of Object.keys(this.DEFAULTS))i[d]!==void 0&&(c[d]=i[d]);return this.finalizeSettings(c,s)}catch(t){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t instanceof Error?t.message:String(t));let n=this.getAllDefaults();return this.finalizeSettings(n,s)}}};var Ct=require("crypto");function Q(r){return(r??"").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu," ").replace(/\s+/g," ").trim()}function G(r){return(r??"").toLowerCase().trim().split(/\s+/).filter(Boolean)}function de(r,e){return Math.log(1+e/(r+.5))}function Nt(r,e){return s=>de(r(s),e)}function bt(r,e){let s=new Map;for(let t of new Set(r))s.set(t,e(t));return s}function Lt(r,e,s){let t=bt(r,s),n=bt(e,s),i=0,o=0,a=0;for(let[_,E]of t){o+=E*E;let c=n.get(_);c!==void 0&&(i+=E*c)}for(let[,_]of n)a+=_*_;return o===0||a===0?0:i/Math.sqrt(o*a)}function It(r,e,s,t){let n=new Set(r),i=new Set(e);for(let o of n)if(!i.has(o)&&s(o)>t)return!0;for(let o of i)if(!n.has(o)&&s(o)>t)return!0;return!1}function Fe(r,e,s,t){let n=Q(r);if(n!==""&&n===Q(e))return{tier:"exact",method:"exact",score:1};let i=G(r),o=G(e),a=t.minSharedTokens??2,_=new Set(o),E=0;for(let d of new Set(i))_.has(d)&&E++;if(E<a)return{tier:"none",method:"none",score:0};let c=Lt(i,o,s);return c>=t.cosineThreshold&&!It(i,o,s,t.vetoThetaIdf)?{tier:"candidate",method:"idf_cosine",score:c}:{tier:"none",method:"none",score:c}}function ce(r,e){return!!r&&!!e}function we(r,e,s,t=!1){let n=Q(s);if(n==="")return null;let i=g(e),o=t?"subagent":"main";return(0,Ct.createHash)("sha256").update(`${r}\0${i}\0${o}\0${n}`).digest("hex").slice(0,32)}function ht(r,e,s){return s===null?null:r.prepare("SELECT id, occurrence_count, created_at_epoch FROM observations WHERE project = ? AND title_norm_key = ? ORDER BY created_at_epoch ASC, id ASC LIMIT 1").get(e,s)??null}function Dt(r,e,s){let t=[...new Set(G(s))],n=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, 1) ON CONFLICT(project, token) DO UPDATE SET df = df + 1");for(let i of t)n.run(e,i);r.prepare("INSERT INTO dedup_meta (project, doc_count) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET doc_count = doc_count + 1").run(e)}function Mt(r,e){return r.prepare("SELECT doc_count FROM dedup_meta WHERE project = ?").get(e)?.doc_count??0}function Ut(r,e){let s=Mt(r,e),t=r.prepare("SELECT token, df FROM token_df WHERE project = ?").all(e),n=new Map(t.map(i=>[i.token,i.df]));return{idfFn:Nt(i=>n.get(i)??0,s),docCount:s}}function yt(r){return r.prepare("INSERT OR IGNORE INTO observation_dedup_candidates (observation_id, duplicate_of_id, project, method, score, status, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")}function vt(r,e,s){return Mt(r,e)>=s}function hs(r,e,s=Number.POSITIVE_INFINITY){let t=r.prepare("SELECT COUNT(*) c FROM observations WHERE project = ?").get(e).c;if(t>s)return u.warn("DEDUP",`Skipping dedup backfill for project ${e}: ${t} rows exceeds cap ${s} (CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS)`),0;let n=r.prepare("SELECT o.id, o.title, o.agent_id, o.agent_type, s.platform_source FROM observations o LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id WHERE o.project = ?").all(e),i=r.prepare("UPDATE observations SET title_norm_key = ? WHERE id = ?"),o=r.prepare("INSERT INTO token_df (project, token, df) VALUES (?, ?, ?)");return r.transaction(()=>{let _=new Map;for(let E of n){i.run(we(e,E.platform_source,E.title,ce(E.agent_id,E.agent_type)),E.id);for(let c of new Set(G(E.title)))_.set(c,(_.get(c)??0)+1)}r.prepare("DELETE FROM token_df WHERE project = ?").run(e);for(let[E,c]of _)o.run(e,E,c);r.prepare("INSERT INTO dedup_meta (project, doc_count, last_rebuild_doc_count, deleted_since_rebuild) VALUES (?, ?, ?, 0) ON CONFLICT(project) DO UPDATE SET doc_count = excluded.doc_count, last_rebuild_doc_count = excluded.last_rebuild_doc_count, deleted_since_rebuild = 0").run(e,n.length,n.length)})(),n.length}function Ds(r,e,s){let t=r.prepare("SELECT id, title FROM observations WHERE project = ? AND title IS NOT NULL ORDER BY id ASC").all(e);if(t.length<2)return 0;if(t.length>s.maxBackfillRows)return u.warn("DEDUP",`Skipping dedup sweep for project ${e}: ${t.length} rows exceeds cap ${s.maxBackfillRows}`),0;let{idfFn:n,docCount:i}=Ut(r,e),o={cosineThreshold:s.cosineThreshold,vetoThetaIdf:de(s.idfVetoDf,i),minSharedTokens:s.minSharedTokens},a=t.map(A=>new Set(G(A.title))),_=new Map;for(let A of a)for(let f of A)_.set(f,(_.get(f)??0)+1);let E=Math.max(2,Math.ceil(Math.sqrt(t.length))*4),c=new Map;a.forEach((A,f)=>{for(let T of A){let C=_.get(T);if(C<2||C>E)continue;let S=c.get(T);S||(S=[],c.set(T,S)),S.push(f)}});let d=new Map;for(let A of c.values())for(let f=0;f<A.length;f++)for(let T=f+1;T<A.length;T++){let C=`${A[f]}:${A[T]}`;d.set(C,(d.get(C)??0)+1)}let l=yt(r),R=new Date().toISOString(),O=Date.now(),L=0;for(let[A,f]of d){if(f<s.minSharedTokens)continue;let[T,C]=A.split(":").map(Number),S=Fe(t[T].title,t[C].title,n,o);S.tier==="candidate"&&(L+=l.run(t[C].id,t[T].id,e,S.method,S.score,"pending",R,O).changes)}return L}function Ft(r,e){return r.prepare("SELECT DISTINCT project FROM observations").all().map(t=>t.project).map(t=>{let n=hs(r,t,e.maxBackfillRows),i=Ds(r,t,e);return{project:t,docs:n,candidates:i}})}function wt(r,e,s,t,n){if(!t)return 0;let{idfFn:i,docCount:o}=Ut(r,e),a={cosineThreshold:n.cosineThreshold,vetoThetaIdf:de(n.idfVetoDf,o),minSharedTokens:n.minSharedTokens},_=r.prepare("SELECT id, title FROM observations WHERE project = ? AND id != ? AND title IS NOT NULL ORDER BY created_at_epoch DESC, id DESC LIMIT ?").all(e,s,n.maxScan);_.length===n.maxScan&&u.debug("DEDUP",`Tier-1 scan hit MAX_SCAN=${n.maxScan} for project ${e}; older rows covered by dedup-scan`);let E=yt(r),c=new Date().toISOString(),d=Date.now(),l=0;for(let R of _){let O=Fe(t,R.title,i,a);O.tier==="candidate"&&(l+=E.run(s,R.id,e,O.method,O.score,"pending",c,d).changes)}return l}function Pt(r,e,s,t,n){let i=Date.now()-t,o=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return r.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${m}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${o}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,s,i)??void 0}var ue=require("fs");var Ms=[{name:"aws_access_key",regex:/AKIA[0-9A-Z]{16}/g},{name:"aws_secret_key",regex:/(?<=AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g},{name:"github_pat",regex:/\bgh[oprs]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g},{name:"openai_key",regex:/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g},{name:"anthropic_key",regex:/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g},{name:"slack_token",regex:/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g},{name:"jwt",regex:/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g},{name:"private_key_pem",regex:/-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g},{name:"stripe_key",regex:/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g},{name:"google_api_key",regex:/\bAIza[0-9A-Za-z_-]{35}\b/g},{name:"claude_mem_key",regex:/\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g}],Us=1024*1024,ys="<redacted type='oversize'/>";function Bt(r,e){if(!e.enabled||r.length===0)return{redacted:r,counts:{},oversize:!1};if(r.length>Us)return u.warn("REDACT","field exceeds the 1M-char redaction cap; replaced by an oversize marker",void 0,{inputLength:r.length}),{redacted:ys,counts:{oversize:1},oversize:!0};let s=new Set(e.disabledBuiltinPatterns??[]),t={},n=r,i=[];for(let a of e.customPatterns??[]){if(!a.name||a.name.length===0){u.warn("REDACT","custom pattern skipped: missing name",void 0,{pattern:a});continue}try{i.push({name:a.name,regex:new RegExp(a.regex,"g")})}catch(_){u.warn("REDACT","custom pattern skipped: invalid regex",{name:a.name},_ instanceof Error?_:new Error(String(_)))}}let o=[...i,...Ms];for(let a of o)s.has(a.name)||(a.regex.lastIndex=0,n=n.replace(a.regex,()=>(t[a.name]=(t[a.name]??0)+1,`<redacted type='${a.name}'/>`)));return e.logMatches&&Object.keys(t).length>0&&u.debug("REDACT","patterns matched",void 0,{counts:t}),{redacted:n,counts:t,oversize:!1}}function vs(r){if(!r||r.trim()==="")return[];try{let e=JSON.parse(r);return Array.isArray(e)?e.filter(s=>s&&typeof s.name=="string"&&typeof s.regex=="string"):(u.warn("REDACT","CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring"),[])}catch(e){return u.warn("REDACT","failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON",void 0,e instanceof Error?e:new Error(String(e))),[]}}function Fs(r){return{enabled:r.CLAUDE_MEM_REDACT_ENABLED==="true",disabledBuiltinPatterns:(r.CLAUDE_MEM_REDACT_DISABLED_BUILTINS??"").split(",").map(e=>e.trim()).filter(Boolean),customPatterns:vs(r.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS??"[]"),logMatches:r.CLAUDE_MEM_REDACT_LOG_MATCHES==="true"}}var Z=null,xt=0,ws=5e3,ee=null,kt=!1,Ps={enabled:!0,disabledBuiltinPatterns:[],customPatterns:[],logMatches:!1},xs=/"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;function ks(r){if(!(0,ue.existsSync)(r))return null;try{return(0,ue.readFileSync)(r,"utf-8")}catch{return""}}function Bs(r){if(r===null)return!1;try{let e=JSON.parse(be(r));return e===null||typeof e!="object"||Array.isArray(e)}catch{return!0}}function Xs(r,e,s){return process.env.CLAUDE_MEM_REDACT_ENABLED==="false"||!(ee?.enabled===!0||xs.test(e))?s:(kt||(kt=!0,u.warn("REDACT","settings.json could not be read; secret redaction stays on until it is repaired",{settingsPath:r,using:ee?.enabled?"the last configuration that loaded":"the built-in patterns"})),ee?.enabled?ee:Ps)}function Xt(r=oe){let e=Date.now();if(Z&&e-xt<ws)return Z;let s=W.loadFromFile(r),t=Fs(s),n=t.enabled?null:ks(r);return Bs(n)?Z=Xs(r,n,t):(Z=t,ee=t),xt=e,Z}var Ht=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],Gt=new RegExp(`<(${Ht.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g");var $t=100;function Gs(r){let e=Object.fromEntries(Ht.map(i=>[i,0]));Gt.lastIndex=0;let s=0,t=r.replace(Gt,(i,o)=>(e[o]=(e[o]??0)+1,s+=1,""));return s>$t&&u.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:$t,contentLength:r.length}),{stripped:Bt(t.trim(),Xt()).redacted,counts:e}}function jt(r){return Gs(r).stripped}var $s=["task-notification"],Rr=new RegExp(`^\\s*<(${$s.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Ar=256*1024;var Pe=4e3,xe="[media prompt]";function le(r){let e=r.trim(),t=jt(r).trim()||e;return t.length<=Pe?t:(u.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:t.length,storedLength:Pe}),`${t.slice(0,Pe-1)}\u2026`)}var Hs=require("bun:sqlite");var js=5e3,Ws=4194304;function Ks(r){return r.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function K(r,e,s){try{r.run(e)}catch(t){let n=t instanceof Error?t:new Error(String(t));throw u.warn("DB",`Failed to apply SQLite pragma ${s}`,{sql:e},n),t}}function pe(r,e={}){let{enableWal:s=!0,enableIncrementalAutoVacuum:t=!0}=e;K(r,`PRAGMA busy_timeout = ${js}`,"busy_timeout"),K(r,"PRAGMA foreign_keys = ON","foreign_keys"),K(r,"PRAGMA synchronous = NORMAL","synchronous"),K(r,`PRAGMA journal_size_limit = ${Ws}`,"journal_size_limit"),t&&!Ks(r)&&K(r,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),s&&K(r,"PRAGMA journal_mode = WAL","journal_mode")}function ke(r){let e=`a.id IN (${r.candidateAttachmentIdsSql})
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
      WHERE id IN (SELECT a.id FROM media_attachments a WHERE ${e})`]}var Te="SELECT event_key FROM media_events WHERE session_db_id=OLD.id",Ys=ke({candidateAttachmentIdsSql:"SELECT attachment_id FROM observation_media_links WHERE observation_id=OLD.id",eventRefsBeingRemovedSql:"0",observationLinksBeingRemovedSql:"l.observation_id=OLD.id"}),Vs=ke({candidateAttachmentIdsSql:`SELECT attachment_id FROM media_event_refs WHERE event_key IN (${Te})`,eventRefsBeingRemovedSql:`r.event_key IN (${Te})`,observationLinksBeingRemovedSql:"0"}),Ir=ke({candidateAttachmentIdsSql:"SELECT attachment_id FROM media_event_refs WHERE event_key=$eventKey",eventRefsBeingRemovedSql:"r.event_key=$eventKey",observationLinksBeingRemovedSql:"0"});function Wt(r){r.transaction(()=>{r.exec(`
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
      -- v62: durable source-event -> observation result mapping, written in the
      -- storeObservations transaction so a replayed event recovers its committed
      -- result without another model call.
      CREATE TABLE IF NOT EXISTS media_event_results (
        event_key TEXT NOT NULL, observation_id INTEGER NOT NULL,
        PRIMARY KEY(event_key, observation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_event_results_observation ON media_event_results(observation_id);
      -- v63: durable cloud media deletions (offline-safe). Drained by
      -- MediaCloudSync; a row survives restarts and reconnects.
      CREATE TABLE IF NOT EXISTS media_cloud_deletions (
        attachment_id TEXT PRIMARY KEY, queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `),me(r,"origin","TEXT NOT NULL DEFAULT 'native'"),me(r,"upload_attempts","INTEGER NOT NULL DEFAULT 0"),me(r,"upload_retry_at","INTEGER NOT NULL DEFAULT 0"),me(r,"upload_error","TEXT"),r.exec("CREATE INDEX IF NOT EXISTS idx_media_attachments_upload ON media_attachments(upload_state, upload_retry_at)"),r.exec(`
      -- Recreated every startup so an older trigger definition never lingers.
      DROP TRIGGER IF EXISTS media_observation_delete;
      CREATE TRIGGER media_observation_delete AFTER DELETE ON observations BEGIN
        ${Ys.join(`;
        `)};
        DELETE FROM observation_media_links WHERE observation_id=OLD.id;
        DELETE FROM media_event_results WHERE observation_id=OLD.id;
      END;
      DROP TRIGGER IF EXISTS media_session_delete;
      CREATE TRIGGER media_session_delete BEFORE DELETE ON sdk_sessions BEGIN
        ${Vs.join(`;
        `)};
        DELETE FROM media_event_refs WHERE event_key IN (${Te});
        DELETE FROM media_event_results WHERE event_key IN (${Te});
        UPDATE media_events SET state='deleted' WHERE session_db_id=OLD.id;
      END;
    `);let e=new Date().toISOString();r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(61,e),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(62,e),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(63,e)})()}function me(r,e,s){r.prepare("PRAGMA table_info(media_attachments)").all().some(n=>n.name===e)||r.exec(`ALTER TABLE media_attachments ADD COLUMN ${e} ${s}`)}var Ge=require("bun:sqlite");function Se(r){return r.replace(/\\/g,"/").replace(/\/+/g,"/").replace(/\/+$/,"")}function Be(r,e){let s=Se(r),t=Se(e);if(s.startsWith(t+"/"))return!s.slice(t.length+1).includes("/");let n=t.split("/"),i=s.split("/");if(i.length<2)return t===""||t===".";let o=i.slice(0,-1).join("/"),a=i[i.length-1];if(t.endsWith("/"+o)||t===o)return!a.includes("/");for(let _=0;_<n.length;_++)if(n.slice(_).join("/")===o)return!0;return!1}var qs=/^\d{4}-\d{2}-\d{2}$/;function $(r,e){if(typeof r=="number")return r;let s=new Date(r).getTime();return e==="end"&&qs.test(r.trim())?s+864e5-1:s}var Xe="\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF",Re=`
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
`,Ae=`
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
`,Kt=class r{db;constructor(e=ie){e instanceof Ge.Database?this.db=e:(ae(D),this.db=new Ge.Database(e)),pe(this.db),this._fts5Available=this.isFts5Available(),this.ensureFTSTables()}_fts5Available;ensureFTSTables(){if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all().some(t=>t.name==="observations_fts"||t.name==="session_summaries_fts")){if(!this.isFts5Available()){u.warn("DB","FTS5 not available on this platform \u2014 skipping FTS table creation (search uses ChromaDB)");return}u.info("DB","Creating FTS5 tables");try{this.createFTSTablesAndTriggers(),u.info("DB","FTS5 tables created successfully")}catch(t){this._fts5Available=!1,u.warn("DB","FTS5 table creation failed \u2014 search will use ChromaDB and LIKE queries",{},t instanceof Error?t:void 0)}}}isFts5Available(){try{return this.db.run("CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)"),this.db.run("DROP TABLE _fts5_probe"),!0}catch(e){return u.debug("DB","FTS5 probe failed \u2014 FTS5 unavailable on this platform",void 0,e instanceof Error?e:new Error(String(e))),!1}}createFTSTablesAndTriggers(){this.db.run(`
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
    `),this.db.run(Re),this.db.run(`
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
    `),this.db.run(Ae)}buildFilterClause(e,s,t="o"){let n=[],i=F(e);if(i.length>0){let o=P(t,i,{includeMerged:!0});n.push(o.sql),s.push(...o.params)}if(e.platformSource&&(n.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = ${t}.memory_session_id), ''), '${m}') = ?`),s.push(g(e.platformSource))),e.type)if(Array.isArray(e.type)){let o=e.type.map(()=>"?").join(",");n.push(`${t}.type IN (${o})`),s.push(...e.type)}else n.push(`${t}.type = ?`),s.push(e.type);if(e.dateRange){let{start:o,end:a}=e.dateRange;o&&(n.push(`${t}.created_at_epoch >= ?`),s.push($(o,"start"))),a&&(n.push(`${t}.created_at_epoch <= ?`),s.push($(a,"end")))}if(e.concepts){let o=Array.isArray(e.concepts)?e.concepts:[e.concepts],a=o.map(()=>`EXISTS (SELECT 1 FROM json_each(${t}.concepts) WHERE value = ?)`);a.length>0&&(n.push(`(${a.join(" OR ")})`),s.push(...o))}if(e.files){let o=Array.isArray(e.files)?e.files:[e.files],a=o.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${t}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${t}.files_modified) WHERE value LIKE ?)
        )`);a.length>0&&(n.push(`(${a.join(" OR ")})`),o.forEach(_=>{s.push(`%${_}%`,`%${_}%`)}))}return n.length>0?n.join(" AND "):""}static UNSEGMENTED_SCRIPT=new RegExp(`[${Xe}]`);static UNSEGMENTED_RUN=new RegExp(`[${Xe}]+|[^\\s${Xe}]+`,"g");static MAX_SUBSTRING_TERMS=500;static buildSubstringClause(e,s){let t=[...new Set(e.match(r.UNSEGMENTED_RUN)??[])].slice(0,r.MAX_SUBSTRING_TERMS);t.length===0&&t.push(e);let n=[];return{clause:`(${t.map(o=>{let a=`%${o.replace(/[\\%_]/g,"\\$&")}%`;for(let _=0;_<s.length;_+=1)n.push(a);return`(${s.map(_=>`${_} LIKE ? ESCAPE '\\'`).join(" OR ")})`}).join(" AND ")})`,params:n}}static buildFTSMatchQuery(e){let s=(e.match(/\S+/g)??[]).filter(t=>/[\p{L}\p{N}]/u.test(t));return s.length===0?`"${e.replace(/"/g,'""')}"`:s.map(t=>`"${t.replace(/"/g,'""')}"`).join(" AND ")}buildOrderClause(e="relevance",s=!0,t="observations_fts"){switch(e){case"relevance":return s?`ORDER BY ${t}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservationsBySubstring(e,s,t,n,i){let o=r.buildSubstringClause(e,["o.title","o.subtitle","o.narrative","o.text","o.facts","o.concepts"]),a=[],_=this.buildFilterClause(s,a,"o"),E=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${o.clause}
      ${_?"AND "+_:""}
      ${this.buildOrderClause(t,!1)}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(E).all(...o.params,...a,n,i)}searchSessionsBySubstring(e,s,t,n,i){let o=r.buildSubstringClause(e,["s.request","s.investigated","s.learned","s.completed","s.next_steps","s.notes"]),a={...s};delete a.type;let _=[],E=this.buildFilterClause(a,_,"s"),c=t==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC",d=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${o.clause}
      ${E?"AND "+E:""}
      ${c}
      LIMIT ? OFFSET ?
    `;return this.db.prepare(d).all(...o.params,..._,n,i)}searchObservations(e,s={}){let t=[],{limit:n=50,offset:i=0,orderBy:o="relevance",...a}=s;if(!e){let _=this.buildFilterClause(a,t,"o");if(!_)return[];let E=this.buildOrderClause(o,!1),c=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        WHERE ${_}
        ${E}
        LIMIT ? OFFSET ?
      `;return t.push(n,i),this.db.prepare(c).all(...t)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchObservationsBySubstring(e,a,o,n,i);if(this._fts5Available){let _=this.buildFilterClause(a,t,"o"),E=this.buildOrderClause(o,!0,"observations_fts"),c=`
        SELECT o.*, o.discovery_tokens
        FROM observations o
        JOIN observations_fts ON observations_fts.rowid = o.id
        WHERE observations_fts MATCH ?
        ${_?"AND "+_:""}
        ${E}
        LIMIT ? OFFSET ?
      `;t.unshift(r.buildFTSMatchQuery(e));let d;try{d=this.db.prepare(c).all(...t,n,i)}catch(l){throw u.warn("DB","FTS5 observation search failed",{},l instanceof Error?l:void 0),l}return d.length>0||i>0&&this.db.prepare(c).all(...t,1,0).length>0?d:this.searchObservationsBySubstring(e,a,o,n,i)}return u.warn("DB","Text search unavailable: ChromaDB disabled and FTS5 not available"),[]}searchSessions(e,s={}){let t=[],{limit:n=50,offset:i=0,orderBy:o="relevance",...a}=s;if(!e){let _={...a};delete _.type;let E=this.buildFilterClause(_,t,"s");if(!E)return[];let d=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        WHERE ${E}
        ${o==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC"}
        LIMIT ? OFFSET ?
      `;return t.push(n,i),this.db.prepare(d).all(...t)}if(r.UNSEGMENTED_SCRIPT.test(e))return this.searchSessionsBySubstring(e,a,o,n,i);if(this._fts5Available){let _={...a};delete _.type;let E=this.buildFilterClause(_,t,"s"),c=o==="date_asc"?"ORDER BY s.created_at_epoch ASC":o==="date_desc"?"ORDER BY s.created_at_epoch DESC":"ORDER BY session_summaries_fts.rank ASC",d=`
        SELECT s.*, s.discovery_tokens
        FROM session_summaries s
        JOIN session_summaries_fts ON session_summaries_fts.rowid = s.id
        WHERE session_summaries_fts MATCH ?
        ${E?"AND "+E:""}
        ${c}
        LIMIT ? OFFSET ?
      `;t.unshift(r.buildFTSMatchQuery(e));let l;try{l=this.db.prepare(d).all(...t,n,i)}catch(R){throw u.warn("DB","FTS5 session search failed",{},R instanceof Error?R:void 0),R}return l.length>0||i>0&&this.db.prepare(d).all(...t,1,0).length>0?l:this.searchSessionsBySubstring(e,a,o,n,i)}return u.warn("DB","Text search unavailable: ChromaDB disabled and FTS5 not available"),[]}findByConcept(e,s={}){let t=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",...a}=s,_={...a,concepts:e},E=this.buildFilterClause(_,t,"o"),c=this.buildOrderClause(o,!1),d=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${E}
      ${c}
      LIMIT ? OFFSET ?
    `;return t.push(n,i),this.db.prepare(d).all(...t)}hasDirectChildFile(e,s){let t=n=>{if(!n)return!1;try{let i=JSON.parse(n);if(Array.isArray(i))return i.some(o=>Be(o,s))}catch(i){u.debug("DB",`Failed to parse files JSON for observation ${e.id}`,void 0,i instanceof Error?i:void 0)}return!1};return t(e.files_modified)||t(e.files_read)}hasDirectChildFileSession(e,s){let t=n=>{if(!n)return!1;try{let i=JSON.parse(n);if(Array.isArray(i))return i.some(o=>Be(o,s))}catch(i){u.debug("DB",`Failed to parse files JSON for session summary ${e.id}`,void 0,i instanceof Error?i:void 0)}return!1};return t(e.files_read)||t(e.files_edited)}static filePathPatterns(e,s){let t=[`%${e}%`];if(!s||!/^([A-Za-z]:)?[\\/]/.test(e))return t;let n=Se(e).split("/").filter(o=>o.length>0),i=/^[A-Za-z]:$/.test(n[0]??"")?1:0;for(let o=i;o<n.length;o+=1){let a=n.slice(o);t.push(`${a.join("/")}/%`),e.includes("\\")&&t.push(`${a.join("\\")}\\%`)}return t}static jsonArrayLikeClause(e,s){let t=Array.from({length:s},()=>"value LIKE ?").join(" OR ");return`(${e.map(n=>`EXISTS (SELECT 1 FROM json_each(${n}) WHERE ${t})`).join(" OR ")})`}findByFile(e,s={}){let t=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",isFolder:a=!1,..._}=s;delete _.files;let E=a?n*3:n,c=r.filePathPatterns(e,a),d=this.buildFilterClause(_,t,"o");t.push(...c,...c);let l=[d,r.jsonArrayLikeClause(["o.files_read","o.files_modified"],c.length)].filter(Boolean).join(" AND "),R=this.buildOrderClause(o,!1),O=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${l}
      ${R}
      LIMIT ? OFFSET ?
    `;t.push(E,i);let L=this.db.prepare(O).all(...t);a&&(L=L.filter(p=>this.hasDirectChildFile(p,e)).slice(0,n));let A=[],f={..._};delete f.type;let T=[],C=F(f);if(C.length>0){let p=P("s",C,{includeMerged:!0});T.push(p.sql),A.push(...p.params)}if(f.platformSource&&(T.push(`COALESCE(NULLIF((SELECT s2.platform_source FROM sdk_sessions s2 WHERE s2.memory_session_id = s.memory_session_id), ''), '${m}') = ?`),A.push(g(f.platformSource))),f.dateRange){let{start:p,end:I}=f.dateRange;p&&(T.push("s.created_at_epoch >= ?"),A.push($(p,"start"))),I&&(T.push("s.created_at_epoch <= ?"),A.push($(I,"end")))}T.push(r.jsonArrayLikeClause(["s.files_read","s.files_edited"],c.length)),A.push(...c,...c);let S=`
      SELECT s.*, s.discovery_tokens
      FROM session_summaries s
      WHERE ${T.join(" AND ")}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;A.push(E,i);let b=this.db.prepare(S).all(...A);return a&&(b=b.filter(p=>this.hasDirectChildFileSession(p,e)).slice(0,n)),{observations:L,sessions:b}}findByType(e,s={}){let t=[],{limit:n=50,offset:i=0,orderBy:o="date_desc",...a}=s,_={...a,type:e},E=this.buildFilterClause(_,t,"o"),c=this.buildOrderClause(o,!1),d=`
      SELECT o.*, o.discovery_tokens
      FROM observations o
      WHERE ${E}
      ${c}
      LIMIT ? OFFSET ?
    `;return t.push(n,i),this.db.prepare(d).all(...t)}searchUserPrompts(e,s={}){let t=[],{limit:n=20,offset:i=0,orderBy:o="relevance",...a}=s,_=[],E=F(a);if(E.length>0){let O=P("s",E,{includeMerged:!1});_.push(O.sql),t.push(...O.params)}if(a.platformSource&&(_.push(`COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?`),t.push(g(a.platformSource))),a.dateRange){let{start:O,end:L}=a.dateRange;O&&(_.push("up.created_at_epoch >= ?"),t.push($(O,"start"))),L&&(_.push("up.created_at_epoch <= ?"),t.push($(L,"end")))}if(!e){if(_.length===0)return[];let O=`WHERE ${_.join(" AND ")}`,A=`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), '${m}') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        ${O}
        ${o==="date_asc"?"ORDER BY up.created_at_epoch ASC":"ORDER BY up.created_at_epoch DESC"}
        LIMIT ? OFFSET ?
      `;return t.push(n,i),this.db.prepare(A).all(...t)}let c=e.replace(/[\\%_]/g,"\\$&");_.push("up.prompt_text LIKE ? ESCAPE '\\'"),t.push(`%${c}%`);let d=`WHERE ${_.join(" AND ")}`,R=`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${m}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ${d}
      ${o==="date_asc"?"ORDER BY up.created_at_epoch ASC":"ORDER BY up.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;return t.push(n,i),this.db.prepare(R).all(...t)}close(){this.db.close()}};var kr=Object.freeze({maxImagesPerEvent:4,maxSourceBytes:3145728,maxCanonicalBytes:3145728,maxPixels:24e6,maxDimension:8192,conversionTimeoutSeconds:5,maxConcurrentConversions:1,maxDerivativeBytes:262144,maxDerivativeDimension:1536,maxInlineEncodedBytes:4194304,maxObservationRefs:32,maxLabelChars:64,maxManifestBytes:8192,maxProvenanceBytes:8192,maxSourceLocatorChars:4096,maxGatewayImageBytes:1048576,maxUploadBodyBytes:3211264,ownerQuotaBytes:268435456});var Yt=4096;var Js=new Set(["set_title","set_prompt_session","remap_project"]),zs=/^(?:0|[1-9][0-9]*)$/,Vt=18446744073709551615n;function U(r){throw u.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:r}),new Error(`canonical content: ${r}`)}function Oe(r,e={}){return typeof r!="string"||!zs.test(r)?U("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(r)>Vt&&U("decimal value exceeds uint64"),e.positive&&r==="0"&&U("decimal value must be positive"),r)}function $e(r){let e=Oe(r);return BigInt(e)===Vt&&U("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function Qs(r){(r===null||typeof r!="object"||Array.isArray(r))&&U("mutation must be an object");let e=r;if((typeof e.op!="string"||!Js.has(e.op))&&U("unsupported mutation op"),e.op==="set_title"){let i=te(e,["fields","op","target"],"set_title"),o=fe(i.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");o.memory_session_id===void 0&&o.content_session_id===void 0&&U("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])o[_]!==void 0&&k(o[_],_);let a=te(i.fields,["custom_title"],"set_title.fields");k(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let i=te(e,["fields","op","target"],"set_prompt_session"),o=te(i.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");Zs(o.origin_device_id),Oe(o.origin_local_id);let a=fe(i.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");k(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&k(a[_],_);return}let s=te(e,["fields","op","where"],"remap_project"),t=fe(s.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");t.project!==void 0&&k(t.project,"project"),t.memory_session_id!==void 0&&k(t.memory_session_id,"memory_session_id"),t.merged_into_project_is_null!==void 0&&t.merged_into_project_is_null!==!0&&U("merged_into_project_is_null may only be true"),Object.keys(t).length===0&&U("remap_project where is empty");let n=fe(s.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&k(n.project,"project"),n.merged_into_project!==void 0&&k(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&U("remap_project fields are empty")}function He(r){Qs(r)}function Zs(r){return typeof r!="string"||r.length===0||Buffer.byteLength(r,"utf8")>128?U("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):r}function k(r,e){return typeof r!="string"||r.length===0||r.trim().length===0||Buffer.byteLength(r,"utf8")>Yt?U(`${e} must be a non-blank string of at most ${Yt} UTF-8 bytes`):r}function te(r,e,s){if(r===null||typeof r!="object"||Array.isArray(r))return U(`${s} must be an object`);let t=r,n=Object.keys(t).sort(),i=[...e].sort();return(n.length!==i.length||n.some((o,a)=>o!==i[a]))&&U(`${s} must contain exactly: ${i.join(", ")}`),t}function fe(r,e,s){if(r===null||typeof r!="object"||Array.isArray(r))return U(`${s} must be an object`);let t=r,n=new Set(e),i=Object.keys(t).find(o=>!n.has(o));return i&&U(`${s} contains unknown field ${i}`),t}var zt=5*6e4,qt=!1;function en(r){return typeof r.iterate=="function"?r.iterate():(qt||(qt=!0,u.warn("DB","bun:sqlite lacks Statement.iterate(); falling back to .all()",{bunVersion:typeof Bun<"u"?Bun.version:"unknown",requiredBunVersion:">=1.1.31",impact:"migration rows are materialized in memory; upgrade Bun to restore streaming"})),r.all())}var M=r=>typeof r=="object"&&r!==null?JSON.stringify(r):r??null;function Qt(r){let e=[],s=[],t=new Set,n=new Set;for(let i of r){for(let o of i.files_read??[])!o||t.has(o)||(t.add(o),e.push(o));for(let o of i.files_modified??[])!o||n.has(o)||(n.add(o),s.push(o))}return{files_read:e,files_edited:s}}var tn=200,sn=1e3,nn=56,rn=57,We=class{db;syncOpsEnabled;statementCache=new Map;constructor(e=ie,s={}){this.syncOpsEnabled=s.syncOpsEnabled??!0,e instanceof je.Database?this.db=e:(e!==":memory:"&&ae(D),this.db=new je.Database(e)),pe(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline(),this.normalizeConceptTags(),this.ensureSDKSessionsObservedColumns(),this.ensureToolUsesTable(),this.ensureTelegramWrapupsTable(),this.addDedupTables(),this.ensureReinforcementColumns(),this.ensureSessionCwdColumn(),this.dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(),this.ensureProjectNocaseIndexes(),this.ensureAdvisorCallsTable(),this.ensureSessionProjectKeySourceColumn(),this.requeuePromptsDeadLetteredForSize(),Wt(this.db)}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(s=>s.name)}hasUniqueIndexOnColumns(e,s){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let i=this.getIndexColumns(n.name);return i.length===s.length&&i.every((o,a)=>o===s[a])})}resolvePromptSessionDbId(e,s,t){if(s!==void 0)return s;let n=t?g(t):void 0;return n?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(m,n,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${m}')
        WHEN '${m}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}addDedupTables(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(s=>s.name==="occurrence_count")||this.db.run("ALTER TABLE observations ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1"),e.some(s=>s.name==="title_norm_key")||this.db.run("ALTER TABLE observations ADD COLUMN title_norm_key TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_title_norm ON observations(project, title_norm_key)"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_token_df_project ON token_df(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_project ON observation_dedup_candidates(project, status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_dedup_candidates_obs ON observation_dedup_candidates(observation_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(nn,new Date().toISOString())}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),t=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!t)){if(t)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),u.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){u.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),s=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),t=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),i=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source");if(!(e&&!s&&t&&i)){if(i||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${m}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${m}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),s){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let a=o instanceof Error?o:new Error(String(o));throw u.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),o}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${m}',
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
        COALESCE(NULLIF(platform_source, ''), '${m}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),o=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&n&&!o)return;let a=n?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${m}')
            WHEN '${m}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${m}')
            WHEN '${m}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let E=_ instanceof Error?_:new Error(String(_));throw u.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},E),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,s){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let t=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&t)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let i=n instanceof Error?n:new Error(String(n));throw u.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},i),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(n=>n.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),u.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let s=this.db.query(`PRAGMA table_info(${e})`).all(),t=new Set(s.map(n=>n.name));t.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),u.debug("DB",`Added origin_device_id column to ${e} table`)),t.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),u.debug("DB",`Added origin_local_id column to ${e} table`)),t.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),u.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(s=>s.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],s=(o,a)=>this.db.query(`PRAGMA table_info(${o})`).all().find(_=>_.name===a),t=o=>o?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(o=>t(s(o.table,o.column))))return;this.db.transaction(()=>{for(let o of e){let a=this.db.query(`PRAGMA table_info(${o.table})`).all(),_=a.find(c=>c.name===o.column);if(!_)throw new Error(`schema v46: missing ${o.table}.${o.column}`);for(let c of en(this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${o.column}) AS storage_type,
                 CAST(${o.column} AS TEXT) AS revision
          FROM ${o.table}
        `))){let d=c;if(d.storage_type==="real")throw new Error(`schema v46: ${o.table}.${o.column} row ${d.row_id} is REAL and unrecoverably rounded`);if(d.storage_type!=="integer"&&d.storage_type!=="text")throw new Error(`schema v46: ${o.table}.${o.column} row ${d.row_id} has unsupported ${d.storage_type} storage`);try{Oe(d.revision,{positive:!0})}catch{throw new Error(`schema v46: ${o.table}.${o.column} row ${d.row_id} is not a positive canonical uint64 revision`)}}if(t(_))continue;if(a.some(c=>c.name===o.temporary))throw new Error(`schema v46: unexpected temporary column ${o.table}.${o.temporary}`);this.db.run(`ALTER TABLE ${o.table} ADD COLUMN ${o.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${o.table} SET ${o.temporary} = CAST(${o.column} AS TEXT)`);let E=this.db.prepare(`
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
    `);let t=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!t){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:c,kind:d}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${c}
            WHERE origin_device_id IS NULL
          `).run(d),this.db.prepare(`
            UPDATE ${c} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let E=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,E),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,E)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&s)return;let i=Date.parse(t.applied_at);if(!Number.isSafeInteger(i)||i<0)throw new Error(`schema v48: invalid v47 applied_at ${t.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:_}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(_,i);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}normalizeConceptTags(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(49))return;let s=0;this.db.transaction(()=>{let n=this.db.prepare(`
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
      `);for(let i of n){if(i.origin_device_id!==null)continue;let o=$e(i.sync_rev);this.db.prepare(`
          UPDATE observations SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,i.id)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(49,new Date().toISOString())})(),u.debug("DB",`Normalized prefixed concept tags in ${s} observations (v49)`)}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),s=this.db.query("PRAGMA table_info(pending_messages)").all(),t=new Set(s.map(o=>o.name)),i=["retry_count","failed_at_epoch","completed_at_epoch"].filter(o=>t.has(o));if(!(e&&i.length===0)){if(i.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let o of i)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${o}`),u.debug("DB",`Dropped dead column ${o} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK"),u.warn("DB","Failed to drop dead columns from pending_messages",{},o instanceof Error?o:new Error(String(o)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),u.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),u.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),u.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),u.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}repairOrphanedSessionParents(e){let s=this.db.prepare(`
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
    `),u.warn("DB",`Created ${s} stub sdk_sessions parent(s) for orphaned ${e} rows before rebuild (#3378)`))}hasMemorySessionIdOnUpdateCascade(e){return this.db.query(`PRAGMA foreign_key_list(${e})`).all().some(t=>t.table==="sdk_sessions"&&t.from==="memory_session_id"&&t.on_update==="CASCADE")}carryLiveColumnsOntoNewTable(e,s,t){let n=this.db.query(`PRAGMA table_info(${e})`).all(),i=n.filter(o=>!t.includes(o.name));for(let o of i){let a=o.type?` ${o.type}`:"",_=o.dflt_value===null||o.dflt_value===void 0?"":` DEFAULT ${o.dflt_value}`;this.db.run(`ALTER TABLE ${s} ADD COLUMN "${o.name}"${a}${_}`),u.debug("DB",`Carried ${o.name} over the ${e} rebuild (#3849)`)}return n.map(o=>o.name)}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(a=>a.unique===1&&a.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}u.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("session_summaries");let t=["id","memory_session_id","project","request","investigated","learned","completed","next_steps","files_read","files_edited","notes","prompt_number","created_at","created_at_epoch"],i=this.db.query("PRAGMA table_info(session_summaries)").all().filter(a=>!t.includes(a.name));this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `);for(let a of i){let _=a.type?` ${a.type}`:"",E=a.dflt_value===null||a.dflt_value===void 0?"":` DEFAULT ${a.dflt_value}`;this.db.run(`ALTER TABLE session_summaries_new ADD COLUMN "${a.name}"${_}${E}`),u.debug("DB",`Carried ${a.name} over the session_summaries UNIQUE-constraint rebuild (#3890)`)}let o=[...t,...i.map(a=>a.name)].map(a=>`"${a}"`).join(", ");this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),u.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}u.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.repairOrphanedSessionParents("observations"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),u.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;u.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(n,i,o)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),_=a.some(c=>c.name===i);return a.some(c=>c.name===o)?!1:_?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${i} TO ${o}`),u.debug("DB",`Renamed ${n}.${i} to ${o}`),!0):(u.warn("DB",`Column ${i} not found in ${n}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?u.debug("DB",`Successfully renamed ${s} session ID columns`):u.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),u.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){let e=!this.hasMemorySessionIdOnUpdateCascade("observations"),s=!this.hasMemorySessionIdOnUpdateCascade("session_summaries");if(!e&&!s){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString());return}u.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");let t=["id","memory_session_id","project","text","type","title","subtitle","facts","narrative","concepts","files_read","files_modified","prompt_number","discovery_tokens","created_at","created_at_epoch"],n=`
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
    `;try{e&&(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.recreateObservationsWithCascade(n,t,i,Re)),s&&(this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.recreateSessionSummariesWithCascade(a,o,_,Ae)),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),u.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(E){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),E instanceof Error?E:new Error(String(E))}}recreateObservationsWithCascade(e,s,t,n){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("observations","observations_new",s).map(_=>`"${_}"`).join(", ");this.db.run(`INSERT INTO observations_new (${o}) SELECT ${o} FROM observations`),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,s,t,n){this.db.run(e);let o=this.carryLiveColumnsOntoNewTable("session_summaries","session_summaries_new",s).map(_=>`"${_}"`).join(", ");this.db.run(`INSERT INTO session_summaries_new (${o}) SELECT ${o} FROM session_summaries`),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),u.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&t||(t||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),u.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&n||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${m}'`),u.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${m}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(n=>n.name==="generated_by_model"),t=e.some(n=>n.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureSDKSessionsObservedColumns(){let e=this.db.query("PRAGMA table_info(sdk_sessions)").all(),s=e.some(n=>n.name==="observed_model"),t=e.some(n=>n.name==="observed_billing");s&&t||(s||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_model TEXT"),t||this.db.run("ALTER TABLE sdk_sessions ADD COLUMN observed_billing TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(50,new Date().toISOString()))}ensureToolUsesTable(){Et(this.db),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(51,new Date().toISOString())}ensureTelegramWrapupsTable(){this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_telegram_wrapups_platform_content ON telegram_wrapups(platform_source, content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(52,new Date().toISOString())}ensureReinforcementColumns(){let e=this.db.query("PRAGMA table_info(observations)").all();e.some(s=>s.name==="reinforcement_dates")||this.db.run("ALTER TABLE observations ADD COLUMN reinforcement_dates TEXT"),e.some(s=>s.name==="last_reinforced")||this.db.run("ALTER TABLE observations ADD COLUMN last_reinforced TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(rn,new Date().toISOString())}dropWriteOnlyUserPromptsFtsAndScopeFtsUpdateTriggers(){let e=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN ('observations_au', 'session_summaries_au')
        AND sql NOT LIKE '%UPDATE OF%'
    `).all().map(t=>t.name),s=this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN ('user_prompts_fts', 'user_prompts_ai', 'user_prompts_ad', 'user_prompts_au')
    `).all();if(e.length>0||s.length>0){this.db.run("BEGIN TRANSACTION");try{e.includes("observations_au")&&(this.db.run("DROP TRIGGER observations_au"),this.db.run(Re)),e.includes("session_summaries_au")&&(this.db.run("DROP TRIGGER session_summaries_au"),this.db.run(Ae)),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_fts"),this.db.run("COMMIT")}catch(t){throw this.db.run("ROLLBACK"),u.error("DB","Failed to scope FTS update triggers / drop user_prompts_fts, rolled back",{},t instanceof Error?t:new Error(String(t))),t}u.info("DB","Scoped FTS update triggers to indexed columns and dropped the write-only user_prompts_fts",{rescopedTriggers:e,droppedUserPromptsFts:s.length>0})}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(54,new Date().toISOString())}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}requeuePromptsDeadLetteredForSize(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(60))return;let s="canonical content: body exceeds % UTF-8 bytes";this.db.transaction(()=>{let t=this.db.prepare(`
        UPDATE user_prompts SET synced_at = NULL
        WHERE synced_at = -1 AND origin_device_id IS NULL
          AND CAST(id AS TEXT) IN (
            SELECT origin_local_id FROM sync_dead_letter
            WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
          )
      `).run(s);this.db.prepare(`
        DELETE FROM sync_dead_letter WHERE lane = 'content' AND kind = 'prompt' AND reason LIKE ?
      `).run(s),t.changes>0&&u.info("DB","Re-queued prompts quarantined for size before the cloud-sync prompt clamp",{prompts:t.changes}),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(60,new Date().toISOString())})()}ensureSessionProjectKeySourceColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="project_key_source")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN project_key_source TEXT"),u.debug("DB","Added project_key_source column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(59,new Date().toISOString())}ensureSessionCwdColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="cwd")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN cwd TEXT"),u.debug("DB","Added cwd column to sdk_sessions table (#2864)")),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_cwd ON sdk_sessions(cwd)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(53,new Date().toISOString())}ensureProjectNocaseIndexes(){this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project_nocase ON observations(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into_nocase ON observations(merged_into_project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project_nocase ON session_summaries(project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into_nocase ON session_summaries(merged_into_project COLLATE NOCASE)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project_nocase ON sdk_sessions(project COLLATE NOCASE)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(55,new Date().toISOString())}ensureAdvisorCallsTable(){this.db.run(`
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
    `),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_calls_tool_use ON advisor_calls(tool_use_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_session ON advisor_calls(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_project ON advisor_calls(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_advisor_calls_occurred ON advisor_calls(occurred_at_epoch DESC)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(58,new Date().toISOString())}recordAdvisorCall(e){let s=new Date,t=this.db.prepare(`
      INSERT OR IGNORE INTO advisor_calls
      (session_db_id, content_session_id, project, platform_source, tool_use_id, advisor_model, cwd, last_user_message, transcript_path, transcript_byte_offset, advice, occurred_at_epoch, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sessionDbId,e.contentSessionId,e.project,e.platformSource,e.toolUseId,e.advisorModel??null,e.cwd??null,e.lastUserMessage??null,e.transcriptPath??null,e.transcriptByteOffset??null,e.advice,e.occurredAtEpoch,s.toISOString(),s.getTime());return t.changes>0?{id:Number(t.lastInsertRowid),inserted:!0}:{id:this.db.prepare("SELECT id FROM advisor_calls WHERE tool_use_id = ?").get(e.toolUseId)?.id??0,inserted:!1}}getAdvisorCalls(e,s,t,n){let i="SELECT * FROM advisor_calls",o=[],a=[];t?(a.push("project = ?"),o.push(t)):(a.push("project != ?"),o.push(J)),n&&(a.push("platform_source = ?"),o.push(n)),i+=` WHERE ${a.join(" AND ")}`,i+=" ORDER BY occurred_at_epoch DESC LIMIT ? OFFSET ?",o.push(s+1,e);let _=this.db.prepare(i).all(...o);return{items:_.slice(0,s),hasMore:_.length>s,offset:e,limit:s}}getAdvisorCallById(e){return this.db.prepare("SELECT * FROM advisor_calls WHERE id = ?").get(e)??null}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(o=>o.name==="agent_type"),n=s.some(o=>o.name==="agent_id");t||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let i=this.db.query("PRAGMA table_info(pending_messages)").all();if(i.length>0){let o=i.some(_=>_.name==="agent_type"),a=i.some(_=>_.name==="agent_id");o||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let i=n instanceof Error?n:new Error(String(n));throw u.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},i),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(i=>i.name==="memory_session_id"),n=s.some(i=>i.name==="content_hash");if(!t||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let o=i instanceof Error?i:new Error(String(i));throw u.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},o),i}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),u.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,s){let t=this.db.prepare(`
      SELECT memory_session_id
      FROM sdk_sessions
      WHERE id = ?
    `).get(e);!t||t.memory_session_id===s||(this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(s,e),s&&this.requeuePromptSync(e))}enqueueMutationOp(e,s){if(!this.syncOpsEnabled)return;let t=JSON.parse(JSON.stringify(s));if(t.op==="set_prompt_session"){let n=t.target;n?.origin_device_id===null&&(n.origin_device_id="self")}He(t),s.op==="set_prompt_session"&&this.cachedStatement(`
        DELETE FROM sync_outbox
        WHERE json_valid(body)
          AND json_extract(body, '$.op') = 'set_prompt_session'
          AND json_extract(body, '$.target.origin_device_id') IS ?
          AND json_extract(body, '$.target.origin_local_id') = ?
      `).run(s.target?.origin_device_id??null,String(s.target?.origin_local_id??"")),this.cachedStatement(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,Jt.randomUUID)(),String(e),JSON.stringify(s),Date.now())}requeuePromptSync(e){if(!this.syncOpsEnabled)return;let s=this.cachedStatement(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!s?.memory_session_id)return;this.db.transaction(()=>{let n=this.cachedStatement(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length===0)return;let i=this.cachedStatement(`
        UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
        WHERE id = ? AND origin_device_id IS NULL
      `);for(let o of n){let a=$e(o.sync_rev);i.run(a,o.id),this.enqueueMutationOp(a,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:o.id},fields:{memory_session_id:s.memory_session_id,project:s.project,content_session_id:s.content_session_id,platform_source:s.platform_source}})}})()}markSessionCompleted(e){let s=Date.now(),t=new Date(s).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t,s,e)}reopenCompletedSession(e){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', completed_at = NULL, completed_at_epoch = NULL
      WHERE id = ? AND status = 'completed'
    `).run(e)}ensureMemorySessionIdRegistered(e,s,t){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);return n.memory_session_id===null?(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),this.requeuePromptSync(e),u.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,newId:s})):n.memory_session_id!==s&&u.debug("DB","Keeping the registered memory_session_id",{sessionDbId:e,registered:n.memory_session_id,offered:s}),typeof t=="number"&&n.worker_port!==t&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(t,e),n.memory_session_id??s}getProjectReadKeys(e){return et(this.db,e)}getAllProjects(e){let s=e?g(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[J];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",n.push(m,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...n).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${m}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${m}'), project
      ORDER BY latest_epoch DESC
    `).all(J),s=[],t=new Set,n={};for(let o of e){let a=g(o.platform_source);n[a]||(n[a]=[]),n[a].includes(o.project)||n[a].push(o.project),t.has(o.project)||(t.add(o.project),s.push(o.project))}let i=it(Object.keys(n));return{projects:s,sources:i,projectsBySource:Object.fromEntries(i.map(o=>[o,n[o]||[]]))}}getSessionCatalog(e={}){let s=Math.min(Math.max(Math.trunc(e.limit??tn),1),sn),t=Math.max(Math.trunc(e.offset??0),0),n=`
      SELECT
        s.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${m}') as platform_source,
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
    `,i=[J];e.project&&(n+=" AND s.project = ?",i.push(e.project)),e.platformSource&&(n+=` AND COALESCE(s.platform_source, '${m}') = ?`,i.push(g(e.platformSource))),n+=" ORDER BY s.started_at_epoch DESC, s.id DESC LIMIT ? OFFSET ?",i.push(s+1,t);let o=this.db.prepare(n).all(...i);return{sessions:o.slice(0,s),hasMore:o.length>s}}getLatestUserPrompt(e,s){let t=this.resolvePromptSessionDbId(e,s),n=t!==null?"up.session_db_id = ?":"up.content_session_id = ?",i=t!==null?t:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${m}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${n}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(i)}findRecentDuplicateUserPrompt(e,s,t,n){return Pt(this.db,e,le(s),t,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,s=3,t){let n=[e],i="";return t&&(i=`AND COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?`,n.push(g(t))),n.push(s),this.db.prepare(`
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
    `).all(...n)}getObservationsForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?
        )
      `,t.push(g(s))),this.db.prepare(`
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
        AND COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?
    `).get(e,g(s))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}upsertToolUse(e){return dt(this.db,e)}linkToolUsesToObservation(e){return ct(this.db,e)}getToolUsesByIds(e,s={}){return lt(this.db,e,s)}queryToolUses(e={}){return pt(this.db,e)}countToolUses(e={}){return mt(this.db,e)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,platformSource:i,type:o,concepts:a,files:_}=s,E=F(s),c=t==="relevance",d=c?"":`ORDER BY o.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,l=n&&!c?`LIMIT ${n}`:"",R=e.map(()=>"?").join(","),O=[...e],L=[];if(E.length>0){let b=P("o",E,{includeMerged:!0});L.push(b.sql),O.push(...b.params)}if(i&&(L.push(`COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?`),O.push(g(i))),o)if(Array.isArray(o)){let b=o.map(()=>"?").join(",");L.push(`o.type IN (${b})`),O.push(...o)}else L.push("o.type = ?"),O.push(o);if(a){let b=Array.isArray(a)?a:[a],p=b.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");O.push(...b),L.push(`(${p.join(" OR ")})`)}if(_){let b=Array.isArray(_)?_:[_],p=b.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");b.forEach(I=>{O.push(`%${I}%`,`%${I}%`)}),L.push(`(${p.join(" OR ")})`)}let A=L.length>0?`WHERE o.id IN (${R}) AND ${L.join(" AND ")}`:`WHERE o.id IN (${R})`,T=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${A}
      ${d}
      ${l}
    `).all(...O);if(!c)return T;let C=new Map(T.map(b=>[b.id,b])),S=e.map(b=>C.get(b)).filter(b=>!!b);return n?S.slice(0,n):S}getSummaryForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${m}') = ?
        )
      `,t.push(g(s))),this.db.prepare(`
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
             COALESCE(platform_source, '${m}') as platform_source,
             user_prompt, custom_title, status,
             observed_model, observed_billing
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}findSessionDbIdByContentSessionId(e,s){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
      LIMIT 1
    `).get(m,g(s),e)?.id??null}claimTelegramWrapup({platformSource:e,contentSessionId:s,project:t,routeKey:n,summaryCreatedAtEpoch:i}){let o=Date.now();return this.db.prepare(`
      INSERT OR IGNORE INTO telegram_wrapups
      (platform_source, content_session_id, project, route_key, summary_created_at_epoch, status, claimed_at_epoch, sent_at_epoch)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL)
    `).run(g(e),s,t,n,i,o).changes===1?!0:this.db.prepare(`
      UPDATE telegram_wrapups
      SET summary_created_at_epoch = ?, claimed_at_epoch = ?, sent_at_epoch = NULL
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
        AND claimed_at_epoch <= ?
    `).run(i,o,g(e),s,t,n,o-zt).changes===1}markTelegramWrapupSent({platformSource:e,contentSessionId:s,project:t,routeKey:n}){this.db.prepare(`
      UPDATE telegram_wrapups
      SET status = 'sent', sent_at_epoch = ?
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(Date.now(),g(e),s,t,n)}releaseTelegramWrapupClaim({platformSource:e,contentSessionId:s,project:t,routeKey:n}){this.db.prepare(`
      DELETE FROM telegram_wrapups
      WHERE platform_source = ?
        AND content_session_id = ?
        AND project = ?
        AND route_key = ?
        AND status = 'claimed'
    `).run(g(e),s,t,n)}setSessionObservedMetadata(e,s,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET observed_model = COALESCE(?, observed_model),
          observed_billing = COALESCE(?, observed_billing)
      WHERE id = ?
    `).run(s||null,t||null,e)}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${m}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e,s){let t=this.resolvePromptSessionDbId(e,s);return t!==null?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(t).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}getLatestPromptTextFromUserPrompts(e,s){let t=this.resolvePromptSessionDbId(e,s),n=t!==null?"session_db_id = ?":"content_session_id = ?",i=t!==null?t:e;return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE ${n}
        AND prompt_text IS NOT NULL
        AND length(trim(prompt_text)) > 0
      ORDER BY prompt_number DESC, created_at_epoch DESC
      LIMIT 1
    `).get(i)?.prompt_text??null}createSDKSession(e,s,t,n,i){let o=new Date,a=o.getTime(),_=i?g(i):m,E=le(t);n&&this.validateSetTitleMutation(e,_,n);let c=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(m,_,e);if(c){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(s,c.id),E&&E!==xe&&this.db.prepare(`
          UPDATE sdk_sessions SET user_prompt = ?
          WHERE id = ? AND (user_prompt IS NULL OR user_prompt = '' OR user_prompt = ?)
        `).run(E,c.id,xe),n){let l=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(c.id);l&&l.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,c.id),this.enqueueSetTitleOp(e,_,n))}return c.id}let d=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,_,E,n||null,o.toISOString(),a);return n&&this.enqueueSetTitleOp(e,_,n),Number(d.lastInsertRowid)}setSessionCwd(e,s,t){s.trim()&&this.db.prepare("UPDATE sdk_sessions SET cwd = ?, project_key_source = ? WHERE id = ? AND cwd IS NULL").run(s,t??null,e)}getSessionCwd(e){return this.db.prepare("SELECT cwd FROM sdk_sessions WHERE id = ?").get(e)?.cwd??null}enqueueSetTitleOp(e,s,t){let n=this.validateSetTitleMutation(e,s,t);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,s,t){let n={op:"set_title",target:{content_session_id:e,platform_source:s},fields:{custom_title:t}};return He(n),n}saveUserPrompt(e,s,t,n){let i=new Date,o=i.getTime(),a=le(t),_=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(_,e,s,a,i.toISOString(),o).lastInsertRowid}getUserPrompt(e,s,t){let n=this.resolvePromptSessionDbId(e,t);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,s)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}dedupConfig(){let e=W.loadFromFile(oe),s=(n,i)=>{let o=Number(e[n]);return Number.isFinite(o)?o:i},t=(n,i)=>Math.trunc(s(n,i));return{enabled:e.CLAUDE_MEM_DEDUP_ENABLED==="true",cosineThreshold:s("CLAUDE_MEM_DEDUP_COSINE_THRESHOLD",.8),idfVetoDf:t("CLAUDE_MEM_DEDUP_IDF_VETO_DF",10),minSharedTokens:t("CLAUDE_MEM_DEDUP_MIN_SHARED_TOKENS",2),maxScan:t("CLAUDE_MEM_DEDUP_MAX_SCAN",2e3),maxBackfillRows:t("CLAUDE_MEM_DEDUP_MAX_BACKFILL_ROWS",5e4),minProjectDocs:t("CLAUDE_MEM_DEDUP_MIN_PROJECT_DOCS",10)}}listDedupCandidates(e,s=100){let t="SELECT c.id, c.project, c.method, c.score, c.status, c.created_at_epoch, c.observation_id, o1.title AS observation_title, c.duplicate_of_id, o2.title AS duplicate_of_title FROM observation_dedup_candidates c JOIN observations o1 ON o1.id = c.observation_id JOIN observations o2 ON o2.id = c.duplicate_of_id ",n="ORDER BY c.score DESC, c.id DESC LIMIT ?";return e?this.db.prepare(`${t}WHERE c.project = ? ${n}`).all(e,s):this.db.prepare(`${t}${n}`).all(s)}isDedupEnabled(){return this.dedupConfig().enabled}runDedupScan(){return Ft(this.db,this.dedupConfig())}maintainDedupOnInsert(e,s,t,n){Dt(this.db,e,t),vt(this.db,e,n.minProjectDocs)&&wt(this.db,e,s,t,n)}storeObservation(e,s,t,n,i=0,o,a){if(!Ue(t.title))throw new Error("storeObservation requires a non-empty title");let _=this.storeObservations(e,s,[t],null,n,i,o,a);return{id:_.observationIds[0],createdAtEpoch:_.createdAtEpoch,mergedIntoExisting:_.mergedIntoExisting[0]??!1}}storeSummary(e,s,t,n,i=0,o){let a=o??Date.now(),_=new Date(a).toISOString(),c=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,JSON.stringify(t.files_read??[]),JSON.stringify(t.files_edited??[]),t.notes,n||null,i,_,a);return{id:Number(c.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,t,n,i,o=0,a,_){let E=a??Date.now(),c=new Date(E).toISOString(),d=ot(E),l=new Date(E),R=this.dedupConfig(),O=g(this.db.prepare("SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ? LIMIT 1").get(e)?.platform_source);return this.db.transaction(()=>{let A=[],f=[],T=[],C=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, title_norm_key, reinforcement_dates, last_reinforced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),S=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let p of t){if(!Ue(p.title)){u.debug("DB","Skipping observation with empty title");continue}let I=st(e,p.title,p.narrative),v=we(s,O,p.title,ce(p.agent_id,p.agent_type));if(R.enabled){let ge=S.get(e,I);if(ge){_e(this.db,ge.id,l),A.push(ge.id),f.push(!1);continue}let se=ht(this.db,s,v);if(se){this.db.prepare("UPDATE observations SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(se.id),_e(this.db,se.id,l),A.push(se.id),f.push(!0);continue}}let Y=C.get(e,s,p.type,p.title,p.subtitle,JSON.stringify(p.facts),p.narrative,JSON.stringify(p.concepts),JSON.stringify(p.files_read),JSON.stringify(p.files_modified),i||null,o,p.agent_type??null,p.agent_id??null,I,c,E,_||null,p.metadata??null,v,d.dates,d.lastReinforced);if(Y){R.enabled&&this.maintainDedupOnInsert(s,Y.id,p.title,R),A.push(Y.id),f.push(!1),T.push(Y.id);continue}let V=S.get(e,I);if(!V)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${I}`);_e(this.db,V.id,l),A.push(V.id),f.push(!1)}let b=null;if(n){let p=Qt(t),I=n.files_read??p.files_read,v=n.files_edited??p.files_edited,V=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,n.request,n.investigated,n.learned,n.completed,n.next_steps,JSON.stringify(I),JSON.stringify(v),n.notes,i||null,o,c,E);b=Number(V.lastInsertRowid)}return{observationIds:A,mergedIntoExisting:f,insertedObservationIds:T,summaryId:b,createdAtEpoch:E}})()}updateDiscoveryTokens(e,s,t){e.length===0&&s===null||this.db.transaction(()=>{let n=this.db.prepare("UPDATE observations SET discovery_tokens = ? WHERE id = ?");for(let i of e)n.run(t,i);s!==null&&this.db.prepare("UPDATE session_summaries SET discovery_tokens = ? WHERE id = ?").run(t,s)})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,platformSource:i}=s,o=F(s),a=t==="relevance",_=a?"":`ORDER BY ss.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,E=n&&!a?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),d=[...e],l=[];if(o.length>0){let T=P("ss",o,{includeMerged:!0});l.push(T.sql),d.push(...T.params)}i&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?`),d.push(g(i)));let R=l.length>0?`AND ${l.join(" AND ")}`:"",L=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${R}
      ${_}
      ${E}
    `).all(...d);if(!a)return L;let A=new Map(L.map(T=>[T.id,T])),f=e.map(T=>A.get(T)).filter(T=>!!T);return n?f.slice(0,n):f}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,platformSource:i}=s,o=F(s),a=t==="relevance",_=a?"":`ORDER BY up.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,E=n&&!a?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),d=[...e],l=[];if(o.length>0){let T=P("s",o,{includeMerged:!1});l.push(T.sql),d.push(...T.params)}i&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${m}') = ?`),d.push(g(i)));let R=l.length>0?`AND ${l.join(" AND ")}`:"",L=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${m}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${R}
      ${_}
      ${E}
    `).all(...d);if(!a)return L;let A=new Map(L.map(T=>[T.id,T])),f=e.map(T=>A.get(T)).filter(T=>!!T);return n?f.slice(0,n):f}getTimelineAroundTimestamp(e,s=10,t=10,n,i){return this.getTimelineAroundObservation(null,e,s,t,n,i)}getTimelineAroundObservation(e,s,t=10,n=10,i,o){let a=o?g(o):void 0,_=(S,b,p=!1)=>{let I=[],v=[];return i&&(p?(I.push(`(${S}.project COLLATE NOCASE = ? OR ${S}.merged_into_project COLLATE NOCASE = ?)`),v.push(i,i)):(I.push(`${S}.project COLLATE NOCASE = ?`),v.push(i))),a&&(I.push(`COALESCE(NULLIF(${b}.platform_source, ''), '${m}') = ?`),v.push(a)),{clause:I.length>0?`AND ${I.join(" AND ")}`:"",params:v}},E=_("o","src",!0),c=_("ss","src",!0),d=_("s","s"),l,R;if(e!==null){let S=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${E.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,b=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${E.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let p=this.db.prepare(S).all(e,...E.params,t+1),I=this.db.prepare(b).all(e,...E.params,n+1);if(p.length===0&&I.length===0)return{observations:[],sessions:[],prompts:[]};l=p.length>0?p[p.length-1].created_at_epoch:s,R=I.length>0?I[I.length-1].created_at_epoch:s}catch(p){return p instanceof Error?u.error("DB","Error getting boundary observations",{project:i},p):u.error("DB","Error getting boundary observations with non-Error",{},new Error(String(p))),{observations:[],sessions:[],prompts:[]}}}else{let S=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch < ? ${E.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,b=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch > ? ${E.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let p=this.db.prepare(S).all(s,...E.params,t),I=this.db.prepare(b).all(s,...E.params,n);l=p.length>0?p[p.length-1].created_at_epoch:s,R=I.length>0?I[I.length-1].created_at_epoch:s}catch(p){return p instanceof Error?u.error("DB","Error getting boundary timestamps",{project:i},p):u.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(p))),{observations:[],sessions:[],prompts:[]}}}let O=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${E.clause}
      ORDER BY o.created_at_epoch ASC, o.id ASC
    `,L=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${c.clause}
      ORDER BY ss.created_at_epoch ASC, ss.id ASC
    `,A=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${m}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${d.clause}
      ORDER BY up.created_at_epoch ASC, up.id ASC
    `,f=this.db.prepare(O).all(l,R,...E.params),T=this.db.prepare(L).all(l,R,...c.params),C=this.db.prepare(A).all(l,R,...d.params);return{observations:f,sessions:T.map(S=>({id:S.id,memory_session_id:S.memory_session_id,project:S.project,request:S.request,completed:S.completed,next_steps:S.next_steps,created_at:S.created_at,created_at_epoch:S.created_at_epoch})),prompts:C.map(S=>({id:S.id,content_session_id:S.content_session_id,prompt_number:S.prompt_number,prompt_text:S.prompt_text,project:S.project,platform_source:S.platform_source,created_at:S.created_at,created_at_epoch:S.created_at_epoch}))}}getOrCreateManualSession(e,s=m){let t=`manual-${e}`,n=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return s&&s!==m&&this.db.prepare("UPDATE sdk_sessions SET platform_source = ? WHERE memory_session_id = ?").run(s,t),t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,n,e,m,o.toISOString(),o.getTime()),u.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}cachedStatement(e){let s=this.statementCache.get(e);return s||(s=this.db.prepare(e),this.statementCache.set(e,s)),s}importSdkSession(e){let s=g(e.platform_source),t=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(s,e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,s,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return u.warn("DB","Skipping imported session summary without memory_session_id",{project:typeof e?.project=="string"?e.project:null}),{imported:!1,id:0};let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,M(e.request),M(e.investigated),M(e.learned),M(e.completed),M(e.next_steps),M(e.files_read),M(e.files_edited),M(e.notes),e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){if(typeof e?.memory_session_id!="string"||e.memory_session_id.trim()==="")return u.warn("DB","Skipping imported observation without memory_session_id",{title:typeof e?.title=="string"?e.title:null,type:typeof e?.type=="string"?e.type:null}),{imported:!1,id:0};let s=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,M(e.title),e.created_at_epoch);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,M(e.text),e.type,M(e.title),M(e.subtitle),M(e.facts),M(e.narrative),M(e.concepts),M(e.files_read),M(e.files_modified),e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=null,t=e.platform_source?g(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${m}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!t||g(a.platform_source)===t)&&(s=a.id)}s===null&&(s=this.resolvePromptSessionDbId(e.content_session_id,void 0,t));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${s!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(s??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(s,e.content_session_id,e.prompt_number,M(e.prompt_text),e.created_at,e.created_at_epoch).lastInsertRowid}}};0&&(module.exports={SessionStore,TELEGRAM_WRAPUP_CLAIM_STALE_AFTER_MS,rollupObservationFileLists});
//# sourceMappingURL=SessionStore.js.map
