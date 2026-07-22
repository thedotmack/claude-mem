var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__filename).href;
"use strict";var B=Object.defineProperty;var me=Object.getOwnPropertyDescriptor;var Ee=Object.getOwnPropertyNames;var Te=Object.prototype.hasOwnProperty;var be=(i,e)=>{for(var t in e)B(i,t,{get:e[t],enumerable:!0})},fe=(i,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Ee(e))!Te.call(i,n)&&n!==t&&B(i,n,{get:()=>e[n],enumerable:!(s=me(e,n))||s.enumerable});return i};var ge=i=>fe(B({},"__esModule",{value:!0}),i);var Pe={};be(Pe,{SessionStore:()=>J});module.exports=ge(Pe);var K=require("bun:sqlite"),le=require("crypto");var g=require("path"),G=require("os"),U=require("fs"),Q=require("url");var Se=null;function Ne(i){return(Se??process.stderr.write.bind(process.stderr))(i)}function x(i){Ne(i)}var je=process.platform==="win32";function he(i){return i.replace(/^\uFEFF/,"")}function F(i){return JSON.parse(he(i))}function Re(){return typeof __dirname<"u"?__dirname:(0,g.dirname)((0,Q.fileURLToPath)(__IMPORT_META_URL__))}var Ve=Re();function Ie(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let i=(0,g.join)((0,G.homedir)(),".claude-mem"),e=(0,g.join)(i,"settings.json");try{if((0,U.existsSync)(e)){let t=F((0,U.readFileSync)(e,"utf-8")),s=t.env??t;if(s.CLAUDE_MEM_DATA_DIR)return s.CLAUDE_MEM_DATA_DIR}}catch{}return i}var R=Ie(),Oe=process.env.CLAUDE_CONFIG_DIR||(0,g.join)((0,G.homedir)(),".claude"),Ye=(0,g.join)(Oe,"plugins","marketplaces","thedotmack"),Ae=(0,g.join)(R,"logs"),Ke=(0,g.join)(R,"settings.json"),z=(0,g.join)(R,"claude-mem.db"),Le=(0,g.join)(R,"observer-sessions"),$=(0,g.basename)(Le);function Z(i){(0,U.mkdirSync)(i,{recursive:!0})}var j={dataDir:()=>R,workerPid:()=>(0,g.join)(R,"worker.pid"),serverPid:()=>(0,g.join)(R,".server-beta.pid"),serverPort:()=>(0,g.join)(R,".server-beta.port"),serverRuntime:()=>(0,g.join)(R,".server-beta.runtime.json"),settings:()=>(0,g.join)(R,"settings.json"),database:()=>(0,g.join)(R,"claude-mem.db"),chroma:()=>(0,g.join)(R,"chroma"),combinedCerts:()=>(0,g.join)(R,"combined_certs.pem"),transcriptsConfig:()=>(0,g.join)(R,"transcript-watch.json"),transcriptsState:()=>(0,g.join)(R,"transcript-watch-state.json"),corpora:()=>(0,g.join)(R,"corpora"),supervisorRegistry:()=>(0,g.join)(R,"supervisor.json"),envFile:()=>(0,g.join)(R,".env"),logsDir:()=>Ae};var v=require("fs"),ee=require("path");var W=(r=>(r[r.DEBUG=0]="DEBUG",r[r.INFO=1]="INFO",r[r.WARN=2]="WARN",r[r.ERROR=3]="ERROR",r[r.SILENT=4]="SILENT",r))(W||{}),H=null,q=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=j.logsDir();(0,v.existsSync)(e)||(0,v.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,ee.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=j.settings();if((0,v.existsSync)(e)){let t=(0,v.readFileSync)(e,"utf-8"),n=(F(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=W[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),r=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${r}:${o}:${a}.${_}`}log(e,t,s,n,r){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),a=W[e].padEnd(5),_=t.padEnd(6),u="";n?.correlationId?u=`[${n.correlationId}] `:n?.sessionId&&(u=`[session-${n.sessionId}] `);let c="";if(r!=null)if(r instanceof Error)c=this.getLevel()===0?`
${r.message}
${r.stack}`:` ${r.message}`;else if(this.getLevel()===0&&typeof r=="object")try{c=`
`+JSON.stringify(r,null,2)}catch{c=" "+this.formatData(r)}else c=" "+this.formatData(r);let l="";if(n){let{sessionId:N,memorySessionId:I,correlationId:S,...E}=n;Object.keys(E).length>0&&(l=` {${Object.entries(E).map(([O,C])=>`${O}=${C}`).join(", ")}}`)}let m=`[${o}] [${a}] [${_}] ${u}${s}${l}${c}`;if(this.logFilePath)try{(0,v.appendFileSync)(this.logFilePath,m+`
`,"utf8")}catch(N){let I=N instanceof Error?N:new Error(String(N));x(`[LOGGER] Failed to write to log file: ${I.message}
${I.stack??""}
`)}else x(m+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}setErrorSink(e){H=e}error(e,t,s,n){this.log(3,e,t,s,n),this.routeErrorToSink(t,s,n)}routeErrorToSink(e,t,s){try{if(!H||!(s instanceof Error))return;H(s)}catch{}}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}},d=new q;var se=require("crypto");function te(i,e,t){return(0,se.createHash)("sha256").update([i||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}var p="claude";function ye(i){return i.trim().toLowerCase().replace(/\s+/g,"-")}function L(i){if(!i)return p;let e=ye(i);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:p}function ne(i){let e=["claude","codex","cursor"];return[...i].sort((t,s)=>{let n=e.indexOf(t),r=e.indexOf(s);return n!==-1||r!==-1?n===-1?1:r===-1?-1:n-r:t.localeCompare(s)})}function re(i,e,t,s,n){let r=Date.now()-s,o=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return i.prepare(`
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
  `).get(a,t,r)??void 0}var ae=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],oe=new RegExp(`<(${ae.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g");var ie=100;function ve(i){let e=Object.fromEntries(ae.map(n=>[n,0]));oe.lastIndex=0;let t=0,s=i.replace(oe,(n,r)=>(e[r]=(e[r]??0)+1,t+=1,""));return t>ie&&d.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:t,maxAllowed:ie,contentLength:i.length}),{stripped:s.trim(),counts:e}}function de(i){return ve(i).stripped}var Ce=["task-notification"],is=new RegExp(`^\\s*<(${Ce.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),as=256*1024;var V=4e3;function k(i){let e=i.trim(),s=de(i).trim()||e;return s.length<=V?s:(d.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:s.length,storedLength:V}),`${s.slice(0,V-1)}\u2026`)}var De=require("bun:sqlite");var Ue=5e3,we=4194304;function Me(i){return i.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function w(i,e,t){try{i.run(e)}catch(s){let n=s instanceof Error?s:new Error(String(s));throw d.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},n),s}}function _e(i,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;w(i,`PRAGMA busy_timeout = ${Ue}`,"busy_timeout"),w(i,"PRAGMA foreign_keys = ON","foreign_keys"),w(i,"PRAGMA synchronous = NORMAL","synchronous"),w(i,`PRAGMA journal_size_limit = ${we}`,"journal_size_limit"),s&&!Me(i)&&w(i,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&w(i,"PRAGMA journal_mode = WAL","journal_mode")}var ue=4096;var xe=new Set(["set_title","set_prompt_session","remap_project"]),Fe=/^(?:0|[1-9][0-9]*)$/,ce=18446744073709551615n;function y(i){throw d.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:i}),new Error(`canonical content: ${i}`)}function P(i,e={}){return typeof i!="string"||!Fe.test(i)?y("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(i)>ce&&y("decimal value exceeds uint64"),e.positive&&i==="0"&&y("decimal value must be positive"),i)}function pe(i){let e=P(i);return BigInt(e)===ce&&y("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function ke(i){(i===null||typeof i!="object"||Array.isArray(i))&&y("mutation must be an object");let e=i;if((typeof e.op!="string"||!xe.has(e.op))&&y("unsupported mutation op"),e.op==="set_title"){let r=M(e,["fields","op","target"],"set_title"),o=X(r.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");o.memory_session_id===void 0&&o.content_session_id===void 0&&y("set_title target requires a session identifier");for(let _ of["memory_session_id","content_session_id","platform_source"])o[_]!==void 0&&D(o[_],_);let a=M(r.fields,["custom_title"],"set_title.fields");D(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let r=M(e,["fields","op","target"],"set_prompt_session"),o=M(r.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");Xe(o.origin_device_id),P(o.origin_local_id);let a=X(r.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");D(a.memory_session_id,"memory_session_id");for(let _ of["content_session_id","platform_source","project"])a[_]!==void 0&&D(a[_],_);return}let t=M(e,["fields","op","where"],"remap_project"),s=X(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&D(s.project,"project"),s.memory_session_id!==void 0&&D(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&y("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&y("remap_project where is empty");let n=X(t.fields,["merged_into_project","project"],"remap_project.fields");n.project!==void 0&&D(n.project,"project"),n.merged_into_project!==void 0&&D(n.merged_into_project,"merged_into_project"),Object.keys(n).length===0&&y("remap_project fields are empty")}function Y(i){ke(i)}function Xe(i){return typeof i!="string"||i.length===0||Buffer.byteLength(i,"utf8")>128?y("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):i}function D(i,e){return typeof i!="string"||i.length===0||i.trim().length===0||Buffer.byteLength(i,"utf8")>ue?y(`${e} must be a non-blank string of at most ${ue} UTF-8 bytes`):i}function M(i,e,t){if(i===null||typeof i!="object"||Array.isArray(i))return y(`${t} must be an object`);let s=i,n=Object.keys(s).sort(),r=[...e].sort();return(n.length!==r.length||n.some((o,a)=>o!==r[a]))&&y(`${t} must contain exactly: ${r.join(", ")}`),s}function X(i,e,t){if(i===null||typeof i!="object"||Array.isArray(i))return y(`${t} must be an object`);let s=i,n=new Set(e),r=Object.keys(s).find(o=>!n.has(o));return r&&y(`${t} contains unknown field ${r}`),s}var J=class{db;constructor(e=z){e instanceof K.Database?this.db=e:(e!==":memory:"&&Z(R),this.db=new K.Database(e)),_e(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let r=this.getIndexColumns(n.name);return r.length===t.length&&r.every((o,a)=>o===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let n=s?L(s):void 0;return n?this.db.prepare(`
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
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),d.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){d.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),r=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source");if(!(e&&!t&&s&&r)){if(r||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let a=o instanceof Error?o:new Error(String(o));throw d.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),o}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(u=>u.name==="session_db_id"),o=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(u=>u.table==="sdk_sessions"&&u.from==="content_session_id");if(e&&n&&!o)return;let a=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,_=n?`COALESCE(up.session_db_id, (
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
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,_,a),this.db.run("COMMIT")}catch(u){this.db.run("ROLLBACK");let c=u instanceof Error?u:new Error(String(u));throw d.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},c),u}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,t,s){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),s&&(this.db.run(`
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
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let r=n instanceof Error?n:new Error(String(n));throw d.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},r),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(n=>n.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),d.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let t=this.db.query(`PRAGMA table_info(${e})`).all(),s=new Set(t.map(n=>n.name));s.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),d.debug("DB",`Added origin_device_id column to ${e} table`)),s.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),d.debug("DB",`Added origin_local_id column to ${e} table`)),s.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),d.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(o,a)=>this.db.query(`PRAGMA table_info(${o})`).all().find(_=>_.name===a),s=o=>o?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(o=>s(t(o.table,o.column))))return;this.db.transaction(()=>{for(let o of e){let a=this.db.query(`PRAGMA table_info(${o.table})`).all(),_=a.find(c=>c.name===o.column);if(!_)throw new Error(`schema v46: missing ${o.table}.${o.column}`);for(let c of this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${o.column}) AS storage_type,
                 CAST(${o.column} AS TEXT) AS revision
          FROM ${o.table}
        `).iterate()){let l=c;if(l.storage_type==="real")throw new Error(`schema v46: ${o.table}.${o.column} row ${l.row_id} is REAL and unrecoverably rounded`);if(l.storage_type!=="integer"&&l.storage_type!=="text")throw new Error(`schema v46: ${o.table}.${o.column} row ${l.row_id} has unsupported ${l.storage_type} storage`);try{P(l.revision,{positive:!0})}catch{throw new Error(`schema v46: ${o.table}.${o.column} row ${l.row_id} is not a positive canonical uint64 revision`)}}if(s(_))continue;if(a.some(c=>c.name===o.temporary))throw new Error(`schema v46: unexpected temporary column ${o.table}.${o.temporary}`);this.db.run(`ALTER TABLE ${o.table} ADD COLUMN ${o.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${o.table} SET ${o.temporary} = CAST(${o.column} AS TEXT)`);let u=this.db.prepare(`
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
    `);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:c,kind:l}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${c}
            WHERE origin_device_id IS NULL
          `).run(l),this.db.prepare(`
            UPDATE ${c} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let u=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,u),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,u)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&t)return;let r=Date.parse(s.applied_at);if(!Number.isSafeInteger(r)||r<0)throw new Error(`schema v48: invalid v47 applied_at ${s.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:_}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(_,r);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(o=>o.name)),r=["retry_count","failed_at_epoch","completed_at_epoch"].filter(o=>s.has(o));if(!(e&&r.length===0)){if(r.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let o of r)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${o}`),d.debug("DB",`Dropped dead column ${o} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK"),d.warn("DB","Failed to drop dead columns from pending_messages",{},o instanceof Error?o:new Error(String(o)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),d.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),d.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),d.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),d.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(s=>s.unique===1&&s.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}d.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),d.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}d.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),d.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}d.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),d.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}d.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `);let s=`
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
    `;try{this.db.run(s),this.db.run(n)}catch(r){r instanceof Error?d.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},r):d.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(r))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),d.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),d.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),d.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),d.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}d.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),d.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;d.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,r,o)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),_=a.some(c=>c.name===r);return a.some(c=>c.name===o)?!1:_?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${r} TO ${o}`),d.debug("DB",`Renamed ${n}.${r} to ${o}`),!0):(d.warn("DB",`Column ${r} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?d.debug("DB",`Successfully renamed ${t} session ID columns`):d.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),d.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;d.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(T=>T.name==="metadata"),n=t.some(T=>T.name==="content_hash"),r=s?`,
        metadata TEXT`:"",o=s?", metadata":"",a=n?`,
        content_hash TEXT`:"",_=n?", content_hash":"",u=`
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
        created_at_epoch INTEGER NOT NULL${r}${a},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,c=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${o}${_}
      FROM observations
    `,l=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,m=`
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
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let N=`
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
    `,I=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,S=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,E=`
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
    `;try{this.recreateObservationsWithCascade(u,c,l,m),this.recreateSessionSummariesWithCascade(N,I,S,E),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),d.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(T){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),T instanceof Error?T:new Error(String(T))}}recreateObservationsWithCascade(e,t,s,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,t,s,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),d.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),d.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),d.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),s=e.some(n=>n.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="agent_type"),n=t.some(o=>o.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let r=this.db.query("PRAGMA table_info(pending_messages)").all();if(r.length>0){let o=r.some(_=>_.name==="agent_type"),a=r.some(_=>_.name==="agent_id");o||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let r=n instanceof Error?n:new Error(String(n));throw d.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},r),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(r=>r.name==="memory_session_id"),n=t.some(r=>r.name==="content_hash");if(!s||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw d.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},o),r}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),d.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e),t&&this.requeuePromptSync(e)}enqueueMutationOp(e,t){let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let n=s.target;n?.origin_device_id===null&&(n.origin_device_id="self")}Y(s),this.db.prepare(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,le.randomUUID)(),String(e),JSON.stringify(t),Date.now())}requeuePromptSync(e){let t=this.db.prepare(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let n=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(n.length!==0)for(let r of n){let o=pe(r.sync_rev);this.db.prepare(`
          UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(o,r.id),this.enqueueMutationOp(o,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:r.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s,t,e)}ensureMemorySessionIdRegistered(e,t,s){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),this.requeuePromptSync(e),d.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:t})),typeof s=="number"&&n.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e)}getAllProjects(e){let t=e?L(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[$];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",n.push(p,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...n).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${p}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${p}'), project
      ORDER BY latest_epoch DESC
    `).all($),t=[],s=new Set,n={};for(let o of e){let a=L(o.platform_source);n[a]||(n[a]=[]),n[a].includes(o.project)||n[a].push(o.project),s.has(o.project)||(s.add(o.project),t.push(o.project))}let r=ne(Object.keys(n));return{projects:t,sources:r,projectsBySource:Object.fromEntries(r.map(o=>[o,n[o]||[]]))}}getLatestUserPrompt(e,t){let s=this.resolvePromptSessionDbId(e,t),n=s!==null?"up.session_db_id = ?":"up.content_session_id = ?",r=s!==null?s:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${n}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(r)}findRecentDuplicateUserPrompt(e,t,s,n){return re(this.db,e,k(t),s,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let n=[e],r="";return s&&(r=`AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`,n.push(L(s))),n.push(t),this.db.prepare(`
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
    `).all(...n)}getObservationsForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
        )
      `,s.push(L(t))),this.db.prepare(`
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
    `).get(e,L(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:r,platformSource:o,type:a,concepts:_,files:u}=t,c=s==="relevance",l=c?"":`ORDER BY o.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,m=n&&!c?`LIMIT ${n}`:"",N=e.map(()=>"?").join(","),I=[...e],S=[];if(r&&(S.push("o.project = ?"),I.push(r)),o&&(S.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),I.push(L(o))),a)if(Array.isArray(a)){let h=a.map(()=>"?").join(",");S.push(`o.type IN (${h})`),I.push(...a)}else S.push("o.type = ?"),I.push(a);if(_){let h=Array.isArray(_)?_:[_],f=h.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");I.push(...h),S.push(`(${f.join(" OR ")})`)}if(u){let h=Array.isArray(u)?u:[u],f=h.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");h.forEach(A=>{I.push(`%${A}%`,`%${A}%`)}),S.push(`(${f.join(" OR ")})`)}let E=S.length>0?`WHERE o.id IN (${N}) AND ${S.join(" AND ")}`:`WHERE o.id IN (${N})`,O=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${E}
      ${l}
      ${m}
    `).all(...I);if(!c)return O;let C=new Map(O.map(h=>[h.id,h])),b=e.map(h=>C.get(h)).filter(h=>!!h);return n?b.slice(0,n):b}getSummaryForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${p}') = ?
        )
      `,s.push(L(t))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(...s)||null}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${p}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${p}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${t})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e,t){let s=this.resolvePromptSessionDbId(e,t);return s!==null?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(s).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,t,s,n,r){let o=new Date,a=o.getTime(),_=r?L(r):p,u=k(s);n&&this.validateSetTitleMutation(e,_,n);let c=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(p,_,e);if(c){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(t,c.id),n){let m=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(c.id);m&&m.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(n,c.id),this.enqueueSetTitleOp(e,_,n))}return c.id}let l=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,_,u,n||null,o.toISOString(),a);return n&&this.enqueueSetTitleOp(e,_,n),Number(l.lastInsertRowid)}enqueueSetTitleOp(e,t,s){let n=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",n)}validateSetTitleMutation(e,t,s){let n={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return Y(n),n}saveUserPrompt(e,t,s,n){let r=new Date,o=r.getTime(),a=k(s),_=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(_,e,t,a,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,t,s){let n=this.resolvePromptSessionDbId(e,s);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,n,r=0,o,a){let _=this.storeObservations(e,t,[s],null,n,r,o,a);return{id:_.observationIds[0],createdAtEpoch:_.createdAtEpoch}}storeSummary(e,t,s,n,r=0,o){let a=o??Date.now(),_=new Date(a).toISOString(),c=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,n||null,r,_,a);return{id:Number(c.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,r,o=0,a,_){let u=a??Date.now(),c=new Date(u).toISOString();return this.db.transaction(()=>{let m=[],N=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),I=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let E of s){let T=te(e,E.title,E.narrative),O=N.get(e,t,E.type,E.title,E.subtitle,JSON.stringify(E.facts),E.narrative,JSON.stringify(E.concepts),JSON.stringify(E.files_read),JSON.stringify(E.files_modified),r||null,o,E.agent_type??null,E.agent_id??null,T,c,u,_||null,E.metadata??null);if(O){m.push(O.id);continue}let C=I.get(e,T);if(!C)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${T}`);m.push(C.id)}let S=null;if(n){let T=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,r||null,o,c,u);S=Number(T.lastInsertRowid)}return{observationIds:m,summaryId:S,createdAtEpoch:u}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:r,platformSource:o}=t,a=s==="relevance",_=a?"":`ORDER BY ss.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,u=n&&!a?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),l=[...e],m=[];r&&(m.push("ss.project = ?"),l.push(r)),o&&(m.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),l.push(L(o)));let N=m.length>0?`AND ${m.join(" AND ")}`:"",S=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${N}
      ${_}
      ${u}
    `).all(...l);if(!a)return S;let E=new Map(S.map(O=>[O.id,O])),T=e.map(O=>E.get(O)).filter(O=>!!O);return n?T.slice(0,n):T}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:r,platformSource:o}=t,a=s==="relevance",_=a?"":`ORDER BY up.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,u=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),l=[...e],m=[];r&&(m.push("s.project = ?"),l.push(r)),o&&(m.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),l.push(L(o)));let N=m.length>0?`AND ${m.join(" AND ")}`:"",S=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${N}
      ${_}
      ${u}
    `).all(...l);if(!a)return S;let E=new Map(S.map(T=>[T.id,T]));return e.map(T=>E.get(T)).filter(T=>!!T)}getTimelineAroundTimestamp(e,t=10,s=10,n,r){return this.getTimelineAroundObservation(null,e,t,s,n,r)}getTimelineAroundObservation(e,t,s=10,n=10,r,o){let a=o?L(o):void 0,_=(b,h)=>{let f=[],A=[];return r&&(f.push(`${b}.project = ?`),A.push(r)),a&&(f.push(`COALESCE(NULLIF(${h}.platform_source, ''), '${p}') = ?`),A.push(a)),{clause:f.length>0?`AND ${f.join(" AND ")}`:"",params:A}},u=_("o","src"),c=_("ss","src"),l=_("s","s"),m,N;if(e!==null){let b=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${u.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,h=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${u.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let f=this.db.prepare(b).all(e,...u.params,s+1),A=this.db.prepare(h).all(e,...u.params,n+1);if(f.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};m=f.length>0?f[f.length-1].created_at_epoch:t,N=A.length>0?A[A.length-1].created_at_epoch:t}catch(f){return f instanceof Error?d.error("DB","Error getting boundary observations",{project:r},f):d.error("DB","Error getting boundary observations with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}else{let b=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${u.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${u.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let f=this.db.prepare(b).all(t,...u.params,s),A=this.db.prepare(h).all(t,...u.params,n+1);if(f.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};m=f.length>0?f[f.length-1].created_at_epoch:t,N=A.length>0?A[A.length-1].created_at_epoch:t}catch(f){return f instanceof Error?d.error("DB","Error getting boundary timestamps",{project:r},f):d.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(f))),{observations:[],sessions:[],prompts:[]}}}let I=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${u.clause}
      ORDER BY o.created_at_epoch ASC
    `,S=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${c.clause}
      ORDER BY ss.created_at_epoch ASC
    `,E=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${l.clause}
      ORDER BY up.created_at_epoch ASC
    `,T=this.db.prepare(I).all(m,N,...u.params),O=this.db.prepare(S).all(m,N,...c.params),C=this.db.prepare(E).all(m,N,...l.params);return{observations:T,sessions:O.map(b=>({id:b.id,memory_session_id:b.memory_session_id,project:b.project,request:b.request,completed:b.completed,next_steps:b.next_steps,created_at:b.created_at,created_at_epoch:b.created_at_epoch})),prompts:C.map(b=>({id:b.id,content_session_id:b.content_session_id,prompt_number:b.prompt_number,prompt_text:b.prompt_text,project:b.project,platform_source:b.platform_source,created_at:b.created_at,created_at_epoch:b.created_at_epoch}))}}getOrCreateManualSession(e){let t=`manual-${e}`,s=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return t;let r=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,s,e,p,r.toISOString(),r.getTime()),d.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=L(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let t=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?L(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${p}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!s||L(a.platform_source)===s)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};0&&(module.exports={SessionStore});
