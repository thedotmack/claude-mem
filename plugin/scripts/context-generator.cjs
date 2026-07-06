"use strict";var Xs=Object.create;var V=Object.defineProperty;var Bs=Object.getOwnPropertyDescriptor;var js=Object.getOwnPropertyNames;var Ws=Object.getPrototypeOf,Vs=Object.prototype.hasOwnProperty;var qs=(r,e)=>{for(var s in e)V(r,s,{get:e[s],enumerable:!0})},Oe=(r,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of js(e))!Vs.call(r,n)&&n!==s&&V(r,n,{get:()=>e[n],enumerable:!(t=Bs(e,n))||t.enumerable});return r};var $=(r,e,s)=>(s=r!=null?Xs(Ws(r)):{},Oe(e||!r||!r.__esModule?V(s,"default",{value:r,enumerable:!0}):s,r)),Ks=r=>Oe(V({},"__esModule",{value:!0}),r);var Mt={};qs(Mt,{generateContext:()=>Gs,generateContextWithStats:()=>Re});module.exports=Ks(Mt);var Fs=$(require("path"),1),$s=require("os"),Hs=require("fs");var me=require("bun:sqlite");var R=require("path"),oe=require("os"),w=require("fs"),he=require("url");var T=require("fs"),be=require("crypto"),v=require("path");var Ys=null;function Js(r){return(Ys??process.stderr.write.bind(process.stderr))(r)}function x(r){Js(r)}var Qs=process.platform==="win32";function zs(r){return r.replace(/^\uFEFF/,"")}function k(r){return JSON.parse(zs(r))}function Zs(r){(0,T.existsSync)(r)||(0,T.mkdirSync)(r,{recursive:!0})}function ne(r,e){let s=r;try{if((0,T.lstatSync)(r).isSymbolicLink())try{s=(0,T.realpathSync)(r)}catch(_){let u=_ instanceof Error?_:new Error(String(_));x(`claude-mem: realpathSync failed for ${r}, resolving symlink manually: ${u.message}
`);let c=(0,T.readlinkSync)(r);s=(0,v.resolve)((0,v.dirname)(r),c)}}catch(_){let u=_.code;if(u!=="ENOENT"&&u!=="ENOTDIR")throw _}Zs((0,v.dirname)(s));let t=(0,v.dirname)(s),n=(0,v.basename)(s),o=(0,v.join)(t,`.${n}.${process.pid}.${(0,be.randomBytes)(6).toString("hex")}.tmp`),i=Buffer.from(JSON.stringify(e,null,2)+`
`,"utf-8"),a;try{a=(0,T.statSync)(s).mode&511}catch{}let d;try{d=a!==void 0?(0,T.openSync)(o,"w",a):(0,T.openSync)(o,"w");let _=0;for(;_<i.length;){let u=(0,T.writeSync)(d,i,_,i.length-_);if(u===0)throw new Error(`writeSync stalled at ${_}/${i.length} bytes`);_+=u}if((0,T.fsyncSync)(d),(0,T.closeSync)(d),d=void 0,(0,T.renameSync)(o,s),!Qs){let u;try{u=(0,T.openSync)(t,"r"),(0,T.fsyncSync)(u)}catch(c){let p=c instanceof Error?c:new Error(String(c));x(`claude-mem: directory fsync failed for ${t}: ${p.message}
`)}finally{if(u!==void 0)try{(0,T.closeSync)(u)}catch{}}}}catch(_){if(d!==void 0)try{(0,T.closeSync)(d)}catch{}try{(0,T.unlinkSync)(o)}catch{}throw _}}var ot={};function et(){return typeof __dirname<"u"?__dirname:(0,R.dirname)((0,he.fileURLToPath)(ot.url))}var st=et();function tt(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let r=(0,R.join)((0,oe.homedir)(),".claude-mem"),e=(0,R.join)(r,"settings.json");try{if((0,w.existsSync)(e)){let s=k((0,w.readFileSync)(e,"utf-8")),t=s.env??s;if(t.CLAUDE_MEM_DATA_DIR)return t.CLAUDE_MEM_DATA_DIR}}catch{}return r}var A=tt(),ie=process.env.CLAUDE_CONFIG_DIR||(0,R.join)((0,oe.homedir)(),".claude"),Pt=(0,R.join)(ie,"plugins","marketplaces","thedotmack"),rt=(0,R.join)(A,"logs"),Ft=(0,R.join)(A,"settings.json"),Ie=(0,R.join)(A,"claude-mem.db"),nt=(0,R.join)(A,"observer-sessions"),ae=(0,R.basename)(nt);function Ne(r){(0,w.mkdirSync)(r,{recursive:!0})}function Ae(){return(0,R.join)(st,"..")}var H={dataDir:()=>A,workerPid:()=>(0,R.join)(A,"worker.pid"),serverPid:()=>(0,R.join)(A,".server-beta.pid"),serverPort:()=>(0,R.join)(A,".server-beta.port"),serverRuntime:()=>(0,R.join)(A,".server-beta.runtime.json"),settings:()=>(0,R.join)(A,"settings.json"),database:()=>(0,R.join)(A,"claude-mem.db"),chroma:()=>(0,R.join)(A,"chroma"),combinedCerts:()=>(0,R.join)(A,"combined_certs.pem"),transcriptsConfig:()=>(0,R.join)(A,"transcript-watch.json"),transcriptsState:()=>(0,R.join)(A,"transcript-watch-state.json"),corpora:()=>(0,R.join)(A,"corpora"),supervisorRegistry:()=>(0,R.join)(A,"supervisor.json"),envFile:()=>(0,R.join)(A,".env"),logsDir:()=>rt};var y=require("fs"),Ce=require("path");var _e=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(_e||{}),de=null,Ee=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=H.logsDir();(0,y.existsSync)(e)||(0,y.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,Ce.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=H.settings();if((0,y.existsSync)(e)){let s=(0,y.readFileSync)(e,"utf-8"),n=(k(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=_e[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${n} ${o}:${i}:${a}.${d}`}log(e,s,t,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=_e[e].padEnd(5),d=s.padEnd(6),_="";n?.correlationId?_=`[${n.correlationId}] `:n?.sessionId&&(_=`[session-${n.sessionId}] `);let u="";if(o!=null)if(o instanceof Error)u=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{u=`
`+JSON.stringify(o,null,2)}catch{u=" "+this.formatData(o)}else u=" "+this.formatData(o);let c="";if(n){let{sessionId:g,memorySessionId:I,correlationId:h,...S}=n;Object.keys(S).length>0&&(c=` {${Object.entries(S).map(([L,U])=>`${L}=${U}`).join(", ")}}`)}let p=`[${i}] [${a}] [${d}] ${_}${t}${c}${u}`;if(this.logFilePath)try{(0,y.appendFileSync)(this.logFilePath,p+`
`,"utf8")}catch(g){let I=g instanceof Error?g:new Error(String(g));x(`[LOGGER] Failed to write to log file: ${I.message}
${I.stack??""}
`)}else x(p+`
`)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}setErrorSink(e){de=e}error(e,s,t,n){this.log(3,e,s,t,n),this.routeErrorToSink(s,t,n)}routeErrorToSink(e,s,t){try{if(!de||!(t instanceof Error))return;de(t)}catch{}}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}},E=new Ee;var Le=require("crypto");function De(r,e,s){return(0,Le.createHash)("sha256").update([r||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}var l="claude";function it(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function C(r){if(!r)return l;let e=it(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:l}function Me(r){let e=["claude","codex","cursor"];return[...r].sort((s,t)=>{let n=e.indexOf(s),o=e.indexOf(t);return n!==-1||o!==-1?n===-1?1:o===-1?-1:n-o:s.localeCompare(t)})}function ve(r,e,s,t,n){let o=Date.now()-t,i=n!==void 0?"up.session_db_id = ?":"up.content_session_id = ?",a=n??e;return r.prepare(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project,
      COALESCE(s.platform_source, '${l}') as platform_source
    FROM user_prompts up
    JOIN sdk_sessions s ON up.session_db_id = s.id
    WHERE ${i}
      AND up.prompt_text = ?
      AND up.created_at_epoch >= ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `).get(a,s,o)??void 0}var xe=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],ye=new RegExp(`<(${xe.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),ke=/<system-reminder>[\s\S]*?<\/system-reminder>/g,Ue=100;function at(r){let e=Object.fromEntries(xe.map(n=>[n,0]));ye.lastIndex=0;let s=0,t=r.replace(ye,(n,o)=>(e[o]=(e[o]??0)+1,s+=1,""));return s>Ue&&E.warn("SYSTEM","tag count exceeds limit",void 0,{tagCount:s,maxAllowed:Ue,contentLength:r.length}),{stripped:t.trim(),counts:e}}function we(r){return at(r).stripped}var dt=["task-notification"],Yt=new RegExp(`^\\s*<(${dt.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Jt=256*1024;var ue=4e3;function q(r){let e=r.trim(),t=we(r).trim()||e;return t.length<=ue?t:(E.debug("DB","Truncated stored prompt text to the configured cap",{originalLength:t.length,storedLength:ue}),`${t.slice(0,ue-1)}\u2026`)}var _t=require("bun:sqlite");var Et=5e3,ut=4194304;function mt(r){return r.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get()!=null}function P(r,e,s){try{r.run(e)}catch(t){let n=t instanceof Error?t:new Error(String(t));throw E.warn("DB",`Failed to apply SQLite pragma ${s}`,{sql:e},n),t}}function Pe(r,e={}){let{enableWal:s=!0,enableIncrementalAutoVacuum:t=!0}=e;P(r,`PRAGMA busy_timeout = ${Et}`,"busy_timeout"),P(r,"PRAGMA foreign_keys = ON","foreign_keys"),P(r,"PRAGMA synchronous = NORMAL","synchronous"),P(r,`PRAGMA journal_size_limit = ${ut}`,"journal_size_limit"),t&&!mt(r)&&P(r,"PRAGMA auto_vacuum = INCREMENTAL","auto_vacuum"),s&&P(r,"PRAGMA journal_mode = WAL","journal_mode")}var K=class{db;constructor(e=Ie){e instanceof me.Database?this.db=e:(e!==":memory:"&&Ne(A),this.db=new me.Database(e)),Pe(this.db),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn(),this.dropDeadPendingMessagesColumns(),this.ensurePendingMessagesToolUseIdColumn(),this.dropWorkerPidColumn(),this.ensureSDKSessionsPlatformContentIdentity(),this.ensureUserPromptsSessionDbId(),this.ensurePendingMessagesSessionToolUniqueIndex()}getIndexColumns(e){return this.db.query(`PRAGMA index_info(${JSON.stringify(e)})`).all().map(s=>s.name)}hasUniqueIndexOnColumns(e,s){return this.db.query(`PRAGMA index_list(${e})`).all().some(n=>{if(n.unique!==1)return!1;let o=this.getIndexColumns(n.name);return o.length===s.length&&o.every((i,a)=>i===s[a])})}resolvePromptSessionDbId(e,s,t){if(s!==void 0)return s;let n=t?C(t):void 0;return n?this.db.prepare(`
        SELECT id
        FROM sdk_sessions
        WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
          AND content_session_id = ?
        LIMIT 1
      `).get(l,n,e)?.id??null:this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE content_session_id = ?
      ORDER BY CASE COALESCE(NULLIF(platform_source, ''), '${l}')
        WHEN '${l}' THEN 0
        ELSE 1
      END, id
      LIMIT 1
    `).get(e)?.id??null}dropWorkerPidColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(32),t=this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="worker_pid");if(!(e&&!t)){if(t)try{this.db.run("DROP INDEX IF EXISTS idx_pending_messages_worker_pid"),this.db.run("ALTER TABLE pending_messages DROP COLUMN worker_pid"),E.debug("DB","Dropped worker_pid column and its index from pending_messages")}catch(n){E.warn("DB","Failed to drop worker_pid column from pending_messages",{},n instanceof Error?n:new Error(String(n)));return}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(32,new Date().toISOString())}}ensureSDKSessionsPlatformContentIdentity(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(33),s=this.hasUniqueIndexOnColumns("sdk_sessions",["content_session_id"]),t=this.hasUniqueIndexOnColumns("sdk_sessions",["platform_source","content_session_id"]),o=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source");if(!(e&&!s&&t&&o)){if(o||this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${l}'`),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${l}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),s){this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildSdkSessionsWithCompositeIdentity(e),this.db.run("COMMIT")}catch(i){this.db.run("ROLLBACK");let a=i instanceof Error?i:new Error(String(i));throw E.error("DB","Failed to rebuild sdk_sessions with composite identity, rolled back",{},a),i}finally{this.db.run("PRAGMA foreign_keys = ON")}return}this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}}rebuildSdkSessionsWithCompositeIdentity(e){this.db.run("DROP TABLE IF EXISTS sdk_sessions_new"),this.db.run(`
      CREATE TABLE sdk_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT '${l}',
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
        COALESCE(NULLIF(platform_source, ''), '${l}'),
        user_prompt, started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter, custom_title
      FROM sdk_sessions
    `),this.db.run("DROP TABLE sdk_sessions"),this.db.run("ALTER TABLE sdk_sessions_new RENAME TO sdk_sessions"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS ux_sdk_sessions_platform_content ON sdk_sessions(platform_source, content_session_id)"),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(33,new Date().toISOString())}ensureUserPromptsSessionDbId(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(34);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString());return}let n=this.db.query("PRAGMA table_info(user_prompts)").all().some(_=>_.name==="session_db_id"),i=this.db.query("PRAGMA foreign_key_list(user_prompts)").all().some(_=>_.table==="sdk_sessions"&&_.from==="content_session_id");if(e&&n&&!i)return;let a=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_prompts_fts'").all().length>0,d=n?`COALESCE(up.session_db_id, (
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${l}')
            WHEN '${l}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        ))`:`(
          SELECT s.id FROM sdk_sessions s
          WHERE s.content_session_id = up.content_session_id
          ORDER BY CASE COALESCE(NULLIF(s.platform_source, ''), '${l}')
            WHEN '${l}' THEN 0
            ELSE 1
          END, s.id
          LIMIT 1
        )`;this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.rebuildUserPromptsWithSessionDbId(e,d,a),this.db.run("COMMIT")}catch(_){this.db.run("ROLLBACK");let u=_ instanceof Error?_:new Error(String(_));throw E.error("DB","Failed to rebuild user_prompts with session_db_id, rolled back",{},u),_}finally{this.db.run("PRAGMA foreign_keys = ON")}}rebuildUserPromptsWithSessionDbId(e,s,t){this.db.run("DROP TRIGGER IF EXISTS user_prompts_ai"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_ad"),this.db.run("DROP TRIGGER IF EXISTS user_prompts_au"),this.db.run("DROP TABLE IF EXISTS user_prompts_new"),this.db.run(`
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
      `),this.db.run("INSERT INTO user_prompts_fts(user_prompts_fts) VALUES('rebuild')")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(34,new Date().toISOString())}ensurePendingMessagesSessionToolUniqueIndex(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(35);if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(35,new Date().toISOString());return}let t=this.hasUniqueIndexOnColumns("pending_messages",["session_db_id","tool_use_id"]);if(!(e&&t)){this.db.run("BEGIN TRANSACTION");try{this.recreatePendingSessionToolUniqueIndex(e),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw E.error("DB","Failed to recreate ux_pending_session_tool index, rolled back",{},o),n}}}recreatePendingSessionToolUniqueIndex(e){this.db.run("DROP INDEX IF EXISTS ux_pending_session_tool"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),E.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),E.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),E.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(t=>t.unique===1&&t.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}E.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),E.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}E.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `;try{this.db.run(t),this.db.run(n)}catch(o){o instanceof Error?E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):E.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),E.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),E.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}E.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),E.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;E.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),E.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(E.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?E.debug("DB",`Successfully renamed ${s} session ID columns`):E.debug("DB","No session ID column renames needed (already up to date)")}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),E.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;E.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(f=>f.name==="metadata"),n=s.some(f=>f.name==="content_hash"),o=t?`,
        metadata TEXT`:"",i=t?", metadata":"",a=n?`,
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
    `,u=`
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
    `,I=`
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
    `;try{this.recreateObservationsWithCascade(_,u,c,p),this.recreateSessionSummariesWithCascade(g,I,h,S),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),E.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(f){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),f instanceof Error?f:new Error(String(f))}}recreateObservationsWithCascade(e,s,t,n){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,s,t,n){this.db.run(e),this.db.run(s),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(t),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),E.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23),t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title");e&&t||(t||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),E.debug("DB","Added custom_title column to sdk_sessions table")),e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString()))}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&n||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${l}'`),E.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${l}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(n=>n.name==="generated_by_model"),t=e.some(n=>n.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(t=>t.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(i=>i.name==="agent_type"),n=s.some(i=>i.name==="agent_id");t||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(d=>d.name==="agent_type"),a=o.some(d=>d.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}ensurePendingMessagesToolUseIdColumn(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="tool_use_id")||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),this.db.run("BEGIN TRANSACTION");try{this.dedupePendingMessagesByToolUseId(),this.db.run("COMMIT")}catch(n){this.db.run("ROLLBACK");let o=n instanceof Error?n:new Error(String(n));throw E.error("DB","Failed to de-dupe pending_messages by tool_use_id, rolled back",{},o),n}}dedupePendingMessagesByToolUseId(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString())}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let s=this.db.query("PRAGMA table_info(observations)").all(),t=s.some(o=>o.name==="memory_session_id"),n=s.some(o=>o.name==="content_hash");if(!t||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.dedupeObservationsByContentHash(),this.db.run("COMMIT")}catch(o){this.db.run("ROLLBACK");let i=o instanceof Error?o:new Error(String(o));throw E.error("DB","Failed to de-dupe observations by content_hash, rolled back",{},i),o}}dedupeObservationsByContentHash(){this.db.run(`
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
    `).run(t,s,e)}ensureMemorySessionIdRegistered(e,s,t){let n=this.db.prepare(`
      SELECT id, memory_session_id, worker_port FROM sdk_sessions WHERE id = ?
    `).get(e);if(!n)throw new Error(`Session ${e} not found in sdk_sessions`);n.memory_session_id!==s&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),E.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:n.memory_session_id,newId:s})),typeof t=="number"&&n.worker_port!==t&&this.db.prepare(`
        UPDATE sdk_sessions SET worker_port = ? WHERE id = ?
      `).run(t,e)}getAllProjects(e){let s=e?C(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[ae];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",n.push(l,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...n).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${l}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${l}'), project
      ORDER BY latest_epoch DESC
    `).all(ae),s=[],t=new Set,n={};for(let i of e){let a=C(i.platform_source);n[a]||(n[a]=[]),n[a].includes(i.project)||n[a].push(i.project),t.has(i.project)||(t.add(i.project),s.push(i.project))}let o=Me(Object.keys(n));return{projects:s,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,n[i]||[]]))}}getLatestUserPrompt(e,s){let t=this.resolvePromptSessionDbId(e,s),n=t!==null?"up.session_db_id = ?":"up.content_session_id = ?",o=t!==null?t:e;return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${l}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE ${n}
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(o)}findRecentDuplicateUserPrompt(e,s,t,n){return ve(this.db,e,q(s),t,this.resolvePromptSessionDbId(e,n)??void 0)}getRecentSessionsWithStatus(e,s=3,t){let n=[e],o="";return t&&(o=`AND COALESCE(NULLIF(s.platform_source, ''), '${l}') = ?`,n.push(C(t))),n.push(s),this.db.prepare(`
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
    `).all(...n)}getObservationsForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions s
          WHERE s.memory_session_id = observations.memory_session_id
            AND COALESCE(NULLIF(s.platform_source, ''), '${l}') = ?
        )
      `,t.push(C(s))),this.db.prepare(`
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
        AND COALESCE(NULLIF(s.platform_source, ''), '${l}') = ?
    `).get(e,C(s))||null:this.db.prepare(`
        SELECT *
        FROM observations
        WHERE id = ?
      `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o,platformSource:i,type:a,concepts:d,files:_}=s,u=t==="relevance",c=u?"":`ORDER BY o.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,p=n&&!u?`LIMIT ${n}`:"",g=e.map(()=>"?").join(","),I=[...e],h=[];if(o&&(h.push("o.project = ?"),I.push(o)),i&&(h.push(`COALESCE(NULLIF(s.platform_source, ''), '${l}') = ?`),I.push(C(i))),a)if(Array.isArray(a)){let N=a.map(()=>"?").join(",");h.push(`o.type IN (${N})`),I.push(...a)}else h.push("o.type = ?"),I.push(a);if(d){let N=Array.isArray(d)?d:[d],b=N.map(()=>"EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value = ?)");I.push(...N),h.push(`(${b.join(" OR ")})`)}if(_){let N=Array.isArray(_)?_:[_],b=N.map(()=>"(EXISTS (SELECT 1 FROM json_each(o.files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(o.files_modified) WHERE value LIKE ?))");N.forEach(D=>{I.push(`%${D}%`,`%${D}%`)}),h.push(`(${b.join(" OR ")})`)}let S=h.length>0?`WHERE o.id IN (${g}) AND ${h.join(" AND ")}`:`WHERE o.id IN (${g})`,L=this.db.prepare(`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ${S}
      ${c}
      ${p}
    `).all(...I);if(!u)return L;let U=new Map(L.map(N=>[N.id,N])),O=e.map(N=>U.get(N)).filter(N=>!!N);return n?O.slice(0,n):O}getSummaryForSession(e,s){let t=[e],n="";return s&&(n=`
        AND EXISTS (
          SELECT 1
          FROM sdk_sessions sdk
          WHERE sdk.memory_session_id = session_summaries.memory_session_id
            AND COALESCE(NULLIF(sdk.platform_source, ''), '${l}') = ?
        )
      `,t.push(C(s))),this.db.prepare(`
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
             COALESCE(platform_source, '${l}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${l}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e,s){let t=this.resolvePromptSessionDbId(e,s);return t!==null?this.db.prepare(`
        SELECT COUNT(*) as count FROM user_prompts WHERE session_db_id = ?
      `).get(t).count:this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,s,t,n,o){let i=new Date,a=i.getTime(),d=o?C(o):l,_=q(t),u=this.db.prepare(`
      SELECT id, platform_source
      FROM sdk_sessions
      WHERE COALESCE(NULLIF(platform_source, ''), ?) = ?
        AND content_session_id = ?
    `).get(l,d,e);if(u)return s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE id = ? AND (project IS NULL OR project = '')
        `).run(s,u.id),n&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE id = ? AND custom_title IS NULL
        `).run(n,u.id),u.id;let c=this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,d,_,n||null,i.toISOString(),a);return Number(c.lastInsertRowid)}saveUserPrompt(e,s,t,n){let o=new Date,i=o.getTime(),a=q(t),d=this.resolvePromptSessionDbId(e,n);return this.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(d,e,s,a,o.toISOString(),i).lastInsertRowid}getUserPrompt(e,s,t){let n=this.resolvePromptSessionDbId(e,t);return n!==null?this.db.prepare(`
        SELECT prompt_text
        FROM user_prompts
        WHERE session_db_id = ? AND prompt_number = ?
        LIMIT 1
      `).get(n,s)?.prompt_text??null:this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,o=0,i,a){let d=this.storeObservations(e,s,[t],null,n,o,i,a);return{id:d.observationIds[0],createdAtEpoch:d.createdAtEpoch}}storeSummary(e,s,t,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,o,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,t,n,o,i=0,a,d){let _=a??Date.now(),u=new Date(_).toISOString();return this.db.transaction(()=>{let p=[],g=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),I=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let S of t){let f=De(e,S.title,S.narrative),L=g.get(e,s,S.type,S.title,S.subtitle,JSON.stringify(S.facts),S.narrative,JSON.stringify(S.concepts),JSON.stringify(S.files_read),JSON.stringify(S.files_modified),o||null,i,S.agent_type??null,S.agent_id??null,f,u,_,d||null,S.metadata??null);if(L){p.push(L.id);continue}let U=I.get(e,f);if(!U)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${f}`);p.push(U.id)}let h=null;if(n){let f=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,u,_);h=Number(f.lastInsertRowid)}return{observationIds:p,summaryId:h,createdAtEpoch:_}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o,platformSource:i}=s,a=t==="relevance",d=a?"":`ORDER BY ss.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,_=n&&!a?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),c=[...e],p=[];o&&(p.push("ss.project = ?"),c.push(o)),i&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${l}') = ?`),c.push(C(i)));let g=p.length>0?`AND ${p.join(" AND ")}`:"",h=this.db.prepare(`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.id IN (${u}) ${g}
      ${d}
      ${_}
    `).all(...c);if(!a)return h;let S=new Map(h.map(L=>[L.id,L])),f=e.map(L=>S.get(L)).filter(L=>!!L);return n?f.slice(0,n):f}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o,platformSource:i}=s,a=t==="relevance",d=a?"":`ORDER BY up.created_at_epoch ${t==="date_asc"?"ASC":"DESC"}`,_=n?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),c=[...e],p=[];o&&(p.push("s.project = ?"),c.push(o)),i&&(p.push(`COALESCE(NULLIF(s.platform_source, ''), '${l}') = ?`),c.push(C(i)));let g=p.length>0?`AND ${p.join(" AND ")}`:"",h=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), '${l}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.id IN (${u}) ${g}
      ${d}
      ${_}
    `).all(...c);if(!a)return h;let S=new Map(h.map(f=>[f.id,f]));return e.map(f=>S.get(f)).filter(f=>!!f)}getTimelineAroundTimestamp(e,s=10,t=10,n,o){return this.getTimelineAroundObservation(null,e,s,t,n,o)}getTimelineAroundObservation(e,s,t=10,n=10,o,i){let a=i?C(i):void 0,d=(O,N)=>{let b=[],D=[];return o&&(b.push(`${O}.project = ?`),D.push(o)),a&&(b.push(`COALESCE(NULLIF(${N}.platform_source, ''), '${l}') = ?`),D.push(a)),{clause:b.length>0?`AND ${b.join(" AND ")}`:"",params:D}},_=d("o","src"),u=d("ss","src"),c=d("s","s"),p,g;if(e!==null){let O=`
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
      `;try{let b=this.db.prepare(O).all(e,..._.params,t+1),D=this.db.prepare(N).all(e,..._.params,n+1);if(b.length===0&&D.length===0)return{observations:[],sessions:[],prompts:[]};p=b.length>0?b[b.length-1].created_at_epoch:s,g=D.length>0?D[D.length-1].created_at_epoch:s}catch(b){return b instanceof Error?E.error("DB","Error getting boundary observations",{project:o},b):E.error("DB","Error getting boundary observations with non-Error",{},new Error(String(b))),{observations:[],sessions:[],prompts:[]}}}else{let O=`
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
      `;try{let b=this.db.prepare(O).all(s,..._.params,t),D=this.db.prepare(N).all(s,..._.params,n+1);if(b.length===0&&D.length===0)return{observations:[],sessions:[],prompts:[]};p=b.length>0?b[b.length-1].created_at_epoch:s,g=D.length>0?D[D.length-1].created_at_epoch:s}catch(b){return b instanceof Error?E.error("DB","Error getting boundary timestamps",{project:o},b):E.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(b))),{observations:[],sessions:[],prompts:[]}}}let I=`
      SELECT o.*
      FROM observations o
      LEFT JOIN sdk_sessions src ON src.memory_session_id = o.memory_session_id
      WHERE o.created_at_epoch >= ? AND o.created_at_epoch <= ? ${_.clause}
      ORDER BY o.created_at_epoch ASC
    `,h=`
      SELECT ss.*
      FROM session_summaries ss
      LEFT JOIN sdk_sessions src ON src.memory_session_id = ss.memory_session_id
      WHERE ss.created_at_epoch >= ? AND ss.created_at_epoch <= ? ${u.clause}
      ORDER BY ss.created_at_epoch ASC
    `,S=`
      SELECT up.*, s.project, s.memory_session_id, COALESCE(NULLIF(s.platform_source, ''), '${l}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${c.clause}
      ORDER BY up.created_at_epoch ASC
    `,f=this.db.prepare(I).all(p,g,..._.params),L=this.db.prepare(h).all(p,g,...u.params),U=this.db.prepare(S).all(p,g,...c.params);return{observations:f,sessions:L.map(O=>({id:O.id,memory_session_id:O.memory_session_id,project:O.project,request:O.request,completed:O.completed,next_steps:O.next_steps,created_at:O.created_at,created_at_epoch:O.created_at_epoch})),prompts:U.map(O=>({id:O.id,content_session_id:O.content_session_id,prompt_number:O.prompt_number,prompt_text:O.prompt_text,project:O.project,platform_source:O.platform_source,created_at:O.created_at,created_at_epoch:O.created_at_epoch}))}}getOrCreateManualSession(e){let s=`manual-${e}`,t=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return s;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,t,e,l,o.toISOString(),o.getTime()),E.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}close(){this.db.close()}importSdkSession(e){let s=C(e.platform_source),t=this.db.prepare(`SELECT id FROM sdk_sessions
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
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=null,t=e.platform_source?C(e.platform_source):void 0;if(typeof e.session_db_id=="number"){let a=this.db.prepare(`
        SELECT id, content_session_id, COALESCE(NULLIF(platform_source, ''), '${l}') as platform_source
        FROM sdk_sessions
        WHERE id = ?
        LIMIT 1
      `).get(e.session_db_id);a&&a.content_session_id===e.content_session_id&&(!t||C(a.platform_source)===t)&&(s=a.id)}s===null&&(s=this.resolvePromptSessionDbId(e.content_session_id,void 0,t));let n=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE ${s!==null?"session_db_id = ?":"content_session_id = ?"} AND prompt_number = ?
    `).get(s??e.content_session_id,e.prompt_number);return n?{imported:!1,id:n.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        session_db_id, content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(s,e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var $e=require("os"),He=$(require("path"),1),Ge=require("child_process");var Y=require("fs"),F=$(require("path"),1);var G={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function Fe(r){let e=F.default.join(r,".git"),s;try{s=(0,Y.statSync)(e)}catch(u){return u instanceof Error&&u.code!=="ENOENT"&&E.warn("GIT","Unexpected error checking .git",{error:u instanceof Error?u.message:String(u)}),G}if(!s.isFile())return G;let t;try{t=(0,Y.readFileSync)(e,"utf-8").trim()}catch(u){return E.warn("GIT","Failed to read .git file",{error:u instanceof Error?u.message:String(u)}),G}let n=t.match(/^gitdir:\s*(.+)$/);if(!n)return G;let i=F.default.resolve(F.default.dirname(e),n[1]).match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return G;let a=i[1],d=F.default.basename(r),_=F.default.basename(a);return{isWorktree:!0,worktreeName:d,parentRepoPath:a,parentProjectName:_}}function Xe(r){return r==="~"||r.startsWith("~/")?r.replace(/^~/,(0,$e.homedir)()):r}function ct(r){try{return(0,Ge.execFileSync)("git",["rev-parse","--show-toplevel"],{cwd:r,encoding:"utf-8",stdio:["ignore","pipe","ignore"]}).trim()||null}catch(e){let s=e instanceof Error?e:new Error(String(e));return E.debug("PROJECT_NAME","git rev-parse failed, falling back to basename",{dir:r},s),null}}function pt(r){if(!r||r.trim()==="")return E.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:r}),"unknown-project";let e=Xe(r),t=ct(e)??e,n=He.default.basename(t);if(n===""){if(process.platform==="win32"){let i=r.match(/^([A-Z]):\\/i);if(i){let d=`drive-${i[1].toUpperCase()}`;return E.info("PROJECT_NAME","Drive root detected",{cwd:r,projectName:d}),d}}return E.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:r}),"unknown-project"}return n}function Be(r){let e=pt(r);if(!r)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let s=Xe(r),t=Fe(s);if(t.isWorktree&&t.parentProjectName){let n=`${t.parentProjectName}/${e}`;return{primary:n,parent:t.parentProjectName,isWorktree:!0,allProjects:[t.parentProjectName,n]}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}var Q=require("fs"),pe=require("path"),le=require("os");var ce={HEALTH_CHECK:3e3,API_REQUEST:3e4,HOOK_READINESS_WAIT:1e4,POST_SPAWN_WAIT:15e3,READINESS_WAIT:3e4,PORT_IN_USE_WAIT:3e3,POWERSHELL_COMMAND:1e4,WINDOWS_MULTIPLIER:1.5};function je(r){return process.platform==="win32"?Math.round(r*ce.WINDOWS_MULTIPLIER):r}var J=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5-20251001",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_API_TIMEOUT_MS:String(je(ce.API_REQUEST)),CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"subscription",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_BASE_URL:"",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_DATA_DIR:(0,pe.join)((0,le.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_WELCOME_HINT_ENABLED:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,pe.join)((0,le.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_TIER_FAST_MODEL:"haiku",CLAUDE_MEM_TIER_SMART_MODEL:"sonnet",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS:"120000",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:"",CLAUDE_MEM_QUEUE_ENGINE:"sqlite",CLAUDE_MEM_REDIS_URL:"",CLAUDE_MEM_REDIS_HOST:"127.0.0.1",CLAUDE_MEM_REDIS_PORT:"6379",CLAUDE_MEM_REDIS_MODE:"external",CLAUDE_MEM_QUEUE_REDIS_PREFIX:`claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT??String(37700+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_AUTH_MODE:"api-key",CLAUDE_MEM_RUNTIME:"worker",CLAUDE_MEM_SERVER_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_API_KEY:"",CLAUDE_MEM_SERVER_PROJECT_ID:"",CLAUDE_MEM_SERVER_BETA_URL:`http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT??String(37877+(process.getuid?.()??77)%100)}`,CLAUDE_MEM_SERVER_BETA_API_KEY:"",CLAUDE_MEM_SERVER_BETA_PROJECT_ID:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static applyEnvOverrides(e){let s={...e};for(let t of Object.keys(this.DEFAULTS))process.env[t]!==void 0&&(s[t]=process.env[t]);return s}static loadFromFile(e,s=!0){try{if(!(0,Q.existsSync)(e)){let a=this.getAllDefaults();try{ne(e,a),console.warn("[SETTINGS] Created settings file with defaults:",e)}catch(d){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,d instanceof Error?d.message:String(d))}return s?this.applyEnvOverrides(a):a}let t=(0,Q.readFileSync)(e,"utf-8"),n=k(t),o=n;if(n.env&&typeof n.env=="object"){o=n.env;try{ne(e,o),console.warn("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(a){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,a instanceof Error?a.message:String(a))}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))o[a]!==void 0&&(i[a]=o[a]);return s?this.applyEnvOverrides(i):i}catch(t){console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t instanceof Error?t.message:String(t));let n=this.getAllDefaults();return s?this.applyEnvOverrides(n):n}}};var X=require("fs"),z=require("path");var M=class r{static instance=null;activeMode=null;modesDir;constructor(){let e=Ae(),s=[...process.env.CLAUDE_MEM_MODES_DIR?[process.env.CLAUDE_MEM_MODES_DIR]:[],(0,z.join)(e,"modes"),(0,z.join)(e,"..","plugin","modes")],t=s.find(n=>(0,X.existsSync)(n));this.modesDir=t||s[0]}static getInstance(){return r.instance||(r.instance=new r),r.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let t={...e};for(let n in s){let o=s[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?t[n]=this.deepMerge(i,o):t[n]=o}return t}loadModeFile(e){let s=(0,z.join)(this.modesDir,`${e}.json`);if(!(0,X.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let t=(0,X.readFileSync)(s,"utf-8");return JSON.parse(t)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,E.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(_=>_.id),concepts:d.observation_concepts.map(_=>_.id)}),d}catch(d){if(d instanceof Error?E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:d.message}):E.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(d)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:t,overrideId:n}=s,o;try{o=this.loadMode(t)}catch(d){d instanceof Error?E.warn("WORKER",`Parent mode '${t}' not found for ${e}, falling back to 'code'`,{message:d.message}):E.warn("WORKER",`Parent mode '${t}' not found for ${e}, falling back to 'code'`,{error:String(d)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),E.debug("SYSTEM",`Loaded override file: ${n} for parent ${t}`)}catch(d){return d instanceof Error?E.warn("WORKER",`Override file '${n}' not found, using parent mode '${t}' only`,{message:d.message}):E.warn("WORKER",`Override file '${n}' not found, using parent mode '${t}' only`,{error:String(d)}),this.activeMode=o,o}if(!i)return E.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${t}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,E.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${t} + ${n})`,void 0,{parent:t,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}};function We(){let r=H.settings(),e=J.loadFromFile(r),s=M.getInstance().getActiveMode(),t=new Set(s.observation_types.map(o=>o.id)),n=new Set(s.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:t,observationConcepts:n,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var m={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},Ve=4,qe=1;function Ke(r){let e=(r.title?.length||0)+(r.subtitle?.length||0)+(r.narrative?.length||0)+JSON.stringify(r.facts||[]).length;return Math.ceil(e/Ve)}function Te(r){let e=r.length,s=r.reduce((i,a)=>i+Ke(a),0),t=r.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=t-s,o=t>0?Math.round(n/t*100):0;return{totalObservations:e,totalReadTokens:s,totalDiscoveryTokens:t,savings:n,savingsPercent:o}}function lt(r){return M.getInstance().getWorkEmoji(r)}function B(r,e){let s=Ke(r),t=r.discovery_tokens||0,n=lt(r.type),o=t>0?`${n} ${t.toLocaleString()}`:"-";return{readTokens:s,discoveryTokens:t,discoveryDisplay:o,workEmoji:n}}function Z(r){return r.showReadTokens||r.showWorkTokens||r.showSavingsAmount||r.showSavingsPercent}var Ye=$(require("path"),1),ee=require("fs");function Je(r,e,s,t){let n=Array.from(s.observationTypes),o=n.map(()=>"?").join(","),i=Array.from(s.observationConcepts),a=i.map(()=>"?").join(","),d=e.map(()=>"?").join(",");return r.db.prepare(`
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
  `).all(...e,...e,t??null,t??null,...n,...i,s.totalObservationCount)}function Qe(r,e,s,t){let n=e.map(()=>"?").join(",");return r.db.prepare(`
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
  `).all(...e,...e,t??null,t??null,s.sessionCount+qe)}function Tt(r){return r.replace(/[/.]/g,"-")}function gt(r){if(!r.includes('"type":"assistant"'))return null;let e=JSON.parse(r);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let s="";for(let t of e.message.content)t.type==="text"&&(s+=t.text);if(s=s.replace(ke,"").trim(),s)return s}return null}function St(r){for(let e=r.length-1;e>=0;e--)try{let s=gt(r[e]);if(s)return s}catch(s){s instanceof Error?E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},s):E.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(s)});continue}return""}function ft(r){try{if(!(0,ee.existsSync)(r))return{assistantMessage:""};let e=(0,ee.readFileSync)(r,"utf-8").trim();if(!e)return{assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim());return{assistantMessage:St(s)}}catch(e){return e instanceof Error?E.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r},e):E.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r,error:String(e)}),{assistantMessage:""}}}function ze(r,e,s,t){if(!e.showLastMessage||r.length===0)return{assistantMessage:""};let n=r.find(d=>d.memory_session_id!==s);if(!n)return{assistantMessage:""};let o=n.memory_session_id,i=Tt(t),a=Ye.default.join(ie,"projects",i,`${o}.jsonl`);return ft(a)}function Ze(r,e){let s=e[0]?.id;return r.map((t,n)=>{let o=n===0?null:e[n+1];return{...t,displayEpoch:o?o.created_at_epoch:t.created_at_epoch,displayTime:o?o.created_at:t.created_at,shouldShowLink:t.id!==s}})}function es(r,e){let s=[...r.map(t=>({type:"observation",data:t})),...e.map(t=>({type:"summary",data:t}))];return s.sort((t,n)=>{let o=t.type==="observation"?t.data.created_at_epoch:t.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),s}function ss(r,e){return new Set(r.slice(0,e).map(s=>s.id))}function ts(){let r=new Date,e=r.toLocaleDateString("en-CA"),s=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),t=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${t}`}function rs(r){return[`# [${r}] recent context, ${ts()}`,""]}function ns(){return[`Legend: \u{1F3AF}session ${M.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji}${s.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function os(r,e){let s=[],t=[`${r.totalObservations} obs (${r.totalReadTokens.toLocaleString()}t read)`,`${r.totalDiscoveryTokens.toLocaleString()}t work`];return r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?t.push(`${r.savingsPercent}% savings`):e.showSavingsAmount&&t.push(`${r.savings.toLocaleString()}t saved`)),s.push(`Stats: ${t.join(" | ")}`),s.push(""),s}function is(r){return[`### ${r}`]}function as(r){return r.toLowerCase().replace(" am","a").replace(" pm","p")}function ds(r,e,s){let t=r.title||"Untitled",n=M.getInstance().getTypeIcon(r.type),o=e?as(e):'"';return`${r.id} ${o} ${n} ${t}`}function _s(r,e,s,t){let n=[],o=r.title||"Untitled",i=M.getInstance().getTypeIcon(r.type),a=e?as(e):'"',{readTokens:d,discoveryDisplay:_}=B(r,t);n.push(`**${r.id}** ${a} ${i} **${o}**`),s&&n.push(s);let u=[];return t.showReadTokens&&u.push(`~${d}t`),t.showWorkTokens&&u.push(_),u.length>0&&n.push(u.join(" ")),n.push(""),n}function Es(r,e){return[`S${r.id} ${r.request||"Session started"} (${e})`]}function j(r,e){return e?[`**${r}**: ${e}`,""]:[]}function us(r){return r.assistantMessage?["","---","","**Previously**","",`A: ${r.assistantMessage}`,""]:[]}function ms(r,e){return["",`Access ${Math.round(r/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function cs(r){return`# [${r}] recent context, ${ts()}

No previous sessions found.`}function ps(){let r=new Date,e=r.toLocaleDateString("en-CA"),s=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),t=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${t}`}function ls(r){return["",`${m.bright}${m.cyan}[${r}] recent context, ${ps()}${m.reset}`,`${m.gray}${"\u2500".repeat(60)}${m.reset}`,""]}function Ts(){let e=M.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji} ${s.id}`).join(" | ");return[`${m.dim}Legend: session-request | ${e}${m.reset}`,""]}function gs(){return[`${m.bright}Column Key${m.reset}`,`${m.dim}  Read: Tokens to read this observation (cost to learn it now)${m.reset}`,`${m.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${m.reset}`,""]}function Ss(){return[`${m.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${m.reset}`,"",`${m.dim}When you need implementation details, rationale, or debugging context:${m.reset}`,`${m.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${m.reset}`,`${m.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${m.reset}`,`${m.dim}  - Trust this index over re-reading code for past decisions and learnings${m.reset}`,""]}function fs(r,e){let s=[];if(s.push(`${m.bright}${m.cyan}Context Economics${m.reset}`),s.push(`${m.dim}  Loading: ${r.totalObservations} observations (${r.totalReadTokens.toLocaleString()} tokens to read)${m.reset}`),s.push(`${m.dim}  Work investment: ${r.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${m.reset}`),r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let t="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?t+=`${r.savings.toLocaleString()} tokens (${r.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?t+=`${r.savings.toLocaleString()} tokens`:t+=`${r.savingsPercent}% reduction from reuse`,s.push(`${m.green}${t}${m.reset}`)}return s.push(""),s}function Rs(r){return[`${m.bright}${m.cyan}${r}${m.reset}`,""]}function Os(r){return[`${m.dim}${r}${m.reset}`]}function bs(r,e,s,t){let n=r.title||"Untitled",o=M.getInstance().getTypeIcon(r.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=B(r,t),_=s?`${m.dim}${e}${m.reset}`:" ".repeat(e.length),u=t.showReadTokens&&i>0?`${m.dim}(~${i}t)${m.reset}`:"",c=t.showWorkTokens&&a>0?`${m.dim}(${d} ${a.toLocaleString()}t)${m.reset}`:"";return`  ${m.dim}#${r.id}${m.reset}  ${_}  ${o}  ${n} ${u} ${c}`}function hs(r,e,s,t,n){let o=[],i=r.title||"Untitled",a=M.getInstance().getTypeIcon(r.type),{readTokens:d,discoveryTokens:_,workEmoji:u}=B(r,n),c=s?`${m.dim}${e}${m.reset}`:" ".repeat(e.length),p=n.showReadTokens&&d>0?`${m.dim}(~${d}t)${m.reset}`:"",g=n.showWorkTokens&&_>0?`${m.dim}(${u} ${_.toLocaleString()}t)${m.reset}`:"";return o.push(`  ${m.dim}#${r.id}${m.reset}  ${c}  ${a}  ${m.bright}${i}${m.reset}`),t&&o.push(`    ${m.dim}${t}${m.reset}`),(p||g)&&o.push(`    ${p} ${g}`),o.push(""),o}function Is(r,e){let s=`${r.request||"Session started"} (${e})`;return[`${m.yellow}#S${r.id}${m.reset} ${s}`,""]}function W(r,e,s){return e?[`${s}${r}:${m.reset} ${e}`,""]:[]}function Ns(r){return r.assistantMessage?["","---","",`${m.bright}${m.magenta}Previously${m.reset}`,"",`${m.dim}A: ${r.assistantMessage}${m.reset}`,""]:[]}function As(r,e){let s=Math.round(r/1e3);return["",`${m.dim}Access ${s}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${m.reset}`]}function Cs(r){return`
${m.bright}${m.cyan}[${r}] recent context, ${ps()}${m.reset}
${m.gray}${"\u2500".repeat(60)}${m.reset}

${m.dim}No previous sessions found for this project yet.${m.reset}
`}function Ls(r,e,s,t){let n=[];return t?n.push(...ls(r)):n.push(...rs(r)),t?n.push(...Ts()):n.push(...ns()),t&&(n.push(...gs()),n.push(...Ss())),Z(s)&&(t?n.push(...fs(e,s)):n.push(...os(e,s))),n}var ge=$(require("path"),1);function re(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[]}catch(e){return E.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:r?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function Se(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function fe(r){return new Date(r).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Ms(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ds(r,e){return ge.default.isAbsolute(r)?ge.default.relative(e,r):r}function vs(r,e,s){let t=re(r);if(t.length>0)return Ds(t[0],e);if(s){let n=re(s);if(n.length>0)return Ds(n[0],e)}return"General"}function Rt(r){let e=new Map;for(let t of r){let n=t.type==="observation"?t.data.created_at:t.data.displayTime,o=Ms(n);e.has(o)||e.set(o,[]),e.get(o).push(t)}let s=Array.from(e.entries()).sort((t,n)=>{let o=new Date(t[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(s)}function ys(r,e){return e.fullObservationField==="narrative"?r.narrative:r.facts?re(r.facts).join(`
`):null}function Ot(r,e,s,t){let n=[];n.push(...is(r));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=Se(a.displayTime);n.push(...Es(a,d))}else{let a=i.data,d=fe(a.created_at),u=d!==o?d:"";if(o=d,s.has(a.id)){let p=ys(a,t);n.push(..._s(a,u,p,t))}else n.push(ds(a,u,t))}return n}function bt(r,e,s,t,n){let o=[];o.push(...Rs(r));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let _=d.data,u=Se(_.displayTime);o.push(...Is(_,u))}else{let _=d.data,u=vs(_.files_modified,n,_.files_read),c=fe(_.created_at),p=c!==a;a=c;let g=s.has(_.id);if(u!==i&&(o.push(...Os(u)),i=u),g){let I=ys(_,t);o.push(...hs(_,c,p,I,t))}else o.push(bs(_,c,p,t))}return o.push(""),o}function ht(r,e,s,t,n,o){return o?bt(r,e,s,t,n):Ot(r,e,s,t)}function Us(r,e,s,t,n){let o=[],i=Rt(r);for(let[a,d]of i)o.push(...ht(a,d,e,s,t,n));return o}function xs(r,e,s){return!(!r.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||s&&e.created_at_epoch<=s.created_at_epoch)}function ks(r,e){let s=[];return e?(s.push(...W("Investigated",r.investigated,m.blue)),s.push(...W("Learned",r.learned,m.yellow)),s.push(...W("Completed",r.completed,m.green)),s.push(...W("Next Steps",r.next_steps,m.magenta))):(s.push(...j("Investigated",r.investigated)),s.push(...j("Learned",r.learned)),s.push(...j("Completed",r.completed)),s.push(...j("Next Steps",r.next_steps))),s}function ws(r,e){return e?Ns(r):us(r)}function Ps(r,e,s){return!Z(e)||r.totalDiscoveryTokens<=0||r.savings<=0?[]:s?As(r.totalDiscoveryTokens,r.totalReadTokens):ms(r.totalDiscoveryTokens,r.totalReadTokens)}var It=Fs.default.join((0,$s.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Nt(){try{return new K}catch(r){if(r instanceof Error&&r.code==="ERR_DLOPEN_FAILED"){try{(0,Hs.unlinkSync)(It)}catch(e){e instanceof Error?E.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):E.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return E.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw r}}function At(r,e){return e?Cs(r):cs(r)}function Ct(r,e,s,t,n,o,i){let a=[],d=Te(e);a.push(...Ls(r,d,t,i));let _=s.slice(0,t.sessionCount),u=Ze(_,s),c=es(e,u),p=ss(e,t.fullObservationCount);a.push(...Us(c,p,t,n,i));let g=s[0],I=e[0];xs(t,g,I)&&a.push(...ks(g,i));let h=ze(e,t,o,n);return a.push(...ws(h,i)),a.push(...Ps(d,t,i)),a.join(`
`).trimEnd()}var Lt=new Set(["bugfix","discovery","decision","refactor"]);function Dt(r,e,s){let t=Te(r),n={bugfix:0,discovery:0,decision:0,refactor:0,other:0},o=new Set,i=Number.POSITIVE_INFINITY;for(let d of r){let _=Lt.has(d.type)?d.type:"other";n[_]++,d.memory_session_id&&o.add(d.memory_session_id),d.created_at_epoch&&d.created_at_epoch<i&&(i=d.created_at_epoch)}let a=Number.isFinite(i)?Math.max(0,Math.floor((Date.now()-i)/864e5)):0;return{observation_count:r.length,session_count:o.size,timeline_depth_days:a,has_session_summary:e.length>0,obs_type_bugfix:n.bugfix,obs_type_discovery:n.discovery,obs_type_decision:n.decision,obs_type_refactor:n.refactor,obs_type_other:n.other,tokens_injected:t.totalReadTokens,tokens_saved_vs_naive:t.savings,search_strategy:s?"full":"timeline"}}async function Re(r,e=!1){let s=We(),t=r?.cwd??process.cwd(),n=Be(t),o=r?.projects?.length?r.projects:n.allProjects,i=o[o.length-1]??n.primary;r?.full&&(s.totalObservationCount=999999,s.sessionCount=999999);let a=Nt();if(!a)return{text:"",stats:null};try{let d=r?.platformSource?C(r.platformSource):void 0,_=o.length>1?o:[i],u=Je(a,_,s,d),c=Qe(a,_,s,d);return u.length===0&&c.length===0?{text:At(i,e),stats:null}:{text:Ct(i,u,c,s,t,r?.session_id,e),stats:Dt(u,c,!!r?.full)}}finally{a.close()}}async function Gs(r,e=!1){return(await Re(r,e)).text}0&&(module.exports={generateContext,generateContextWithStats});
