"use strict";var zt=Object.create;var J=Object.defineProperty;var Zt=Object.getOwnPropertyDescriptor;var es=Object.getOwnPropertyNames;var ts=Object.getPrototypeOf,ss=Object.prototype.hasOwnProperty;var ns=(n,e)=>{for(var t in e)J(n,t,{get:e[t],enumerable:!0})},Le=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of es(e))!ss.call(n,r)&&r!==t&&J(n,r,{get:()=>e[r],enumerable:!(s=Zt(e,r))||s.enumerable});return n};var H=(n,e,t)=>(t=n!=null?zt(ts(n)):{},Le(e||!n||!n.__esModule?J(t,"default",{value:n,enumerable:!0}):t,n)),rs=n=>Le(J({},"__esModule",{value:!0}),n);var js={};ns(js,{generateContext:()=>Qt,generateContextWithStats:()=>Ie});module.exports=rs(js);var qt=H(require("path"),1),Kt=require("os"),Jt=require("fs");var Se=require("bun:sqlite"),Ye=require("crypto");var b=require("path"),ce=require("os"),F=require("fs"),ye=require("url");var T=require("fs"),Ce=require("crypto"),M=require("path");var os=null;function is(n){return(os??process.stderr.write.bind(process.stderr))(n)}function k(n){is(n)}var as=process.platform==="win32";function ds(n){return n.replace(/^\uFEFF/,"")}function $(n){return JSON.parse(ds(n))}function _s(n){(0,T.existsSync)(n)||(0,T.mkdirSync)(n,{recursive:!0})}function ue(n,e){let t=n;try{if((0,T.lstatSync)(n).isSymbolicLink())try{t=(0,T.realpathSync)(n)}catch(_){let u=_ instanceof Error?_:new Error(String(_));k(`claude-mem: realpathSync failed for ${n}, resolving symlink manually: ${u.message}
`);let l=(0,T.readlinkSync)(n);t=(0,M.resolve)((0,M.dirname)(n),l)}}catch(_){let u=_.code;if(u!=="ENOENT"&&u!=="ENOTDIR")throw _}_s((0,M.dirname)(t));let s=(0,M.dirname)(t),r=(0,M.basename)(t),o=(0,M.join)(s,`.${r}.${process.pid}.${(0,Ce.randomBytes)(6).toString("hex")}.tmp`),i=Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),a;try{a=(0,T.statSync)(t).mode&511}catch{}let d;try{d=a!==void 0?(0,T.openSync)(o,"w",a):(0,T.openSync)(o,"w");let _=0;for(;_<i.length;){let u=(0,T.writeSync)(d,i,_,i.length-_);if(u===0)throw new Error(`writeSync stalled at ${_}/${i.length} bytes`);_+=u}if((0,T.fsyncSync)(d),(0,T.closeSync)(d),d=void 0,(0,T.renameSync)(o,t),!as){let u;try{u=(0,T.openSync)(s,"r"),(0,T.fsyncSync)(u)}catch(l){let m=l instanceof Error?l:new Error(String(l));k(`claude-mem: directory fsync failed for ${s}: ${m.message}
`)}finally{if(u!==void 0)try{(0,T.closeSync)(u)}catch{}}}}catch(_){if(d!==void 0)try{(0,T.closeSync)(d)}catch{}try{(0,T.unlinkSync)(o)}catch{}throw _}}var ps={};function us(){return typeof __dirname<"u"?__dirname:(0,b.dirname)((0,ye.fileURLToPath)(ps.url))}var cs=us();function Es(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let n=(0,b.join)((0,ce.homedir)(),".claude-mem"),e=(0,b.join)(n,"settings.json");try{if((0,F.existsSync)(e)){let t=$((0,F.readFileSync)(e,"utf-8")),s=t.env??t;if(s.CLAUDE_MEM_DATA_DIR)return s.CLAUDE_MEM_DATA_DIR}}catch{}return n}var I=Es(),Ee=process.env.CLAUDE_CONFIG_DIR||(0,b.join)((0,ce.homedir)(),".claude"),Qs=(0,b.join)(Ee,"plugins","marketplaces","thedotmack"),ls=(0,b.join)(I,"logs"),zs=(0,b.join)(I,"settings.json"),De=(0,b.join)(I,"claude-mem.db"),ms=(0,b.join)(I,"observer-sessions"),le=(0,b.basename)(ms);function ve(n){(0,F.mkdirSync)(n,{recursive:!0})}function Me(){return(0,b.join)(cs,"..")}var G={dataDir:()=>I,workerPid:()=>(0,b.join)(I,"worker.pid"),serverPid:()=>(0,b.join)(I,".server-beta.pid"),serverPort:()=>(0,b.join)(I,".server-beta.port"),serverRuntime:()=>(0,b.join)(I,".server-beta.runtime.json"),settings:()=>(0,b.join)(I,"settings.json"),database:()=>(0,b.join)(I,"claude-mem.db"),chroma:()=>(0,b.join)(I,"chroma"),combinedCerts:()=>(0,b.join)(I,"combined_certs.pem"),transcriptsConfig:()=>(0,b.join)(I,"transcript-watch.json"),transcriptsState:()=>(0,b.join)(I,"transcript-watch-state.json"),corpora:()=>(0,b.join)(I,"corpora"),supervisorRegistry:()=>(0,b.join)(I,"supervisor.json"),envFile:()=>(0,b.join)(I,".env"),logsDir:()=>ls};var U=require("fs"),Ue=require("path");var pe=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(pe||{}),me=null,Te=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=G.logsDir();(0,U.existsSync)(e)||(0,U.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,Ue.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=G.settings();if((0,U.existsSync)(e)){let t=(0,U.readFileSync)(e,"utf-8"),r=($(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=pe[r]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${r} ${o}:${i}:${a}.${d}`}log(e,t,s,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=pe[e].padEnd(5),d=t.padEnd(6),_="";r?.correlationId?_=`[${r.correlationId}] `:r?.sessionId&&(_=`[session-${r.sessionId}] `);let u="";if(o!=null)if(o instanceof Error)u=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{u=`
`+JSON.stringify(o,null,2)}catch{u=" "+this.formatData(o)}else u=" "+this.formatData(o);let l="";if(r){let{sessionId:g,memorySessionId:N,correlationId:R,...f}=r;Object.keys(f).length>0&&(l=` {${Object.entries(f).map(([C,x])=>`${C}=${x}`).join(", ")}}`)}let m=`[${i}] [${a}] [${d}] ${_}${s}${l}${u}`;if(this.logFilePath)try{(0,U.appendFileSync)(this.logFilePath,m+`
`,"utf8")}catch(g){let N=g instanceof Error?g:new Error(String(g));k(`[LOGGER] Failed to write to log file: ${N.message}
${N.stack??""}
`)}else k(m+`
`)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}setErrorSink(e){me=e}error(e,t,s,r){this.log(3,e,t,s,r),this.routeErrorToSink(t,s,r)}routeErrorToSink(e,t,s){try{if(!me||!(s instanceof Error))return;me(s)}catch{}}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}},c=new Te;var xe=require("crypto");function we(n,e,t){return(0,xe.createHash)("sha256").update([n||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}var p="claude";function Ts(n){return n.trim().toLowerCase().replace(/\s+/g,"-")}function L(n){if(!n)return p;let e=Ts(n);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:p}function ke(n){let e=["claude","codex","cursor"];return[...n].sort((t,s)=>{let r=e.indexOf(t),o=e.indexOf(s);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:t.localeCompare(s)})}function $e(n,e,t,s,r){let o=Date.now()-s,i=r!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=r??e;return n.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${p}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${i}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,t,o)??void 0}var Xe=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],Fe=new RegExp(`<(${Xe.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),He=/<system-reminder>[\s\S]*?<\/system-reminder>/g,Pe=100;function gs(n){let e=Object.fromEntries(Xe.map(r=>[r,0]));Fe.lastIndex=0;let t=0,s=n.replace(Fe,(r,o)=>(e[o]=(e[o]??0)+1,t+=1,""));return t>Pe&&c.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:t,maxAllowed:Pe,contentLength:n.length}),{stripped:s.trim(),counts:e}}function Ge(n){return gs(n).stripped}var fs=["task-notification"],un=new RegExp(`^\\s*<(${fs.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),cn=256*1024;var ge=4e3;function Q(n){let e=n.trim(),s=Ge(n).trim()||e;return s.length<=ge?s:(c.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:s.length,storedLength:ge}),`${s.slice(0,ge-1)}\u2026`)}var Ss=require("bun:sqlite");var bs=5e3,hs=4194304;function Os(n){return n.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function P(n,e,t){try{n.run(e)}catch(s){let r=s instanceof Error?s:new Error(String(s));throw c.warn("DB",`Failed to apply SQLite pragma ${t}`,{sql:e},r),s}}function Be(n,e={}){let{enableWal:t=!0,enableIncrementalAutoVacuum:s=!0}=e;P(n,`PRAGMA busy_timeout = ${bs}`,"busy_timeout"),P(n,"PRAGMA foreign_keys = ON","foreign_keys"),P(n,"PRAGMA synchronous = NORMAL","synchronous"),P(n,`PRAGMA journal_size_limit = ${hs}`,"journal_size_limit"),s&&!Os(n)&&P(n,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),t&&P(n,"PRAGMA journal_mode = WAL","journal_mode")}var je=4096;var Rs=new Set(["set_title","set_prompt_session","remap_project"]),Ns=/^(?:0|[1-9][0-9]*)$/,We=18446744073709551615n;function D(n){throw c.debug("CLOUD_SYNC","Rejected invalid canonical content",{reason:n}),new Error(`canonical content: ${n}`)}function Z(n,e={}){return typeof n!="string"||!Ns.test(n)?D("decimal values must be unsigned base-10 strings without leading zeroes"):(BigInt(n)>We&&D("decimal value exceeds uint64"),e.positive&&n==="0"&&D("decimal value must be positive"),n)}function Ve(n){let e=Z(n);return BigInt(e)===We&&D("uint64 sequence overflow"),(BigInt(e)+1n).toString(10)}function As(n){(n===null||typeof n!="object"||Array.isArray(n))&&D("mutation must be an object");let e=n;if((typeof e.op!="string"||!Rs.has(e.op))&&D("unsupported mutation op"),e.op==="set_title"){let o=B(e,["fields","op","target"],"set_title"),i=z(o.target,["content_session_id","memory_session_id","platform_source"],"set_title.target");i.memory_session_id===void 0&&i.content_session_id===void 0&&D("set_title target requires a session identifier");for(let d of["memory_session_id","content_session_id","platform_source"])i[d]!==void 0&&w(i[d],d);let a=B(o.fields,["custom_title"],"set_title.fields");w(a.custom_title,"custom_title");return}if(e.op==="set_prompt_session"){let o=B(e,["fields","op","target"],"set_prompt_session"),i=B(o.target,["origin_device_id","origin_local_id"],"set_prompt_session.target");Is(i.origin_device_id),Z(i.origin_local_id);let a=z(o.fields,["content_session_id","memory_session_id","platform_source","project"],"set_prompt_session.fields");w(a.memory_session_id,"memory_session_id");for(let d of["content_session_id","platform_source","project"])a[d]!==void 0&&w(a[d],d);return}let t=B(e,["fields","op","where"],"remap_project"),s=z(t.where,["memory_session_id","merged_into_project_is_null","project"],"remap_project.where");s.project!==void 0&&w(s.project,"project"),s.memory_session_id!==void 0&&w(s.memory_session_id,"memory_session_id"),s.merged_into_project_is_null!==void 0&&s.merged_into_project_is_null!==!0&&D("merged_into_project_is_null may only be true"),Object.keys(s).length===0&&D("remap_project where is empty");let r=z(t.fields,["merged_into_project","project"],"remap_project.fields");r.project!==void 0&&w(r.project,"project"),r.merged_into_project!==void 0&&w(r.merged_into_project,"merged_into_project"),Object.keys(r).length===0&&D("remap_project fields are empty")}function fe(n){As(n)}function Is(n){return typeof n!="string"||n.length===0||Buffer.byteLength(n,"utf8")>128?D("origin_device_id must be a non-empty string of at most 128 UTF-8 bytes"):n}function w(n,e){return typeof n!="string"||n.length===0||n.trim().length===0||Buffer.byteLength(n,"utf8")>je?D(`${e} must be a non-blank string of at most ${je} UTF-8 bytes`):n}function B(n,e,t){if(n===null||typeof n!="object"||Array.isArray(n))return D(`${t} must be an object`);let s=n,r=Object.keys(s).sort(),o=[...e].sort();return(r.length!==o.length||r.some((i,a)=>i!==o[a]))&&D(`${t} must contain exactly: ${o.join(", ")}`),s}function z(n,e,t){if(n===null||typeof n!="object"||Array.isArray(n))return D(`${t} must be an object`);let s=n,r=new Set(e),o=Object.keys(s).find(i=>!r.has(i));return o&&D(`${t} contains unknown field ${o}`),s}var ee=class{db;constructor(e=De){e instanceof Se.Database?this.db=e:(e!==":memory:"&&ve(I),this.db=new Se.Database(e)),Be(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.ensureSyncedAtColumns(),this.ensureSyncOriginColumns(),this.ensureSyncOutbox(),this.ensureSyncEntityLedger(),this.ensureSyncRevisionTextAffinity(),this.initializeSyncHubLaunchBaseline()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(r=>{if(r.unique!==1)return!1;let o=this.getIndexColumns(r.name);return o.length===t.length&&o.every((i,a)=>i===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let r=s?L(s):void 0;return r?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(p,r,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${p}')
        WHEN '${p}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),c.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(r){c.warn("DB","Failed to drop worker_pid column from pending_messages",{},r instanceof Error?r:new Error(String(r)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!t&&s&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let a=i instanceof Error?i:new Error(String(i));throw c.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),i}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let r=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&r&&!i)return;let a=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,d=r?`COALESCE(up.session_db_id, (
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
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,d,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let u=_ instanceof Error?_:new Error(String(_));throw c.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},u),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,t,s){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw c.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),r}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}ensureSyncedAtColumns(){for(let e of["observations","session_summaries","user_prompts"])this.db.query(`PRAGMA table_info(${e})`).all().some(r=>r.name==="synced_at")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN synced_at INTEGER`),c.debug("DB",`Added synced_at column to ${e} table`)),this.db.run(`CREATE INDEX IF NOT EXISTS idx_${e}_unsynced ON ${e}(id) WHERE synced_at IS NULL`);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(39,new Date().toISOString())}ensureSyncOriginColumns(){for(let e of["observations","session_summaries","user_prompts"]){let t=this.db.query(`PRAGMA table_info(${e})`).all(),s=new Set(t.map(r=>r.name));s.has("origin_device_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_device_id TEXT`),c.debug("DB",`Added origin_device_id column to ${e} table`)),s.has("origin_local_id")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN origin_local_id TEXT`),c.debug("DB",`Added origin_local_id column to ${e} table`)),s.has("sync_rev")||(this.db.run(`ALTER TABLE ${e} ADD COLUMN sync_rev TEXT NOT NULL DEFAULT '1'`),c.debug("DB",`Added sync_rev column to ${e} table`)),this.db.run(`
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
    `);let e=new Set(this.db.query("PRAGMA table_info(sync_outbox)").all().map(t=>t.name));e.has("canonical_body")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN canonical_body TEXT"),e.has("operation_sha256")||this.db.run("ALTER TABLE sync_outbox ADD COLUMN operation_sha256 TEXT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(42,new Date().toISOString())}ensureSyncRevisionTextAffinity(){let e=[{table:"observations",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"session_summaries",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"user_prompts",column:"sync_rev",temporary:"sync_rev_text_v46"},{table:"sync_outbox",column:"rev",temporary:"rev_text_v46"}],t=(i,a)=>this.db.query(`PRAGMA table_info(${i})`).all().find(d=>d.name===a),s=i=>i?.type.trim().toUpperCase()==="TEXT";if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(46)&&e.every(i=>s(t(i.table,i.column))))return;this.db.transaction(()=>{for(let i of e){let a=this.db.query(`PRAGMA table_info(${i.table})`).all(),d=a.find(u=>u.name===i.column);if(!d)throw new Error(`schema v46: missing ${i.table}.${i.column}`);for(let u of this.db.query(`
          SELECT CAST(id AS TEXT) AS row_id,
                 typeof(${i.column}) AS storage_type,
                 CAST(${i.column} AS TEXT) AS revision
          FROM ${i.table}
        `).iterate()){let l=u;if(l.storage_type==="real")throw new Error(`schema v46: ${i.table}.${i.column} row ${l.row_id} is REAL and unrecoverably rounded`);if(l.storage_type!=="integer"&&l.storage_type!=="text")throw new Error(`schema v46: ${i.table}.${i.column} row ${l.row_id} has unsupported ${l.storage_type} storage`);try{Z(l.revision,{positive:!0})}catch{throw new Error(`schema v46: ${i.table}.${i.column} row ${l.row_id} is not a positive canonical uint64 revision`)}}if(s(d))continue;if(a.some(u=>u.name===i.temporary))throw new Error(`schema v46: unexpected temporary column ${i.table}.${i.temporary}`);this.db.run(`ALTER TABLE ${i.table} ADD COLUMN ${i.temporary} TEXT NOT NULL DEFAULT '1'`),this.db.run(`UPDATE ${i.table} SET ${i.temporary} = CAST(${i.column} AS TEXT)`);let _=this.db.prepare(`
          SELECT CAST(id AS TEXT) AS row_id
          FROM ${i.table}
          WHERE ${i.temporary} <> CAST(${i.column} AS TEXT)
          LIMIT 1
        `).get();if(_)throw new Error(`schema v46: failed to copy ${i.table}.${i.column} row ${_.row_id} exactly`);this.db.run(`ALTER TABLE ${i.table} DROP COLUMN ${i.column}`),this.db.run(`ALTER TABLE ${i.table} RENAME COLUMN ${i.temporary} TO ${i.column}`)}this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(46,new Date().toISOString())})()}ensureSyncEntityLedger(){this.db.run(`
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
    `);let s=this.db.prepare("SELECT version, applied_at FROM schema_versions WHERE version = ?").get(47);if(!s){let a=Date.now();this.db.transaction(()=>{this.db.run("DELETE FROM sync_launch_exclusions");for(let{table:u,kind:l}of e)this.db.prepare(`
            INSERT INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
            SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
            FROM ${u}
            WHERE origin_device_id IS NULL
          `).run(l),this.db.prepare(`
            UPDATE ${u} SET synced_at = ?
            WHERE synced_at IS NULL AND origin_device_id IS NULL
          `).run(a);this.db.run("DELETE FROM sync_outbox"),this.db.run("DELETE FROM sync_content_outbox"),this.db.run("DELETE FROM sync_dead_letter"),this.db.run("DELETE FROM sync_state");let _=new Date(a).toISOString();this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(47,_),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,_)})();return}if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(48)&&t)return;let o=Date.parse(s.applied_at);if(!Number.isSafeInteger(o)||o<0)throw new Error(`schema v48: invalid v47 applied_at ${s.applied_at}`);this.db.transaction(()=>{for(let{table:a,kind:d}of e)this.db.prepare(`
          INSERT OR IGNORE INTO sync_launch_exclusions (kind, origin_local_id, through_rev)
          SELECT ?, CAST(id AS TEXT), CAST(sync_rev AS TEXT)
          FROM ${a}
          WHERE origin_device_id IS NULL
            AND synced_at > 0
            AND synced_at <= ?
        `).run(d,o);this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(48,new Date().toISOString())})()}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>s.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),c.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),c.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),c.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),c.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),c.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),c.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(s=>s.unique===1&&s.origin==="u")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}c.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),c.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}c.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),c.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}c.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),c.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}c.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `,r=`
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
    `;try{this.db.run(s),this.db.run(r)}catch(o){o instanceof Error?c.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):c.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),c.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),c.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),c.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),c.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}c.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),c.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;c.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),c.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(c.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?c.debug("DB",`Successfully renamed ${t} session ID columns`):c.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),c.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;c.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(S=>S.name==="metadata"),r=t.some(S=>S.name==="content_hash"),o=s?`,
        metadata TEXT`:"",i=s?", metadata":"",a=r?`,
        content_hash TEXT`:"",d=r?", content_hash":"",_=`
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
        created_at_epoch INTEGER NOT NULL${o}${a},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,u=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${i}${d}
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
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let g=`
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
    `,N=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,R=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,f=`
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
    `;try{this.recreateObservationsWithCascade(_,u,l,m),this.recreateSessionSummariesWithCascade(g,N,R,f),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),c.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(S){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),S instanceof Error?S:new Error(String(S))}}recreateObservationsWithCascade(e,t,s,r){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(r)}recreateSessionSummariesWithCascade(e,t,s,r){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(r)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),c.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title");e&&s||(s||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),c.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&r||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),c.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(r=>r.name==="generated_by_model"),s=e.some(r=>r.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="agent_type"),r=t.some(i=>i.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(d=>d.name==="agent_type"),a=o.some(d=>d.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw c.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),r}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="memory_session_id"),r=t.some(o=>o.name==="content_hash");if(!s||!r){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw c.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),c.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e),t&&this.requeuePromptSync(e)}enqueueMutationOp(e,t){let s=JSON.parse(JSON.stringify(t));if(s.op==="set_prompt_session"){let r=s.target;r?.origin_device_id===null&&(r.origin_device_id="self")}fe(s),this.db.prepare(`
      INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
      VALUES (?, ?, ?, ?)
    `).run((0,Ye.randomUUID)(),String(e),JSON.stringify(t),Date.now())}requeuePromptSync(e){let t=this.db.prepare(`
      SELECT memory_session_id, project, content_session_id, platform_source
      FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t?.memory_session_id)return;this.db.transaction(()=>{let r=this.db.prepare(`
        SELECT CAST(id AS TEXT) AS id, CAST(sync_rev AS TEXT) AS sync_rev FROM user_prompts
        WHERE session_db_id = ? AND origin_device_id IS NULL
      `).all(e);if(r.length!==0)for(let o of r){let i=Ve(o.sync_rev);this.db.prepare(`
          UPDATE user_prompts SET sync_rev = ?, synced_at = NULL
          WHERE id = ? AND origin_device_id IS NULL
        `).run(i,o.id),this.enqueueMutationOp(i,{op:"set_prompt_session",target:{origin_device_id:null,origin_local_id:o.id},fields:{memory_session_id:t.memory_session_id,project:t.project,content_session_id:t.content_session_id,platform_source:t.platform_source}})}})()}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s,t,e)}ensureMemorySessionIdRegistered(e,t,s){let r=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!r)throw new Error(`Session ${e} not found in sdk_sessions`);r.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),this.requeuePromptSync(e),c.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:r.memory_session_id,newId:t})),typeof s=="number"&&r.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e)}getAllProjects(e){let t=e?L(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,r=[le];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",r.push(p,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${p}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${p}'), project
      ORDER BY latest_epoch DESC
    `).all(le),t=[],s=new Set,r={};for(let i of e){let a=L(i.platform_source);r[a]||(r[a]=[]),r[a].includes(i.project)||r[a].push(i.project),s.has(i.project)||(s.add(i.project),t.push(i.project))}let o=ke(Object.keys(r));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getLatestUserPrompt(e,t){let s=this.resolvePromptSessionDbId(e,t),r=s!==null?"up.session_db_id = ?":"up.content_session_id = ?",o=s!==null?s:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${r}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(o)}findRecentDuplicateUserPrompt(e,t,s,r){return $e(this.db,e,Q(t),s,this.resolvePromptSessionDbId(e,r)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let r=[e],o="";return s&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`,r.push(L(s))),r.push(t),this.db.prepare(`
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
            AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
        )
      `,s.push(L(t))),this.db.prepare(`
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
        AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
    `).get(e,L(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o,platformSource:i,type:a,concepts:d,files:_}=t,u=s==="relevance",l=u?"":`ORDER BY o.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,m=r&&!u?`LIMIT ${r}`:"",g=e.map(()=>"?").join(","),N=[...e],R=[];if(o&&(R.push("o.project = ?"),N.push(o)),i&&(R.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),N.push(L(i))),a)if(Array.isArray(a)){let A=a.map(()=>"?").join(",");R.push(`o.type IN (${A})`),N.push(...a)}else R.push("o.type = ?"),N.push(a);if(d){let A=Array.isArray(d)?d:[d],O=A.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");N.push(...A),R.push(`(${O.join(" OR ")})`)}if(_){let A=Array.isArray(_)?_:[_],O=A.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");A.forEach(y=>{N.push(`%${y}%`,`%${y}%`)}),R.push(`(${O.join(" OR ")})`)}let f=R.length>0?`WHERE o.id IN (${g}) AND ${R.join(" AND ")}`:`WHERE o.id IN (${g})`,C=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${f}
      ${l}
      ${m}
    `).all(...N);if(!u)return C;let x=new Map(C.map(A=>[A.id,A])),h=e.map(A=>x.get(A)).filter(A=>!!A);return r?h.slice(0,r):h}getSummaryForSession(e,t){let s=[e],r="";return t&&(r=`
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
      ${r}
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
    `).get(e).count}createSDKSession(e,t,s,r,o){let i=new Date,a=i.getTime(),d=o?L(o):p,_=Q(s);r&&this.validateSetTitleMutation(e,d,r);let u=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(p,d,e);if(u){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(t,u.id),r){let m=this.db.prepare("SELECT custom_title FROM sdk_sessions WHERE id = ?").get(u.id);m&&m.custom_title===null&&(this.db.prepare(`
            UPDATE sdk_sessions SET custom_title = ?
            WHERE id = ? AND custom_title IS NULL
          `).run(r,u.id),this.enqueueSetTitleOp(e,d,r))}return u.id}let l=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,d,_,r||null,i.toISOString(),a);return r&&this.enqueueSetTitleOp(e,d,r),Number(l.lastInsertRowid)}enqueueSetTitleOp(e,t,s){let r=this.validateSetTitleMutation(e,t,s);this.enqueueMutationOp("1",r)}validateSetTitleMutation(e,t,s){let r={op:"set_title",target:{content_session_id:e,platform_source:t},fields:{custom_title:s}};return fe(r),r}saveUserPrompt(e,t,s,r){let o=new Date,i=o.getTime(),a=Q(s),d=this.resolvePromptSessionDbId(e,r);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d,e,t,a,o.toISOString(),i).lastInsertRowid}getUserPrompt(e,t,s){let r=this.resolvePromptSessionDbId(e,s);return r!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(r,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,r,o=0,i,a){let d=this.storeObservations(e,t,[s],null,r,o,i,a);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch}}storeSummary(e,t,s,r,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,r||null,o,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,r,o,i=0,a,d){let _=a??Date.now(),u=new Date(_).toISOString();return this.db.transaction(()=>{let m=[],g=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),N=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let f of s){let S=we(e,f.title,f.narrative),C=g.get(e,t,f.type,f.title,f.subtitle,JSON.stringify(f.facts),f.narrative,JSON.stringify(f.concepts),JSON.stringify(f.files_read),JSON.stringify(f.files_modified),o||null,i,f.agent_type??null,f.agent_id??null,S,u,_,d||null,f.metadata??null);if(C){m.push(C.id);continue}let x=N.get(e,S);if(!x)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${S}`);m.push(x.id)}let R=null;if(r){let S=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,o||null,i,u,_);R=Number(S.lastInsertRowid)}return{observationIds:m,summaryId:R,createdAtEpoch:_}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o,platformSource:i}=t,a=s==="relevance",d=a?"":`ORDER BY ss.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,_=r&&!a?`LIMIT ${r}`:"",u=e.map(()=>"?").join(","),l=[...e],m=[];o&&(m.push("ss.project = ?"),l.push(o)),i&&(m.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),l.push(L(i)));let g=m.length>0?`AND ${m.join(" AND ")}`:"",R=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${u}) ${g}
      ${d}
      ${_}
    `).all(...l);if(!a)return R;let f=new Map(R.map(C=>[C.id,C])),S=e.map(C=>f.get(C)).filter(C=>!!C);return r?S.slice(0,r):S}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o,platformSource:i}=t,a=s==="relevance",d=a?"":`ORDER BY up.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,_=r?`LIMIT ${r}`:"",u=e.map(()=>"?").join(","),l=[...e],m=[];o&&(m.push("s.project = ?"),l.push(o)),i&&(m.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),l.push(L(i)));let g=m.length>0?`AND ${m.join(" AND ")}`:"",R=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${u}) ${g}
      ${d}
      ${_}
    `).all(...l);if(!a)return R;let f=new Map(R.map(S=>[S.id,S]));return e.map(S=>f.get(S)).filter(S=>!!S)}getTimelineAroundTimestamp(e,t=10,s=10,r,o){return this.getTimelineAroundObservation(null,e,t,s,r,o)}getTimelineAroundObservation(e,t,s=10,r=10,o,i){let a=i?L(i):void 0,d=(h,A)=>{let O=[],y=[];return o&&(O.push(`${h}.project = ?`),y.push(o)),a&&(O.push(`COALESCE(NULLIF(${A}.platform_source, ''), '${p}') = ?`),y.push(a)),{clause:O.length>0?`AND ${O.join(" AND ")}`:"",params:y}},_=d("o","src"),u=d("ss","src"),l=d("s","s"),m,g;if(e!==null){let h=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${_.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,A=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${_.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let O=this.db.prepare(h).all(e,..._.params,s+1),y=this.db.prepare(A).all(e,..._.params,r+1);if(O.length===0&&y.length===0)return{observations:[],sessions:[],prompts:[]};m=O.length>0?O[O.length-1].created_at_epoch:t,g=y.length>0?y[y.length-1].created_at_epoch:t}catch(O){return O instanceof Error?c.error("DB","Error getting boundary observations",{project:o},O):c.error("DB","Error getting boundary observations with non-Error",{},new Error(String(O))),{observations:[],sessions:[],prompts:[]}}}else{let h=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${_.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,A=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${_.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let O=this.db.prepare(h).all(t,..._.params,s),y=this.db.prepare(A).all(t,..._.params,r+1);if(O.length===0&&y.length===0)return{observations:[],sessions:[],prompts:[]};m=O.length>0?O[O.length-1].created_at_epoch:t,g=y.length>0?y[y.length-1].created_at_epoch:t}catch(O){return O instanceof Error?c.error("DB","Error getting boundary timestamps",{project:o},O):c.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(O))),{observations:[],sessions:[],prompts:[]}}}let N=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${_.clause}
      ORDER BY o.created_at_epoch ASC
    `,R=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${u.clause}
      ORDER BY ss.created_at_epoch ASC
    `,f=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${l.clause}
      ORDER BY up.created_at_epoch ASC
    `,S=this.db.prepare(N).all(m,g,..._.params),C=this.db.prepare(R).all(m,g,...u.params),x=this.db.prepare(f).all(m,g,...l.params);return{observations:S,sessions:C.map(h=>({id:h.id,memory_session_id:h.memory_session_id,project:h.project,request:h.request,completed:h.completed,next_steps:h.next_steps,created_at:h.created_at,created_at_epoch:h.created_at_epoch})),prompts:x.map(h=>({id:h.id,content_session_id:h.content_session_id,prompt_number:h.prompt_number,prompt_text:h.prompt_text,project:h.project,platform_source:h.platform_source,created_at:h.created_at,created_at_epoch:h.created_at_epoch}))}}getOrCreateManualSession(e){let t=`manual-${e}`,s=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,s,e,p,o.toISOString(),o.getTime()),c.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=L(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
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
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!s||L(a.platform_source)===s)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let r=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);return r?{imported:!1,id:r.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Ke=require("os"),Je=H(require("path"),1),Qe=require("child_process");var te=require("fs"),X=H(require("path"),1);var j={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function qe(n){let e=X.default.join(n,".git"),t;try{t=(0,te.statSync)(e)}catch(u){return u instanceof Error&&u.code!=="ENOENT"&&c.warn("GIT","Unexpected error checking .git",{error:u instanceof Error?u.message:String(u)}),j}if(!t.isFile())return j;let s;try{s=(0,te.readFileSync)(e,"utf-8").trim()}catch(u){return c.warn("GIT","Failed to read .git file",{error:u instanceof Error?u.message:String(u)}),j}let r=s.match(/^gitdir:\s*(.+)$/);if(!r)return j;let i=X.default.resolve(X.default.dirname(e),r[1]).match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return j;let a=i[1],d=X.default.basename(n),_=X.default.basename(a);return{isWorktree:!0,worktreeName:d,parentRepoPath:a,parentProjectName:_}}function ze(n){return n==="~"||n.startsWith("~/")?n.replace(/^~/,(0,Ke.homedir)()):n}function Ls(n){try{return(0,Qe.execFileSync)("git",["rev-parse","--show-toplevel"],{cwd:n,encoding:"utf-8",stdio:["ignore","pipe","ignore"]}).trim()||null}catch(e){let t=e instanceof Error?e:new Error(String(e));return c.debug("PROJECT_NAME","git rev-parse failed, falling back to basename",{dir:n},t),null}}function Cs(n){if(!n||n.trim()==="")return c.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:n}),"unknown-project";let e=ze(n),s=Ls(e)??e,r=Je.default.basename(s);if(r===""){if(process.platform==="win32"){let i=n.match(/^([A-Z]):\\/i);if(i){let d=`drive-${i[1].toUpperCase()}`;return c.info("PROJECT_NAME","Drive root detected",{cwd:n,projectName:d}),d}}return c.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:n}),"unknown-project"}return r}function Ze(n){let e=Cs(n);if(!n)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let t=ze(n),s=qe(t);if(s.isWorktree&&s.parentProjectName){let r=`${s.parentProjectName}/${e}`;return{primary:r,parent:s.parentProjectName,isWorktree:!0,allProjects:[s.parentProjectName,r]}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}var ne=require("fs"),he=require("path"),W=require("os");var be={HEALTH_CHECK:3e3,API_REQUEST:3e4,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function et(n){return process.platform==="win32"?Math.round(n*be.WINDOWS_MULTIPLIER):n}var se=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_API_TIMEOUT_MS:String(et(be.API_REQUEST)),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_DATA_DIR:(0,he.join)((0,W.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,he.join)((0,W.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_CLOUD_SYNC_TOKEN:"",CLAUDE_MEM_CLOUD_SYNC_USER_ID:"",CLAUDE_MEM_CLOUD_SYNC_HUB_URL:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID:"",CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME:(0,W.hostname)(),CLAUDE_MEM_CLOUD_SYNC_WS:"true",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0){try{if(!(0,ne.existsSync)(e)){let a=this.getAllDefaults();try{ue(e,a),console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(d){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,d instanceof Error?d.message:String(d))}return t?this.applyEnvOverrides(a):a}let s=(0,ne.readFileSync)(e,"utf-8"),r=$(s),o=r;if(r.env&&typeof r.env=="object"){o=r.env;try{ue(e,o),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(a){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,a instanceof Error?a.message:String(a))}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))o[a]!==void 0&&(i[a]=o[a]);return t?this.applyEnvOverrides(i):i}catch(s){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,s instanceof Error?s.message:String(s));let r=this.getAllDefaults();return t?this.applyEnvOverrides(r):r}}};var V=require("fs"),re=require("path");var v=class n{static instance=null;activeMode=null;modesDir;constructor(){let e=Me(),t=[...process.env.CLAUDE_MEM_MODES_DIR?[process.env.CLAUDE_MEM_MODES_DIR]:[],(0,re.join)(e,"modes"),(0,re.join)(e,"..","plugin","modes")],s=t.find(r=>(0,V.existsSync)(r));this.modesDir=s||t[0]}static getInstance(){return n.instance||(n.instance=new n),n.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let r in t){let o=t[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?s[r]=this.deepMerge(i,o):s[r]=o}return s}loadModeFile(e){let t=(0,re.join)(this.modesDir,`${e}.json`);if(!(0,V.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,V.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,c.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(_=>_.id),concepts:d.observation_concepts.map(_=>_.id)}),d}catch(d){if(d instanceof Error?c.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:d.message}):c.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(d)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:r}=t,o;try{o=this.loadMode(s)}catch(d){d instanceof Error?c.warn("WORKER",`Parent mode '${s}' not found for ${e}, falling back to 'code'`,{message:d.message}):c.warn("WORKER",`Parent mode '${s}' not found for ${e}, falling back to 'code'`,{error:String(d)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),c.debug("SYSTEM",`Loaded override file: ${r} for parent ${s}`)}catch(d){return d instanceof Error?c.warn("WORKER",`Override file '${r}' not found, using parent mode '${s}' only`,{message:d.message}):c.warn("WORKER",`Override file '${r}' not found, using parent mode '${s}' only`,{error:String(d)}),this.activeMode=o,o}if(!i)return c.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${s}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,c.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${s} + ${r})`,void 0,{parent:s,override:r,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}};function tt(){let n=G.settings(),e=se.loadFromFile(n),t=v.getInstance().getActiveMode(),s=new Set(t.observation_types.map(o=>o.id)),r=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:s,observationConcepts:r,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var E={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},st=4,nt=1;function rt(n){let e=(n.title?.length||0)+(n.subtitle?.length||0)+(n.narrative?.length||0)+JSON.stringify(n.facts||[]).length;return Math.ceil(e/st)}function Oe(n){let e=n.length,t=n.reduce((i,a)=>i+rt(a),0),s=n.reduce((i,a)=>i+(a.discovery_tokens||0),0),r=s-t,o=s>0?Math.round(r/s*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:s,savings:r,savingsPercent:o}}function ys(n){return v.getInstance().getWorkEmoji(n)}function Y(n,e){let t=rt(n),s=n.discovery_tokens||0,r=ys(n.type),o=s>0?`${r} ${s.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:s,discoveryDisplay:o,workEmoji:r}}function oe(n){return n.showReadTokens||n.showWorkTokens||n.showSavingsAmount||n.showSavingsPercent}var ot=H(require("path"),1),ie=require("fs");function it(n,e,t,s){let r=Array.from(t.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(t.observationConcepts),a=i.map(()=>"?").join(","),d=e.map(()=>"?").join(",");return n.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      o.project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${d})
           OR o.merged_into_project IN (${d}))
      AND (? IS NULL OR s.platform_source = ?)
      AND type IN (${o})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${a})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,s??null,s??null,...r,...i,t.totalObservationCount)}function at(n,e,t,s){let r=e.map(()=>"?").join(",");return n.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch,
      ss.project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${r})
           OR ss.merged_into_project IN (${r}))
      AND (? IS NULL OR s.platform_source = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,s??null,s??null,t.sessionCount+nt)}function Ds(n){return n.replace(/[/.]/g,"-")}function vs(n){if(!n.includes('"type":"assistant"'))return null;let e=JSON.parse(n);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let t="";for(let s of e.message.content)s.type==="text"&&(t+=s.text);if(t=t.replace(He,"").trim(),t)return t}return null}function Ms(n){for(let e=n.length-1;e>=0;e--)try{let t=vs(n[e]);if(t)return t}catch(t){t instanceof Error?c.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},t):c.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(t)});continue}return""}function Us(n){try{if(!(0,ie.existsSync)(n))return{assistantMessage:""};let e=(0,ie.readFileSync)(n,"utf-8").trim();if(!e)return{assistantMessage:""};let t=e.split(`
`).filter(r=>r.trim());return{assistantMessage:Ms(t)}}catch(e){return e instanceof Error?c.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:n},e):c.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:n,error:String(e)}),{assistantMessage:""}}}function dt(n,e,t,s){if(!e.showLastMessage||n.length===0)return{assistantMessage:""};let r=n.find(d=>d.memory_session_id!==t);if(!r)return{assistantMessage:""};let o=r.memory_session_id,i=Ds(s),a=ot.default.join(Ee,"projects",i,`${o}.jsonl`);return Us(a)}function _t(n,e){let t=e[0]?.id;return n.map((s,r)=>{let o=r===0?null:e[r+1];return{...s,displayEpoch:o?o.created_at_epoch:s.created_at_epoch,displayTime:o?o.created_at:s.created_at,shouldShowLink:s.id!==t}})}function ut(n,e){let t=[...n.map(s=>({type:"observation",data:s})),...e.map(s=>({type:"summary",data:s}))];return t.sort((s,r)=>{let o=s.type==="observation"?s.data.created_at_epoch:s.data.displayEpoch,i=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch;return o-i}),t}function ct(n,e){return new Set(n.slice(0,e).map(t=>t.id))}function Et(){let n=new Date,e=n.toLocaleDateString("en-CA"),t=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function lt(n){return[`# [${n}] recent context, ${Et()}`,""]}function mt(){return[`Legend: \u{1F3AF}session ${v.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji}${t.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function pt(n,e){let t=[],s=[`${n.totalObservations} obs (${n.totalReadTokens.toLocaleString()}t read)`,`${n.totalDiscoveryTokens.toLocaleString()}t work`];return n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?s.push(`${n.savingsPercent}% savings`):e.showSavingsAmount&&s.push(`${n.savings.toLocaleString()}t saved`)),t.push(`Stats: ${s.join(" | ")}`),t.push(""),t}function Tt(n){return[`### ${n}`]}function gt(n){return n.toLowerCase().replace(" am","a").replace(" pm","p")}function ft(n,e,t){let s=n.title||"Untitled",r=v.getInstance().getTypeIcon(n.type),o=e?gt(e):'"';return`${n.id} ${o} ${r} ${s}`}function St(n,e,t,s){let r=[],o=n.title||"Untitled",i=v.getInstance().getTypeIcon(n.type),a=e?gt(e):'"',{readTokens:d,discoveryDisplay:_}=Y(n,s);r.push(`**${n.id}** ${a} ${i} **${o}**`),t&&r.push(t);let u=[];return s.showReadTokens&&u.push(`~${d}t`),s.showWorkTokens&&u.push(_),u.length>0&&r.push(u.join(" ")),r.push(""),r}function bt(n,e){return[`S${n.id} ${n.request||"Session started"} (${e})`]}function q(n,e){return e?[`**${n}**: ${e}`,""]:[]}function ht(n){return n.assistantMessage?["","---","","**Previously**","",`A: ${n.assistantMessage}`,""]:[]}function Ot(n,e){return["",`Access ${Math.round(n/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function Rt(n){return`# [${n}] recent context, ${Et()}

No previous sessions found.`}function Nt(){let n=new Date,e=n.toLocaleDateString("en-CA"),t=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function At(n){return["",`${E.bright}${E.cyan}[${n}] recent context, ${Nt()}${E.reset}`,`${E.gray}${"\u2500".repeat(60)}${E.reset}`,""]}function It(){let e=v.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${E.dim}Legend: session-request | ${e}${E.reset}`,""]}function Lt(){return[`${E.bright}Column Key${E.reset}`,`${E.dim}  Read: Tokens to read this observation (cost to learn it now)${E.reset}`,`${E.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${E.reset}`,""]}function Ct(){return[`${E.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${E.reset}`,"",`${E.dim}When you need implementation details, rationale, or debugging context:${E.reset}`,`${E.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${E.reset}`,`${E.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${E.reset}`,`${E.dim}  - Trust this index over re-reading code for past decisions and learnings${E.reset}`,""]}function yt(n,e){let t=[];if(t.push(`${E.bright}${E.cyan}Context Economics${E.reset}`),t.push(`${E.dim}  Loading: ${n.totalObservations} observations (${n.totalReadTokens.toLocaleString()} tokens to read)${E.reset}`),t.push(`${E.dim}  Work investment: ${n.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${E.reset}`),n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${n.savings.toLocaleString()} tokens (${n.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?s+=`${n.savings.toLocaleString()} tokens`:s+=`${n.savingsPercent}% reduction from reuse`,t.push(`${E.green}${s}${E.reset}`)}return t.push(""),t}function Dt(n){return[`${E.bright}${E.cyan}${n}${E.reset}`,""]}function vt(n){return[`${E.dim}${n}${E.reset}`]}function Mt(n,e,t,s){let r=n.title||"Untitled",o=v.getInstance().getTypeIcon(n.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=Y(n,s),_=t?`${E.dim}${e}${E.reset}`:" ".repeat(e.length),u=s.showReadTokens&&i>0?`${E.dim}(~${i}t)${E.reset}`:"",l=s.showWorkTokens&&a>0?`${E.dim}(${d} ${a.toLocaleString()}t)${E.reset}`:"";return`  ${E.dim}#${n.id}${E.reset}  ${_}  ${o}  ${r} ${u} ${l}`}function Ut(n,e,t,s,r){let o=[],i=n.title||"Untitled",a=v.getInstance().getTypeIcon(n.type),{readTokens:d,discoveryTokens:_,workEmoji:u}=Y(n,r),l=t?`${E.dim}${e}${E.reset}`:" ".repeat(e.length),m=r.showReadTokens&&d>0?`${E.dim}(~${d}t)${E.reset}`:"",g=r.showWorkTokens&&_>0?`${E.dim}(${u} ${_.toLocaleString()}t)${E.reset}`:"";return o.push(`  ${E.dim}#${n.id}${E.reset}  ${l}  ${a}  ${E.bright}${i}${E.reset}`),s&&o.push(`    ${E.dim}${s}${E.reset}`),(m||g)&&o.push(`    ${m} ${g}`),o.push(""),o}function xt(n,e){let t=`${n.request||"Session started"} (${e})`;return[`${E.yellow}#S${n.id}${E.reset} ${t}`,""]}function K(n,e,t){return e?[`${t}${n}:${E.reset} ${e}`,""]:[]}function wt(n){return n.assistantMessage?["","---","",`${E.bright}${E.magenta}Previously${E.reset}`,"",`${E.dim}A: ${n.assistantMessage}${E.reset}`,""]:[]}function kt(n,e){let t=Math.round(n/1e3);return["",`${E.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${E.reset}`]}function $t(n){return`
${E.bright}${E.cyan}[${n}] recent context, ${Nt()}${E.reset}
${E.gray}${"\u2500".repeat(60)}${E.reset}

${E.dim}No previous sessions found for this project yet.${E.reset}
`}function Ft(n,e,t,s){let r=[];return s?r.push(...At(n)):r.push(...lt(n)),s?r.push(...It()):r.push(...mt()),s&&(r.push(...Lt()),r.push(...Ct())),oe(t)&&(s?r.push(...yt(e,t)):r.push(...pt(e,t))),r}var Re=H(require("path"),1);function _e(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[]}catch(e){return c.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:n?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function Ne(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Ae(n){return new Date(n).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Xt(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Pt(n,e){return Re.default.isAbsolute(n)?Re.default.relative(e,n):n}function Ht(n,e,t){let s=_e(n);if(s.length>0)return Pt(s[0],e);if(t){let r=_e(t);if(r.length>0)return Pt(r[0],e)}return"General"}function xs(n){let e=new Map;for(let s of n){let r=s.type==="observation"?s.data.created_at:s.data.displayTime,o=Xt(r);e.has(o)||e.set(o,[]),e.get(o).push(s)}let t=Array.from(e.entries()).sort((s,r)=>{let o=new Date(s[0]).getTime(),i=new Date(r[0]).getTime();return o-i});return new Map(t)}function Gt(n,e){return e.fullObservationField==="narrative"?n.narrative:n.facts?_e(n.facts).join(`
`):null}function ws(n,e,t,s){let r=[];r.push(...Tt(n));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=Ne(a.displayTime);r.push(...bt(a,d))}else{let a=i.data,d=Ae(a.created_at),u=d!==o?d:"";if(o=d,t.has(a.id)){let m=Gt(a,s);r.push(...St(a,u,m,s))}else r.push(ft(a,u,s))}return r}function ks(n,e,t,s,r){let o=[];o.push(...Dt(n));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let _=d.data,u=Ne(_.displayTime);o.push(...xt(_,u))}else{let _=d.data,u=Ht(_.files_modified,r,_.files_read),l=Ae(_.created_at),m=l!==a;a=l;let g=t.has(_.id);if(u!==i&&(o.push(...vt(u)),i=u),g){let N=Gt(_,s);o.push(...Ut(_,l,m,N,s))}else o.push(Mt(_,l,m,s))}return o.push(""),o}function $s(n,e,t,s,r,o){return o?ks(n,e,t,s,r):ws(n,e,t,s)}function Bt(n,e,t,s,r){let o=[],i=xs(n);for(let[a,d]of i)o.push(...$s(a,d,e,t,s,r));return o}function jt(n,e,t){return!(!n.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function Wt(n,e){let t=[];return e?(t.push(...K("Investigated",n.investigated,E.blue)),t.push(...K("Learned",n.learned,E.yellow)),t.push(...K("Completed",n.completed,E.green)),t.push(...K("Next Steps",n.next_steps,E.magenta))):(t.push(...q("Investigated",n.investigated)),t.push(...q("Learned",n.learned)),t.push(...q("Completed",n.completed)),t.push(...q("Next Steps",n.next_steps))),t}function Vt(n,e){return e?wt(n):ht(n)}function Yt(n,e,t){return!oe(e)||n.totalDiscoveryTokens<=0||n.savings<=0?[]:t?kt(n.totalDiscoveryTokens,n.totalReadTokens):Ot(n.totalDiscoveryTokens,n.totalReadTokens)}var Fs=qt.default.join((0,Kt.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ps(){try{return new ee}catch(n){if(n instanceof Error&&n.code==="ERR_DLOPEN_FAILED"){try{(0,Jt.unlinkSync)(Fs)}catch(e){e instanceof Error?c.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):c.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return c.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw n}}function Xs(n,e){return e?$t(n):Rt(n)}function Hs(n,e,t,s,r,o,i){let a=[],d=Oe(e);a.push(...Ft(n,d,s,i));let _=t.slice(0,s.sessionCount),u=_t(_,t),l=ut(e,u),m=ct(e,s.fullObservationCount);a.push(...Bt(l,m,s,r,i));let g=t[0],N=e[0];jt(s,g,N)&&a.push(...Wt(g,i));let R=dt(e,s,o,r);return a.push(...Vt(R,i)),a.push(...Yt(d,s,i)),a.join(`
`).trimEnd()}var Gs=new Set(["bugfix","discovery","decision","refactor"]);function Bs(n,e,t){let s=Oe(n),r={bugfix:0,discovery:0,decision:0,refactor:0,other:0},o=new Set,i=Number.POSITIVE_INFINITY;for(let d of n){let _=Gs.has(d.type)?d.type:"other";r[_]++,d.memory_session_id&&o.add(d.memory_session_id),d.created_at_epoch&&d.created_at_epoch<i&&(i=d.created_at_epoch)}let a=Number.isFinite(i)?Math.max(0,Math.floor((Date.now()-i)/864e5)):0;return{observation_count:n.length,session_count:o.size,timeline_depth_days:a,has_session_summary:e.length>0,obs_type_bugfix:r.bugfix,obs_type_discovery:r.discovery,obs_type_decision:r.decision,obs_type_refactor:r.refactor,obs_type_other:r.other,tokens_injected:s.totalReadTokens,tokens_saved_vs_naive:s.savings,search_strategy:t?"full":"timeline"}}async function Ie(n,e=!1){let t=tt(),s=n?.cwd??process.cwd(),r=Ze(s),o=n?.projects?.length?n.projects:r.allProjects,i=o[o.length-1]??r.primary;n?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let a=Ps();if(!a)return{text:"",stats:null};try{let d=n?.platformSource?L(n.platformSource):void 0,_=o.length>1?o:[i],u=it(a,_,t,d),l=at(a,_,t,d);return u.length===0&&l.length===0?{text:Xs(i,e),stats:null}:{text:Hs(i,u,l,t,s,n?.session_id,e),stats:Bs(u,l,!!n?.full)}}finally{a.close()}}async function Qt(n,e=!1){return(await Ie(n,e)).text}0&&(module.exports={generateContext,generateContextWithStats});
