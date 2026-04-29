"use strict";var yt=Object.create;var G=Object.defineProperty;var Mt=Object.getOwnPropertyDescriptor;var vt=Object.getOwnPropertyNames;var Dt=Object.getPrototypeOf,Ut=Object.prototype.hasOwnProperty;var xt=(r,e)=>{for(var t in e)G(r,t,{get:e[t],enumerable:!0})},be=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of vt(e))!Ut.call(r,n)&&n!==t&&G(r,n,{get:()=>e[n],enumerable:!(s=Mt(e,n))||s.enumerable});return r};var y=(r,e,t)=>(t=r!=null?yt(Dt(r)):{},be(e||!r||!r.__esModule?G(t,"default",{value:r,enumerable:!0}):t,r)),wt=r=>be(G({},"__esModule",{value:!0}),r);var os={};xt(os,{generateContext:()=>fe});module.exports=wt(os);var Ct=y(require("path"),1),It=require("os"),Lt=require("fs");var oe=require("bun:sqlite");var h=require("path"),te=require("os"),H=require("fs");var Ae=require("url");var L=require("fs"),U=require("path"),Oe=require("os"),Z=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Z||{}),he=(0,U.join)((0,Oe.homedir)(),".claude-mem"),ee=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,U.join)(he,"logs");(0,L.existsSync)(e)||(0,L.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,U.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e instanceof Error?e.message:String(e)),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,U.join)(he,"settings.json");if((0,L.existsSync)(e)){let t=(0,L.readFileSync)(e,"utf-8"),n=(JSON.parse(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Z[n]??1}else this.level=1}catch(e){console.error("[LOGGER] Failed to load log level from settings:",e instanceof Error?e.message:String(e)),this.level=1}return this.level}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${o}:${i}:${a}.${d}`}log(e,t,s,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Z[e].padEnd(5),d=t.padEnd(6),c="";n?.correlationId?c=`[${n.correlationId}] `:n?.sessionId&&(c=`[session-${n.sessionId}] `);let u="";if(o!=null)if(o instanceof Error)u=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`;else if(this.getLevel()===0&&typeof o=="object")try{u=`
`+JSON.stringify(o,null,2)}catch{u=" "+this.formatData(o)}else u=" "+this.formatData(o);let T="";if(n){let{sessionId:g,memorySessionId:f,correlationId:S,...p}=n;Object.keys(p).length>0&&(T=` {${Object.entries(p).map(([b,l])=>`${b}=${l}`).join(", ")}}`)}let E=`[${i}] [${a}] [${d}] ${c}${s}${T}${u}`;if(this.logFilePath)try{(0,L.appendFileSync)(this.logFilePath,E+`
`,"utf8")}catch(g){process.stderr.write(`[LOGGER] Failed to write to log file: ${g instanceof Error?g.message:String(g)}
`)}else process.stderr.write(E+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}error(e,t,s,n){this.log(3,e,t,s,n)}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}timing(e,t,s,n){this.info(e,`\u23F1 ${t}`,n,{duration:`${s}ms`})}happyPathError(e,t,s,n,o=""){let c=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=c?`${c[1].split("/").pop()}:${c[2]}`:"unknown",T={...s,location:u};return this.warn(e,`[HAPPY-PATH] ${t}`,T,n),o}},m=new ee;var Gt={};function kt(){return typeof __dirname<"u"?__dirname:(0,h.dirname)((0,Ae.fileURLToPath)(Gt.url))}var Ft=kt();function $t(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let r=(0,h.join)((0,te.homedir)(),".claude-mem"),e=(0,h.join)(r,"settings.json");try{if((0,H.existsSync)(e)){let{readFileSync:t}=require("fs"),s=JSON.parse(t(e,"utf-8")),n=s.env??s;if(n.CLAUDE_MEM_DATA_DIR)return n.CLAUDE_MEM_DATA_DIR}}catch{}return r}var N=$t(),M=process.env.CLAUDE_CONFIG_DIR||(0,h.join)((0,te.homedir)(),".claude"),us=(0,h.join)(M,"plugins","marketplaces","thedotmack"),ms=(0,h.join)(N,"archives"),cs=(0,h.join)(N,"logs"),ls=(0,h.join)(N,"trash"),ps=(0,h.join)(N,"backups"),Es=(0,h.join)(N,"modes"),gs=(0,h.join)(N,"settings.json"),Re=(0,h.join)(N,"claude-mem.db"),Ts=(0,h.join)(N,"vector-db"),Pt=(0,h.join)(N,"observer-sessions"),se=(0,h.basename)(Pt),fs=(0,h.join)(M,"settings.json"),Ss=(0,h.join)(M,"commands"),bs=(0,h.join)(M,"CLAUDE.md");function Ne(r){(0,H.mkdirSync)(r,{recursive:!0})}function Ce(){return(0,h.join)(Ft,"..")}var ve=require("crypto");var Le=require("os"),ye=y(require("path"),1);var j=require("fs"),X=y(require("path"),1),x={isWorktree:!1,worktreeName:null,parentRepoPath:null,parentProjectName:null};function Ie(r){let e=X.default.join(r,".git"),t;try{t=(0,j.statSync)(e)}catch(u){return u instanceof Error&&u.code!=="ENOENT"&&console.warn("[worktree] Unexpected error checking .git:",u),x}if(!t.isFile())return x;let s;try{s=(0,j.readFileSync)(e,"utf-8").trim()}catch(u){return console.warn("[worktree] Failed to read .git file:",u instanceof Error?u.message:String(u)),x}let n=s.match(/^gitdir:\s*(.+)$/);if(!n)return x;let i=n[1].match(/^(.+)[/\\]\.git[/\\]worktrees[/\\]([^/\\]+)$/);if(!i)return x;let a=i[1],d=X.default.basename(r),c=X.default.basename(a);return{isWorktree:!0,worktreeName:d,parentRepoPath:a,parentProjectName:c}}function Me(r){return r==="~"||r.startsWith("~/")?r.replace(/^~/,(0,Le.homedir)()):r}function Ht(r){if(!r||r.trim()==="")return m.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:r}),"unknown-project";let e=Me(r),t=ye.default.basename(e);if(t===""){if(process.platform==="win32"){let n=r.match(/^([A-Z]):\\/i);if(n){let i=`drive-${n[1].toUpperCase()}`;return m.info("PROJECT_NAME","Drive root detected",{cwd:r,projectName:i}),i}}return m.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:r}),"unknown-project"}return t}function re(r){let e=Ht(r);if(!r)return{primary:e,parent:null,isWorktree:!1,allProjects:[e]};let t=Me(r),s=Ie(t);if(s.isWorktree&&s.parentProjectName){let n=`${s.parentProjectName}/${e}`;return{primary:n,parent:s.parentProjectName,isWorktree:!0,allProjects:[s.parentProjectName,n]}}return{primary:e,parent:null,isWorktree:!1,allProjects:[e]}}function B(r,e,t){return(0,ve.createHash)("sha256").update([r||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function ne(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[String(e)]}catch{return[r]}}var A="claude";function Xt(r){return r.trim().toLowerCase().replace(/\s+/g,"-")}function v(r){if(!r)return A;let e=Xt(r);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:A}function De(r){let e=["claude","codex","cursor"];return[...r].sort((t,s)=>{let n=e.indexOf(t),o=e.indexOf(s);return n!==-1||o!==-1?n===-1?1:o===-1?-1:n-o:t.localeCompare(s)})}function jt(r,e){return{customTitle:r,platformSource:e?v(e):void 0}}var W=class{db;constructor(e=Re){e instanceof oe.Database?this.db=e:(e!==":memory:"&&Ne(N),this.db=new oe.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.db.run("PRAGMA journal_size_limit = 4194304")),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.ensureMergedIntoProjectColumns(),this.addObservationSubagentColumns(),this.addPendingMessagesToolUseIdAndWorkerPidColumns(),this.addObservationsUniqueContentHashIndex(),this.addObservationsMetadataColumn()}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),m.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),m.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),m.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),m.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(s=>s.unique===1&&s.origin!=="pk")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}m.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),m.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}m.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),m.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}m.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),m.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}m.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
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
    `;try{this.db.run(s),this.db.run(n)}catch(o){o instanceof Error?m.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},o):m.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},new Error(String(o))),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),m.debug("DB","Created user_prompts table (without FTS5)");return}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),m.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),m.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),m.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}m.debug("DB","Creating pending_messages table"),this.db.run(`
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),m.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;m.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),m.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(m.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?m.debug("DB",`Successfully renamed ${t} session ID columns`):m.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),m.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21))return;m.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let s=this.db.query("PRAGMA table_info(observations)").all().some(f=>f.name==="metadata"),n=s?`,
        metadata TEXT`:"",o=s?", metadata":"",i=`
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
        created_at_epoch INTEGER NOT NULL${n},
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      )
    `,a=`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             discovery_tokens, created_at, created_at_epoch${o}
      FROM observations
    `,d=`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `,c=`
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
    `;this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let u=`
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
    `,T=`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, discovery_tokens, created_at, created_at_epoch
      FROM session_summaries
    `,E=`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `,g=`
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
    `;try{this.recreateObservationsWithCascade(i,a,d,c),this.recreateSessionSummariesWithCascade(u,T,E,g),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),m.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(f){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),f instanceof Error?f:new Error(String(f))}}recreateObservationsWithCascade(e,t,s,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(n)}recreateSessionSummariesWithCascade(e,t,s,n){this.db.run(e),this.db.run(t),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(s),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(n)}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),m.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),m.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),n=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&n||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${A}'`),m.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${A}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),n||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(n=>n.name==="generated_by_model"),s=e.some(n=>n.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}ensureMergedIntoProjectColumns(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE observations ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_merged_into ON observations(merged_into_project)"),this.db.query("PRAGMA table_info(session_summaries)").all().some(s=>s.name==="merged_into_project")||this.db.run("ALTER TABLE session_summaries ADD COLUMN merged_into_project TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_merged_into ON session_summaries(merged_into_project)")}addObservationSubagentColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(i=>i.name==="agent_type"),n=t.some(i=>i.name==="agent_id");s||this.db.run("ALTER TABLE observations ADD COLUMN agent_type TEXT"),n||this.db.run("ALTER TABLE observations ADD COLUMN agent_id TEXT"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id)");let o=this.db.query("PRAGMA table_info(pending_messages)").all();if(o.length>0){let i=o.some(d=>d.name==="agent_type"),a=o.some(d=>d.name==="agent_id");i||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_type TEXT"),a||this.db.run("ALTER TABLE pending_messages ADD COLUMN agent_id TEXT")}e||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}addPendingMessagesToolUseIdAndWorkerPidColumns(){if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString());return}let t=this.db.query("PRAGMA table_info(pending_messages)").all(),s=t.some(o=>o.name==="tool_use_id"),n=t.some(o=>o.name==="worker_pid");s||this.db.run("ALTER TABLE pending_messages ADD COLUMN tool_use_id TEXT"),n||this.db.run("ALTER TABLE pending_messages ADD COLUMN worker_pid INTEGER"),this.db.run("BEGIN TRANSACTION");try{this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_worker_pid ON pending_messages(worker_pid)"),this.db.run(`
        DELETE FROM pending_messages
         WHERE tool_use_id IS NOT NULL
           AND id NOT IN (
             SELECT MIN(id) FROM pending_messages
              WHERE tool_use_id IS NOT NULL
              GROUP BY content_session_id, tool_use_id
           )
      `),this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_session_tool
        ON pending_messages(content_session_id, tool_use_id)
        WHERE tool_use_id IS NOT NULL
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()),this.db.run("COMMIT")}catch(o){throw this.db.run("ROLLBACK"),o}}addObservationsUniqueContentHashIndex(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(29))return;let t=this.db.query("PRAGMA table_info(observations)").all(),s=t.some(o=>o.name==="memory_session_id"),n=t.some(o=>o.name==="content_hash");if(!s||!n){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString());return}this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        DELETE FROM observations
         WHERE id NOT IN (
           SELECT MIN(id) FROM observations
            GROUP BY memory_session_id, content_hash
         )
      `),this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_session_hash
        ON observations(memory_session_id, content_hash)
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(29,new Date().toISOString()),this.db.run("COMMIT")}catch(o){throw this.db.run("ROLLBACK"),o}}addObservationsMetadataColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="metadata")||(this.db.run("ALTER TABLE observations ADD COLUMN metadata TEXT"),m.debug("DB","Added metadata column to observations table (#2116)")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(30,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}markSessionCompleted(e){let t=Date.now(),s=new Date(t).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s,t,e)}ensureMemorySessionIdRegistered(e,t){let s=this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(e);if(!s)throw new Error(`Session ${e} not found in sdk_sessions`);s.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),m.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:s.memory_session_id,newId:t}))}getRecentSummaries(e,t=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentSummariesWithSessionInfo(e,t=3){return this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentObservations(e,t=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getAllRecentObservations(e=100){return this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${A}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentSummaries(e=50){return this.db.prepare(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${A}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentUserPrompts(e=100){return this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${A}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(e){let t=e?v(e):void 0,s=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
    `,n=[se];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",n.push(A,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...n).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${A}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
        AND project != ?
      GROUP BY COALESCE(platform_source, '${A}'), project
      ORDER BY latest_epoch DESC
    `).all(se),t=[],s=new Set,n={};for(let i of e){let a=v(i.platform_source);n[a]||(n[a]=[]),n[a].includes(i.project)||n[a].push(i.project),s.has(i.project)||(s.add(i.project),t.push(i.project))}let o=De(Object.keys(n));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,n[i]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${A}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getRecentSessionsWithStatus(e,t=3){return this.db.prepare(`
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
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(e,t)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o,type:i,concepts:a,files:d}=t,c=s==="relevance",u=c?"":`ORDER BY created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,T=n?`LIMIT ${n}`:"",E=e.map(()=>"?").join(","),g=[...e],f=[];if(o&&(f.push("project = ?"),g.push(o)),i)if(Array.isArray(i)){let l=i.map(()=>"?").join(",");f.push(`type IN (${l})`),g.push(...i)}else f.push("type = ?"),g.push(i);if(a){let l=Array.isArray(a)?a:[a],I=l.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");g.push(...l),f.push(`(${I.join(" OR ")})`)}if(d){let l=Array.isArray(d)?d:[d],I=l.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");l.forEach(D=>{g.push(`%${D}%`,`%${D}%`)}),f.push(`(${I.join(" OR ")})`)}let S=f.length>0?`WHERE id IN (${E}) AND ${f.join(" AND ")}`:`WHERE id IN (${E})`,O=this.db.prepare(`
      SELECT *
      FROM observations
      ${S}
      ${u}
      ${T}
    `).all(...g);if(!c)return O;let b=new Map(O.map(l=>[l.id,l]));return e.map(l=>b.get(l)).filter(l=>!!l)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let s=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).all(e),n=new Set,o=new Set;for(let i of s)ne(i.files_read).forEach(a=>n.add(a)),ne(i.files_modified).forEach(a=>o.add(a));return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${A}') as platform_source,
             user_prompt, custom_title, status
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${A}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${t})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,t,s,n,o){let i=new Date,a=i.getTime(),d=jt(n,o),c=d.platformSource??A,u=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(u){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(t,e),d.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(d.customTitle,e),d.platformSource){let E=u.platform_source?.trim()?v(u.platform_source):void 0;if(!E)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(d.platformSource,e);else if(E!==d.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${E}, received=${d.platformSource}`)}return u.id}return this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,c,s,d.customTitle||null,i.toISOString(),a),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,t,s){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,s,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,n,o=0,i,a){let d=i??Date.now(),c=new Date(d).toISOString(),u=B(e,s.title,s.narrative),E=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
       generated_by_model, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_session_id, content_hash) DO NOTHING
      RETURNING id, created_at_epoch
    `).get(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),n||null,o,s.agent_type??null,s.agent_id??null,u,c,d,a||null,s.metadata??null);if(E)return{id:E.id,createdAtEpoch:E.created_at_epoch};let g=this.db.prepare("SELECT id, created_at_epoch FROM observations WHERE memory_session_id = ? AND content_hash = ?").get(e,u);if(!g)throw new Error(`storeObservation: ON CONFLICT without existing row for content_hash=${u}`);return{id:g.id,createdAtEpoch:g.created_at_epoch}}storeSummary(e,t,s,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,n||null,o,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,o,i=0,a,d){let c=a??Date.now(),u=new Date(c).toISOString();return this.db.transaction(()=>{let E=[],g=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),f=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let p of s){let O=B(e,p.title,p.narrative),b=g.get(e,t,p.type,p.title,p.subtitle,JSON.stringify(p.facts),p.narrative,JSON.stringify(p.concepts),JSON.stringify(p.files_read),JSON.stringify(p.files_modified),o||null,i,p.agent_type??null,p.agent_id??null,O,u,c,d||null);if(b){E.push(b.id);continue}let l=f.get(e,O);if(!l)throw new Error(`storeObservations: ON CONFLICT without existing row for content_hash=${O}`);E.push(l.id)}let S=null;if(n){let O=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,u,c);S=Number(O.lastInsertRowid)}return{observationIds:E,summaryId:S,createdAtEpoch:c}})()}storeObservationsAndMarkComplete(e,t,s,n,o,i,a,d=0,c,u){let T=c??Date.now(),E=new Date(T).toISOString();return this.db.transaction(()=>{let f=[],S=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_session_id, content_hash) DO NOTHING
        RETURNING id
      `),p=this.db.prepare("SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?");for(let l of s){let I=B(e,l.title,l.narrative),D=S.get(e,t,l.type,l.title,l.subtitle,JSON.stringify(l.facts),l.narrative,JSON.stringify(l.concepts),JSON.stringify(l.files_read),JSON.stringify(l.files_modified),a||null,d,l.agent_type??null,l.agent_id??null,I,E,T,u||null);if(D){f.push(D.id);continue}let Se=p.get(e,I);if(!Se)throw new Error(`storeObservationsAndMarkComplete: ON CONFLICT without existing row for content_hash=${I}`);f.push(Se.id)}let O;if(n){let I=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,a||null,d,E,T);O=Number(I.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(T,o),{observationIds:f,summaryId:O,createdAtEpoch:T}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o}=t,i=s==="relevance",a=i?"":`ORDER BY created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),u=[...e],T=o?`WHERE id IN (${c}) AND project = ?`:`WHERE id IN (${c})`;o&&u.push(o);let g=this.db.prepare(`
      SELECT * FROM session_summaries
      ${T}
      ${a}
      ${d}
    `).all(...u);if(!i)return g;let f=new Map(g.map(S=>[S.id,S]));return e.map(S=>f.get(S)).filter(S=>!!S)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o}=t,i=s==="relevance",a=i?"":`ORDER BY up.created_at_epoch ${s==="date_asc"?"ASC":"DESC"}`,d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(","),u=[...e],T=o?"AND s.project = ?":"";o&&u.push(o);let g=this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${c}) ${T}
      ${a}
      ${d}
    `).all(...u);if(!i)return g;let f=new Map(g.map(S=>[S.id,S]));return e.map(S=>f.get(S)).filter(S=>!!S)}getTimelineAroundTimestamp(e,t=10,s=10,n){return this.getTimelineAroundObservation(null,e,t,s,n)}getTimelineAroundObservation(e,t,s=10,n=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],d,c;if(e!==null){let p=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,O=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let b=this.db.prepare(p).all(e,...a,s+1),l=this.db.prepare(O).all(e,...a,n+1);if(b.length===0&&l.length===0)return{observations:[],sessions:[],prompts:[]};d=b.length>0?b[b.length-1].created_at_epoch:t,c=l.length>0?l[l.length-1].created_at_epoch:t}catch(b){return b instanceof Error?m.error("DB","Error getting boundary observations",{project:o},b):m.error("DB","Error getting boundary observations with non-Error",{},new Error(String(b))),{observations:[],sessions:[],prompts:[]}}}else{let p=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,O=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let b=this.db.prepare(p).all(t,...a,s),l=this.db.prepare(O).all(t,...a,n+1);if(b.length===0&&l.length===0)return{observations:[],sessions:[],prompts:[]};d=b.length>0?b[b.length-1].created_at_epoch:t,c=l.length>0?l[l.length-1].created_at_epoch:t}catch(b){return b instanceof Error?m.error("DB","Error getting boundary timestamps",{project:o},b):m.error("DB","Error getting boundary timestamps with non-Error",{},new Error(String(b))),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,T=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,E=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,g=this.db.prepare(u).all(d,c,...a),f=this.db.prepare(T).all(d,c,...a),S=this.db.prepare(E).all(d,c,...a);return{observations:g,sessions:f.map(p=>({id:p.id,memory_session_id:p.memory_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:S.map(p=>({id:p.id,content_session_id:p.content_session_id,prompt_number:p.prompt_number,prompt_text:p.prompt_text,project:p.project,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${t})
      ORDER BY p.created_at_epoch DESC
    `).all(...e)}getSessionSummaryById(e){return this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getOrCreateManualSession(e){let t=`manual-${e}`,s=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(t))return t;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(t,s,e,A,o.toISOString(),o.getTime()),m.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,v(e.platform_source),e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let t=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
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
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.agent_type??null,e.agent_id??null,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Ue=y(require("path"),1),xe=require("os");var C=require("fs"),w=require("path"),ie=require("os"),q=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-6",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:String(37700+(process.getuid?.()??77)%100),CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_DATA_DIR:(0,w.join)((0,ie.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,w.join)((0,ie.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD:"3",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_TELEGRAM_ENABLED:"true",CLAUDE_MEM_TELEGRAM_BOT_TOKEN:"",CLAUDE_MEM_TELEGRAM_CHAT_ID:"",CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES:"security_alert",CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){let t=this.get(e);return t==="true"||t===!0}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e){try{if(!(0,C.existsSync)(e)){let i=this.getAllDefaults();try{let a=(0,w.dirname)(e);(0,C.existsSync)(a)||(0,C.mkdirSync)(a,{recursive:!0}),(0,C.writeFileSync)(e,JSON.stringify(i,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(a){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,a instanceof Error?a.message:String(a))}return this.applyEnvOverrides(i)}let t=(0,C.readFileSync)(e,"utf-8"),s=JSON.parse(t),n=s;if(s.env&&typeof s.env=="object"){n=s.env;try{(0,C.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(i){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,i instanceof Error?i.message:String(i))}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))n[i]!==void 0&&(o[i]=n[i]);return this.applyEnvOverrides(o)}catch(t){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t instanceof Error?t.message:String(t)),this.applyEnvOverrides(this.getAllDefaults())}}};var k=require("fs"),Y=require("path");var R=class r{static instance=null;activeMode=null;modesDir;constructor(){let e=Ce(),t=[(0,Y.join)(e,"modes"),(0,Y.join)(e,"..","plugin","modes")],s=t.find(n=>(0,k.existsSync)(n));this.modesDir=s||t[0]}static getInstance(){return r.instance||(r.instance=new r),r.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?s[n]=this.deepMerge(i,o):s[n]=o}return s}loadModeFile(e){let t=(0,Y.join)(this.modesDir,`${e}.json`);if(!(0,k.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,k.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,m.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(c=>c.id),concepts:d.observation_concepts.map(c=>c.id)}),d}catch(d){if(d instanceof Error?m.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{message:d.message}):m.warn("WORKER",`Mode file not found: ${e}, falling back to 'code'`,{error:String(d)}),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:n}=t,o;try{o=this.loadMode(s)}catch(d){d instanceof Error?m.warn("WORKER",`Parent mode '${s}' not found for ${e}, falling back to 'code'`,{message:d.message}):m.warn("WORKER",`Parent mode '${s}' not found for ${e}, falling back to 'code'`,{error:String(d)}),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),m.debug("SYSTEM",`Loaded override file: ${n} for parent ${s}`)}catch(d){return d instanceof Error?m.warn("WORKER",`Override file '${n}' not found, using parent mode '${s}' only`,{message:d.message}):m.warn("WORKER",`Override file '${n}' not found, using parent mode '${s}' only`,{error:String(d)}),this.activeMode=o,o}if(!i)return m.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${s}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,m.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${s} + ${n})`,void 0,{parent:s,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(s=>s.id===e)?.label||e}};function ae(){let r=Ue.default.join((0,xe.homedir)(),".claude-mem","settings.json"),e=q.loadFromFile(r),t=R.getInstance().getActiveMode(),s=new Set(t.observation_types.map(o=>o.id)),n=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:s,observationConcepts:n,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var _={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},we=4,de=1;function _e(r){let e=(r.title?.length||0)+(r.subtitle?.length||0)+(r.narrative?.length||0)+JSON.stringify(r.facts||[]).length;return Math.ceil(e/we)}function ue(r){let e=r.length,t=r.reduce((i,a)=>i+_e(a),0),s=r.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=s-t,o=s>0?Math.round(n/s*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:s,savings:n,savingsPercent:o}}function Bt(r){return R.getInstance().getWorkEmoji(r)}function F(r,e){let t=_e(r),s=r.discovery_tokens||0,n=Bt(r.type),o=s>0?`${n} ${s.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:s,discoveryDisplay:o,workEmoji:n}}function V(r){return r.showReadTokens||r.showWorkTokens||r.showSavingsAmount||r.showSavingsPercent}var Fe=y(require("path"),1),K=require("fs");var Wt=["private","claude-mem-context","system_instruction","system-instruction","persisted-output","system-reminder"],Ks=new RegExp(`<(${Wt.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`,"g"),ke=/<system-reminder>[\s\S]*?<\/system-reminder>/g;var qt=["task-notification"],Js=new RegExp(`^\\s*<(${qt.join("|")})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`),Qs=256*1024;function me(r,e,t){let s=Array.from(t.observationTypes),n=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(",");return r.db.prepare(`
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
      o.created_at_epoch
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project = ? OR o.merged_into_project = ?)
      AND type IN (${n})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${i})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(e,e,...s,...o,t.totalObservationCount)}function ce(r,e,t){return r.db.prepare(`
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
      ss.created_at_epoch
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project = ? OR ss.merged_into_project = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(e,e,t.sessionCount+de)}function $e(r,e,t){let s=Array.from(t.observationTypes),n=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return r.db.prepare(`
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
      AND type IN (${n})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${i})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,...s,...o,t.totalObservationCount)}function Pe(r,e,t){let s=e.map(()=>"?").join(",");return r.db.prepare(`
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
    WHERE (ss.project IN (${s})
           OR ss.merged_into_project IN (${s}))
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...e,t.sessionCount+de)}function Yt(r){return r.replace(/\//g,"-")}function Vt(r){if(!r.includes('"type":"assistant"'))return null;let e=JSON.parse(r);if(e.type==="assistant"&&e.message?.content&&Array.isArray(e.message.content)){let t="";for(let s of e.message.content)s.type==="text"&&(t+=s.text);if(t=t.replace(ke,"").trim(),t)return t}return null}function Kt(r){for(let e=r.length-1;e>=0;e--)try{let t=Vt(r[e]);if(t)return t}catch(t){t instanceof Error?m.debug("WORKER","Skipping malformed transcript line",{lineIndex:e},t):m.debug("WORKER","Skipping malformed transcript line",{lineIndex:e,error:String(t)});continue}return""}function Jt(r){try{if(!(0,K.existsSync)(r))return{userMessage:"",assistantMessage:""};let e=(0,K.readFileSync)(r,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim());return{userMessage:"",assistantMessage:Kt(t)}}catch(e){return e instanceof Error?m.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r},e):m.warn("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r,error:String(e)}),{userMessage:"",assistantMessage:""}}}function le(r,e,t,s){if(!e.showLastMessage||r.length===0)return{userMessage:"",assistantMessage:""};let n=r.find(d=>d.memory_session_id!==t);if(!n)return{userMessage:"",assistantMessage:""};let o=n.memory_session_id,i=Yt(s),a=Fe.default.join(M,"projects",i,`${o}.jsonl`);return Jt(a)}function Ge(r,e){let t=e[0]?.id;return r.map((s,n)=>{let o=n===0?null:e[n+1];return{...s,displayEpoch:o?o.created_at_epoch:s.created_at_epoch,displayTime:o?o.created_at:s.created_at,shouldShowLink:s.id!==t}})}function pe(r,e){let t=[...r.map(s=>({type:"observation",data:s})),...e.map(s=>({type:"summary",data:s}))];return t.sort((s,n)=>{let o=s.type==="observation"?s.data.created_at_epoch:s.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function He(r,e){return new Set(r.slice(0,e).map(t=>t.id))}function Xe(){let r=new Date,e=r.toLocaleDateString("en-CA"),t=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function je(r){return[`# [${r}] recent context, ${Xe()}`,""]}function Be(){return[`Legend: \u{1F3AF}session ${R.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji}${t.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function We(){return[]}function qe(){return[]}function Ye(r,e){let t=[],s=[`${r.totalObservations} obs (${r.totalReadTokens.toLocaleString()}t read)`,`${r.totalDiscoveryTokens.toLocaleString()}t work`];return r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?s.push(`${r.savingsPercent}% savings`):e.showSavingsAmount&&s.push(`${r.savings.toLocaleString()}t saved`)),t.push(`Stats: ${s.join(" | ")}`),t.push(""),t}function Ve(r){return[`### ${r}`]}function Ke(r){return r.toLowerCase().replace(" am","a").replace(" pm","p")}function Je(r,e,t){let s=r.title||"Untitled",n=R.getInstance().getTypeIcon(r.type),o=e?Ke(e):'"';return`${r.id} ${o} ${n} ${s}`}function Qe(r,e,t,s){let n=[],o=r.title||"Untitled",i=R.getInstance().getTypeIcon(r.type),a=e?Ke(e):'"',{readTokens:d,discoveryDisplay:c}=F(r,s);n.push(`**${r.id}** ${a} ${i} **${o}**`),t&&n.push(t);let u=[];return s.showReadTokens&&u.push(`~${d}t`),s.showWorkTokens&&u.push(c),u.length>0&&n.push(u.join(" ")),n.push(""),n}function ze(r,e){return[`S${r.id} ${r.request||"Session started"} (${e})`]}function $(r,e){return e?[`**${r}**: ${e}`,""]:[]}function Ze(r){return r.assistantMessage?["","---","","**Previously**","",`A: ${r.assistantMessage}`,""]:[]}function et(r,e){return["",`Access ${Math.round(r/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function tt(r){return`# [${r}] recent context, ${Xe()}

No previous sessions found.`}function st(){let r=new Date,e=r.toLocaleDateString("en-CA"),t=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function rt(r){return["",`${_.bright}${_.cyan}[${r}] recent context, ${st()}${_.reset}`,`${_.gray}${"\u2500".repeat(60)}${_.reset}`,""]}function nt(){let e=R.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${_.dim}Legend: session-request | ${e}${_.reset}`,""]}function ot(){return[`${_.bright}Column Key${_.reset}`,`${_.dim}  Read: Tokens to read this observation (cost to learn it now)${_.reset}`,`${_.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${_.reset}`,""]}function it(){return[`${_.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${_.reset}`,"",`${_.dim}When you need implementation details, rationale, or debugging context:${_.reset}`,`${_.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${_.reset}`,`${_.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${_.reset}`,`${_.dim}  - Trust this index over re-reading code for past decisions and learnings${_.reset}`,""]}function at(r,e){let t=[];if(t.push(`${_.bright}${_.cyan}Context Economics${_.reset}`),t.push(`${_.dim}  Loading: ${r.totalObservations} observations (${r.totalReadTokens.toLocaleString()} tokens to read)${_.reset}`),t.push(`${_.dim}  Work investment: ${r.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${_.reset}`),r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${r.savings.toLocaleString()} tokens (${r.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?s+=`${r.savings.toLocaleString()} tokens`:s+=`${r.savingsPercent}% reduction from reuse`,t.push(`${_.green}${s}${_.reset}`)}return t.push(""),t}function dt(r){return[`${_.bright}${_.cyan}${r}${_.reset}`,""]}function _t(r){return[`${_.dim}${r}${_.reset}`]}function ut(r,e,t,s){let n=r.title||"Untitled",o=R.getInstance().getTypeIcon(r.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=F(r,s),c=t?`${_.dim}${e}${_.reset}`:" ".repeat(e.length),u=s.showReadTokens&&i>0?`${_.dim}(~${i}t)${_.reset}`:"",T=s.showWorkTokens&&a>0?`${_.dim}(${d} ${a.toLocaleString()}t)${_.reset}`:"";return`  ${_.dim}#${r.id}${_.reset}  ${c}  ${o}  ${n} ${u} ${T}`}function mt(r,e,t,s,n){let o=[],i=r.title||"Untitled",a=R.getInstance().getTypeIcon(r.type),{readTokens:d,discoveryTokens:c,workEmoji:u}=F(r,n),T=t?`${_.dim}${e}${_.reset}`:" ".repeat(e.length),E=n.showReadTokens&&d>0?`${_.dim}(~${d}t)${_.reset}`:"",g=n.showWorkTokens&&c>0?`${_.dim}(${u} ${c.toLocaleString()}t)${_.reset}`:"";return o.push(`  ${_.dim}#${r.id}${_.reset}  ${T}  ${a}  ${_.bright}${i}${_.reset}`),s&&o.push(`    ${_.dim}${s}${_.reset}`),(E||g)&&o.push(`    ${E} ${g}`),o.push(""),o}function ct(r,e){let t=`${r.request||"Session started"} (${e})`;return[`${_.yellow}#S${r.id}${_.reset} ${t}`,""]}function P(r,e,t){return e?[`${t}${r}:${_.reset} ${e}`,""]:[]}function lt(r){return r.assistantMessage?["","---","",`${_.bright}${_.magenta}Previously${_.reset}`,"",`${_.dim}A: ${r.assistantMessage}${_.reset}`,""]:[]}function pt(r,e){let t=Math.round(r/1e3);return["",`${_.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${_.reset}`]}function Et(r){return`
${_.bright}${_.cyan}[${r}] recent context, ${st()}${_.reset}
${_.gray}${"\u2500".repeat(60)}${_.reset}

${_.dim}No previous sessions found for this project yet.${_.reset}
`}function gt(r,e,t,s){let n=[];return s?n.push(...rt(r)):n.push(...je(r)),s?n.push(...nt()):n.push(...Be()),s?n.push(...ot()):n.push(...We()),s?n.push(...it()):n.push(...qe()),V(t)&&(s?n.push(...at(e,t)):n.push(...Ye(e,t))),n}var Ee=y(require("path"),1);function z(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[]}catch(e){return m.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:r?.substring(0,50)},e instanceof Error?e:new Error(String(e))),[]}}function ge(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Te(r){return new Date(r).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ft(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Tt(r,e){return Ee.default.isAbsolute(r)?Ee.default.relative(e,r):r}function St(r,e,t){let s=z(r);if(s.length>0)return Tt(s[0],e);if(t){let n=z(t);if(n.length>0)return Tt(n[0],e)}return"General"}function Qt(r){let e=new Map;for(let s of r){let n=s.type==="observation"?s.data.created_at:s.data.displayTime,o=ft(n);e.has(o)||e.set(o,[]),e.get(o).push(s)}let t=Array.from(e.entries()).sort((s,n)=>{let o=new Date(s[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function bt(r,e){return e.fullObservationField==="narrative"?r.narrative:r.facts?z(r.facts).join(`
`):null}function zt(r,e,t,s){let n=[];n.push(...Ve(r));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=ge(a.displayTime);n.push(...ze(a,d))}else{let a=i.data,d=Te(a.created_at),u=d!==o?d:"";if(o=d,t.has(a.id)){let E=bt(a,s);n.push(...Qe(a,u,E,s))}else n.push(Je(a,u,s))}return n}function Zt(r,e,t,s,n){let o=[];o.push(...dt(r));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let c=d.data,u=ge(c.displayTime);o.push(...ct(c,u))}else{let c=d.data,u=St(c.files_modified,n,c.files_read),T=Te(c.created_at),E=T!==a;a=T;let g=t.has(c.id);if(u!==i&&(o.push(..._t(u)),i=u),g){let f=bt(c,s);o.push(...mt(c,T,E,f,s))}else o.push(ut(c,T,E,s))}return o.push(""),o}function es(r,e,t,s,n,o){return o?Zt(r,e,t,s,n):zt(r,e,t,s)}function ht(r,e,t,s,n){let o=[],i=Qt(r);for(let[a,d]of i)o.push(...es(a,d,e,t,s,n));return o}function Ot(r,e,t){return!(!r.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function At(r,e){let t=[];return e?(t.push(...P("Investigated",r.investigated,_.blue)),t.push(...P("Learned",r.learned,_.yellow)),t.push(...P("Completed",r.completed,_.green)),t.push(...P("Next Steps",r.next_steps,_.magenta))):(t.push(...$("Investigated",r.investigated)),t.push(...$("Learned",r.learned)),t.push(...$("Completed",r.completed)),t.push(...$("Next Steps",r.next_steps))),t}function Rt(r,e){return e?lt(r):Ze(r)}function Nt(r,e,t){return!V(e)||r.totalDiscoveryTokens<=0||r.savings<=0?[]:t?pt(r.totalDiscoveryTokens,r.totalReadTokens):et(r.totalDiscoveryTokens,r.totalReadTokens)}var ts=Ct.default.join((0,It.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function ss(){try{return new W}catch(r){if(r instanceof Error&&r.code==="ERR_DLOPEN_FAILED"){try{(0,Lt.unlinkSync)(ts)}catch(e){e instanceof Error?m.debug("WORKER","Marker file cleanup failed (may not exist)",{},e):m.debug("WORKER","Marker file cleanup failed (may not exist)",{error:String(e)})}return m.error("WORKER","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw r}}function rs(r,e){return e?Et(r):tt(r)}function ns(r,e,t,s,n,o,i){let a=[],d=ue(e);a.push(...gt(r,d,s,i));let c=t.slice(0,s.sessionCount),u=Ge(c,t),T=pe(e,u),E=He(e,s.fullObservationCount);a.push(...ht(T,E,s,n,i));let g=t[0],f=e[0];Ot(s,g,f)&&a.push(...At(g,i));let S=le(e,s,o,n);return a.push(...Rt(S,i)),a.push(...Nt(d,s,i)),a.join(`
`).trimEnd()}async function fe(r,e=!1){let t=ae(),s=r?.cwd??process.cwd(),n=re(s),o=r?.projects?.length?r.projects:n.allProjects,i=o[o.length-1]??n.primary;r?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let a=ss();if(!a)return"";try{let d=o.length>1?$e(a,o,t):me(a,i,t),c=o.length>1?Pe(a,o,t):ce(a,i,t);return d.length===0&&c.length===0?rs(i,e):ns(i,d,c,t,s,r?.session_id,e)}finally{a.close()}}0&&(module.exports={generateContext});
