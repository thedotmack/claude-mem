"use strict";var js=Object.create;var V=Object.defineProperty;var Ws=Object.getOwnPropertyDescriptor;var Vs=Object.getOwnPropertyNames;var Ks=Object.getPrototypeOf,Ys=Object.prototype.hasOwnProperty;var qs=(n,e)=>{for(var s in e)V(n,s,{get:e[s],enumerable:!0})},Oe=(n,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Vs(e))!Ys.call(n,r)&&r!==s&&V(n,r,{get:()=>e[r],enumerable:!(t=Ws(e,r))||t.enumerable});return n};var F=(n,e,s)=>(s=n!=null?js(Ks(n)):{},Oe(e||!n||!n.__esModule?V(s,"default",{value:n,enumerable:!0}):s,n)),Js=n=>Oe(V({},"__esModule",{value:!0}),n);var Mt={};qs(Mt,{generateContext:()=>Bs,generateContextWithStats:()=>be});module.exports=Js(Mt);var Gs=F(require("path"),1),Hs=require("os"),Xs=require("fs");var me=require("bun:sqlite");var R=require("path"),ne=require("os"),P=require("fs"),he=require("url"),tt={};function Qs(){return typeof __dirname<"u"?__dirname:(0,R.dirname)((0,he.fileURLToPath)(tt.url))}var zs=Qs();function Zs(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let n=(0,R.join)((0,ne.homedir)(),".claude-mem"),e=(0,R.join)(n,"settings.json");try{if((0,P.existsSync)(e)){let s=JSON.parse((0,P.readFileSync)(e,"utf-8")),t=s.env??s;if(t.CLAUDE_MEM_DATA_DIR)return t.CLAUDE_MEM_DATA_DIR}}catch{}return n}var C=Zs(),oe=process.env.CLAUDE_CONFIG_DIR||(0,R.join)((0,ne.homedir)(),".claude"),Ut=(0,R.join)(oe,"plugins","marketplaces","thedotmack"),et=(0,R.join)(C,"logs"),xt=(0,R.join)(C,"settings.json"),Ne=(0,R.join)(C,"claude-mem.db"),st=(0,R.join)(C,"observer-sessions"),ie=(0,R.basename)(st);function Ie(n){(0,P.mkdirSync)(n,{recursive:!0})}function Ae(){return(0,R.join)(zs,"..")}var $={dataDir:()=>C,workerPid:()=>(0,R.join)(C,"worker.pid"),serverPid:()=>(0,R.join)(C,".server-beta.pid"),serverPort:()=>(0,R.join)(C,".server-beta.port"),serverRuntime:()=>(0,R.join)(C,".server-beta.runtime.json"),settings:()=>(0,R.join)(C,"settings.json"),database:()=>(0,R.join)(C,"claude-mem.db"),chroma:()=>(0,R.join)(C,"chroma"),combinedCerts:()=>(0,R.join)(C,"combined_certs.pem"),transcriptsConfig:()=>(0,R.join)(C,"transcript-watch.json"),transcriptsState:()=>(0,R.join)(C,"transcript-watch-state.json"),corpora:()=>(0,R.join)(C,"corpora"),supervisorRegistry:()=>(0,R.join)(C,"supervisor.json"),envFile:()=>(0,R.join)(C,".env"),logsDir:()=>et};var U=require("fs"),Ce=require("path");var rt=null;function nt(n){return(rt??process.stderr.write.bind(process.stderr))(n)}function ae(n){nt(n)}var _e=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(_e||{}),de=null,Ee=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=$.logsDir();(0,U.existsSync)(e)||(0,U.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,Ce.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=$.settings();if((0,U.existsSync)(e)){let s=(0,U.readFileSync)(e,"utf-8"),r=(JSON.parse(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=_e[r]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),d=String(e.getSeconds()).padStart(2,"0"),a=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${r} ${o}:${i}:${d}.${a}`}log(e,s,t,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),d=_e[e].padEnd(5),a=s.padEnd(6),_="";r?.correlationId?_=`[${r.correlationId}] `:r?.sessionId&&(_=`[session-${r.sessionId}] `);let m="";if(o!=null)if(o instanceof Error)m=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{m=`
`+JSON.stringify(o,null,2)}catch{m=" "+this.formatData(o)}else m=" "+this.formatData(o);let l="";if(r){let{sessionId:T,memorySessionId:N,correlationId:h,...S}=r;Object.keys(S).length>0&&(l=` {${Object.entries(S).map(([D,x])=>`${D}=${x}`).join(", ")}}`)}let p=`[${i}] [${d}] [${a}] ${_}${t}${l}${m}`;if(this.logFilePath)try{(0,U.appendFileSync)(this.logFilePath,p+`
`,"utf8")}catch(T){let N=T instanceof Error?T:new Error(String(T));ae(`[LOGGER] Failed to write to log file: ${N.message}
${N.stack??""}
`)}else ae(p+`
`)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}setErrorSink(e){de=e}error(e,s,t,r){this.log(3,e,s,t,r),this.routeErrorToSink(s,t,r)}routeErrorToSink(e,s,t){try{if(!de||!(t instanceof Error))return;de(t)}catch{}}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}},E=new Ee;var Le=require("crypto");function De(n,e,s){return(0,Le.createHash)("sha256").update([n||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}var c="claude";function ot(n){return n.trim().toLowerCase().replace(/\s+/g,"-")}function L(n){if(!n)return c;let e=ot(n);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:c}function Me(n){let e=["claude","codex","cursor"];return[...n].sort((s,t)=>{let r=e.indexOf(s),o=e.indexOf(t);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:s.localeCompare(t)})}function ve(n,e,s,t,r){let o=Date.now()-t,i=r!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",d=r??e;return n.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${c}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${i}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(d,s,o)??void 0}var xe=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],ye=new RegExp(`<(${xe.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),ke=/<system-reminder>[\s\S]*?<\/system-reminder>/g,Ue=100;function it(n){let e=Object.fromEntries(xe.map(r=>[r,0]));ye.lastIndex=0;let s=0,t=n.replace(ye,(r,o)=>(e[o]=(e[o]??0)+1,s+=1,""));return s>Ue&&E.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:Ue,contentLength:n.length}),{stripped:t.trim(),counts:e}}function we(n){return it(n).stripped}var at=["task-notification"],Wt=new RegExp(`^\\s*<(${at.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Vt=256*1024;var ue=4e3;function K(n){let e=n.trim(),t=we(n).trim()||e;return t.length<=ue?t:(E.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:t.length,storedLength:ue}),`${t.slice(0,ue-1)}\u2026`)}var dt=5e3,Y=class{db;constructor(e=Ne){e instanceof me.Database?this.db=e:(e!==":memory:"&&Ie(C),this.db=new me.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.db.run("PRAGMA journal_size_limit = 4194304")),this.db.run(`PRAGMA busy_timeout = ${dt}`),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(s=>s.name)}hasUniqueIndexOnColumns(e,s){return this.db.query(`PRAGMA index_list(${e})`).all().some(r=>{if(r.unique!==1)return!1;let o=this.getIndexColumns(r.name);return o.length===s.length&&o.every((i,d)=>i===s[d])})}resolvePromptSessionDbId(e,s,t){if(s!==void 0)return s;let r=t?L(t):void 0;return r?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(c,r,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${c}')
        WHEN '${c}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),t=this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="worker_pid");if(!(e&&!t)){if(t)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),E.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(r){E.warn("DB","Failed to drop worker_pid column from pending_messages",{},r instanceof Error?r:new Error(String(r)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),s=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),t=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!s&&t&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${c}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${c}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),s){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let d=i instanceof Error?i:new Error(String(i));throw E.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},d),i}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
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
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let r=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&r&&!i)return;let d=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,a=r?`COALESCE(up.session_db_id, (
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
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,a,d),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let m=_ instanceof Error?_:new Error(String(_));throw E.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},m),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,s,t){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let t=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&t)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw E.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),r}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString())}dropDeadPendingMessagesColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(31),s=this.db.query("PRAGMA table_info(pending_messages)").all(),t=new Set(s.map(i=>i.name)),o=["retry_count","failed_at_epoch","completed_at_epoch"].filter(i=>t.has(i));if(!(e&&o.length===0)){if(o.length>0){this.db.run("BEGIN TRANSACTION");try{this.db.run("DELETE FROM pending_messages WHERE status NOT IN ('pending', 'processing')");for(let i of o)this.db.run(`ALTER TABLE pending_messages DROP COLUMN ${i}`),E.debug("DB",`Dropped dead column ${i} from pending_messages`);e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString()),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK"),E.warn("DB","Failed to drop dead columns from pending_messages",{},i instanceof Error?i:new Error(String(i)));return}return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(31,new Date().toISOString())}}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),E.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(d=>d.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),E.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(d=>d.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(d=>d.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(t=>t.unique===1&&t.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}E.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),E.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}E.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),E.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}E.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `);let t=`
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
    `;try{this.db.run(t),this.db.run(r)}catch(o){o instanceof Error?E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}E.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),E.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;E.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(r,o,i)=>{let d=this.db.query(`PRAGMA table_info(${r})`).all(),a=d.some(m=>m.name===o);return d.some(m=>m.name===i)?!1:a?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),E.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(E.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?E.debug("DB",`Successfully renamed ${s} session ID columns`):E.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),E.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;E.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(f=>f.name==="metadata"),r=s.some(f=>f.name==="content_hash"),o=t?`,
        metadata TEXT`:"",i=t?", metadata":"",d=r?`,
        content_hash TEXT`:"",a=r?", content_hash":"",_=`
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
        created_at_epoch INTEGER NOT NULL${o}${d},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,m=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${i}${a}
      FROM observations
    `,l=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,p=`
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
    `,N=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,h=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,S=`
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
    `;try{this.recreateObservationsWithCascade(_,m,l,p),this.recreateSessionSummariesWithCascade(T,N,h,S),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),E.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(f){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),f instanceof Error?f:new Error(String(f))}}recreateObservationsWithCascade(e,s,t,r){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(r)}recreateSessionSummariesWithCascade(e,s,t,r){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(r)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),E.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),E.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&r||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${c}'`),E.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${c}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(r=>r.name==="generated_by_model"),t=e.some(r=>r.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(i=>i.name==="agent_type"),r=s.some(i=>i.name==="agent_id");t||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),r||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(a=>a.name==="agent_type"),d=o.some(a=>a.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),d||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(r){this.db.run("ROLLBACK");let o=r instanceof Error?r:new Error(String(r));throw E.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),r}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(o=>o.name==="memory_session_id"),r=s.some(o=>o.name==="content_hash");if(!t||!r){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw E.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString())}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),E.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(s,e)}markSessionCompleted(e){let s=Date.now(),t=new Date(s).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t,s,e)}ensureMemorySessionIdRegistered(e,s,t){let r=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!r)throw new Error(`Session ${e} not found in sdk_sessions`);r.memory_session_id!==s&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),E.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:r.memory_session_id,newId:s})),typeof t=="number"&&r.worker_port!==t&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(t,e)}getAllProjects(e){let s=e?L(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,r=[ie];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",r.push(c,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${c}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${c}'), project
      ORDER BY latest_epoch DESC
    `).all(ie),s=[],t=new Set,r={};for(let i of e){let d=L(i.platform_source);r[d]||(r[d]=[]),r[d].includes(i.project)||r[d].push(i.project),t.has(i.project)||(t.add(i.project),s.push(i.project))}let o=Me(Object.keys(r));return{projects:s,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getLatestUserPrompt(e,s){let t=this.resolvePromptSessionDbId(e,s),r=t!==null?"up.session_db_id = ?":"up.content_session_id = ?",o=t!==null?t:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${c}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${r}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(o)}findRecentDuplicateUserPrompt(e,s,t,r){return ve(this.db,e,K(s),t,this.resolvePromptSessionDbId(e,r)??void 0)}getRecentSessionsWithStatus(e,s=3,t){let r=[e],o="";return t&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`,r.push(L(t))),r.push(s),this.db.prepare(`
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
    `).all(...r)}getObservationsForSession(e,s){let t=[e],r="";return s&&(r=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?
        )
      `,t.push(L(s))),this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ${r}
      ORDER BY created_at_epoch ASC
    `).all(...t)}getObservationById(e,s){return s?this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.id = ?
        AND COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?
    `).get(e,L(s))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:o,platformSource:i,type:d,concepts:a,files:_}=s,m=t==="relevance",l=m?"":`ORDER BY o.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,p=r&&!m?`LIMIT ${r}`:"",T=e.map(()=>"?").join(","),N=[...e],h=[];if(o&&(h.push("o.project = ?"),N.push(o)),i&&(h.push(`COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`),N.push(L(i))),d)if(Array.isArray(d)){let A=d.map(()=>"?").join(",");h.push(`o.type IN (${A})`),N.push(...d)}else h.push("o.type = ?"),N.push(d);if(a){let A=Array.isArray(a)?a:[a],O=A.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");N.push(...A),h.push(`(${O.join(" OR ")})`)}if(_){let A=Array.isArray(_)?_:[_],O=A.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");A.forEach(M=>{N.push(`%${M}%`,`%${M}%`)}),h.push(`(${O.join(" OR ")})`)}let S=h.length>0?`WHERE o.id IN (${T}) AND ${h.join(" AND ")}`:`WHERE o.id IN (${T})`,D=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${S}
      ${l}
      ${p}
    `).all(...N);if(!m)return D;let x=new Map(D.map(A=>[A.id,A])),b=e.map(A=>x.get(A)).filter(A=>!!A);return r?b.slice(0,r):b}getSummaryForSession(e,s){let t=[e],r="";return s&&(r=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${c}') = ?
        )
      `,t.push(L(s))),this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ${r}
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(...t)||null}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${c}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).get(e).count}createSDKSession(e,s,t,r,o){let i=new Date,d=i.getTime(),a=o?L(o):c,_=K(t),m=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(c,a,e);if(m)return s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(s,m.id),r&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE id = ? AND custom_title IS NULL
        `).run(r,m.id),m.id;let l=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,a,_,r||null,i.toISOString(),d);return Number(l.lastInsertRowid)}saveUserPrompt(e,s,t,r){let o=new Date,i=o.getTime(),d=K(t),a=this.resolvePromptSessionDbId(e,r);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(a,e,s,d,o.toISOString(),i).lastInsertRowid}getUserPrompt(e,s,t){let r=this.resolvePromptSessionDbId(e,t);return r!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(r,s)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,o=0,i,d){let a=this.storeObservations(e,s,[t],null,r,o,i,d);return{id:a.observationIds[0],createdAtEpoch:a.createdAtEpoch}}storeSummary(e,s,t,r,o=0,i){let d=i??Date.now(),a=new Date(d).toISOString(),m=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,o,a,d);return{id:Number(m.lastInsertRowid),createdAtEpoch:d}}storeObservations(e,s,t,r,o,i=0,d,a){let _=d??Date.now(),m=new Date(_).toISOString();return this.db.transaction(()=>{let p=[],T=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),N=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let S of t){let f=De(e,S.title,S.narrative),D=T.get(e,s,S.type,S.title,S.subtitle,JSON.stringify(S.facts),S.narrative,JSON.stringify(S.concepts),JSON.stringify(S.files_read),JSON.stringify(S.files_modified),o||null,i,S.agent_type??null,S.agent_id??null,f,m,_,a||null,S.metadata??null);if(D){p.push(D.id);continue}let x=N.get(e,f);if(!x)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${f}`);p.push(x.id)}let h=null;if(r){let f=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,o||null,i,m,_);h=Number(f.lastInsertRowid)}return{observationIds:p,summaryId:h,createdAtEpoch:_}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:o,platformSource:i}=s,d=t==="relevance",a=d?"":`ORDER BY ss.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,_=r&&!d?`LIMIT ${r}`:"",m=e.map(()=>"?").join(","),l=[...e],p=[];o&&(p.push("ss.project = ?"),l.push(o)),i&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`),l.push(L(i)));let T=p.length>0?`AND ${p.join(" AND ")}`:"",h=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${m}) ${T}
      ${a}
      ${_}
    `).all(...l);if(!d)return h;let S=new Map(h.map(D=>[D.id,D])),f=e.map(D=>S.get(D)).filter(D=>!!D);return r?f.slice(0,r):f}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:o,platformSource:i}=s,d=t==="relevance",a=d?"":`ORDER BY up.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,_=r?`LIMIT ${r}`:"",m=e.map(()=>"?").join(","),l=[...e],p=[];o&&(p.push("s.project = ?"),l.push(o)),i&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${c}') = ?`),l.push(L(i)));let T=p.length>0?`AND ${p.join(" AND ")}`:"",h=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${c}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${m}) ${T}
      ${a}
      ${_}
    `).all(...l);if(!d)return h;let S=new Map(h.map(f=>[f.id,f]));return e.map(f=>S.get(f)).filter(f=>!!f)}getTimelineAroundTimestamp(e,s=10,t=10,r,o){return this.getTimelineAroundObservation(null,e,s,t,r,o)}getTimelineAroundObservation(e,s,t=10,r=10,o,i){let d=i?L(i):void 0,a=(b,A)=>{let O=[],M=[];return o&&(O.push(`${b}.project = ?`),M.push(o)),d&&(O.push(`COALESCE(NULLIF(${A}.platform_source, ''), '${c}') = ?`),M.push(d)),{clause:O.length>0?`AND ${O.join(" AND ")}`:"",params:M}},_=a("o","src"),m=a("ss","src"),l=a("s","s"),p,T;if(e!==null){let b=`
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
      `;try{let O=this.db.prepare(b).all(e,..._.params,t+1),M=this.db.prepare(A).all(e,..._.params,r+1);if(O.length===0&&M.length===0)return{observations:[],sessions:[],prompts:[]};p=O.length>0?O[O.length-1].created_at_epoch:s,T=M.length>0?M[M.length-1].created_at_epoch:s}catch(O){return O instanceof Error?E.error("DB","Error getting boundary observations",{project:o},O):E.error("DB","Error getting boundary observations with non-Error",{},new Error(String(O))),{observations:[],sessions:[],prompts:[]}}}else{let b=`
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
      `;try{let O=this.db.prepare(b).all(s,..._.params,t),M=this.db.prepare(A).all(s,..._.params,r+1);if(O.length===0&&M.length===0)return{observations:[],sessions:[],prompts:[]};p=O.length>0?O[O.length-1].created_at_epoch:s,T=M.length>0?M[M.length-1].created_at_epoch:s}catch(O){return O instanceof Error?E.error("DB","Error getting boundary timestamps",{project:o},O):E.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(O))),{observations:[],sessions:[],prompts:[]}}}let N=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${_.clause}
      ORDER BY o.created_at_epoch ASC
    `,h=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${m.clause}
      ORDER BY ss.created_at_epoch ASC
    `,S=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${c}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${l.clause}
      ORDER BY up.created_at_epoch ASC
    `,f=this.db.prepare(N).all(p,T,..._.params),D=this.db.prepare(h).all(p,T,...m.params),x=this.db.prepare(S).all(p,T,...l.params);return{observations:f,sessions:D.map(b=>({id:b.id,memory_session_id:b.memory_session_id,project:b.project,request:b.request,completed:b.completed,next_steps:b.next_steps,created_at:b.created_at,created_at_epoch:b.created_at_epoch})),prompts:x.map(b=>({id:b.id,content_session_id:b.content_session_id,prompt_number:b.prompt_number,prompt_text:b.prompt_text,project:b.project,platform_source:b.platform_source,created_at:b.created_at,created_at_epoch:b.created_at_epoch}))}}getOrCreateManualSession(e){let s=`manual-${e}`,t=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return s;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,t,e,c,o.toISOString(),o.getTime()),E.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}close(){this.db.close()}importSdkSession(e){let s=L(e.platform_source),t=this.db.prepare(`SELECT id FROM sdk_sessions
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
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=null,t=e.platform_source?L(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let d=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${c}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);d&&d.content_session_id===e.content_session_id&&(!t||L(d.platform_source)===t)&&(s=d.id)}s===null&&(s=this.resolvePromptSessionDbId(e.content_session_id,void 0,t));let r=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${s!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(s??e.content_session_id,e.prompt_number);return r?{imported:!1,id:r.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(s,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var $e=require("os"),I=F(require("path"),1),Ge=require("child_process"),J=require("fs");var q=require("fs"),k=F(require("path"),1);var G={isWorktree:!1,isSubmodule:!1,kind:null,worktreeName:null,parentRepoPath:null,parentProjectName:null};function Pe(n){let e=k.default.join(n,".git"),s;try{s=(0,q.statSync)(e)}catch(a){return a instanceof Error&&a.code!=="ENOENT"&&E.warn("GIT","Unexpected error checking .git",{error:a instanceof Error?a.message:String(a)}),G}if(!s.isFile())return G;let t;try{t=(0,q.readFileSync)(e,"utf-8").trim()}catch(a){return E.warn("GIT","Failed to read .git file",{error:a instanceof Error?a.message:String(a)}),G}let r=t.match(/^gitdir:\s*(.+)$/);if(!r)return G;let o=k.default.resolve(k.default.dirname(e),r[1]),i=o.match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(i){let a=i[1],_=k.default.basename(n),m=k.default.basename(a);return{isWorktree:!0,isSubmodule:!1,kind:"worktree",worktreeName:_,parentRepoPath:a,parentProjectName:m}}let d=o.match(/^(.+)[/\\]\.git[/\\]modules[/\\].+$/);if(d){let a=d[1];return{isWorktree:!1,isSubmodule:!0,kind:"submodule",worktreeName:k.default.basename(n),parentRepoPath:a,parentProjectName:k.default.basename(a)}}return G}var _t=["package.json","pyproject.toml","Cargo.toml","go.mod","deno.json","deno.jsonc","composer.json","Gemfile","mix.exs"];function He(n){return n==="~"||n.startsWith("~/")?n.replace(/^~/,(0,$e.homedir)()):n}function Xe(n){try{return(0,Ge.execFileSync)("git",["rev-parse","--show-toplevel"],{cwd:n,encoding:"utf-8",stdio:["ignore","pipe","ignore"]}).trim()||null}catch(e){let s=e instanceof Error?e:new Error(String(e));return E.debug("PROJECT_NAME","git rev-parse failed, falling back to basename",{dir:n},s),null}}function ce(n,e){let s=I.default.relative(I.default.resolve(e),I.default.resolve(n));return s===""||!s.startsWith("..")&&!I.default.isAbsolute(s)}function Et(n,e){let s=I.default.resolve(n),t=I.default.resolve(e);for(;ce(s,t)&&s!==t;){if(_t.some(o=>(0,J.existsSync)(I.default.join(s,o))))return s;let r=I.default.dirname(s);if(r===s)break;s=r}return null}function ut(n,e){let s=I.default.resolve(n),t=I.default.resolve(e),r=I.default.basename(s);if(!r||!ce(t,s))return r;let o=I.default.relative(s,t);if(o==="")return r;let i=Et(t,s),d=o.split(I.default.sep).filter(Boolean)[0],a=i??(d?I.default.join(s,d):s),_=I.default.relative(s,a).split(I.default.sep).join("/");return _?`${r}/${_}`:r}function mt(n){let e=I.default.resolve(n);for(;;){let s=I.default.join(e,".git");try{if((0,J.statSync)(s).isFile())return e}catch{}let t=I.default.dirname(e);if(t===e)return null;e=t}}function Fe(n){if(!n||n.trim()==="")return E.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:n}),"unknown-project";let e=He(n),s=Xe(e);if(s)return ut(s,e);let t=I.default.basename(e);if(t===""){if(process.platform==="win32"){let o=n.match(/^([A-Z]):\\/i);if(o){let d=`drive-${o[1].toUpperCase()}`;return E.info("PROJECT_NAME","Drive root detected",{cwd:n,projectName:d}),d}}return E.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:n}),"unknown-project"}return t}function Be(n){if(!n){let d=Fe(n);return{primary:d,parent:null,isWorktree:!1,allProjects:[d]}}let e=He(n),s=Xe(e),t=mt(e),r=t&&(!s||ce(t,s))?t:null,o=Pe(r??s??e);if(o.isWorktree&&o.parentProjectName){let d=o.worktreeName??I.default.basename(r??e),a=`${o.parentProjectName}/${d}`;return{primary:a,parent:o.parentProjectName,isWorktree:!0,allProjects:[o.parentProjectName,a]}}if(o.isSubmodule&&o.parentProjectName)return{primary:o.parentProjectName,parent:null,isWorktree:!1,allProjects:[o.parentProjectName]};let i=Fe(n);return{primary:i,parent:null,isWorktree:!1,allProjects:[i]}}var w=require("fs"),H=require("path"),Te=require("os");var pe={HEALTH_CHECK:3e3,API_REQUEST:3e4,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function je(n){return process.platform==="win32"?Math.round(n*pe.WINDOWS_MULTIPLIER):n}var g=require("fs"),We=require("crypto"),y=require("path"),ct=process.platform==="win32";function pt(n){return n.replace(/^\uFEFF/,"")}function Ve(n){return JSON.parse(pt(n))}function le(n,e){let s=n;try{if((0,g.lstatSync)(n).isSymbolicLink())try{s=(0,g.realpathSync)(n)}catch{let _=(0,g.readlinkSync)(n);s=(0,y.resolve)((0,y.dirname)(n),_)}}catch(_){let m=_.code;if(m!=="ENOENT"&&m!=="ENOTDIR")throw _}(0,g.mkdirSync)((0,y.dirname)(s),{recursive:!0});let t=(0,y.dirname)(s),r=(0,y.basename)(s),o=(0,y.join)(t,`.${r}.${process.pid}.${(0,We.randomBytes)(6).toString("hex")}.tmp`),i=Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),d;try{d=(0,g.statSync)(s).mode&511}catch{}let a;try{a=d!==void 0?(0,g.openSync)(o,"w",d):(0,g.openSync)(o,"w");let _=0;for(;_<i.length;){let m=(0,g.writeSync)(a,i,_,i.length-_);if(m===0)throw new Error(`writeSync stalled at ${_}/${i.length} bytes`);_+=m}if((0,g.fsyncSync)(a),(0,g.closeSync)(a),a=void 0,(0,g.renameSync)(o,s),!ct){let m;try{m=(0,g.openSync)(t,"r"),(0,g.fsyncSync)(m)}catch{}finally{if(m!==void 0)try{(0,g.closeSync)(m)}catch{}}}}catch(_){if(a!==void 0)try{(0,g.closeSync)(a)}catch{}try{(0,g.unlinkSync)(o)}catch{}throw _}}var Q=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_API_TIMEOUT_MS:String(je(pe.API_REQUEST)),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_DATA_DIR:(0,H.join)((0,Te.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,H.join)((0,Te.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static applyEnvOverrides(e){let s={...e};for(let t of Object.keys(this.DEFAULTS))process.env[t]!==void 0&&(s[t]=process.env[t]);return s}static loadFromFile(e,s=!0){try{if(!(0,w.existsSync)(e)){let a=this.getAllDefaults();try{let _=(0,H.dirname)(e);(0,w.existsSync)(_)||(0,w.mkdirSync)(_,{recursive:!0}),le(e,a),console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(_){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,_ instanceof Error?_.message:String(_))}return s?this.applyEnvOverrides(a):a}let t=(0,w.readFileSync)(e,"utf-8"),r=Ve(t);if(!r||typeof r!="object"||Array.isArray(r))throw new Error("settings.json must contain a JSON object");let o=r,i=o;if(o.env&&typeof o.env=="object"&&!Array.isArray(o.env)){i=o.env;try{le(e,i),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(a){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,a instanceof Error?a.message:String(a))}}let d={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS)){let _=i[a];typeof _=="string"&&(d[a]=_)}return s?this.applyEnvOverrides(d):d}catch(t){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t instanceof Error?t.message:String(t));let r=this.getAllDefaults();return s?this.applyEnvOverrides(r):r}}};var X=require("fs"),z=require("path");var v=class n{static instance=null;activeMode=null;modesDir;constructor(){let e=Ae(),s=[...process.env.CLAUDE_MEM_MODES_DIR?[process.env.CLAUDE_MEM_MODES_DIR]:[],(0,z.join)(e,"modes"),(0,z.join)(e,"..","plugin","modes")],t=s.find(r=>(0,X.existsSync)(r));this.modesDir=t||s[0]}static getInstance(){return n.instance||(n.instance=new n),n.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let t={...e};for(let r in s){let o=s[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?t[r]=this.deepMerge(i,o):t[r]=o}return t}loadModeFile(e){let s=(0,z.join)(this.modesDir,`${e}.json`);if(!(0,X.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let t=(0,X.readFileSync)(s,"utf-8");return JSON.parse(t)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let a=this.loadModeFile(e);return this.activeMode=a,E.debug("SYSTEM",`Loaded mode: ${a.name} (${e})`,void 0,{types:a.observation_types.map(_=>_.id),concepts:a.observation_concepts.map(_=>_.id)}),a}catch(a){if(a instanceof Error?E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:a.message}):E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(a)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:t,overrideId:r}=s,o;try{o=this.loadMode(t)}catch(a){a instanceof Error?E.warn("WORKER",`Parent mode '${t}' not found for ${e}, falling back to 'code'`,{message:a.message}):E.warn("WORKER",`Parent mode '${t}' not found for ${e}, falling back to 'code'`,{error:String(a)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),E.debug("SYSTEM",`Loaded override file: ${r} for parent ${t}`)}catch(a){return a instanceof Error?E.warn("WORKER",`Override file '${r}' not found, using parent mode '${t}' only`,{message:a.message}):E.warn("WORKER",`Override file '${r}' not found, using parent mode '${t}' only`,{error:String(a)}),this.activeMode=o,o}if(!i)return E.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${t}' only`),this.activeMode=o,o;let d=this.deepMerge(o,i);return this.activeMode=d,E.debug("SYSTEM",`Loaded mode with inheritance: ${d.name} (${e} = ${t} + ${r})`,void 0,{parent:t,override:r,types:d.observation_types.map(a=>a.id),concepts:d.observation_concepts.map(a=>a.id)}),d}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}};function Ke(){let n=$.settings(),e=Q.loadFromFile(n),s=v.getInstance().getActiveMode(),t=new Set(s.observation_types.map(o=>o.id)),r=new Set(s.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:t,observationConcepts:r,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var u={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},Ye=4,qe=1;function Je(n){let e=(n.title?.length||0)+(n.subtitle?.length||0)+(n.narrative?.length||0)+JSON.stringify(n.facts||[]).length;return Math.ceil(e/Ye)}function ge(n){let e=n.length,s=n.reduce((i,d)=>i+Je(d),0),t=n.reduce((i,d)=>i+(d.discovery_tokens||0),0),r=t-s,o=t>0?Math.round(r/t*100):0;return{totalObservations:e,totalReadTokens:s,totalDiscoveryTokens:t,savings:r,savingsPercent:o}}function lt(n){return v.getInstance().getWorkEmoji(n)}function B(n,e){let s=Je(n),t=n.discovery_tokens||0,r=lt(n.type),o=t>0?`${r} ${t.toLocaleString()}`:"-";return{readTokens:s,discoveryTokens:t,discoveryDisplay:o,workEmoji:r}}function Z(n){return n.showReadTokens||n.showWorkTokens||n.showSavingsAmount||n.showSavingsPercent}var Qe=F(require("path"),1),ee=require("fs");function ze(n,e,s,t){let r=Array.from(s.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(s.observationConcepts),d=i.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return n.db.prepare(`
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
    WHERE (o.project IN (${a})
           OR o.merged_into_project IN (${a}))
      AND (? IS NULL OR s.platform_source = ?)
      AND type IN (${o})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${d})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,t??null,t??null,...r,...i,s.totalObservationCount)}function Ze(n,e,s,t){let r=e.map(()=>"?").join(",");return n.db.prepare(`
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
  `).all(...e,...e,t??null,t??null,s.sessionCount+qe)}function Tt(n){return n.replace(/[/.]/g,"-")}function gt(n){if(!n.includes('"type":"assistant"'))return null;let e=JSON.parse(n);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let s="";for(let t of e.message.content)t.type==="text"&&(s+=t.text);if(s=s.replace(ke,"").trim(),s)return s}return null}function St(n){for(let e=n.length-1;e>=0;e--)try{let s=gt(n[e]);if(s)return s}catch(s){s instanceof Error?E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},s):E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(s)});continue}return""}function ft(n){try{if(!(0,ee.existsSync)(n))return{assistantMessage:""};let e=(0,ee.readFileSync)(n,"utf-8").trim();if(!e)return{assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim());return{assistantMessage:St(s)}}catch(e){return e instanceof Error?E.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:n},e):E.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:n,error:String(e)}),{assistantMessage:""}}}function es(n,e,s,t){if(!e.showLastMessage||n.length===0)return{assistantMessage:""};let r=n.find(a=>a.memory_session_id!==s);if(!r)return{assistantMessage:""};let o=r.memory_session_id,i=Tt(t),d=Qe.default.join(oe,"projects",i,`${o}.jsonl`);return ft(d)}function ss(n,e){let s=e[0]?.id;return n.map((t,r)=>{let o=r===0?null:e[r+1];return{...t,displayEpoch:o?o.created_at_epoch:t.created_at_epoch,displayTime:o?o.created_at:t.created_at,shouldShowLink:t.id!==s}})}function ts(n,e){let s=[...n.map(t=>({type:"observation",data:t})),...e.map(t=>({type:"summary",data:t}))];return s.sort((t,r)=>{let o=t.type==="observation"?t.data.created_at_epoch:t.data.displayEpoch,i=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch;return o-i}),s}function rs(n,e){return new Set(n.slice(0,e).map(s=>s.id))}function ns(){let n=new Date,e=n.toLocaleDateString("en-CA"),s=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),t=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${t}`}function os(n){return[`# [${n}] recent context, ${ns()}`,""]}function is(){return[`Legend: \u{1F3AF}session ${v.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji}${s.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function as(n,e){let s=[],t=[`${n.totalObservations} obs (${n.totalReadTokens.toLocaleString()}t read)`,`${n.totalDiscoveryTokens.toLocaleString()}t work`];return n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?t.push(`${n.savingsPercent}% savings`):e.showSavingsAmount&&t.push(`${n.savings.toLocaleString()}t saved`)),s.push(`Stats: ${t.join(" | ")}`),s.push(""),s}function ds(n){return[`### ${n}`]}function _s(n){return n.toLowerCase().replace(" am","a").replace(" pm","p")}function Es(n,e,s){let t=n.title||"Untitled",r=v.getInstance().getTypeIcon(n.type),o=e?_s(e):'"';return`${n.id} ${o} ${r} ${t}`}function us(n,e,s,t){let r=[],o=n.title||"Untitled",i=v.getInstance().getTypeIcon(n.type),d=e?_s(e):'"',{readTokens:a,discoveryDisplay:_}=B(n,t);r.push(`**${n.id}** ${d} ${i} **${o}**`),s&&r.push(s);let m=[];return t.showReadTokens&&m.push(`~${a}t`),t.showWorkTokens&&m.push(_),m.length>0&&r.push(m.join(" ")),r.push(""),r}function ms(n,e){return[`S${n.id} ${n.request||"Session started"} (${e})`]}function j(n,e){return e?[`**${n}**: ${e}`,""]:[]}function cs(n){return n.assistantMessage?["","---","","**Previously**","",`A: ${n.assistantMessage}`,""]:[]}function ps(n,e){return["",`Access ${Math.round(n/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function ls(n){return`# [${n}] recent context, ${ns()}

No previous sessions found.`}function Ts(){let n=new Date,e=n.toLocaleDateString("en-CA"),s=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),t=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${t}`}function gs(n){return["",`${u.bright}${u.cyan}[${n}] recent context, ${Ts()}${u.reset}`,`${u.gray}${"\u2500".repeat(60)}${u.reset}`,""]}function Ss(){let e=v.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji} ${s.id}`).join(" | ");return[`${u.dim}Legend: session-request | ${e}${u.reset}`,""]}function fs(){return[`${u.bright}Column Key${u.reset}`,`${u.dim}  Read: Tokens to read this observation (cost to learn it now)${u.reset}`,`${u.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${u.reset}`,""]}function Rs(){return[`${u.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${u.reset}`,"",`${u.dim}When you need implementation details, rationale, or debugging context:${u.reset}`,`${u.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${u.reset}`,`${u.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${u.reset}`,`${u.dim}  - Trust this index over re-reading code for past decisions and learnings${u.reset}`,""]}function bs(n,e){let s=[];if(s.push(`${u.bright}${u.cyan}Context Economics${u.reset}`),s.push(`${u.dim}  Loading: ${n.totalObservations} observations (${n.totalReadTokens.toLocaleString()} tokens to read)${u.reset}`),s.push(`${u.dim}  Work investment: ${n.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${u.reset}`),n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let t="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?t+=`${n.savings.toLocaleString()} tokens (${n.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?t+=`${n.savings.toLocaleString()} tokens`:t+=`${n.savingsPercent}% reduction from reuse`,s.push(`${u.green}${t}${u.reset}`)}return s.push(""),s}function Os(n){return[`${u.bright}${u.cyan}${n}${u.reset}`,""]}function hs(n){return[`${u.dim}${n}${u.reset}`]}function Ns(n,e,s,t){let r=n.title||"Untitled",o=v.getInstance().getTypeIcon(n.type),{readTokens:i,discoveryTokens:d,workEmoji:a}=B(n,t),_=s?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),m=t.showReadTokens&&i>0?`${u.dim}(~${i}t)${u.reset}`:"",l=t.showWorkTokens&&d>0?`${u.dim}(${a} ${d.toLocaleString()}t)${u.reset}`:"";return`  ${u.dim}#${n.id}${u.reset}  ${_}  ${o}  ${r} ${m} ${l}`}function Is(n,e,s,t,r){let o=[],i=n.title||"Untitled",d=v.getInstance().getTypeIcon(n.type),{readTokens:a,discoveryTokens:_,workEmoji:m}=B(n,r),l=s?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),p=r.showReadTokens&&a>0?`${u.dim}(~${a}t)${u.reset}`:"",T=r.showWorkTokens&&_>0?`${u.dim}(${m} ${_.toLocaleString()}t)${u.reset}`:"";return o.push(`  ${u.dim}#${n.id}${u.reset}  ${l}  ${d}  ${u.bright}${i}${u.reset}`),t&&o.push(`    ${u.dim}${t}${u.reset}`),(p||T)&&o.push(`    ${p} ${T}`),o.push(""),o}function As(n,e){let s=`${n.request||"Session started"} (${e})`;return[`${u.yellow}#S${n.id}${u.reset} ${s}`,""]}function W(n,e,s){return e?[`${s}${n}:${u.reset} ${e}`,""]:[]}function Cs(n){return n.assistantMessage?["","---","",`${u.bright}${u.magenta}Previously${u.reset}`,"",`${u.dim}A: ${n.assistantMessage}${u.reset}`,""]:[]}function Ls(n,e){let s=Math.round(n/1e3);return["",`${u.dim}Access ${s}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${u.reset}`]}function Ds(n){return`
${u.bright}${u.cyan}[${n}] recent context, ${Ts()}${u.reset}
${u.gray}${"\u2500".repeat(60)}${u.reset}

${u.dim}No previous sessions found for this project yet.${u.reset}
`}function Ms(n,e,s,t){let r=[];return t?r.push(...gs(n)):r.push(...os(n)),t?r.push(...Ss()):r.push(...is()),t&&(r.push(...fs()),r.push(...Rs())),Z(s)&&(t?r.push(...bs(e,s)):r.push(...as(e,s))),r}var Se=F(require("path"),1);function re(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[]}catch(e){return E.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:n?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function fe(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Re(n){return new Date(n).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ys(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function vs(n,e){return Se.default.isAbsolute(n)?Se.default.relative(e,n):n}function Us(n,e,s){let t=re(n);if(t.length>0)return vs(t[0],e);if(s){let r=re(s);if(r.length>0)return vs(r[0],e)}return"General"}function Rt(n){let e=new Map;for(let t of n){let r=t.type==="observation"?t.data.created_at:t.data.displayTime,o=ys(r);e.has(o)||e.set(o,[]),e.get(o).push(t)}let s=Array.from(e.entries()).sort((t,r)=>{let o=new Date(t[0]).getTime(),i=new Date(r[0]).getTime();return o-i});return new Map(s)}function xs(n,e){return e.fullObservationField==="narrative"?n.narrative:n.facts?re(n.facts).join(`
`):null}function bt(n,e,s,t){let r=[];r.push(...ds(n));let o="";for(let i of e)if(i.type==="summary"){let d=i.data,a=fe(d.displayTime);r.push(...ms(d,a))}else{let d=i.data,a=Re(d.created_at),m=a!==o?a:"";if(o=a,s.has(d.id)){let p=xs(d,t);r.push(...us(d,m,p,t))}else r.push(Es(d,m,t))}return r}function Ot(n,e,s,t,r){let o=[];o.push(...Os(n));let i=null,d="";for(let a of e)if(a.type==="summary"){i=null,d="";let _=a.data,m=fe(_.displayTime);o.push(...As(_,m))}else{let _=a.data,m=Us(_.files_modified,r,_.files_read),l=Re(_.created_at),p=l!==d;d=l;let T=s.has(_.id);if(m!==i&&(o.push(...hs(m)),i=m),T){let N=xs(_,t);o.push(...Is(_,l,p,N,t))}else o.push(Ns(_,l,p,t))}return o.push(""),o}function ht(n,e,s,t,r,o){return o?Ot(n,e,s,t,r):bt(n,e,s,t)}function ks(n,e,s,t,r){let o=[],i=Rt(n);for(let[d,a]of i)o.push(...ht(d,a,e,s,t,r));return o}function ws(n,e,s){return!(!n.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||s&&e.created_at_epoch<=s.created_at_epoch)}function Ps(n,e){let s=[];return e?(s.push(...W("Investigated",n.investigated,u.blue)),s.push(...W("Learned",n.learned,u.yellow)),s.push(...W("Completed",n.completed,u.green)),s.push(...W("Next Steps",n.next_steps,u.magenta))):(s.push(...j("Investigated",n.investigated)),s.push(...j("Learned",n.learned)),s.push(...j("Completed",n.completed)),s.push(...j("Next Steps",n.next_steps))),s}function Fs(n,e){return e?Cs(n):cs(n)}function $s(n,e,s){return!Z(e)||n.totalDiscoveryTokens<=0||n.savings<=0?[]:s?Ls(n.totalDiscoveryTokens,n.totalReadTokens):ps(n.totalDiscoveryTokens,n.totalReadTokens)}var Nt=Gs.default.join((0,Hs.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function It(){try{return new Y}catch(n){if(n instanceof Error&&n.code==="ERR_DLOPEN_FAILED"){try{(0,Xs.unlinkSync)(Nt)}catch(e){e instanceof Error?E.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):E.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return E.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw n}}function At(n,e){return e?Ds(n):ls(n)}function Ct(n,e,s,t,r,o,i){let d=[],a=ge(e);d.push(...Ms(n,a,t,i));let _=s.slice(0,t.sessionCount),m=ss(_,s),l=ts(e,m),p=rs(e,t.fullObservationCount);d.push(...ks(l,p,t,r,i));let T=s[0],N=e[0];ws(t,T,N)&&d.push(...Ps(T,i));let h=es(e,t,o,r);return d.push(...Fs(h,i)),d.push(...$s(a,t,i)),d.join(`
`).trimEnd()}var Lt=new Set(["bugfix","discovery","decision","refactor"]);function Dt(n,e,s){let t=ge(n),r={bugfix:0,discovery:0,decision:0,refactor:0,other:0},o=new Set,i=Number.POSITIVE_INFINITY;for(let a of n){let _=Lt.has(a.type)?a.type:"other";r[_]++,a.memory_session_id&&o.add(a.memory_session_id),a.created_at_epoch&&a.created_at_epoch<i&&(i=a.created_at_epoch)}let d=Number.isFinite(i)?Math.max(0,Math.floor((Date.now()-i)/864e5)):0;return{observation_count:n.length,session_count:o.size,timeline_depth_days:d,has_session_summary:e.length>0,obs_type_bugfix:r.bugfix,obs_type_discovery:r.discovery,obs_type_decision:r.decision,obs_type_refactor:r.refactor,obs_type_other:r.other,tokens_injected:t.totalReadTokens,tokens_saved_vs_naive:t.savings,search_strategy:s?"full":"timeline"}}async function be(n,e=!1){let s=Ke(),t=n?.cwd??process.cwd(),r=Be(t),o=n?.projects?.length?n.projects:r.allProjects,i=o[o.length-1]??r.primary;n?.full&&(s.totalObservationCount=999999,s.sessionCount=999999);let d=It();if(!d)return{text:"",stats:null};try{let a=n?.platformSource?L(n.platformSource):void 0,_=o.length>1?o:[i],m=ze(d,_,s,a),l=Ze(d,_,s,a);return m.length===0&&l.length===0?{text:At(i,e),stats:null}:{text:Ct(i,m,l,s,t,n?.session_id,e),stats:Dt(m,l,!!n?.full)}}finally{d.close()}}async function Bs(n,e=!1){return(await be(n,e)).text}0&&(module.exports={generateContext,generateContextWithStats});
