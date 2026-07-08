"use strict";var ps=Object.create;var ee=Object.defineProperty;var Ts=Object.getOwnPropertyDescriptor;var gs=Object.getOwnPropertyNames;var fs=Object.getPrototypeOf,Ss=Object.prototype.hasOwnProperty;var Rs=(s,e)=>{for(var t in e)ee(s,t,{get:e[t],enumerable:!0})},Pe=(s,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of gs(e))!Ss.call(s,n)&&n!==t&&ee(s,n,{get:()=>e[n],enumerable:!(r=Ts(e,n))||r.enumerable});return s};var j=(s,e,t)=>(t=s!=null?ps(fs(s)):{},Pe(e||!s||!s.__esModule?ee(t,"default",{value:s,enumerable:!0}):t,s)),Os=s=>Pe(ee({},"__esModule",{value:!0}),s);var Cr={};Rs(Cr,{generateContext:()=>ls,generateContextWithStats:()=>ke});module.exports=Os(Cr);var Es=j(require("path"),1),us=require("os"),cs=require("fs");var rt=require("bun:sqlite");var R=require("path"),pe=require("os"),$=require("fs"),we=require("url");function F(s){return s.charCodeAt(0)===65279?s.slice(1):s}var Cs={};function bs(){return typeof __dirname<"u"?__dirname:(0,R.dirname)((0,we.fileURLToPath)(Cs.url))}var As=bs();function hs(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let s=(0,R.join)((0,pe.homedir)(),".claude-mem"),e=(0,R.join)(s,"settings.json");try{if((0,$.existsSync)(e)){let t=JSON.parse(F((0,$.readFileSync)(e,"utf-8"))),r=t.env??t;if(r.CLAUDE_MEM_DATA_DIR)return r.CLAUDE_MEM_DATA_DIR}}catch{}return s}var I=hs(),Te=process.env.CLAUDE_CONFIG_DIR||(0,R.join)((0,pe.homedir)(),".claude"),yr=(0,R.join)(Te,"plugins","marketplaces","thedotmack"),Ns=(0,R.join)(I,"logs"),Ur=(0,R.join)(I,"settings.json"),Fe=(0,R.join)(I,"claude-mem.db"),Is=(0,R.join)(I,"observer-sessions"),ge=(0,R.basename)(Is);function $e(s){(0,$.mkdirSync)(s,{recursive:!0})}function Xe(){return(0,R.join)(As,"..")}var W={dataDir:()=>I,workerPid:()=>(0,R.join)(I,"worker.pid"),serverPid:()=>(0,R.join)(I,".server-beta.pid"),serverPort:()=>(0,R.join)(I,".server-beta.port"),serverRuntime:()=>(0,R.join)(I,".server-beta.runtime.json"),settings:()=>(0,R.join)(I,"settings.json"),database:()=>(0,R.join)(I,"claude-mem.db"),chroma:()=>(0,R.join)(I,"chroma"),combinedCerts:()=>(0,R.join)(I,"combined_certs.pem"),transcriptsConfig:()=>(0,R.join)(I,"transcript-watch.json"),transcriptsState:()=>(0,R.join)(I,"transcript-watch-state.json"),corpora:()=>(0,R.join)(I,"corpora"),supervisorRegistry:()=>(0,R.join)(I,"supervisor.json"),envFile:()=>(0,R.join)(I,".env"),logsDir:()=>Ns};var k=require("fs"),Ge=require("path");var Ls=null;function Ms(s){return(Ls??process.stderr.write.bind(process.stderr))(s)}function x(s){Ms(s)}var Se=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Se||{}),fe=null,Re=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=W.logsDir();(0,k.existsSync)(e)||(0,k.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,Ge.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=W.settings();if((0,k.existsSync)(e)){let t=(0,k.readFileSync)(e,"utf-8"),n=(JSON.parse(F(t)).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Se[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let r=t;if(typeof t=="string")try{r=JSON.parse(t)}catch{r=t}if(e==="Bash"&&r.command)return`${e}(${r.command})`;if(r.file_path)return`${e}(${r.file_path})`;if(r.notebook_path)return`${e}(${r.notebook_path})`;if(e==="Glob"&&r.pattern)return`${e}(${r.pattern})`;if(e==="Grep"&&r.pattern)return`${e}(${r.pattern})`;if(r.url)return`${e}(${r.url})`;if(r.query)return`${e}(${r.query})`;if(e==="Task"){if(r.subagent_type)return`${e}(${r.subagent_type})`;if(r.description)return`${e}(${r.description})`}return e==="Skill"&&r.skill?`${e}(${r.skill})`:e==="LSP"&&r.operation?`${e}(${r.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),r=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${r}-${n} ${o}:${i}:${a}.${d}`}log(e,t,r,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Se[e].padEnd(5),d=t.padEnd(6),_="";n?.correlationId?_=`[${n.correlationId}] `:n?.sessionId&&(_=`[session-${n.sessionId}] `);let c="";if(o!=null)if(o instanceof Error)c=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{c=`
`+JSON.stringify(o,null,2)}catch{c=" "+this.formatData(o)}else c=" "+this.formatData(o);let m="";if(n){let{sessionId:T,memorySessionId:f,correlationId:A,...L}=n;Object.keys(L).length>0&&(m=` {${Object.entries(L).map(([N,P])=>`${N}=${P}`).join(", ")}}`)}let l=`[${i}] [${a}] [${d}] ${_}${r}${m}${c}`;if(this.logFilePath)try{(0,k.appendFileSync)(this.logFilePath,l+`
`,"utf8")}catch(T){let f=T instanceof Error?T:new Error(String(T));x(`[LOGGER] Failed to write to log file: ${f.message}
${f.stack??""}
`)}else x(l+`
`)}debug(e,t,r,n){this.log(0,e,t,r,n)}info(e,t,r,n){this.log(1,e,t,r,n)}warn(e,t,r,n){this.log(2,e,t,r,n)}setErrorSink(e){fe=e}error(e,t,r,n){this.log(3,e,t,r,n),this.routeErrorToSink(t,r,n)}routeErrorToSink(e,t,r){try{if(!fe||!(r instanceof Error))return;fe(r)}catch{}}dataIn(e,t,r,n){this.info(e,`\u2192 ${t}`,r,n)}dataOut(e,t,r,n){this.info(e,`\u2190 ${t}`,r,n)}success(e,t,r,n){this.info(e,`\u2713 ${t}`,r,n)}failure(e,t,r,n){this.error(e,`\u2717 ${t}`,r,n)}},E=new Re;var He=require("crypto");function Be(s,e,t){return(0,He.createHash)("sha256").update([s||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}var p="claude";function Ds(s){return s.trim().toLowerCase().replace(/\s+/g,"-")}function C(s){if(!s)return p;let e=Ds(s);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:p}function je(s){let e=["claude","codex","cursor"];return[...s].sort((t,r)=>{let n=e.indexOf(t),o=e.indexOf(r);return n!==-1||o!==-1?n===-1?1:o===-1?-1:n-o:t.localeCompare(r)})}function We(s,e,t,r,n){let o=Date.now()-r,i=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return s.prepare(`
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
  `).get(a,t,o)??void 0}var Ye=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],Ve=new RegExp(`<(${Ye.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),qe=/<system-reminder>[\s\S]*?<\/system-reminder>/g,Ke=100;function vs(s){let e=Object.fromEntries(Ye.map(n=>[n,0]));Ve.lastIndex=0;let t=0,r=s.replace(Ve,(n,o)=>(e[o]=(e[o]??0)+1,t+=1,""));return t>Ke&&E.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:t,maxAllowed:Ke,contentLength:s.length}),{stripped:r.trim(),counts:e}}function Je(s){return vs(s).stripped}var ys=["task-notification"],Wr=new RegExp(`^\\s*<(${ys.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Vr=256*1024;var V=4e3,Oe=["<private","<claude-mem-context","<system_instruction","<system-instruction","<persisted-output","<system-reminder"];function X(s){let e=s.trim(),r=Je(s).trim()||e;return r.length<=V?r:(E.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:r.length,storedLength:V}),`${r.slice(0,V-1)}\u2026`)}var Qe=38,Us=512*1024;function te(s,e){let t=s.prepare(`PRAGMA ${e}`).get();return Number(t?.[e]??0)}function xs(){return`
    SELECT id, prompt_text
    FROM user_prompts
    WHERE length(prompt_text) > ?
      OR ${Oe.map(()=>"instr(prompt_text, ?) > 0").join(" OR ")}
  `}function ks(s){let e=s.prepare(xs()).all(V,...Oe);if(e.length===0)return 0;let t=s.prepare("UPDATE user_prompts SET prompt_text = ? WHERE id = ?"),r=0;for(let n of e){let o=X(n.prompt_text);o!==n.prompt_text&&(t.run(o,n.id),r+=1)}return r}function Ps(s){let e=s.prepare(`
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
  `).run();return Number(e.changes??0)}function ze(s,e,t){try{s.run("PRAGMA wal_checkpoint(PASSIVE)")}catch(d){E.debug("DB","Legacy prompt bloat cleanup could not checkpoint WAL before compaction",{error:d instanceof Error?d.message:String(d)})}let r=te(s,"page_size"),n=te(s,"freelist_count"),o=r*n,i=te(s,"auto_vacuum");if(e===0||o<t)return{autoVacuumMode:i,freeBytesAfter:o,freeBytesBefore:o,freelistCountAfter:n,freelistCountBefore:n,mode:"skipped",pageSize:r,thresholdBytes:t};try{i===2?s.run(`PRAGMA incremental_vacuum(${n})`):s.run("VACUUM")}catch(d){let _=d instanceof Error?d:new Error(String(d));return E.warn("DB","Legacy prompt bloat cleanup could not reclaim free pages",{autoVacuumMode:i,freeBytesBefore:o,freelistCountBefore:n},_),{autoVacuumMode:i,error:_.message,freeBytesAfter:o,freeBytesBefore:o,freelistCountAfter:n,freelistCountBefore:n,mode:"failed",pageSize:r,thresholdBytes:t}}let a=te(s,"freelist_count");return{autoVacuumMode:i,freeBytesAfter:r*a,freeBytesBefore:o,freelistCountAfter:a,freelistCountBefore:n,mode:i===2?"incremental_vacuum":"vacuum",pageSize:r,thresholdBytes:t}}function Ze(s,e=Us){if(s.prepare("SELECT 1 FROM schema_versions WHERE version = ?").get(Qe))return{clearedSessionPrompts:0,compaction:ze(s,0,e),normalizedPromptRows:0,versionApplied:!1};let r=0,n=0;s.run("BEGIN TRANSACTION");try{r=ks(s),n=Ps(s),s.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(Qe,new Date().toISOString()),s.run("COMMIT")}catch(i){throw s.run("ROLLBACK"),i}let o=ze(s,r+n,e);return(r>0||n>0)&&E.info("DB","Applied legacy prompt bloat maintenance",{normalizedPromptRows:r,clearedSessionPrompts:n,compactionMode:o.mode,freeBytesBefore:o.freeBytesBefore,freeBytesAfter:o.freeBytesAfter}),{clearedSessionPrompts:n,compaction:o,normalizedPromptRows:r,versionApplied:!0}}var et=require("bun:sqlite"),tt=require("node:path");var ws=5e3;function Fs(s){s!==":memory:"&&$e((0,tt.dirname)(s))}function be(s){s.run(`PRAGMA busy_timeout = ${ws}`)}function $s(s){let{tableCount:e}=s.query("SELECT COUNT(*) AS tableCount FROM sqlite_master WHERE type = 'table'").get(),{page_count:t}=s.query("PRAGMA page_count").get();return e>0||t>1?!1:(s.run("PRAGMA auto_vacuum = INCREMENTAL"),!0)}function Xs(s){be(s),s.run("PRAGMA journal_mode = WAL"),s.run("PRAGMA synchronous = NORMAL"),s.run("PRAGMA foreign_keys = ON"),s.run("PRAGMA journal_size_limit = 4194304")}function st(s){Fs(s);let e=new et.Database(s);return $s(e),Xs(e),e}var se=class{db;constructor(e=Fe){e instanceof rt.Database?(this.db=e,be(this.db)):this.db=st(e),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex(),this.addObservationContentSessionIdColumns(),this.createObservationFeedbackTable(),Ze(this.db)}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(t=>t.name)}hasUniqueIndexOnColumns(e,t){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let o=this.getIndexColumns(n.name);return o.length===t.length&&o.every((i,a)=>i===t[a])})}resolvePromptSessionDbId(e,t,r){if(t!==void 0)return t;let n=r?C(r):void 0;return n?this.db.prepare(`
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
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),r=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!r)){if(r)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),E.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){E.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),t=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),r=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!t&&r&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),this.db.run(`
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
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,d,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let c=_ instanceof Error?_:new Error(String(_));throw E.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},c),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,t,r){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE user_prompts"),this.db.run("ALTER TABLE user_prompts_new RENAME TO user_prompts"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_claude_session ON user_prompts(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_prompt_number ON user_prompts(prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_lookup ON user_prompts(session_db_id, prompt_number)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_content_lookup ON user_prompts(content_session_id, prompt_number)"),r&&(this.db.run(`
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
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let r=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&r)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw E.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}addObservationContentSessionIdColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(36),r=this.db.query("PRAGMA table_info(observations)").all().some(d=>d.name==="content_session_id"),o=this.db.query("PRAGMA table_info(session_summaries)").all().some(d=>d.name==="content_session_id"),i=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_observations_content_session'
    `).get(),a=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_summaries_content_session'
    `).get();e&&r&&o&&i&&a||(r||(this.db.run("ALTER TABLE observations ADD COLUMN content_session_id TEXT"),E.debug("DB","Added content_session_id column to observations table (#2769)")),this.db.run(`
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
    `).get(),r=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_observation'
    `).get(),n=this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_feedback_signal'
    `).get();e&&t&&r&&n||(this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        session_db_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_signal ON observation_feedback(signal_type)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(37,new Date().toISOString()))}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),t=this.db.query("PRAGMA table_info(pending_messages)").all(),r=new Set(t.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>r.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),E.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),E.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="platform_source")&&(this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),E.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),E.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(r=>r.unique===1&&r.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}E.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),E.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}E.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `);let r=`
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
    `;try{this.db.run(r),this.db.run(n)}catch(o){o instanceof Error?E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}E.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),E.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;E.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,r=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(c=>c.name===o);return a.some(c=>c.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),E.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(E.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};r("sdk_sessions","claude_session_id","content_session_id")&&t++,r("sdk_sessions","sdk_session_id","memory_session_id")&&t++,r("pending_messages","claude_session_id","content_session_id")&&t++,r("observations","sdk_session_id","memory_session_id")&&t++,r("session_summaries","sdk_session_id","memory_session_id")&&t++,r("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?E.debug("DB",`Successfully renamed ${t} session ID columns`):E.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),E.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;E.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(g=>g.name==="metadata"),n=t.some(g=>g.name==="content_hash"),o=r?`,
        metadata TEXT`:"",i=r?", metadata":"",a=n?`,
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
    `,c=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${i}${d}
      FROM observations
    `,m=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,l=`
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
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let T=`
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
    `,f=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,A=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,L=`
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
    `;try{this.recreateObservationsWithCascade(_,c,m,l),this.recreateSessionSummariesWithCascade(T,f,A,L),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),E.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(g){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),g instanceof Error?g:new Error(String(g))}}recreateObservationsWithCascade(e,t,r,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(r),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,t,r,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(r),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),E.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),E.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${p}'`),E.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${p}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),r=e.some(n=>n.name==="relevance_count");t&&r||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(r=>r.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(i=>i.name==="agent_type"),n=t.some(i=>i.name==="agent_id");r||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(d=>d.name==="agent_type"),a=o.some(d=>d.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw E.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(o=>o.name==="memory_session_id"),n=t.some(o=>o.name==="content_hash");if(!r||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw E.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),E.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}markSessionCompleted(e){let t=Date.now(),r=new Date(t).toISOString();this.db.prepare(`
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
    `).run(r,t,e)}ensureMemorySessionIdRegistered(e,t,r){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),E.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:t})),typeof r=="number"&&n.worker_port!==r&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(r,e)}getAllProjects(e){let t=e?C(e):void 0,r=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[ge];return t&&(r+=" AND COALESCE(platform_source, ?) = ?",n.push(p,t)),r+=" ORDER BY project ASC",this.db.prepare(r).all(...n).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${p}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${p}'), project
      ORDER BY latest_epoch DESC
    `).all(ge),t=[],r=new Set,n={};for(let i of e){let a=C(i.platform_source);n[a]||(n[a]=[]),n[a].includes(i.project)||n[a].push(i.project),r.has(i.project)||(r.add(i.project),t.push(i.project))}let o=je(Object.keys(n));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,n[i]||[]]))}}getLatestUserPrompt(e,t){let r=this.resolvePromptSessionDbId(e,t),n=r!==null?"up.session_db_id = ?":"up.content_session_id = ?",o=r!==null?r:e;return this.db.prepare(`
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
    `).get(o)}findRecentDuplicateUserPrompt(e,t,r,n){return We(this.db,e,X(t),r,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,t=3,r){let n=[e],o="";return r&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`,n.push(C(r))),n.push(t),this.db.prepare(`
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
    `).all(...n)}getObservationsForSession(e,t){let r=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
        )
      `,r.push(C(t))),this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch ASC
    `).all(...r)}getObservationById(e,t){return t?this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?
    `).get(e,C(t))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o,platformSource:i,type:a,concepts:d,files:_}=t,c=r==="relevance",m=c?"":`ORDER BY o.created_at_epoch ${r==="date_asc"?"ASC":"DESC"}`,l=n&&!c?`LIMIT ${n}`:"",T=e.map(()=>"?").join(","),f=[...e],A=[];if(o&&(A.push("o.project = ?"),f.push(o)),i&&(A.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),f.push(C(i))),a)if(Array.isArray(a)){let h=a.map(()=>"?").join(",");A.push(`o.type IN (${h})`),f.push(...a)}else A.push("o.type = ?"),f.push(a);if(d){let h=Array.isArray(d)?d:[d],O=h.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");f.push(...h),A.push(`(${O.join(" OR ")})`)}if(_){let h=Array.isArray(_)?_:[_],O=h.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");h.forEach(M=>{f.push(`%${M}%`,`%${M}%`)}),A.push(`(${O.join(" OR ")})`)}let L=A.length>0?`WHERE o.id IN (${T}) AND ${A.join(" AND ")}`:`WHERE o.id IN (${T})`,N=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${L}
      ${m}
      ${l}
    `).all(...f);if(!c)return N;let P=new Map(N.map(h=>[h.id,h])),S=e.map(h=>P.get(h)).filter(h=>!!h);return n?S.slice(0,n):S}dismissObservation(e,t){let r=typeof t=="string"?t.trim():"",n=r?JSON.stringify({reason:r}):null;this.db.prepare(`
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
    `).get(e)!=null}getSummaryForSession(e,t){let r=[e],n="";return t&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${p}') = ?
        )
      `,r.push(C(t))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${n}
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(...r)||null}getSessionById(e){return this.db.prepare(`
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
    `).all(...e)}getPromptNumberFromUserPrompts(e,t){let r=this.resolvePromptSessionDbId(e,t);return r!==null?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(r).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,t,r,n,o){let i=new Date,a=i.getTime(),d=o?C(o):p,_=X(r),c=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(p,d,e);if(c)return t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(t,c.id),n&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE id = ? AND custom_title IS NULL
        `).run(n,c.id),c.id;let m=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,d,_,n||null,i.toISOString(),a);return Number(m.lastInsertRowid)}saveUserPrompt(e,t,r,n){let o=new Date,i=o.getTime(),a=X(r),d=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d,e,t,a,o.toISOString(),i).lastInsertRowid}getUserPrompt(e,t,r){let n=this.resolvePromptSessionDbId(e,r);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,t)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,r,n,o=0,i,a,d){let _=this.storeObservations(e,t,[r],null,n,o,i,a,d);return{id:_.observationIds[0],createdAtEpoch:_.createdAtEpoch}}storeSummary(e,t,r,n,o=0,i,a){let d=i??Date.now(),_=new Date(d).toISOString(),m=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
       content_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,o,_,d,a??null);return{id:Number(m.lastInsertRowid),createdAtEpoch:d}}storeObservations(e,t,r,n,o,i=0,a,d,_){let c=a??Date.now(),m=new Date(c).toISOString();return this.db.transaction(()=>{let T=[],f=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata, content_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),A=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let g of r){let N=Be(e,g.title,g.narrative),P=f.get(e,t,g.type,g.title,g.subtitle,JSON.stringify(g.facts),g.narrative,JSON.stringify(g.concepts),JSON.stringify(g.files_read),JSON.stringify(g.files_modified),o||null,i,g.agent_type??null,g.agent_id??null,N,m,c,d||null,g.metadata??null,_??null);if(P){T.push(P.id);continue}let S=A.get(e,N);if(!S)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${N}`);T.push(S.id)}let L=null;if(n){let N=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
           content_session_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,m,c,_??null);L=Number(N.lastInsertRowid)}return{observationIds:T,summaryId:L,createdAtEpoch:c}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o,platformSource:i}=t,a=r==="relevance",d=a?"":`ORDER BY ss.created_at_epoch ${r==="date_asc"?"ASC":"DESC"}`,_=n&&!a?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),m=[...e],l=[];o&&(l.push("ss.project = ?"),m.push(o)),i&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),m.push(C(i)));let T=l.length>0?`AND ${l.join(" AND ")}`:"",A=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${c}) ${T}
      ${d}
      ${_}
    `).all(...m);if(!a)return A;let L=new Map(A.map(N=>[N.id,N])),g=e.map(N=>L.get(N)).filter(N=>!!N);return n?g.slice(0,n):g}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o,platformSource:i}=t,a=r==="relevance",d=a?"":`ORDER BY up.created_at_epoch ${r==="date_asc"?"ASC":"DESC"}`,_=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),m=[...e],l=[];o&&(l.push("s.project = ?"),m.push(o)),i&&(l.push(`COALESCE(NULLIF(s.platform_source, ''), '${p}') = ?`),m.push(C(i)));let T=l.length>0?`AND ${l.join(" AND ")}`:"",A=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${c}) ${T}
      ${d}
      ${_}
    `).all(...m);if(!a)return A;let L=new Map(A.map(g=>[g.id,g]));return e.map(g=>L.get(g)).filter(g=>!!g)}getTimelineAroundTimestamp(e,t=10,r=10,n,o){return this.getTimelineAroundObservation(null,e,t,r,n,o)}getTimelineAroundObservation(e,t,r=10,n=10,o,i){let a=i?C(i):void 0,d=(S,h)=>{let O=[],M=[];return o&&(O.push(`${S}.project = ?`),M.push(o)),a&&(O.push(`COALESCE(NULLIF(${h}.platform_source, ''), '${p}') = ?`),M.push(a)),{clause:O.length>0?`AND ${O.join(" AND ")}`:"",params:M}},_=d("o","src"),c=d("ss","src"),m=d("s","s"),l,T;if(e!==null){let S=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id <= ? ${_.clause}
        ORDER BY o.id DESC
        LIMIT ?
      `,h=`
        SELECT o.id, o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.id >= ? ${_.clause}
        ORDER BY o.id ASC
        LIMIT ?
      `;try{let O=this.db.prepare(S).all(e,..._.params,r+1),M=this.db.prepare(h).all(e,..._.params,n+1);if(O.length===0&&M.length===0)return{observations:[],sessions:[],prompts:[]};l=O.length>0?O[O.length-1].created_at_epoch:t,T=M.length>0?M[M.length-1].created_at_epoch:t}catch(O){return O instanceof Error?E.error("DB","Error getting boundary observations",{project:o},O):E.error("DB","Error getting boundary observations with non-Error",{},new Error(String(O))),{observations:[],sessions:[],prompts:[]}}}else{let S=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch <= ? ${_.clause}
        ORDER BY o.created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
        WHERE o.created_at_epoch >= ? ${_.clause}
        ORDER BY o.created_at_epoch ASC
        LIMIT ?
      `;try{let O=this.db.prepare(S).all(t,..._.params,r),M=this.db.prepare(h).all(t,..._.params,n+1);if(O.length===0&&M.length===0)return{observations:[],sessions:[],prompts:[]};l=O.length>0?O[O.length-1].created_at_epoch:t,T=M.length>0?M[M.length-1].created_at_epoch:t}catch(O){return O instanceof Error?E.error("DB","Error getting boundary timestamps",{project:o},O):E.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(O))),{observations:[],sessions:[],prompts:[]}}}let f=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${_.clause}
      ORDER BY o.created_at_epoch ASC
    `,A=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${c.clause}
      ORDER BY ss.created_at_epoch ASC
    `,L=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${p}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${m.clause}
      ORDER BY up.created_at_epoch ASC
    `,g=this.db.prepare(f).all(l,T,..._.params),N=this.db.prepare(A).all(l,T,...c.params),P=this.db.prepare(L).all(l,T,...m.params);return{observations:g,sessions:N.map(S=>({id:S.id,memory_session_id:S.memory_session_id,project:S.project,request:S.request,completed:S.completed,next_steps:S.next_steps,created_at:S.created_at,created_at_epoch:S.created_at_epoch})),prompts:P.map(S=>({id:S.id,content_session_id:S.content_session_id,prompt_number:S.prompt_number,prompt_text:S.prompt_text,project:S.project,platform_source:S.platform_source,created_at:S.created_at,created_at_epoch:S.created_at_epoch}))}}getOrCreateManualSession(e){let t=`manual-${e}`,r=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,r,e,p,o.toISOString(),o.getTime()),E.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=C(e.platform_source),r=this.db.prepare(`SELECT id FROM sdk_sessions
       WHERE platform_source = ? AND content_session_id = ?`).get(t,e.content_session_id);return r?{imported:!1,id:r.id}:{imported:!0,id:this.db.prepare(`
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
    `).run(e.memory_session_id,e.content_session_id??null,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=null,r=e.platform_source?C(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${p}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!r||C(a.platform_source)===r)&&(t=a.id)}t===null&&(t=this.resolvePromptSessionDbId(e.content_session_id,void 0,r));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${t!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(t??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(t,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Ne=require("os"),b=j(require("path"),1),v=require("fs"),ot=require("child_process");var ne=require("fs"),re=j(require("path"),1);var K={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function Ae(s){let e=re.default.join(s,".git"),t;try{t=(0,ne.statSync)(e)}catch(c){return c instanceof Error&&c.code!=="ENOENT"&&E.warn("GIT","Unexpected error checking .git",{error:c instanceof Error?c.message:String(c)}),K}if(!t.isFile())return K;let r;try{r=(0,ne.readFileSync)(e,"utf-8").trim()}catch(c){return E.warn("GIT","Failed to read .git file",{error:c instanceof Error?c.message:String(c)}),K}let n=r.match(/^gitdir:\s*(.+)$/);if(!n)return K;let i=n[1].match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return K;let a=i[1],d=re.default.basename(s),_=re.default.basename(a);return{isWorktree:!0,worktreeName:d,parentRepoPath:a,parentProjectName:_}}var Gs=".claude-mem.json";function it(s){return s==="~"||s.startsWith("~/")?s.replace(/^~/,(0,Ne.homedir)()):s}function Hs(s){let e;try{e=JSON.parse((0,v.readFileSync)(s,"utf-8"))}catch{return null}let t=e.projectName??e.project_name;return typeof t=="string"&&t.trim()!==""?t.trim():null}function at(s){let e=(0,Ne.homedir)(),t=b.default.resolve(s);for(;;){let r=Hs(b.default.join(t,Gs));if(r)return E.info("PROJECT_NAME","Using project name from .claude-mem.json",{configDir:t,projectName:r}),r;let n=b.default.dirname(t);if(t===e||n===t)break;t=n}return null}function dt(s){try{return(0,ot.execFileSync)("git",["rev-parse","--show-toplevel"],{cwd:s,encoding:"utf-8",stdio:["ignore","pipe","ignore"]}).trim()||null}catch(e){let t=e instanceof Error?e:new Error(String(e));return E.debug("PROJECT_NAME","git rev-parse failed, falling back to basename",{dir:s},t),null}}function U(s){try{return(0,v.realpathSync)(s)}catch{return b.default.resolve(s)}}function nt(s){let e=U(s);return process.platform==="win32"?e.toLowerCase():e}function ie(s,e){return nt(s)===nt(e)}function Bs(s,e){let t=b.default.relative(U(e),U(s));return t===""||!!t&&!t.startsWith("..")&&!b.default.isAbsolute(t)}function js(s){let e=b.default.join(s,".git");try{if(!(0,v.statSync)(e).isFile())return!1;let t=(0,v.readFileSync)(e,"utf-8").trim();return/^gitdir:\s*.+[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/i.test(t)}catch{return!1}}function _t(s){let e=U(s);for(;;){if(js(e))return e;let t=b.default.dirname(e);if(t===e)return null;e=t}}function he(s){try{return(0,v.statSync)(b.default.join(s,"package.json")).isFile()}catch{return!1}}function Ws(s,e){let t=U(s),r=U(e);for(;Bs(t,r)&&!ie(t,r);){if(he(t))return t;let n=b.default.dirname(t);if(n===t)break;t=n}return null}function Vs(s){try{let e=JSON.parse((0,v.readFileSync)(b.default.join(s,"package.json"),"utf-8"));return Array.isArray(e.workspaces)?e.workspaces.length>0:Array.isArray(e.workspaces?.packages)&&e.workspaces.packages.length>0}catch{return!1}}function Ks(s){let e=new Set([".git","node_modules",".claude-mem","dist","build"]);try{for(let t of(0,v.readdirSync)(s,{withFileTypes:!0})){if(!t.isDirectory()||e.has(t.name))continue;let r=b.default.join(s,t.name);if(he(r))return!0;try{for(let n of(0,v.readdirSync)(r,{withFileTypes:!0}))if(!(!n.isDirectory()||e.has(n.name))&&he(b.default.join(r,n.name)))return!0}catch{}}}catch{return!1}return!1}function Ys(s){return Vs(s)||Ks(s)}function qs(s,e){let t=b.default.relative(U(e),U(s)),[r]=t.split(b.default.sep).filter(Boolean);return r?b.default.join(e,r):e}function Js(s){return s.split(b.default.sep).filter(Boolean).join("/")}function Qs(s){if(!s||s.trim()==="")return E.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:s}),"unknown-project";let e=it(s),t=at(e);if(t)return t;let r=dt(e),n=_t(e);if(n&&(!r||ie(r,n)))return b.default.basename(n);if(r){if(ie(e,r))return b.default.basename(r);let a=Ws(e,r);if(!a&&!Ys(r))return b.default.basename(r);let d=a??qs(e,r),_=Js(b.default.relative(U(r),U(d)));return`${b.default.basename(r)}/${_}`}let i=b.default.basename(e);if(i===""){if(process.platform==="win32"){let d=s.match(/^([A-Z]):\\/i);if(d){let c=`drive-${d[1].toUpperCase()}`;return E.info("PROJECT_NAME","Drive root detected",{cwd:s,projectName:c}),c}}return E.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:s}),"unknown-project"}return i}function zs(s){return s.endsWith(":dream")?s:`${s}:dream`}function oe(s){return[...s.map(zs),...s]}function Et(s){let e=Qs(s);if(!s)return{primary:e,parent:null,isWorktree:!1,allProjects:oe([e])};let t=it(s);if(at(t))return{primary:e,parent:null,isWorktree:!1,allProjects:oe([e])};let r=dt(t),n=_t(t),o=n&&(!r||ie(r,n))?n:null,i=Ae(t),a=i.isWorktree?i:o?Ae(o):i;if(a.isWorktree&&a.parentProjectName){let d=o?b.default.basename(o):e,_=`${a.parentProjectName}/${d}`;return{primary:_,parent:a.parentProjectName,isWorktree:!0,allProjects:oe([a.parentProjectName,_])}}return{primary:e,parent:null,isWorktree:!1,allProjects:oe([e])}}var y=require("fs"),Y=require("path"),Ce=require("os");var Ie={HEALTH_CHECK:3e3,API_REQUEST:3e4,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function ut(s){return process.platform==="win32"?Math.round(s*Ie.WINDOWS_MULTIPLIER):s}var mt=384;function Le(s){process.platform!=="win32"&&(0,y.chmodSync)(s,mt)}function ct(s,e){(0,y.existsSync)(s)&&Le(s),(0,y.writeFileSync)(s,JSON.stringify(e,null,2),{encoding:"utf-8",mode:mt}),Le(s)}var ae=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_WORKER_AUTOSTART:"true",CLAUDE_MEM_API_TIMEOUT_MS:String(ut(Ie.API_REQUEST)),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_ALLOW_DISMISS:"false",CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS:"false",CLAUDE_MEM_SKIP_AGENT_TYPES:"",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_CLAUDE_MAX_TOKENS:"150000",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_REASONING_EFFORT:"",CLAUDE_MEM_OPENROUTER_EXTRA_BODY:"",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_CODEX_MODEL:"gpt-5.3-codex-spark",CLAUDE_MEM_CODEX_PATH:"codex",CLAUDE_MEM_CODEX_REASONING_EFFORT:"",CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_CODEX_MAX_TOKENS:"100000",CLAUDE_MEM_CODEX_TIMEOUT_MS:"120000",CLAUDE_MEM_KIRO_AGENT:"claude-mem-observer",CLAUDE_MEM_KIRO_MODEL:"claude-haiku-4.5",CLAUDE_MEM_KIRO_CLI_PATH:"",CLAUDE_MEM_DATA_DIR:(0,Y.join)((0,Ce.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_CONTEXT_FETCH_BY_ID_SUPPORTED:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,Y.join)((0,Ce.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"10",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_MERMAID_CONTEXT:"false",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static applyEnvOverrides(e){let t={...e};for(let r of Object.keys(this.DEFAULTS))process.env[r]!==void 0&&(t[r]=process.env[r]);return t}static loadFromFile(e,t=!0){try{if(!(0,y.existsSync)(e)){let a=this.getAllDefaults();try{let d=(0,Y.dirname)(e);(0,y.existsSync)(d)||(0,y.mkdirSync)(d,{recursive:!0}),ct(e,a),x(`[SETTINGS] Created settings file with defaults: ${e}
`)}catch(d){x(`[SETTINGS] Failed to create settings file, using in-memory defaults: ${e} ${d instanceof Error?d.message:String(d)}
`)}return t?this.applyEnvOverrides(a):a}try{Le(e)}catch(a){console.warn("[SETTINGS] Failed to tighten settings file permissions:",e,a instanceof Error?a.message:String(a))}let r=(0,y.readFileSync)(e,"utf-8"),n=JSON.parse(F(r)),o=n;if(n.env&&typeof n.env=="object"){o=n.env;try{ct(e,o),x(`[SETTINGS] Migrated settings file from nested to flat schema: ${e}
`)}catch(a){x(`[SETTINGS] Failed to auto-migrate settings file: ${e} ${a instanceof Error?a.message:String(a)}
`)}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))o[a]!==void 0&&(i[a]=o[a]);return t?this.applyEnvOverrides(i):i}catch(r){x(`[SETTINGS] Failed to load settings, using defaults: ${e} ${r instanceof Error?r.message:String(r)}
`);let n=this.getAllDefaults();return t?this.applyEnvOverrides(n):n}}};var q=require("fs"),de=require("path");var D=class s{static instance=null;activeMode=null;modesDir;constructor(){let e=Xe(),t=[...process.env.CLAUDE_MEM_MODES_DIR?[process.env.CLAUDE_MEM_MODES_DIR]:[],(0,de.join)(e,"modes"),(0,de.join)(e,"..","plugin","modes")],r=t.find(n=>(0,q.existsSync)(n));this.modesDir=r||t[0]}static getInstance(){return s.instance||(s.instance=new s),s.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let r={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?r[n]=this.deepMerge(i,o):r[n]=o}return r}loadModeFile(e){let t=(0,de.join)(this.modesDir,`${e}.json`);if(!(0,q.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let r=(0,q.readFileSync)(t,"utf-8");return JSON.parse(r)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,E.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(_=>_.id),concepts:d.observation_concepts.map(_=>_.id)}),d}catch(d){if(d instanceof Error?E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:d.message}):E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(d)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:r,overrideId:n}=t,o;try{o=this.loadMode(r)}catch(d){d instanceof Error?E.warn("WORKER",`Parent mode '${r}' not found for ${e}, falling back to 'code'`,{message:d.message}):E.warn("WORKER",`Parent mode '${r}' not found for ${e}, falling back to 'code'`,{error:String(d)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),E.debug("SYSTEM",`Loaded override file: ${n} for parent ${r}`)}catch(d){return d instanceof Error?E.warn("WORKER",`Override file '${n}' not found, using parent mode '${r}' only`,{message:d.message}):E.warn("WORKER",`Override file '${n}' not found, using parent mode '${r}' only`,{error:String(d)}),this.activeMode=o,o}if(!i)return E.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${r}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,E.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${r} + ${n})`,void 0,{parent:r,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getTypeIcon(e){return this.getObservationTypes().find(r=>r.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(r=>r.id===e)?.work_emoji||"\u{1F4DD}"}};var Zs=50,er=0,tr=10;function Me(s,e){let t=parseInt(String(s??""),10);return Number.isFinite(t)&&t>=0?t:e}function lt(){let s=W.settings(),e=ae.loadFromFile(s),t=D.getInstance().getActiveMode(),r=new Set(t.observation_types.map(o=>o.id)),n=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:Me(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,Zs),fullObservationCount:Me(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,er),sessionCount:Me(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,tr),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:r,observationConcepts:n,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true",mermaidContext:e.CLAUDE_MEM_MERMAID_CONTEXT==="true",fetchByIdSupported:e.CLAUDE_MEM_CONTEXT_FETCH_BY_ID_SUPPORTED!=="false"}}var u={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},pt=4,J=1;function Tt(s){let e=(s.title?.length||0)+(s.subtitle?.length||0)+(s.narrative?.length||0)+JSON.stringify(s.facts||[]).length;return Math.ceil(e/pt)}function De(s){let e=s.length,t=s.reduce((i,a)=>i+Tt(a),0),r=s.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=r-t,o=r>0?Math.round(n/r*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:r,savings:n,savingsPercent:o}}function sr(s){return D.getInstance().getWorkEmoji(s)}function Q(s,e){let t=Tt(s),r=s.discovery_tokens||0,n=sr(s.type),o=r>0?`${n} ${r.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:r,discoveryDisplay:o,workEmoji:n}}function _e(s){return s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent}var gt=j(require("path"),1),ue=require("fs");var Ee="NOT EXISTS (SELECT 1 FROM observation_feedback f WHERE f.observation_id = o.id AND f.signal_type = 'dismissed')";function w(s){return!!s?.endsWith(":dream")}function rr(s){return w(s)?s.slice(0,-6):s}function nr(s){return Array.from(new Set(s.filter(Boolean)))}function ft(s){return nr(s.map(rr))}function ve(s,e){return!!(s.project&&!w(s.project)&&e.has(s.project)||s.merged_into_project&&e.has(s.merged_into_project))}function St(s,e){let t=new Set(e);return[...s].sort((r,n)=>{let o=w(r.project)&&!ve(r,t),i=w(n.project)&&!ve(n,t);return o!==i?o?-1:1:n.created_at_epoch-r.created_at_epoch})}function or(s,e,t,r){let n=new Set(t),o=s.slice(0,r);return!e||o.length===0||o.some(a=>ve(a,n))||o.findIndex(a=>a.id===e.id)>=0?o:[...o.slice(0,Math.max(0,r-1)),e]}function ir(s,e,t,r,n){if(e.length===0)return null;let o=e.map(()=>"?").join(","),i=t.map(()=>"?").join(","),a=r.map(()=>"?").join(",");return s.db.prepare(`
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
      o.project,
      o.merged_into_project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${o})
           OR o.merged_into_project IN (${o}))
      AND o.project NOT LIKE '%:dream'
      AND (? IS NULL OR s.platform_source = ?)
      AND type IN (${i})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${a})
      )
      AND ${Ee}
    ORDER BY o.created_at_epoch DESC
    LIMIT 1
  `).get(...e,...e,n??null,n??null,...t,...r)??null}function Rt(s,e,t,r){let n=Array.from(t.observationTypes),o=n.map(()=>"?").join(","),i=Array.from(t.observationConcepts),a=i.map(()=>"?").join(","),d=e.map(()=>"?").join(","),_=ft(e),c=e.some(w),m=c?Math.max(t.totalObservationCount*2,t.totalObservationCount+_.length):t.totalObservationCount,l=s.db.prepare(`
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
      o.project,
      o.merged_into_project
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
      AND ${Ee}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,r??null,r??null,...n,...i,m);if(!c)return l;let T=St(l,_),f=ir(s,_,n,i,r);return or(T,f,_,t.totalObservationCount)}function Ot(s,e,t){if(e.length===0)return 0;let r=e.map(()=>"?").join(",");return s.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${r})
       OR o.merged_into_project IN (${r}))
      AND (? IS NULL OR s.platform_source = ?)
      AND ${Ee}
  `).get(...e,...e,t??null,t??null)?.count??0}function bt(s,e,t,r){let n=e.map(()=>"?").join(","),o=ft(e),i=e.some(w),a=i?Math.max((t.sessionCount+J)*2,t.sessionCount+J+o.length):t.sessionCount+J,d=s.db.prepare(`
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
      ss.project,
      ss.merged_into_project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${n})
           OR ss.merged_into_project IN (${n}))
      AND (? IS NULL OR s.platform_source = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,r??null,r??null,a);return i?St(d,o).slice(0,t.sessionCount+J):d}function At(s,e,t){if(e.length===0)return 0;let r=e.map(()=>"?").join(",");return s.db.prepare(`
    SELECT COUNT(*) as count
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${r})
       OR ss.merged_into_project IN (${r}))
      AND (? IS NULL OR s.platform_source = ?)
  `).get(...e,...e,t??null,t??null)?.count??0}function ar(s){return s.replace(/[/.]/g,"-")}function dr(s){if(!s.includes('"type":"assistant"'))return null;let e=JSON.parse(s);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let t="";for(let r of e.message.content)r.type==="text"&&(t+=r.text);if(t=t.replace(qe,"").trim(),t)return t}return null}function _r(s){for(let e=s.length-1;e>=0;e--)try{let t=dr(s[e]);if(t)return t}catch(t){t instanceof Error?E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},t):E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(t)});continue}return""}function Er(s){try{if(!(0,ue.existsSync)(s))return{assistantMessage:""};let e=(0,ue.readFileSync)(s,"utf-8").trim();if(!e)return{assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim());return{assistantMessage:_r(t)}}catch(e){return e instanceof Error?E.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:s},e):E.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:s,error:String(e)}),{assistantMessage:""}}}function ht(s,e,t,r){if(!e.showLastMessage||s.length===0)return{assistantMessage:""};let n=s.find(d=>d.memory_session_id!==t&&!w(d.project));if(!n)return{assistantMessage:""};let o=n.memory_session_id,i=ar(r),a=gt.default.join(Te,"projects",i,`${o}.jsonl`);return Er(a)}function Nt(s,e){let t=e[0]?.id;return s.map((r,n)=>{let o=null;for(let i=n+1;i<e.length;i++)if(e[i].project===r.project){o=e[i];break}return{...r,displayEpoch:o?o.created_at_epoch:r.created_at_epoch,displayTime:o?o.created_at:r.created_at,shouldShowLink:r.id!==t}})}function It(s,e){let t=[...s.map(r=>({type:"observation",data:r})),...e.map(r=>({type:"summary",data:r}))];return t.sort((r,n)=>{let o=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function Ct(s,e){return new Set(s.slice(0,e).map(t=>t.id))}var ye=j(require("path"),1);function G(s){if(!s)return[];try{let e=JSON.parse(s);return Array.isArray(e)?e:[]}catch(e){return E.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:s?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function Ue(s){return new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function xe(s){return new Date(s).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function H(s=new Date){return s.toLocaleDateString("en-CA")}function Mt(s){return new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Lt(s,e){return ye.default.isAbsolute(s)?ye.default.relative(e,s):s}function Dt(s,e,t){let r=G(s);if(r.length>0)return Lt(r[0],e);if(t){let n=G(t);if(n.length>0)return Lt(n[0],e)}return"General"}var ur=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;function B(s,e){let t=String(s);return e.fetchByIdSupported===!1&&ur.test(t)?t.slice(0,8):t}function vt(s){let e=H();return[`# [${s}] recent context, ${e}`,""]}function yt(s=!0){let t=D.getInstance().getActiveMode().observation_types.map(n=>`${n.emoji}${n.id}`).join(" "),r=s?"Fetch details: get_observations([IDs]) | Search: mem-search skill":"Fetch details: mem-search by title/context (short refs are display-only)";return[`Legend: \u{1F3AF}session ${t}`,"Format: ID TIME TYPE TITLE",r,""]}function Ut(s,e){let t=[],r=[`${s.totalObservations} obs (${s.totalReadTokens.toLocaleString()}t read)`,`${s.totalDiscoveryTokens.toLocaleString()}t work`];return s.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?r.push(`${s.savingsPercent}% savings`):e.showSavingsAmount&&r.push(`${s.savings.toLocaleString()}t saved`)),t.push(`Stats: ${r.join(" | ")}`),t.push(""),t}function xt(s){return[`### ${s}`]}function kt(s){return s.toLowerCase().replace(" am","a").replace(" pm","p")}function Pt(s,e,t){let r=s.title||"Untitled",n=D.getInstance().getTypeIcon(s.type),o=e?kt(e):'"';return`${B(s.id,t)} ${o} ${n} ${r}`}function wt(s,e,t,r){let n=[],o=s.title||"Untitled",i=D.getInstance().getTypeIcon(s.type),a=e?kt(e):'"',{readTokens:d,discoveryDisplay:_}=Q(s,r),c=B(s.id,r);n.push(`**${c}** ${a} ${i} **${o}**`),t&&n.push(t);let m=[];return r.showReadTokens&&m.push(`~${d}t`),r.showWorkTokens&&m.push(_),m.length>0&&n.push(m.join(" ")),n.push(""),n}function Ft(s,e){return[`S${s.id} ${s.request||"Session started"} (${e})`]}function z(s,e){return e?[`**${s}**: ${e}`,""]:[]}function $t(s){return s.assistantMessage?["","---","","**Previously**","",`A: ${s.assistantMessage}`,""]:[]}function Xt(s,e,t=!0){return["",`Access ${Math.round(s/1e3)}k tokens of past work via ${t?"get_observations([IDs]) or mem-search skill":"mem-search skill"}.`]}function Gt(s){let e=H();return`# [${s}] recent context, ${e}

No previous sessions found.`}function Ht(s){let e=H();return["",`${u.bright}${u.cyan}[${s}] recent context, ${e}${u.reset}`,`${u.gray}${"\u2500".repeat(60)}${u.reset}`,""]}function Bt(){let e=D.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${u.dim}Legend: session-request | ${e}${u.reset}`,""]}function jt(){return[`${u.bright}Column Key${u.reset}`,`${u.dim}  Read: Tokens to read this observation (cost to learn it now)${u.reset}`,`${u.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${u.reset}`,""]}function Wt(s=!0){let e=s?`${u.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${u.reset}`:`${u.dim}  - Search: observation_search / mem-search skill (by-id fetch is not available in server-beta mode)${u.reset}`;return[`${u.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${u.reset}`,"",`${u.dim}When you need implementation details, rationale, or debugging context:${u.reset}`,e,`${u.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${u.reset}`,`${u.dim}  - Trust this index over re-reading code for past decisions and learnings${u.reset}`,""]}function Vt(s,e){let t=[];if(t.push(`${u.bright}${u.cyan}Context Economics${u.reset}`),t.push(`${u.dim}  Loading: ${s.totalObservations} observations (${s.totalReadTokens.toLocaleString()} tokens to read)${u.reset}`),t.push(`${u.dim}  Work investment: ${s.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${u.reset}`),s.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let r="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?r+=`${s.savings.toLocaleString()} tokens (${s.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?r+=`${s.savings.toLocaleString()} tokens`:r+=`${s.savingsPercent}% reduction from reuse`,t.push(`${u.green}${r}${u.reset}`)}return t.push(""),t}function Kt(s){return[`${u.bright}${u.cyan}${s}${u.reset}`,""]}function Yt(s){return[`${u.dim}${s}${u.reset}`]}function qt(s,e,t,r){let n=s.title||"Untitled",o=D.getInstance().getTypeIcon(s.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=Q(s,r),_=t?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),c=r.showReadTokens&&i>0?`${u.dim}(~${i}t)${u.reset}`:"",m=r.showWorkTokens&&a>0?`${u.dim}(${d} ${a.toLocaleString()}t)${u.reset}`:"";return`  ${u.dim}#${B(s.id,r)}${u.reset}  ${_}  ${o}  ${n} ${c} ${m}`}function Jt(s,e,t,r,n){let o=[],i=s.title||"Untitled",a=D.getInstance().getTypeIcon(s.type),{readTokens:d,discoveryTokens:_,workEmoji:c}=Q(s,n),m=t?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),l=n.showReadTokens&&d>0?`${u.dim}(~${d}t)${u.reset}`:"",T=n.showWorkTokens&&_>0?`${u.dim}(${c} ${_.toLocaleString()}t)${u.reset}`:"";return o.push(`  ${u.dim}#${B(s.id,n)}${u.reset}  ${m}  ${a}  ${u.bright}${i}${u.reset}`),r&&o.push(`    ${u.dim}${r}${u.reset}`),(l||T)&&o.push(`    ${l} ${T}`),o.push(""),o}function Qt(s,e){let t=`${s.request||"Session started"} (${e})`;return[`${u.yellow}#S${s.id}${u.reset} ${t}`,""]}function Z(s,e,t){return e?[`${t}${s}:${u.reset} ${e}`,""]:[]}function zt(s){return s.assistantMessage?["","---","",`${u.bright}${u.magenta}Previously${u.reset}`,"",`${u.dim}A: ${s.assistantMessage}${u.reset}`,""]:[]}function Zt(s,e){let t=Math.round(s/1e3);return["",`${u.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${u.reset}`]}function es(s){let e=H();return`
${u.bright}${u.cyan}[${s}] recent context, ${e}${u.reset}
${u.gray}${"\u2500".repeat(60)}${u.reset}

${u.dim}No previous sessions found for this project yet.${u.reset}
`}function ts(s,e,t,r){let n=[];return r?n.push(...Ht(s)):n.push(...vt(s)),r?n.push(...Bt()):n.push(...yt(t.fetchByIdSupported)),r&&(n.push(...jt()),n.push(...Wt(t.fetchByIdSupported))),_e(t)&&(r?n.push(...Vt(e,t)):n.push(...Ut(e,t))),n}function cr(s){let e=new Map;for(let r of s){let n=r.type==="observation"?r.data.created_at:r.data.displayTime,o=Mt(n);e.has(o)||e.set(o,[]),e.get(o).push(r)}let t=Array.from(e.entries()).sort((r,n)=>{let o=new Date(r[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function ss(s,e){return e.fullObservationField==="narrative"?s.narrative:s.facts?G(s.facts).join(`
`):null}function mr(s,e,t,r){let n=[];n.push(...xt(s));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=Ue(a.displayTime);n.push(...Ft(a,d))}else{let a=i.data,d=xe(a.created_at),c=d!==o?d:"";if(o=d,t.has(a.id)){let l=ss(a,r);n.push(...wt(a,c,l,r))}else n.push(Pt(a,c,r))}return n}function lr(s,e,t,r,n){let o=[];o.push(...Kt(s));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let _=d.data,c=Ue(_.displayTime);o.push(...Qt(_,c))}else{let _=d.data,c=Dt(_.files_modified,n,_.files_read),m=xe(_.created_at),l=m!==a;a=m;let T=t.has(_.id);if(c!==i&&(o.push(...Yt(c)),i=c),T){let f=ss(_,r);o.push(...Jt(_,m,l,f,r))}else o.push(qt(_,m,l,r))}return o.push(""),o}function pr(s,e,t,r,n,o){return o?lr(s,e,t,r,n):mr(s,e,t,r)}function rs(s,e,t,r,n){let o=[],i=cr(s);for(let[a,d]of i)o.push(...pr(a,d,e,t,r,n));return o}function ns(s,e,t){return!(!s.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function os(s,e){let t=[];return e?(t.push(...Z("Investigated",s.investigated,u.blue)),t.push(...Z("Learned",s.learned,u.yellow)),t.push(...Z("Completed",s.completed,u.green)),t.push(...Z("Next Steps",s.next_steps,u.magenta))):(t.push(...z("Investigated",s.investigated)),t.push(...z("Learned",s.learned)),t.push(...z("Completed",s.completed)),t.push(...z("Next Steps",s.next_steps))),t}function is(s,e){return e?zt(s):$t(s)}function as(s,e,t){return!_e(e)||s.totalDiscoveryTokens<=0||s.savings<=0?[]:t?Zt(s.totalDiscoveryTokens,s.totalReadTokens):Xt(s.totalDiscoveryTokens,s.totalReadTokens,e.fetchByIdSupported)}var Tr={bugfix:{fill:"#fed7d7",color:"#1a202c",emoji:"\u{1F534}"},feature:{fill:"#e9d8fd",color:"#1a202c",emoji:"\u{1F7E3}"},refactor:{fill:"#fef9c3",color:"#1a202c",emoji:"\u{1F504}"},change:{fill:"#dcfce7",color:"#1a202c",emoji:"\u2705"},discovery:{fill:"#dbeafe",color:"#1a202c",emoji:"\u{1F535}"},decision:{fill:"#ffedd5",color:"#1a202c",emoji:"\u2696\uFE0F"}},gr={fill:"#f1f5f9",color:"#1a202c",emoji:"\u{1F4CC}"};function ds(s){return s.replace(/"/g,"'").replace(/\n/g," ").replace(/[<>{}|[\]]/g," ").trim().slice(0,60)}function fr(s){if(!s)return"";try{let e=G(s);return e.length===0?"":e[0].split("/").slice(-2).join("/")}catch{return""}}function Sr(s,e){let t=Tr[s.type]??gr,r=`N${e}`,n=ds(s.title??s.subtitle??s.type),o=fr(s.files_modified??s.files_read),i=o?`${t.emoji} ${n} \xB7 ${o}`:`${t.emoji} ${n}`;return{id:r,line:`    ${r}["${i}"]`,style:`    style ${r} fill:${t.fill},color:${t.color}`}}function _s(s,e){if(s.length===0)return[];let t=s[0].memory_session_id,r=s.filter(a=>a.memory_session_id===t).reverse();if(r.length===0)return[];let n=e?.memory_session_id===t?e:void 0,o=r.map((a,d)=>Sr(a,d)),i=[];i.push("## Task Flow (Last Session)"),i.push(""),i.push("```mermaid"),i.push("graph LR");for(let a of o)i.push(a.line);for(let a=0;a<o.length-1;a++)i.push(`    ${o[a].id} --> ${o[a+1].id}`);if(n?.next_steps&&n.next_steps.trim()){let a=ds(n.next_steps);i.push(`    NEXT(["Next: ${a}"])`),i.push(`    ${o[o.length-1].id} --> NEXT`),i.push("    style NEXT fill:#bee3f8,color:#1a202c")}for(let a of o)i.push(a.style);return i.push("```"),i.push(""),i}var Rr=Es.default.join((0,us.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Or(){try{return new se}catch(s){if(s instanceof Error&&s.code==="ERR_DLOPEN_FAILED"){try{(0,cs.unlinkSync)(Rr)}catch(e){e instanceof Error?E.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):E.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return E.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw s}}function br(s,e){return e?es(s):Gt(s)}function le(s){return s.endsWith(":dream")}function ms(s){return le(s)?s.slice(0,-6):s}function Ar(s,e){let t=[...s].reverse().find(r=>!le(r))??e;return ms(t)}function hr(s,e,t,r,n,o,i){let a=[],d=De(e),_=t[0];a.push(...ts(s,d,r,i)),r.mermaidContext&&!i&&a.push(..._s(e,_));let c=t.slice(0,r.sessionCount),m=Nt(c,t),l=It(e,m),T=Ct(e,r.fullObservationCount);a.push(...rs(l,T,r,n,i));let f=e[0];ns(r,_,f)&&a.push(...os(_,i));let A=ht(e,r,o,n);return a.push(...is(A,i)),a.push(...as(d,r,i)),a.join(`
`).trimEnd()}var Nr=new Set(["bugfix","discovery","decision","refactor"]);function Ir(s,e,t){let r=De(s),n={bugfix:0,discovery:0,decision:0,refactor:0,other:0},o=new Set,i=Number.POSITIVE_INFINITY;for(let d of s){let _=Nr.has(d.type)?d.type:"other";n[_]++,d.memory_session_id&&o.add(d.memory_session_id),d.created_at_epoch&&d.created_at_epoch<i&&(i=d.created_at_epoch)}let a=Number.isFinite(i)?Math.max(0,Math.floor((Date.now()-i)/864e5)):0;return{observation_count:s.length,session_count:o.size,timeline_depth_days:a,has_session_summary:e.length>0,obs_type_bugfix:n.bugfix,obs_type_discovery:n.discovery,obs_type_decision:n.decision,obs_type_refactor:n.refactor,obs_type_other:n.other,tokens_injected:r.totalReadTokens,tokens_saved_vs_naive:r.savings,search_strategy:t?"full":"timeline"}}async function ke(s,e=!1){let t=lt(),r=s?.cwd??process.cwd(),n=Et(r),o=s?.projects?.length?s.projects:n.allProjects,i=Ar(o,n.primary);s?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let a=Or();if(!a)return{text:"",stats:null};try{let d=s?.platformSource?C(s.platformSource):void 0,_=o.filter(le),c=o.filter(L=>!le(L)).map(ms),l=_.length>0&&(Ot(a,_,d)>0||At(a,_,d)>0)||c.length===0?o:c,T=Rt(a,l,t,d),f=bt(a,l,t,d);return T.length===0&&f.length===0?{text:br(i,e),stats:null}:{text:hr(i,T,f,t,r,s?.session_id,e),stats:Ir(T,f,!!s?.full)}}finally{a.close()}}async function ls(s,e=!1){return(await ke(s,e)).text}0&&(module.exports={generateContext,generateContextWithStats});
