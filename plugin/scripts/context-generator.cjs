"use strict";var is=Object.create;var z=Object.defineProperty;var as=Object.getOwnPropertyDescriptor;var ds=Object.getOwnPropertyNames;var _s=Object.getPrototypeOf,Es=Object.prototype.hasOwnProperty;var us=(r,e)=>{for(var t in e)z(r,t,{get:e[t],enumerable:!0})},De=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of ds(e))!Es.call(r,n)&&n!==t&&z(r,n,{get:()=>e[n],enumerable:!(s=as(e,n))||s.enumerable});return r};var B=(r,e,t)=>(t=r!=null?is(_s(r)):{},De(e||!r||!r.__esModule?z(t,"default",{value:r,enumerable:!0}):t,r)),ms=r=>De(z({},"__esModule",{value:!0}),r);var mr={};us(mr,{generateContext:()=>os,generateContextWithStats:()=>Me});module.exports=ms(mr);var ss=B(require("path"),1),rs=require("os"),ns=require("fs");var Qe=require("bun:sqlite");var S=require("path"),Ee=require("os"),w=require("fs"),ve=require("url");function F(r){return r.charCodeAt(0)===65279?r.slice(1):r}var fs={};function cs(){return typeof __dirname<"u"?__dirname:(0,S.dirname)((0,ve.fileURLToPath)(fs.url))}var ps=cs();function ls(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let r=(0,S.join)((0,Ee.homedir)(),".claude-mem"),e=(0,S.join)(r,"settings.json");try{if((0,w.existsSync)(e)){let t=JSON.parse(F((0,w.readFileSync)(e,"utf-8"))),s=t.env??t;if(s.CLAUDE_MEM_DATA_DIR)return s.CLAUDE_MEM_DATA_DIR}}catch{}return r}var I=ls(),ue=process.env.CLAUDE_CONFIG_DIR||(0,S.join)((0,Ee.homedir)(),".claude"),gr=(0,S.join)(ue,"plugins","marketplaces","thedotmack"),Ts=(0,S.join)(I,"logs"),fr=(0,S.join)(I,"settings.json"),ye=(0,S.join)(I,"claude-mem.db"),gs=(0,S.join)(I,"observer-sessions"),me=(0,S.basename)(gs);function Ue(r){(0,w.mkdirSync)(r,{recursive:!0})}function xe(){return(0,S.join)(ps,"..")}var W={dataDir:()=>I,workerPid:()=>(0,S.join)(I,"worker.pid"),serverPid:()=>(0,S.join)(I,".server-beta.pid"),serverPort:()=>(0,S.join)(I,".server-beta.port"),serverRuntime:()=>(0,S.join)(I,".server-beta.runtime.json"),settings:()=>(0,S.join)(I,"settings.json"),database:()=>(0,S.join)(I,"claude-mem.db"),chroma:()=>(0,S.join)(I,"chroma"),combinedCerts:()=>(0,S.join)(I,"combined_certs.pem"),transcriptsConfig:()=>(0,S.join)(I,"transcript-watch.json"),transcriptsState:()=>(0,S.join)(I,"transcript-watch-state.json"),corpora:()=>(0,S.join)(I,"corpora"),supervisorRegistry:()=>(0,S.join)(I,"supervisor.json"),envFile:()=>(0,S.join)(I,".env"),logsDir:()=>Ts};var k=require("fs"),ke=require("path");var Ss=null;function Rs(r){return(Ss??process.stderr.write.bind(process.stderr))(r)}function x(r){Rs(r)}var pe=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(pe||{}),ce=null,le=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=W.logsDir();(0,k.existsSync)(e)||(0,k.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,ke.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=W.settings();if((0,k.existsSync)(e)){let t=(0,k.readFileSync)(e,"utf-8"),n=(JSON.parse(F(t)).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=pe[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${o}:${i}:${a}.${d}`}log(e,t,s,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=pe[e].padEnd(5),d=t.padEnd(6),_="";n?.correlationId?_=`[${n.correlationId}] `:n?.sessionId&&(_=`[session-${n.sessionId}] `);let m="";if(o!=null)if(o instanceof Error)m=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{m=`
`+JSON.stringify(o,null,2)}catch{m=" "+this.formatData(o)}else m=" "+this.formatData(o);let c="";if(n){let{sessionId:g,memorySessionId:b,correlationId:A,...M}=n;Object.keys(M).length>0&&(c=` {${Object.entries(M).map(([h,P])=>`${h}=${P}`).join(", ")}}`)}let T=`[${i}] [${a}] [${d}] ${_}${s}${c}${m}`;if(this.logFilePath)try{(0,k.appendFileSync)(this.logFilePath,T+`
`,"utf8")}catch(g){let b=g instanceof Error?g:new Error(String(g));x(`[LOGGER] Failed to write to log file: ${b.message}
${b.stack??""}
`)}else x(T+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}setErrorSink(e){ce=e}error(e,t,s,n){this.log(3,e,t,s,n),this.routeErrorToSink(t,s,n)}routeErrorToSink(e,t,s){try{if(!ce||!(s instanceof Error))return;ce(s)}catch{}}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}},E=new le;var Pe=require("crypto");function Fe(r,e,t){return(0,Pe.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}var p="claude";function Os(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function C(r){if(!r)return p;let e=Os(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:p}function we(r){let e=["claude","codex","cursor"];return[...r].sort((t,s)=>{let n=e.indexOf(t),o=e.indexOf(s);return n!==-1||o!==-1?n===-1?1:o===-1?-1:n-o:t.localeCompare(s)})}function $e(r,e,t,s,n){let o=Date.now()-s,i=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return r.prepare(`
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
  `).get(a,t,o)??void 0}var He=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],Xe=new RegExp(`<(${He.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),Be=/<system-reminder>[\s\S]*?<\/system-reminder>/g,Ge=100;function bs(r){let e=Object.fromEntries(He.map(n=>[n,0]));Xe.lastIndex=0;let t=0,s=r.replace(Xe,(n,o)=>(e[o]=(e[o]??0)+1,t+=1,""));return t>Ge&&E.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:t,maxAllowed:Ge,contentLength:r.length}),{stripped:s.trim(),counts:e}}function We(r){return bs(r).stripped}var As=["task-notification"],Dr=new RegExp(`^\\s*<(${As.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),vr=256*1024;var j=4e3,Te=["<private","<claude-mem-context","<system_instruction","<system-instruction","<persisted-output","<system-reminder"];function $(r){let e=r.trim(),s=We(r).trim()||e;return s.length<=j?s:(E.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:s.length,storedLength:j}),`${s.slice(0,j-1)}\u2026`)}var je=38,Ns=512*1024;function Z(r,e){let t=r.prepare(`PRAGMA ${e}`).get();return Number(t?.[e]??0)}function hs(){return`
    SELECT id, prompt_text
    FROM user_prompts
    WHERE length(prompt_text) > ?
      OR ${Te.map(()=>"instr(prompt_text, ?) > 0").join(" OR ")}
  `}function Is(r){let e=r.prepare(hs()).all(j,...Te);if(e.length===0)return 0;let t=r.prepare("UPDATE user_prompts SET prompt_text = ? WHERE id = ?"),s=0;for(let n of e){let o=$(n.prompt_text);o!==n.prompt_text&&(t.run(o,n.id),s+=1)}return s}function Cs(r){let e=r.prepare(`
    UPDATE sdk_sessions
    SET user_prompt = NULL
    WHERE user_prompt IS NOT NULL
      AND status IN ('completed', 'failed')
      AND EXISTS (
        SELECT 1
        FROM user_prompts up
        WHERE up.session_db_id = sdk_sessions.id
          AND up.prompt_number = 1
      )
  `).run();return Number(e.changes??0)}function Ve(r,e,t){try{r.run("PRAGMA wal_checkpoint(PASSIVE)")}catch(d){E.debug("DB","Legacy prompt bloat cleanup could not checkpoint WAL before compaction",{error:d instanceof Error?d.message:String(d)})}let s=Z(r,"page_size"),n=Z(r,"freelist_count"),o=s*n,i=Z(r,"auto_vacuum");if(e===0||o<t)return{autoVacuumMode:i,freeBytesAfter:o,freeBytesBefore:o,freelistCountAfter:n,freelistCountBefore:n,mode:"skipped",pageSize:s,thresholdBytes:t};try{i===2?r.run(`PRAGMA incremental_vacuum(${n})`):r.run("VACUUM")}catch(d){let _=d instanceof Error?d:new Error(String(d));return E.warn("DB","Legacy prompt bloat cleanup could not reclaim free pages",{autoVacuumMode:i,freeBytesBefore:o,freelistCountBefore:n},_),{autoVacuumMode:i,error:_.message,freeBytesAfter:o,freeBytesBefore:o,freelistCountAfter:n,freelistCountBefore:n,mode:"failed",pageSize:s,thresholdBytes:t}}let a=Z(r,"freelist_count");return{autoVacuumMode:i,freeBytesAfter:s*a,freeBytesBefore:o,freelistCountAfter:a,freelistCountBefore:n,mode:i===2?"incremental_vacuum":"vacuum",pageSize:s,thresholdBytes:t}}function Ke(r,e=Ns){if(r.prepare("SELECT 1 FROM schema_versions WHERE version = ?").get(je))return{clearedSessionPrompts:0,compaction:Ve(r,0,e),normalizedPromptRows:0,versionApplied:!1};let s=0,n=0;r.run("BEGIN TRANSACTION");try{s=Is(r),n=Cs(r),r.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(je,new Date().toISOString()),r.run("COMMIT")}catch(i){throw r.run("ROLLBACK"),i}let o=Ve(r,s+n,e);return(s>0||n>0)&&E.info("DB","Applied legacy prompt bloat maintenance",{normalizedPromptRows:s,clearedSessionPrompts:n,compactionMode:o.mode,freeBytesBefore:o.freeBytesBefore,freeBytesAfter:o.freeBytesAfter}),{clearedSessionPrompts:n,compaction:o,normalizedPromptRows:s,versionApplied:!0}}var Ye=require("bun:sqlite"),qe=require("node:path");var Ls=5e3;function Ms(r){r!==":memory:"&&Ue((0,qe.dirname)(r))}function ge(r){r.run(`PRAGMA busy_timeout = ${Ls}`)}function Ds(r){let{tableCount:e}=r.query("SELECT COUNT(*) AS tableCount FROM sqlite_master WHERE type = 'table'").get(),{page_count:t}=r.query("PRAGMA page_count").get();return e>0||t>1?!1:(r.run("PRAGMA auto_vacuum = INCREMENTAL"),!0)}function vs(r){ge(r),r.run("PRAGMA journal_mode = WAL"),r.run("PRAGMA synchronous = NORMAL"),r.run("PRAGMA foreign_keys = ON"),r.run("PRAGMA journal_size_limit = 4194304")}function Je(r){Ms(r);let e=new Ye.Database(r);return Ds(e),vs(e),e}var ee=class{db;constructor(e=ye){e instanceof Qe.Database?(this.db=e,ge(this.db)):this.db=Je(e),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.addObservationContentSessionIdColumns(),this.createObservationFeedbackTable(),Ke(this.db)}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let o=this.getIndexColumns(n.name);return o.length===t.length&&o.every((i,a)=>i===t[a])})}resolvePromptSessionDbId(e,t,s){if(t!==void 0)return t;let n=s?C(s):void 0;return n?this.db.prepare(`
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
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),s=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!s)){if(s)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),E.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){E.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),s=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!t&&s&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),t){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let a=i instanceof Error?i:new Error(String(i));throw E.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),i}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&n&&!i)return;let a=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,d=n?`COALESCE(up.session_db_id, (
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
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,d,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let m=_ instanceof Error?_:new Error(String(_));throw E.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},m),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,t,s){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let s=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&s)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw E.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}addObservationContentSessionIdColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(36),s=this.db.query("PRAGMA table_info(observations)").all().some(d=>d.name==="content_session_id"),o=this.db.query("PRAGMA table_info(session_summaries)").all().some(d=>d.name==="content_session_id"),i=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_observations_content_session'
    `).get(),a=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_summaries_content_session'
    `).get();e&&s&&o&&i&&a||(s||(this.db.run("ALTER TABLE observations ADD COLUMN content_session_id TEXT"),E.debug("DB","Added content_session_id column to observations table (#2769)")),this.db.run(`
      UPDATE observations
         SET content_session_id = (
           SELECT s.content_session_id
             FROM sdk_sessions s
            WHERE s.memory_session_id = observations.memory_session_id
            LIMIT 1
         )
       WHERE content_session_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM sdk_sessions s
            WHERE s.memory_session_id = observations.memory_session_id
         )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_session ON observations(content_session_id)"),o||(this.db.run("ALTER TABLE session_summaries ADD COLUMN content_session_id TEXT"),E.debug("DB","Added content_session_id column to session_summaries table (#2769)")),this.db.run(`
      UPDATE session_summaries
         SET content_session_id = (
           SELECT s.content_session_id
             FROM sdk_sessions s
            WHERE s.memory_session_id = session_summaries.memory_session_id
            LIMIT 1
         )
       WHERE content_session_id IS NULL
         AND EXISTS (
           SELECT 1
             FROM sdk_sessions s
            WHERE s.memory_session_id = session_summaries.memory_session_id
         )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_session_summaries_content_session ON session_summaries(content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(36,new Date().toISOString()))}createObservationFeedbackTable(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(37),t=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observation_feedback'
    `).get(),s=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_observation'
    `).get(),n=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_signal'
    `).get();e&&t&&s&&n||(this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        session_db_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_signal ON observation_feedback(signal_type)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(37,new Date().toISOString()))}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=new Set(t.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>s.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),E.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),E.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
        content_session_id TEXT,
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
        content_session_id TEXT,
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
    `),this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="platform_source")&&(this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),E.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),E.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(s=>s.unique===1&&s.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}E.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),E.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}E.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),E.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}E.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),E.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}E.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `;try{this.db.run(s),this.db.run(n)}catch(o){o instanceof Error?E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}E.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),E.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;E.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(m=>m.name===o);return a.some(m=>m.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),E.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(E.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?E.debug("DB",`Successfully renamed ${t} session ID columns`):E.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),E.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;E.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(l=>l.name==="metadata"),n=t.some(l=>l.name==="content_hash"),o=s?`,
        metadata TEXT`:"",i=s?", metadata":"",a=n?`,
        content_hash TEXT`:"",d=n?", content_hash":"",_=`
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
    `,m=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${i}${d}
      FROM observations
    `,c=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,T=`
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
    `,b=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,A=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,M=`
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
    `;try{this.recreateObservationsWithCascade(_,m,c,T),this.recreateSessionSummariesWithCascade(g,b,A,M),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),E.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(l){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),l instanceof Error?l:new Error(String(l))}}recreateObservationsWithCascade(e,t,s,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,t,s,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),E.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),E.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),E.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),s=e.some(n=>n.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="agent_type"),n=t.some(i=>i.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(d=>d.name==="agent_type"),a=o.some(d=>d.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw E.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="memory_session_id"),n=t.some(o=>o.name==="content_hash");if(!s||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw E.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),E.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed',
          completed_at = ?,
          completed_at_epoch = ?,
          user_prompt = CASE
            WHEN EXISTS (
              SELECT 1
              FROM user_prompts up
              WHERE up.session_db_id = sdk_sessions.id
                AND up.prompt_number = 1
            ) THEN NULL
            ELSE user_prompt
          END
      WHERE id = ?
    `).run(s,t,e)}ensureMemorySessionIdRegistered(e,t,s){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),E.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:t})),typeof s=="number"&&n.worker_port!==s&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(s,e)}getAllProjects(e){let t=e?C(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[me];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",n.push(p,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...n).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${p}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${p}'), project
      ORDER BY latest_epoch DESC
    `).all(me),t=[],s=new Set,n={};for(let i of e){let a=C(i.platform_source);n[a]||(n[a]=[]),n[a].includes(i.project)||n[a].push(i.project),s.has(i.project)||(s.add(i.project),t.push(i.project))}let o=we(Object.keys(n));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,n[i]||[]]))}}getLatestUserPrompt(e,t){let s=this.resolvePromptSessionDbId(e,t),n=s!==null?"up.session_db_id = ?":"up.content_session_id = ?",o=s!==null?s:e;return this.db.prepare(`
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
    `).get(o)}findRecentDuplicateUserPrompt(e,t,s,n){return $e(this.db,e,$(t),s,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,t=3,s){let n=[e],o="";return s&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`,n.push(C(s))),n.push(t),this.db.prepare(`
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
    `).all(...n)}getObservationsForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
        )
      `,s.push(C(t))),this.db.prepare(`
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
    `).get(e,C(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o,platformSource:i,type:a,concepts:d,files:_}=t,m=s==="relevance",c=m?"":`ORDER BY o.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,T=n&&!m?`LIMIT ${n}`:"",g=e.map(()=>"?").join(","),b=[...e],A=[];if(o&&(A.push("o.project = ?"),b.push(o)),i&&(A.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),b.push(C(i))),a)if(Array.isArray(a)){let N=a.map(()=>"?").join(",");A.push(`o.type IN (${N})`),b.push(...a)}else A.push("o.type = ?"),b.push(a);if(d){let N=Array.isArray(d)?d:[d],R=N.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");b.push(...N),A.push(`(${R.join(" OR ")})`)}if(_){let N=Array.isArray(_)?_:[_],R=N.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");N.forEach(L=>{b.push(`%${L}%`,`%${L}%`)}),A.push(`(${R.join(" OR ")})`)}let M=A.length>0?`WHERE o.id IN (${g}) AND ${A.join(" AND ")}`:`WHERE o.id IN (${g})`,h=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${M}
      ${c}
      ${T}
    `).all(...b);if(!m)return h;let P=new Map(h.map(N=>[N.id,N])),f=e.map(N=>P.get(N)).filter(N=>!!N);return n?f.slice(0,n):f}dismissObservation(e,t){let s=typeof t=="string"?t.trim():"",n=s?JSON.stringify({reason:s}):null;this.db.prepare(`
      INSERT INTO observation_feedback (observation_id, signal_type, session_db_id, created_at_epoch, metadata)
      SELECT ?, 'dismissed', NULL, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM observation_feedback
        WHERE observation_id = ? AND signal_type = 'dismissed'
      )
    `).run(e,Date.now(),n,e)}undismissObservation(e){this.db.prepare(`
      DELETE FROM observation_feedback
      WHERE observation_id = ? AND signal_type = 'dismissed'
    `).run(e)}isDismissed(e){return this.db.prepare(`
      SELECT 1 FROM observation_feedback
      WHERE observation_id = ? AND signal_type = 'dismissed'
      LIMIT 1
    `).get(e)!=null}getSummaryForSession(e,t){let s=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${p}') = ?
        )
      `,s.push(C(t))),this.db.prepare(`
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
    `).get(e).count}createSDKSession(e,t,s,n,o){let i=new Date,a=i.getTime(),d=o?C(o):p,_=$(s),m=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(p,d,e);if(m)return t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(t,m.id),n&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE id = ? AND custom_title IS NULL
        `).run(n,m.id),m.id;let c=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,d,_,n||null,i.toISOString(),a);return Number(c.lastInsertRowid)}saveUserPrompt(e,t,s,n){let o=new Date,i=o.getTime(),a=$(s),d=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d,e,t,a,o.toISOString(),i).lastInsertRowid}getUserPrompt(e,t,s){let n=this.resolvePromptSessionDbId(e,s);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,n,o=0,i,a,d){let _=this.storeObservations(e,t,[s],null,n,o,i,a,d);return{id:_.observationIds[0],createdAtEpoch:_.createdAtEpoch}}storeSummary(e,t,s,n,o=0,i,a){let d=i??Date.now(),_=new Date(d).toISOString(),c=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
       content_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,n||null,o,_,d,a??null);return{id:Number(c.lastInsertRowid),createdAtEpoch:d}}storeObservations(e,t,s,n,o,i=0,a,d,_){let m=a??Date.now(),c=new Date(m).toISOString();return this.db.transaction(()=>{let g=[],b=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, content_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),A=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let l of s){let h=Fe(e,l.title,l.narrative),P=b.get(e,t,l.type,l.title,l.subtitle,JSON.stringify(l.facts),l.narrative,JSON.stringify(l.concepts),JSON.stringify(l.files_read),JSON.stringify(l.files_modified),o||null,i,l.agent_type??null,l.agent_id??null,h,c,m,d||null,l.metadata??null,_??null);if(P){g.push(P.id);continue}let f=A.get(e,h);if(!f)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${h}`);g.push(f.id)}let M=null;if(n){let h=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
           content_session_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,c,m,_??null);M=Number(h.lastInsertRowid)}return{observationIds:g,summaryId:M,createdAtEpoch:m}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o,platformSource:i}=t,a=s==="relevance",d=a?"":`ORDER BY ss.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,_=n&&!a?`LIMIT ${n}`:"",m=e.map(()=>"?").join(","),c=[...e],T=[];o&&(T.push("ss.project = ?"),c.push(o)),i&&(T.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),c.push(C(i)));let g=T.length>0?`AND ${T.join(" AND ")}`:"",A=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${m}) ${g}
      ${d}
      ${_}
    `).all(...c);if(!a)return A;let M=new Map(A.map(h=>[h.id,h])),l=e.map(h=>M.get(h)).filter(h=>!!h);return n?l.slice(0,n):l}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o,platformSource:i}=t,a=s==="relevance",d=a?"":`ORDER BY up.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,_=n?`LIMIT ${n}`:"",m=e.map(()=>"?").join(","),c=[...e],T=[];o&&(T.push("s.project = ?"),c.push(o)),i&&(T.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),c.push(C(i)));let g=T.length>0?`AND ${T.join(" AND ")}`:"",A=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${m}) ${g}
      ${d}
      ${_}
    `).all(...c);if(!a)return A;let M=new Map(A.map(l=>[l.id,l]));return e.map(l=>M.get(l)).filter(l=>!!l)}getTimelineAroundTimestamp(e,t=10,s=10,n,o){return this.getTimelineAroundObservation(null,e,t,s,n,o)}getTimelineAroundObservation(e,t,s=10,n=10,o,i){let a=i?C(i):void 0,d=(f,N)=>{let R=[],L=[];return o&&(R.push(`${f}.project = ?`),L.push(o)),a&&(R.push(`COALESCE(NULLIF(${N}.platform_source, ''), '${p}') = ?`),L.push(a)),{clause:R.length>0?`AND ${R.join(" AND ")}`:"",params:L}},_=d("o","src"),m=d("ss","src"),c=d("s","s"),T,g;if(e!==null){let f=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${_.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,N=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${_.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let R=this.db.prepare(f).all(e,..._.params,s+1),L=this.db.prepare(N).all(e,..._.params,n+1);if(R.length===0&&L.length===0)return{observations:[],sessions:[],prompts:[]};T=R.length>0?R[R.length-1].created_at_epoch:t,g=L.length>0?L[L.length-1].created_at_epoch:t}catch(R){return R instanceof Error?E.error("DB","Error getting boundary observations",{project:o},R):E.error("DB","Error getting boundary observations with non-Error",{},new Error(String(R))),{observations:[],sessions:[],prompts:[]}}}else{let f=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${_.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,N=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${_.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let R=this.db.prepare(f).all(t,..._.params,s),L=this.db.prepare(N).all(t,..._.params,n+1);if(R.length===0&&L.length===0)return{observations:[],sessions:[],prompts:[]};T=R.length>0?R[R.length-1].created_at_epoch:t,g=L.length>0?L[L.length-1].created_at_epoch:t}catch(R){return R instanceof Error?E.error("DB","Error getting boundary timestamps",{project:o},R):E.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(R))),{observations:[],sessions:[],prompts:[]}}}let b=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${_.clause}
      ORDER BY o.created_at_epoch ASC
    `,A=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${m.clause}
      ORDER BY ss.created_at_epoch ASC
    `,M=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${c.clause}
      ORDER BY up.created_at_epoch ASC
    `,l=this.db.prepare(b).all(T,g,..._.params),h=this.db.prepare(A).all(T,g,...m.params),P=this.db.prepare(M).all(T,g,...c.params);return{observations:l,sessions:h.map(f=>({id:f.id,memory_session_id:f.memory_session_id,project:f.project,request:f.request,completed:f.completed,next_steps:f.next_steps,created_at:f.created_at,created_at_epoch:f.created_at_epoch})),prompts:P.map(f=>({id:f.id,content_session_id:f.content_session_id,prompt_number:f.prompt_number,prompt_text:f.prompt_text,project:f.project,platform_source:f.platform_source,created_at:f.created_at,created_at_epoch:f.created_at_epoch}))}}getOrCreateManualSession(e){let t=`manual-${e}`,s=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,s,e,p,o.toISOString(),o.getTime()),E.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=C(e.platform_source),s=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,t,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let t=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, content_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.content_session_id??null,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, content_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, agent_type, agent_id,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.content_session_id??null,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,s=e.platform_source?C(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${p}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!s||C(a.platform_source)===s)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,s));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Re=require("os"),O=B(require("path"),1),v=require("fs"),Ze=require("child_process");var se=require("fs"),te=B(require("path"),1);var V={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function fe(r){let e=te.default.join(r,".git"),t;try{t=(0,se.statSync)(e)}catch(m){return m instanceof Error&&m.code!=="ENOENT"&&E.warn("GIT","Unexpected error checking .git",{error:m instanceof Error?m.message:String(m)}),V}if(!t.isFile())return V;let s;try{s=(0,se.readFileSync)(e,"utf-8").trim()}catch(m){return E.warn("GIT","Failed to read .git file",{error:m instanceof Error?m.message:String(m)}),V}let n=s.match(/^gitdir:\s*(.+)$/);if(!n)return V;let i=n[1].match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return V;let a=i[1],d=te.default.basename(r),_=te.default.basename(a);return{isWorktree:!0,worktreeName:d,parentRepoPath:a,parentProjectName:_}}var ys=".claude-mem.json";function et(r){return r==="~"||r.startsWith("~/")?r.replace(/^~/,(0,Re.homedir)()):r}function Us(r){let e;try{e=JSON.parse((0,v.readFileSync)(r,"utf-8"))}catch{return null}let t=e.projectName??e.project_name;return typeof t=="string"&&t.trim()!==""?t.trim():null}function tt(r){let e=(0,Re.homedir)(),t=O.default.resolve(r);for(;;){let s=Us(O.default.join(t,ys));if(s)return E.info("PROJECT_NAME","Using project name from .claude-mem.json",{configDir:t,projectName:s}),s;let n=O.default.dirname(t);if(t===e||n===t)break;t=n}return null}function st(r){try{return(0,Ze.execFileSync)("git",["rev-parse","--show-toplevel"],{cwd:r,encoding:"utf-8",stdio:["ignore","pipe","ignore"]}).trim()||null}catch(e){let t=e instanceof Error?e:new Error(String(e));return E.debug("PROJECT_NAME","git rev-parse failed, falling back to basename",{dir:r},t),null}}function U(r){try{return(0,v.realpathSync)(r)}catch{return O.default.resolve(r)}}function ze(r){let e=U(r);return process.platform==="win32"?e.toLowerCase():e}function re(r,e){return ze(r)===ze(e)}function xs(r,e){let t=O.default.relative(U(e),U(r));return t===""||!!t&&!t.startsWith("..")&&!O.default.isAbsolute(t)}function ks(r){let e=O.default.join(r,".git");try{if(!(0,v.statSync)(e).isFile())return!1;let t=(0,v.readFileSync)(e,"utf-8").trim();return/^gitdir:\s*.+[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/i.test(t)}catch{return!1}}function rt(r){let e=U(r);for(;;){if(ks(e))return e;let t=O.default.dirname(e);if(t===e)return null;e=t}}function Se(r){try{return(0,v.statSync)(O.default.join(r,"package.json")).isFile()}catch{return!1}}function Ps(r,e){let t=U(r),s=U(e);for(;xs(t,s)&&!re(t,s);){if(Se(t))return t;let n=O.default.dirname(t);if(n===t)break;t=n}return null}function Fs(r){try{let e=JSON.parse((0,v.readFileSync)(O.default.join(r,"package.json"),"utf-8"));return Array.isArray(e.workspaces)?e.workspaces.length>0:Array.isArray(e.workspaces?.packages)&&e.workspaces.packages.length>0}catch{return!1}}function ws(r){let e=new Set([".git","node_modules",".claude-mem","dist","build"]);try{for(let t of(0,v.readdirSync)(r,{withFileTypes:!0})){if(!t.isDirectory()||e.has(t.name))continue;let s=O.default.join(r,t.name);if(Se(s))return!0;try{for(let n of(0,v.readdirSync)(s,{withFileTypes:!0}))if(!(!n.isDirectory()||e.has(n.name))&&Se(O.default.join(s,n.name)))return!0}catch{}}}catch{return!1}return!1}function $s(r){return Fs(r)||ws(r)}function Xs(r,e){let t=O.default.relative(U(e),U(r)),[s]=t.split(O.default.sep).filter(Boolean);return s?O.default.join(e,s):e}function Gs(r){return r.split(O.default.sep).filter(Boolean).join("/")}function Hs(r){if(!r||r.trim()==="")return E.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:r}),"unknown-project";let e=et(r),t=tt(e);if(t)return t;let s=st(e),n=rt(e);if(n&&(!s||re(s,n)))return O.default.basename(n);if(s){if(re(e,s))return O.default.basename(s);let a=Ps(e,s);if(!a&&!$s(s))return O.default.basename(s);let d=a??Xs(e,s),_=Gs(O.default.relative(U(s),U(d)));return`${O.default.basename(s)}/${_}`}let i=O.default.basename(e);if(i===""){if(process.platform==="win32"){let d=r.match(/^([A-Z]):\\/i);if(d){let m=`drive-${d[1].toUpperCase()}`;return E.info("PROJECT_NAME","Drive root detected",{cwd:r,projectName:m}),m}}return E.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:r}),"unknown-project"}return i}function nt(r){let e=Hs(r);if(!r)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let t=et(r);if(tt(t))return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let s=st(t),n=rt(t),o=n&&(!s||re(s,n))?n:null,i=fe(t),a=i.isWorktree?i:o?fe(o):i;if(a.isWorktree&&a.parentProjectName){let d=o?O.default.basename(o):e,_=`${a.parentProjectName}/${d}`;return{primary:_,parent:a.parentProjectName,isWorktree:!0,allProjects:[a.parentProjectName,_]}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}var y=require("fs"),K=require("path"),be=require("os");var Oe={HEALTH_CHECK:3e3,API_REQUEST:3e4,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function ot(r){return process.platform==="win32"?Math.round(r*Oe.WINDOWS_MULTIPLIER):r}var at=384;function Ae(r){process.platform!=="win32"&&(0,y.chmodSync)(r,at)}function it(r,e){(0,y.existsSync)(r)&&Ae(r),(0,y.writeFileSync)(r,JSON.stringify(e,null,2),{encoding:"utf-8",mode:at}),Ae(r)}var ne=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_API_TIMEOUT_MS:String(ot(Oe.API_REQUEST)),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_ALLOW_DISMISS:"false",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_CLAUDE_MAX_TOKENS:"150000",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_CODEX_MODEL:"gpt-5.3-codex-spark",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"",CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_CODEX_MAX_TOKENS:"100000",CLAUDE_MEM_CODEX_TIMEOUT_MS:"120000",CLAUDE_MEM_KIRO_AGENT:"claude-mem-observer",CLAUDE_MEM_KIRO_MODEL:"claude-haiku-4.5",CLAUDE_MEM_KIRO_CLI_PATH:"",CLAUDE_MEM_DATA_DIR:(0,K.join)((0,be.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_CONTEXT_FETCH_BY_ID_SUPPORTED:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,K.join)((0,be.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"10",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_MERMAID_CONTEXT:"false",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e,t=!0){try{if(!(0,y.existsSync)(e)){let a=this.getAllDefaults();try{let d=(0,K.dirname)(e);(0,y.existsSync)(d)||(0,y.mkdirSync)(d,{recursive:!0}),it(e,a),x(`[SETTINGS] Created settings file with defaults: ${e}
`)}catch(d){x(`[SETTINGS] Failed to create settings file, using in-memory defaults: ${e} ${d instanceof Error?d.message:String(d)}
`)}return t?this.applyEnvOverrides(a):a}try{Ae(e)}catch(a){console.warn("[SETTINGS] Failed to tighten settings file permissions:",e,a instanceof Error?a.message:String(a))}let s=(0,y.readFileSync)(e,"utf-8"),n=JSON.parse(F(s)),o=n;if(n.env&&typeof n.env=="object"){o=n.env;try{it(e,o),x(`[SETTINGS] Migrated settings file from nested to flat schema: ${e}
`)}catch(a){x(`[SETTINGS] Failed to auto-migrate settings file: ${e} ${a instanceof Error?a.message:String(a)}
`)}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))o[a]!==void 0&&(i[a]=o[a]);return t?this.applyEnvOverrides(i):i}catch(s){x(`[SETTINGS] Failed to load settings, using defaults: ${e} ${s instanceof Error?s.message:String(s)}
`);let n=this.getAllDefaults();return t?this.applyEnvOverrides(n):n}}};var Y=require("fs"),oe=require("path");var D=class r{static instance=null;activeMode=null;modesDir;constructor(){let e=xe(),t=[...process.env.CLAUDE_MEM_MODES_DIR?[process.env.CLAUDE_MEM_MODES_DIR]:[],(0,oe.join)(e,"modes"),(0,oe.join)(e,"..","plugin","modes")],s=t.find(n=>(0,Y.existsSync)(n));this.modesDir=s||t[0]}static getInstance(){return r.instance||(r.instance=new r),r.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?s[n]=this.deepMerge(i,o):s[n]=o}return s}loadModeFile(e){let t=(0,oe.join)(this.modesDir,`${e}.json`);if(!(0,Y.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,Y.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,E.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(_=>_.id),concepts:d.observation_concepts.map(_=>_.id)}),d}catch(d){if(d instanceof Error?E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:d.message}):E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(d)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:n}=t,o;try{o=this.loadMode(s)}catch(d){d instanceof Error?E.warn("WORKER",`Parent mode '${s}' not found for ${e}, falling back to 'code'`,{message:d.message}):E.warn("WORKER",`Parent mode '${s}' not found for ${e}, falling back to 'code'`,{error:String(d)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),E.debug("SYSTEM",`Loaded override file: ${n} for parent ${s}`)}catch(d){return d instanceof Error?E.warn("WORKER",`Override file '${n}' not found, using parent mode '${s}' only`,{message:d.message}):E.warn("WORKER",`Override file '${n}' not found, using parent mode '${s}' only`,{error:String(d)}),this.activeMode=o,o}if(!i)return E.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${s}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,E.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${s} + ${n})`,void 0,{parent:s,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}};var Bs=50,Ws=0,js=10;function Ne(r,e){let t=parseInt(String(r??""),10);return Number.isFinite(t)&&t>=0?t:e}function dt(){let r=W.settings(),e=ne.loadFromFile(r),t=D.getInstance().getActiveMode(),s=new Set(t.observation_types.map(o=>o.id)),n=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:Ne(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,Bs),fullObservationCount:Ne(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,Ws),sessionCount:Ne(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,js),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:s,observationConcepts:n,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true",mermaidContext:e.CLAUDE_MEM_MERMAID_CONTEXT==="true",fetchByIdSupported:e.CLAUDE_MEM_CONTEXT_FETCH_BY_ID_SUPPORTED!=="false"}}var u={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},_t=4,Et=1;function ut(r){let e=(r.title?.length||0)+(r.subtitle?.length||0)+(r.narrative?.length||0)+JSON.stringify(r.facts||[]).length;return Math.ceil(e/_t)}function he(r){let e=r.length,t=r.reduce((i,a)=>i+ut(a),0),s=r.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=s-t,o=s>0?Math.round(n/s*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:s,savings:n,savingsPercent:o}}function Vs(r){return D.getInstance().getWorkEmoji(r)}function q(r,e){let t=ut(r),s=r.discovery_tokens||0,n=Vs(r.type),o=s>0?`${n} ${s.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:s,discoveryDisplay:o,workEmoji:n}}function ie(r){return r.showReadTokens||r.showWorkTokens||r.showSavingsAmount||r.showSavingsPercent}var ct=B(require("path"),1),ae=require("fs");var mt="NOT EXISTS (SELECT 1 FROM observation_feedback f WHERE f.observation_id = o.id AND f.signal_type = 'dismissed')";function pt(r,e,t,s){let n=Array.from(t.observationTypes),o=n.map(()=>"?").join(","),i=Array.from(t.observationConcepts),a=i.map(()=>"?").join(","),d=e.map(()=>"?").join(",");return r.db.prepare(`
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
      AND ${mt}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,s??null,s??null,...n,...i,t.totalObservationCount)}function lt(r,e,t,s){let n=e.map(()=>"?").join(",");return r.db.prepare(`
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
    WHERE (ss.project IN (${n})
           OR ss.merged_into_project IN (${n}))
      AND (? IS NULL OR s.platform_source = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,s??null,s??null,t.sessionCount+Et)}function Ks(r){return r.replace(/[/.]/g,"-")}function Ys(r){if(!r.includes('"type":"assistant"'))return null;let e=JSON.parse(r);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let t="";for(let s of e.message.content)s.type==="text"&&(t+=s.text);if(t=t.replace(Be,"").trim(),t)return t}return null}function qs(r){for(let e=r.length-1;e>=0;e--)try{let t=Ys(r[e]);if(t)return t}catch(t){t instanceof Error?E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},t):E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(t)});continue}return""}function Js(r){try{if(!(0,ae.existsSync)(r))return{assistantMessage:""};let e=(0,ae.readFileSync)(r,"utf-8").trim();if(!e)return{assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim());return{assistantMessage:qs(t)}}catch(e){return e instanceof Error?E.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r},e):E.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r,error:String(e)}),{assistantMessage:""}}}function Tt(r,e,t,s){if(!e.showLastMessage||r.length===0)return{assistantMessage:""};let n=r.find(d=>d.memory_session_id!==t);if(!n)return{assistantMessage:""};let o=n.memory_session_id,i=Ks(s),a=ct.default.join(ue,"projects",i,`${o}.jsonl`);return Js(a)}function gt(r,e){let t=e[0]?.id;return r.map((s,n)=>{let o=null;for(let i=n+1;i<e.length;i++)if(e[i].project===s.project){o=e[i];break}return{...s,displayEpoch:o?o.created_at_epoch:s.created_at_epoch,displayTime:o?o.created_at:s.created_at,shouldShowLink:s.id!==t}})}function ft(r,e){let t=[...r.map(s=>({type:"observation",data:s})),...e.map(s=>({type:"summary",data:s}))];return t.sort((s,n)=>{let o=s.type==="observation"?s.data.created_at_epoch:s.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function St(r,e){return new Set(r.slice(0,e).map(t=>t.id))}var Ie=B(require("path"),1);function X(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[]}catch(e){return E.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:r?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function Ce(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Le(r){return new Date(r).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function G(r=new Date){return r.toLocaleDateString("en-CA")}function Ot(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Rt(r,e){return Ie.default.isAbsolute(r)?Ie.default.relative(e,r):r}function bt(r,e,t){let s=X(r);if(s.length>0)return Rt(s[0],e);if(t){let n=X(t);if(n.length>0)return Rt(n[0],e)}return"General"}var Qs=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;function H(r,e){let t=String(r);return e.fetchByIdSupported===!1&&Qs.test(t)?t.slice(0,8):t}function At(r){let e=G();return[`# [${r}] recent context, ${e}`,""]}function Nt(r=!0){let t=D.getInstance().getActiveMode().observation_types.map(n=>`${n.emoji}${n.id}`).join(" "),s=r?"Fetch details: get_observations([IDs]) | Search: mem-search skill":"Fetch details: mem-search by title/context (short refs are display-only)";return[`Legend: \u{1F3AF}session ${t}`,"Format: ID TIME TYPE TITLE",s,""]}function ht(r,e){let t=[],s=[`${r.totalObservations} obs (${r.totalReadTokens.toLocaleString()}t read)`,`${r.totalDiscoveryTokens.toLocaleString()}t work`];return r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?s.push(`${r.savingsPercent}% savings`):e.showSavingsAmount&&s.push(`${r.savings.toLocaleString()}t saved`)),t.push(`Stats: ${s.join(" | ")}`),t.push(""),t}function It(r){return[`### ${r}`]}function Ct(r){return r.toLowerCase().replace(" am","a").replace(" pm","p")}function Lt(r,e,t){let s=r.title||"Untitled",n=D.getInstance().getTypeIcon(r.type),o=e?Ct(e):'"';return`${H(r.id,t)} ${o} ${n} ${s}`}function Mt(r,e,t,s){let n=[],o=r.title||"Untitled",i=D.getInstance().getTypeIcon(r.type),a=e?Ct(e):'"',{readTokens:d,discoveryDisplay:_}=q(r,s),m=H(r.id,s);n.push(`**${m}** ${a} ${i} **${o}**`),t&&n.push(t);let c=[];return s.showReadTokens&&c.push(`~${d}t`),s.showWorkTokens&&c.push(_),c.length>0&&n.push(c.join(" ")),n.push(""),n}function Dt(r,e){return[`S${r.id} ${r.request||"Session started"} (${e})`]}function J(r,e){return e?[`**${r}**: ${e}`,""]:[]}function vt(r){return r.assistantMessage?["","---","","**Previously**","",`A: ${r.assistantMessage}`,""]:[]}function yt(r,e,t=!0){return["",`Access ${Math.round(r/1e3)}k tokens of past work via ${t?"get_observations([IDs]) or mem-search skill":"mem-search skill"}.`]}function Ut(r){let e=G();return`# [${r}] recent context, ${e}

No previous sessions found.`}function xt(r){let e=G();return["",`${u.bright}${u.cyan}[${r}] recent context, ${e}${u.reset}`,`${u.gray}${"\u2500".repeat(60)}${u.reset}`,""]}function kt(){let e=D.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${u.dim}Legend: session-request | ${e}${u.reset}`,""]}function Pt(){return[`${u.bright}Column Key${u.reset}`,`${u.dim}  Read: Tokens to read this observation (cost to learn it now)${u.reset}`,`${u.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${u.reset}`,""]}function Ft(r=!0){let e=r?`${u.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${u.reset}`:`${u.dim}  - Search: observation_search / mem-search skill (by-id fetch is not available in server-beta mode)${u.reset}`;return[`${u.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${u.reset}`,"",`${u.dim}When you need implementation details, rationale, or debugging context:${u.reset}`,e,`${u.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${u.reset}`,`${u.dim}  - Trust this index over re-reading code for past decisions and learnings${u.reset}`,""]}function wt(r,e){let t=[];if(t.push(`${u.bright}${u.cyan}Context Economics${u.reset}`),t.push(`${u.dim}  Loading: ${r.totalObservations} observations (${r.totalReadTokens.toLocaleString()} tokens to read)${u.reset}`),t.push(`${u.dim}  Work investment: ${r.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${u.reset}`),r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${r.savings.toLocaleString()} tokens (${r.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?s+=`${r.savings.toLocaleString()} tokens`:s+=`${r.savingsPercent}% reduction from reuse`,t.push(`${u.green}${s}${u.reset}`)}return t.push(""),t}function $t(r){return[`${u.bright}${u.cyan}${r}${u.reset}`,""]}function Xt(r){return[`${u.dim}${r}${u.reset}`]}function Gt(r,e,t,s){let n=r.title||"Untitled",o=D.getInstance().getTypeIcon(r.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=q(r,s),_=t?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),m=s.showReadTokens&&i>0?`${u.dim}(~${i}t)${u.reset}`:"",c=s.showWorkTokens&&a>0?`${u.dim}(${d} ${a.toLocaleString()}t)${u.reset}`:"";return`  ${u.dim}#${H(r.id,s)}${u.reset}  ${_}  ${o}  ${n} ${m} ${c}`}function Ht(r,e,t,s,n){let o=[],i=r.title||"Untitled",a=D.getInstance().getTypeIcon(r.type),{readTokens:d,discoveryTokens:_,workEmoji:m}=q(r,n),c=t?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),T=n.showReadTokens&&d>0?`${u.dim}(~${d}t)${u.reset}`:"",g=n.showWorkTokens&&_>0?`${u.dim}(${m} ${_.toLocaleString()}t)${u.reset}`:"";return o.push(`  ${u.dim}#${H(r.id,n)}${u.reset}  ${c}  ${a}  ${u.bright}${i}${u.reset}`),s&&o.push(`    ${u.dim}${s}${u.reset}`),(T||g)&&o.push(`    ${T} ${g}`),o.push(""),o}function Bt(r,e){let t=`${r.request||"Session started"} (${e})`;return[`${u.yellow}#S${r.id}${u.reset} ${t}`,""]}function Q(r,e,t){return e?[`${t}${r}:${u.reset} ${e}`,""]:[]}function Wt(r){return r.assistantMessage?["","---","",`${u.bright}${u.magenta}Previously${u.reset}`,"",`${u.dim}A: ${r.assistantMessage}${u.reset}`,""]:[]}function jt(r,e){let t=Math.round(r/1e3);return["",`${u.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${u.reset}`]}function Vt(r){let e=G();return`
${u.bright}${u.cyan}[${r}] recent context, ${e}${u.reset}
${u.gray}${"\u2500".repeat(60)}${u.reset}

${u.dim}No previous sessions found for this project yet.${u.reset}
`}function Kt(r,e,t,s){let n=[];return s?n.push(...xt(r)):n.push(...At(r)),s?n.push(...kt()):n.push(...Nt(t.fetchByIdSupported)),s&&(n.push(...Pt()),n.push(...Ft(t.fetchByIdSupported))),ie(t)&&(s?n.push(...wt(e,t)):n.push(...ht(e,t))),n}function zs(r){let e=new Map;for(let s of r){let n=s.type==="observation"?s.data.created_at:s.data.displayTime,o=Ot(n);e.has(o)||e.set(o,[]),e.get(o).push(s)}let t=Array.from(e.entries()).sort((s,n)=>{let o=new Date(s[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function Yt(r,e){return e.fullObservationField==="narrative"?r.narrative:r.facts?X(r.facts).join(`
`):null}function Zs(r,e,t,s){let n=[];n.push(...It(r));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=Ce(a.displayTime);n.push(...Dt(a,d))}else{let a=i.data,d=Le(a.created_at),m=d!==o?d:"";if(o=d,t.has(a.id)){let T=Yt(a,s);n.push(...Mt(a,m,T,s))}else n.push(Lt(a,m,s))}return n}function er(r,e,t,s,n){let o=[];o.push(...$t(r));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let _=d.data,m=Ce(_.displayTime);o.push(...Bt(_,m))}else{let _=d.data,m=bt(_.files_modified,n,_.files_read),c=Le(_.created_at),T=c!==a;a=c;let g=t.has(_.id);if(m!==i&&(o.push(...Xt(m)),i=m),g){let b=Yt(_,s);o.push(...Ht(_,c,T,b,s))}else o.push(Gt(_,c,T,s))}return o.push(""),o}function tr(r,e,t,s,n,o){return o?er(r,e,t,s,n):Zs(r,e,t,s)}function qt(r,e,t,s,n){let o=[],i=zs(r);for(let[a,d]of i)o.push(...tr(a,d,e,t,s,n));return o}function Jt(r,e,t){return!(!r.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function Qt(r,e){let t=[];return e?(t.push(...Q("Investigated",r.investigated,u.blue)),t.push(...Q("Learned",r.learned,u.yellow)),t.push(...Q("Completed",r.completed,u.green)),t.push(...Q("Next Steps",r.next_steps,u.magenta))):(t.push(...J("Investigated",r.investigated)),t.push(...J("Learned",r.learned)),t.push(...J("Completed",r.completed)),t.push(...J("Next Steps",r.next_steps))),t}function zt(r,e){return e?Wt(r):vt(r)}function Zt(r,e,t){return!ie(e)||r.totalDiscoveryTokens<=0||r.savings<=0?[]:t?jt(r.totalDiscoveryTokens,r.totalReadTokens):yt(r.totalDiscoveryTokens,r.totalReadTokens,e.fetchByIdSupported)}var sr={bugfix:{fill:"#fed7d7",color:"#1a202c",emoji:"\u{1F534}"},feature:{fill:"#e9d8fd",color:"#1a202c",emoji:"\u{1F7E3}"},refactor:{fill:"#fef9c3",color:"#1a202c",emoji:"\u{1F504}"},change:{fill:"#dcfce7",color:"#1a202c",emoji:"\u2705"},discovery:{fill:"#dbeafe",color:"#1a202c",emoji:"\u{1F535}"},decision:{fill:"#ffedd5",color:"#1a202c",emoji:"\u2696\uFE0F"}},rr={fill:"#f1f5f9",color:"#1a202c",emoji:"\u{1F4CC}"};function es(r){return r.replace(/"/g,"'").replace(/\n/g," ").replace(/[<>{}|[\]]/g," ").trim().slice(0,60)}function nr(r){if(!r)return"";try{let e=X(r);return e.length===0?"":e[0].split("/").slice(-2).join("/")}catch{return""}}function or(r,e){let t=sr[r.type]??rr,s=`N${e}`,n=es(r.title??r.subtitle??r.type),o=nr(r.files_modified??r.files_read),i=o?`${t.emoji} ${n} \xB7 ${o}`:`${t.emoji} ${n}`;return{id:s,line:`    ${s}["${i}"]`,style:`    style ${s} fill:${t.fill},color:${t.color}`}}function ts(r,e){if(r.length===0)return[];let t=r[0].memory_session_id,s=r.filter(a=>a.memory_session_id===t).reverse();if(s.length===0)return[];let n=e?.memory_session_id===t?e:void 0,o=s.map((a,d)=>or(a,d)),i=[];i.push("## Task Flow (Last Session)"),i.push(""),i.push("```mermaid"),i.push("graph LR");for(let a of o)i.push(a.line);for(let a=0;a<o.length-1;a++)i.push(`    ${o[a].id} --> ${o[a+1].id}`);if(n?.next_steps&&n.next_steps.trim()){let a=es(n.next_steps);i.push(`    NEXT(["Next: ${a}"])`),i.push(`    ${o[o.length-1].id} --> NEXT`),i.push("    style NEXT fill:#bee3f8,color:#1a202c")}for(let a of o)i.push(a.style);return i.push("```"),i.push(""),i}var ir=ss.default.join((0,rs.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function ar(){try{return new ee}catch(r){if(r instanceof Error&&r.code==="ERR_DLOPEN_FAILED"){try{(0,ns.unlinkSync)(ir)}catch(e){e instanceof Error?E.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):E.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return E.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw r}}function dr(r,e){return e?Vt(r):Ut(r)}function _r(r,e,t,s,n,o,i){let a=[],d=he(e),_=t[0];a.push(...Kt(r,d,s,i)),s.mermaidContext&&!i&&a.push(...ts(e,_));let m=t.slice(0,s.sessionCount),c=gt(m,t),T=ft(e,c),g=St(e,s.fullObservationCount);a.push(...qt(T,g,s,n,i));let b=e[0];Jt(s,_,b)&&a.push(...Qt(_,i));let A=Tt(e,s,o,n);return a.push(...zt(A,i)),a.push(...Zt(d,s,i)),a.join(`
`).trimEnd()}var Er=new Set(["bugfix","discovery","decision","refactor"]);function ur(r,e,t){let s=he(r),n={bugfix:0,discovery:0,decision:0,refactor:0,other:0},o=new Set,i=Number.POSITIVE_INFINITY;for(let d of r){let _=Er.has(d.type)?d.type:"other";n[_]++,d.memory_session_id&&o.add(d.memory_session_id),d.created_at_epoch&&d.created_at_epoch<i&&(i=d.created_at_epoch)}let a=Number.isFinite(i)?Math.max(0,Math.floor((Date.now()-i)/864e5)):0;return{observation_count:r.length,session_count:o.size,timeline_depth_days:a,has_session_summary:e.length>0,obs_type_bugfix:n.bugfix,obs_type_discovery:n.discovery,obs_type_decision:n.decision,obs_type_refactor:n.refactor,obs_type_other:n.other,tokens_injected:s.totalReadTokens,tokens_saved_vs_naive:s.savings,search_strategy:t?"full":"timeline"}}async function Me(r,e=!1){let t=dt(),s=r?.cwd??process.cwd(),n=nt(s),o=r?.projects?.length?r.projects:n.allProjects,i=o[o.length-1]??n.primary;r?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let a=ar();if(!a)return{text:"",stats:null};try{let d=r?.platformSource?C(r.platformSource):void 0,_=o.length>1?o:[i],m=pt(a,_,t,d),c=lt(a,_,t,d);return m.length===0&&c.length===0?{text:dr(i,e),stats:null}:{text:_r(i,m,c,t,s,r?.session_id,e),stats:ur(m,c,!!r?.full)}}finally{a.close()}}async function os(r,e=!1){return(await Me(r,e)).text}0&&(module.exports={generateContext,generateContextWithStats});
