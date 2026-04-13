"use strict";var As=Object.create;var w=Object.defineProperty;var hs=Object.getOwnPropertyDescriptor;var Is=Object.getOwnPropertyNames;var Ls=Object.getPrototypeOf,Cs=Object.prototype.hasOwnProperty;var vs=(n,e)=>{for(var s in e)w(n,s,{get:e[s],enumerable:!0})},pe=(n,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Is(e))!Cs.call(n,r)&&r!==s&&w(n,r,{get:()=>e[r],enumerable:!(t=hs(e,r))||t.enumerable});return n};var D=(n,e,s)=>(s=n!=null?As(Ls(n)):{},pe(e||!n||!n.__esModule?w(s,"default",{value:n,enumerable:!0}):s,n)),Ds=n=>pe(w({},"__esModule",{value:!0}),n);var Js={};vs(Js,{generateContext:()=>ue});module.exports=Ds(Js);var Ns=D(require("path"),1),Ss=require("os"),Rs=require("fs");var Oe=require("bun:sqlite");var b=require("path"),Q=require("os"),X=require("fs");var ge=require("url");var L=require("fs"),y=require("path"),Te=require("os"),J=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(J||{}),le=(0,y.join)((0,Te.homedir)(),".claude-mem"),z=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,y.join)(le,"logs");(0,L.existsSync)(e)||(0,L.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,y.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,y.join)(le,"settings.json");if((0,L.existsSync)(e)){let s=(0,L.readFileSync)(e,"utf-8"),r=(JSON.parse(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=J[r]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${r} ${o}:${i}:${a}.${d}`}log(e,s,t,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=J[e].padEnd(5),d=s.padEnd(6),m="";r?.correlationId?m=`[${r.correlationId}] `:r?.sessionId&&(m=`[session-${r.sessionId}] `);let u="";o!=null&&(o instanceof Error?u=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?u=`
`+JSON.stringify(o,null,2):u=" "+this.formatData(o));let p="";if(r){let{sessionId:g,memorySessionId:R,correlationId:f,...c}=r;Object.keys(c).length>0&&(p=` {${Object.entries(c).map(([T,S])=>`${T}=${S}`).join(", ")}}`)}let l=`[${i}] [${a}] [${d}] ${m}${t}${p}${u}`;if(this.logFilePath)try{(0,L.appendFileSync)(this.logFilePath,l+`
`,"utf8")}catch(g){process.stderr.write(`[LOGGER] Failed to write to log file: ${g}
`)}else process.stderr.write(l+`
`)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}happyPathError(e,s,t,r,o=""){let m=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=m?`${m[1].split("/").pop()}:${m[2]}`:"unknown",p={...t,location:u};return this.warn(e,`[HAPPY-PATH] ${s}`,p,r),o}},_=new z;var xs={};function ys(){return typeof __dirname<"u"?__dirname:(0,b.dirname)((0,ge.fileURLToPath)(xs.url))}var Ms=ys();function Us(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let n=(0,b.join)((0,Q.homedir)(),".claude-mem"),e=(0,b.join)(n,"settings.json");try{if((0,X.existsSync)(e)){let{readFileSync:s}=require("fs"),t=JSON.parse(s(e,"utf-8")),r=t.env??t;if(r.CLAUDE_MEM_DATA_DIR)return r.CLAUDE_MEM_DATA_DIR}}catch{}return n}var h=Us(),C=process.env.CLAUDE_CONFIG_DIR||(0,b.join)((0,Q.homedir)(),".claude"),st=(0,b.join)(C,"plugins","marketplaces","thedotmack"),tt=(0,b.join)(h,"archives"),rt=(0,b.join)(h,"logs"),nt=(0,b.join)(h,"trash"),ot=(0,b.join)(h,"backups"),it=(0,b.join)(h,"modes"),at=(0,b.join)(h,"settings.json"),be=(0,b.join)(h,"claude-mem.db"),dt=(0,b.join)(h,"vector-db"),_t=(0,b.join)(h,"observer-sessions"),Et=(0,b.join)(C,"settings.json"),mt=(0,b.join)(C,"commands"),ut=(0,b.join)(C,"CLAUDE.md");function fe(n){(0,X.mkdirSync)(n,{recursive:!0})}function Ne(){return(0,b.join)(Ms,"..")}var Se=require("crypto");var Fs=3e4;function P(n,e,s){return(0,Se.createHash)("sha256").update([n||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}function G(n,e,s){let t=s-Fs;return n.prepare("SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?").get(e,t)}function Z(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[String(e)]}catch{return[n]}}var N="claude";function ks(n){return n.trim().toLowerCase().replace(/\s+/g,"-")}function v(n){if(!n)return N;let e=ks(n);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:N}function Re(n){let e=["claude","codex","cursor"];return[...n].sort((s,t)=>{let r=e.indexOf(s),o=e.indexOf(t);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:s.localeCompare(t)})}var $=class{constructor(e){this.db=e}db;runAllMigrations(){this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.createObservationFeedbackTable(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.addTemporalScoringColumns()}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),_.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),_.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(t=>t.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}_.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),_.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}_.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),_.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}_.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),_.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}_.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `);try{this.db.run(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        );
      `),this.db.run(`
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
      `)}catch(t){_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},t)}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}_.debug("DB","Creating pending_messages table"),this.db.run(`
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
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),_.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;_.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),_.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(_.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?_.debug("DB",`Successfully renamed ${s} session ID columns`):_.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addTemporalScoringColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27))return;let s=this.db.query("PRAGMA table_info(observations)").all(),t=new Set(s.map(r=>r.name));t.has("last_accessed_at")||this.db.run("ALTER TABLE observations ADD COLUMN last_accessed_at INTEGER"),t.has("access_count")||this.db.run("ALTER TABLE observations ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0"),t.has("importance")||this.db.run("ALTER TABLE observations ADD COLUMN importance INTEGER NOT NULL DEFAULT 5"),t.has("is_stale")||this.db.run("ALTER TABLE observations ADD COLUMN is_stale INTEGER NOT NULL DEFAULT 0"),t.has("corrected_by_id")||this.db.run("ALTER TABLE observations ADD COLUMN corrected_by_id INTEGER"),_.debug("DB","Ensured temporal scoring columns on observations table"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),_.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(!this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)){_.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
      `),this.db.run(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(`
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
        `),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
      `),this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(`
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
        `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),_.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(s){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),s}}}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),_.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),_.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}createObservationFeedbackTable(){this.db.query("SELECT 1 FROM schema_versions WHERE version = 24").get()||(this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        session_db_id INTEGER,
        created_at_epoch INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_observation ON observation_feedback(observation_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_feedback_signal ON observation_feedback(signal_type)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()),_.debug("DB","Created observation_feedback table for usage tracking"))}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(25)&&s&&r||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${N}'`),_.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${N}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(25,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(o=>o.name==="generated_by_model"),t=e.some(o=>o.name==="relevance_count"),r=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(26);s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),!(r&&s&&t)&&this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString())}};function ws(n,e){return{customTitle:n,platformSource:e?v(e):void 0}}var B=class{db;constructor(e=be){e!==":memory:"&&fe(h),this.db=new Oe.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),new $(this.db).runAllMigrations()}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),_.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),_.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),_.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(t=>t.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}_.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),_.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}_.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),_.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}_.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),_.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}_.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `);try{this.db.run(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        );
      `),this.db.run(`
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
      `)}catch(t){_.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},t)}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),_.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),_.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}_.debug("DB","Creating pending_messages table"),this.db.run(`
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
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),_.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;_.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),_.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(_.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?_.debug("DB",`Successfully renamed ${s} session ID columns`):_.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),_.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(!this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)){_.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
      `),this.db.run(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(`
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
        `),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
      `),this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(`
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
        `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),_.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(s){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),s}}}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),_.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),_.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&r||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${N}'`),_.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${N}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(r=>r.name==="generated_by_model"),t=e.some(r=>r.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}updateMemorySessionId(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(s,e)}markSessionCompleted(e){let s=Date.now(),t=new Date(s).toISOString();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t,s,e)}ensureMemorySessionIdRegistered(e,s){let t=this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t)throw new Error(`Session ${e} not found in sdk_sessions`);t.memory_session_id!==s&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),_.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:t.memory_session_id,newId:s}))}getRecentSummaries(e,s=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentSummariesWithSessionInfo(e,s=3){return this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentObservations(e,s=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getAllRecentObservations(e=100){return this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${N}') as platform_source,
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
        COALESCE(s.platform_source, '${N}') as platform_source,
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
        COALESCE(s.platform_source, '${N}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(e){let s=e?v(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
    `,r=[];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",r.push(N,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${N}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      GROUP BY COALESCE(platform_source, '${N}'), project
      ORDER BY latest_epoch DESC
    `).all(),s=[],t=new Set,r={};for(let i of e){let a=v(i.platform_source);r[a]||(r[a]=[]),r[a].includes(i.project)||r[a].push(i.project),t.has(i.project)||(t.add(i.project),s.push(i.project))}let o=Re(Object.keys(r));return{projects:s,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${N}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).all(e,s)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}markObservationStale(e,s){this.db.prepare("UPDATE observations SET is_stale = 1, corrected_by_id = ? WHERE id = ?").run(s,e)}setObservationImportance(e,s){let t=Math.min(10,Math.max(1,Math.round(s)));this.db.prepare("UPDATE observations SET importance = ? WHERE id = ?").run(t,e)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:o,type:i,concepts:a,files:d}=s,m=t==="date_asc"?"ASC":"DESC",u=r?`LIMIT ${r}`:"",p=e.map(()=>"?").join(","),l=[...e],g=[];if(o&&(g.push("project = ?"),l.push(o)),i)if(Array.isArray(i)){let c=i.map(()=>"?").join(",");g.push(`type IN (${c})`),l.push(...i)}else g.push("type = ?"),l.push(i);if(a){let c=Array.isArray(a)?a:[a],A=c.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");l.push(...c),g.push(`(${A.join(" OR ")})`)}if(d){let c=Array.isArray(d)?d:[d],A=c.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");c.forEach(T=>{l.push(`%${T}%`,`%${T}%`)}),g.push(`(${A.join(" OR ")})`)}let R=g.length>0?`WHERE id IN (${p}) AND ${g.join(" AND ")}`:`WHERE id IN (${p})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${R}
      ORDER BY created_at_epoch ${m}
      ${u}
    `).all(...l)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).all(e),r=new Set,o=new Set;for(let i of t)Z(i.files_read).forEach(a=>r.add(a)),Z(i.files_modified).forEach(a=>o.add(a));return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${N}') as platform_source,
             user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${N}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,s,t,r,o){let i=new Date,a=i.getTime(),d=ws(r,o),m=d.platformSource??N,u=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(u){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(s,e),d.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(d.customTitle,e),d.platformSource){let l=u.platform_source?.trim()?v(u.platform_source):void 0;if(!l)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(d.platformSource,e);else if(l!==d.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${l}, received=${d.platformSource}`)}return u.id}return this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,m,t,d.customTitle||null,i.toISOString(),a),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,s,t){let r=new Date,o=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,o=0,i,a){let d=i??Date.now(),m=new Date(d).toISOString(),u=P(e,t.title,t.narrative),p=G(this.db,u,d);if(p)return{id:p.id,createdAtEpoch:p.created_at_epoch};let g=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,o,u,m,d,a||null);return{id:Number(g.lastInsertRowid),createdAtEpoch:d}}contradictObservation(e,s,t,r,o,i=0,a,d){return this.db.transaction(()=>{let u=this.storeObservation(s,t,r,o,i,a,d);if(this.db.prepare("UPDATE observations SET is_stale = 1, corrected_by_id = ? WHERE id = ?").run(u.id,e).changes===0)throw new Error(`Observation #${e} not found`);return u})()}storeSummary(e,s,t,r,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,o,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,s,t,r,o,i=0,a,d){let m=a??Date.now(),u=new Date(m).toISOString();return this.db.transaction(()=>{let l=[],g=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let f of t){let c=P(e,f.title,f.narrative),A=G(this.db,c,m);if(A){l.push(A.id);continue}let T=g.run(e,s,f.type,f.title,f.subtitle,JSON.stringify(f.facts),f.narrative,JSON.stringify(f.concepts),JSON.stringify(f.files_read),JSON.stringify(f.files_modified),o||null,i,c,u,m,d||null);l.push(Number(T.lastInsertRowid))}let R=null;if(r){let c=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,o||null,i,u,m);R=Number(c.lastInsertRowid)}return{observationIds:l,summaryId:R,createdAtEpoch:m}})()}storeObservationsAndMarkComplete(e,s,t,r,o,i,a,d=0,m,u){let p=m??Date.now(),l=new Date(p).toISOString();return this.db.transaction(()=>{let R=[],f=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let T of t){let S=P(e,T.title,T.narrative),ce=G(this.db,S,p);if(ce){R.push(ce.id);continue}let Os=f.run(e,s,T.type,T.title,T.subtitle,JSON.stringify(T.facts),T.narrative,JSON.stringify(T.concepts),JSON.stringify(T.files_read),JSON.stringify(T.files_modified),a||null,d,S,l,p,u||null);R.push(Number(Os.lastInsertRowid))}let c;if(r){let S=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,a||null,d,l,p);c=Number(S.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(p,o),{observationIds:R,summaryId:c,createdAtEpoch:p}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:o}=s,i=t==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),m=[...e],u=o?`WHERE id IN (${d}) AND project = ?`:`WHERE id IN (${d})`;return o&&m.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${u}
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...m)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:o}=s,i=t==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),m=[...e],u=o?"AND s.project = ?":"";return o&&m.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${d}) ${u}
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...m)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],d,m;if(e!==null){let c=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,A=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let T=this.db.prepare(c).all(e,...a,t+1),S=this.db.prepare(A).all(e,...a,r+1);if(T.length===0&&S.length===0)return{observations:[],sessions:[],prompts:[]};d=T.length>0?T[T.length-1].created_at_epoch:s,m=S.length>0?S[S.length-1].created_at_epoch:s}catch(T){return _.error("DB","Error getting boundary observations",void 0,{error:T,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let c=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,A=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let T=this.db.prepare(c).all(s,...a,t),S=this.db.prepare(A).all(s,...a,r+1);if(T.length===0&&S.length===0)return{observations:[],sessions:[],prompts:[]};d=T.length>0?T[T.length-1].created_at_epoch:s,m=S.length>0?S[S.length-1].created_at_epoch:s}catch(T){return _.error("DB","Error getting boundary timestamps",void 0,{error:T,project:o}),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,p=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,l=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,g=this.db.prepare(u).all(d,m,...a),R=this.db.prepare(p).all(d,m,...a),f=this.db.prepare(l).all(d,m,...a);return{observations:g,sessions:R.map(c=>({id:c.id,memory_session_id:c.memory_session_id,project:c.project,request:c.request,completed:c.completed,next_steps:c.next_steps,created_at:c.created_at,created_at_epoch:c.created_at_epoch})),prompts:f.map(c=>({id:c.id,content_session_id:c.content_session_id,prompt_number:c.prompt_number,prompt_text:c.prompt_text,project:c.project,created_at:c.created_at,created_at_epoch:c.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
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
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
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
      WHERE p.id IN (${s})
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
    `).get(e)||null}getOrCreateManualSession(e){let s=`manual-${e}`,t=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return s;let o=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,t,e,N,o.toISOString(),o.getTime()),_.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}close(){this.db.close()}importSdkSession(e){let s=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,v(e.platform_source),e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
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
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let s=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Ae=require("os"),he=D(require("path"),1);function Xs(n){return n==="~"||n.startsWith("~/")?n.replace(/^~/,(0,Ae.homedir)()):n}function Ie(n){if(!n||n.trim()==="")return _.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:n}),"unknown-project";let e=Xs(n),s=he.default.basename(e);if(s===""){if(process.platform==="win32"){let r=n.match(/^([A-Z]):\\/i);if(r){let i=`drive-${r[1].toUpperCase()}`;return _.info("PROJECT_NAME","Drive root detected",{cwd:n,projectName:i}),i}}return _.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:n}),"unknown-project"}return s}var Le=D(require("path"),1),Ce=require("os");var I=require("fs"),M=require("path"),ee=require("os"),H=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-6",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_DATA_DIR:(0,M.join)((0,ee.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,M.join)((0,ee.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){let s=this.get(e);return s==="true"||s===!0}static applyEnvOverrides(e){let s={...e};for(let t of Object.keys(this.DEFAULTS))process.env[t]!==void 0&&(s[t]=process.env[t]);return s}static loadFromFile(e){try{if(!(0,I.existsSync)(e)){let i=this.getAllDefaults();try{let a=(0,M.dirname)(e);(0,I.existsSync)(a)||(0,I.mkdirSync)(a,{recursive:!0}),(0,I.writeFileSync)(e,JSON.stringify(i,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(a){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,a)}return this.applyEnvOverrides(i)}let s=(0,I.readFileSync)(e,"utf-8"),t=JSON.parse(s),r=t;if(t.env&&typeof t.env=="object"){r=t.env;try{(0,I.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(i){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,i)}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))r[i]!==void 0&&(o[i]=r[i]);return this.applyEnvOverrides(o)}catch(s){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,s),this.applyEnvOverrides(this.getAllDefaults())}}};var U=require("fs"),j=require("path");var O=class n{static instance=null;activeMode=null;modesDir;constructor(){let e=Ne(),s=[(0,j.join)(e,"modes"),(0,j.join)(e,"..","plugin","modes")],t=s.find(r=>(0,U.existsSync)(r));this.modesDir=t||s[0]}static getInstance(){return n.instance||(n.instance=new n),n.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let t={...e};for(let r in s){let o=s[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?t[r]=this.deepMerge(i,o):t[r]=o}return t}loadModeFile(e){let s=(0,j.join)(this.modesDir,`${e}.json`);if(!(0,U.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let t=(0,U.readFileSync)(s,"utf-8");return JSON.parse(t)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,_.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(m=>m.id),concepts:d.observation_concepts.map(m=>m.id)}),d}catch{if(_.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:t,overrideId:r}=s,o;try{o=this.loadMode(t)}catch{_.warn("SYSTEM",`Parent mode '${t}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),_.debug("SYSTEM",`Loaded override file: ${r} for parent ${t}`)}catch{return _.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${t}' only`),this.activeMode=o,o}if(!i)return _.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${t}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,_.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${t} + ${r})`,void 0,{parent:t,override:r,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(t=>t.id===e)?.label||e}};function se(){let n=Le.default.join((0,Ce.homedir)(),".claude-mem","settings.json"),e=H.loadFromFile(n),s=O.getInstance().getActiveMode(),t=new Set(s.observation_types.map(o=>o.id)),r=new Set(s.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:t,observationConcepts:r,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var E={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},ve=4,te=1;function re(n){let e=(n.title?.length||0)+(n.subtitle?.length||0)+(n.narrative?.length||0)+JSON.stringify(n.facts||[]).length;return Math.ceil(e/ve)}function ne(n){let e=n.length,s=n.reduce((i,a)=>i+re(a),0),t=n.reduce((i,a)=>i+(a.discovery_tokens||0),0),r=t-s,o=t>0?Math.round(r/t*100):0;return{totalObservations:e,totalReadTokens:s,totalDiscoveryTokens:t,savings:r,savingsPercent:o}}function Ps(n){return O.getInstance().getWorkEmoji(n)}function x(n,e){let s=re(n),t=n.discovery_tokens||0,r=Ps(n.type),o=t>0?`${r} ${t.toLocaleString()}`:"-";return{readTokens:s,discoveryTokens:t,discoveryDisplay:o,workEmoji:r}}function W(n){return n.showReadTokens||n.showWorkTokens||n.showSavingsAmount||n.showSavingsPercent}var ye=D(require("path"),1),V=require("fs");var De=/<system-reminder>[\s\S]*?<\/system-reminder>/g;function oe(n,e,s,t){let r=Array.from(s.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(s.observationConcepts),a=i.map(()=>"?").join(",");return n.db.prepare(`
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
    WHERE o.project = ?
      AND type IN (${o})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${a})
      )
      ${t?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(e,...r,...i,...t?[t]:[],s.totalObservationCount)}function ie(n,e,s,t){return n.db.prepare(`
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
    WHERE ss.project = ?
      ${t?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(e,...t?[t]:[],s.sessionCount+te)}function Me(n,e,s,t){let r=Array.from(s.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(s.observationConcepts),a=i.map(()=>"?").join(","),d=e.map(()=>"?").join(",");return n.db.prepare(`
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
    WHERE o.project IN (${d})
      AND type IN (${o})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${a})
      )
      ${t?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...r,...i,...t?[t]:[],s.totalObservationCount)}function Ue(n,e,s,t){let r=e.map(()=>"?").join(",");return n.db.prepare(`
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
    WHERE ss.project IN (${r})
      ${t?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...t?[t]:[],s.sessionCount+te)}function Gs(n){return n.replace(/\//g,"-")}function $s(n){try{if(!(0,V.existsSync)(n))return{userMessage:"",assistantMessage:""};let e=(0,V.readFileSync)(n,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim()),t="";for(let r=s.length-1;r>=0;r--)try{let o=s[r];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let a="";for(let d of i.message.content)d.type==="text"&&(a+=d.text);if(a=a.replace(De,"").trim(),a){t=a;break}}}catch(o){_.debug("PARSER","Skipping malformed transcript line",{lineIndex:r},o);continue}return{userMessage:"",assistantMessage:t}}catch(e){return _.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:n},e),{userMessage:"",assistantMessage:""}}}function ae(n,e,s,t){if(!e.showLastMessage||n.length===0)return{userMessage:"",assistantMessage:""};let r=n.find(d=>d.memory_session_id!==s);if(!r)return{userMessage:"",assistantMessage:""};let o=r.memory_session_id,i=Gs(t),a=ye.default.join(C,"projects",i,`${o}.jsonl`);return $s(a)}function xe(n,e){let s=e[0]?.id;return n.map((t,r)=>{let o=r===0?null:e[r+1];return{...t,displayEpoch:o?o.created_at_epoch:t.created_at_epoch,displayTime:o?o.created_at:t.created_at,shouldShowLink:t.id!==s}})}function de(n,e){let s=[...n.map(t=>({type:"observation",data:t})),...e.map(t=>({type:"summary",data:t}))];return s.sort((t,r)=>{let o=t.type==="observation"?t.data.created_at_epoch:t.data.displayEpoch,i=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch;return o-i}),s}function Fe(n,e){return new Set(n.slice(0,e).map(s=>s.id))}function ke(){let n=new Date,e=n.toLocaleDateString("en-CA"),s=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),t=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${t}`}function we(n){return[`# $CMEM ${n} ${ke()}`,""]}function Xe(){return[`Legend: \u{1F3AF}session ${O.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji}${s.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function Pe(){return[]}function Ge(){return[]}function $e(n,e){let s=[],t=[`${n.totalObservations} obs (${n.totalReadTokens.toLocaleString()}t read)`,`${n.totalDiscoveryTokens.toLocaleString()}t work`];return n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?t.push(`${n.savingsPercent}% savings`):e.showSavingsAmount&&t.push(`${n.savings.toLocaleString()}t saved`)),s.push(`Stats: ${t.join(" | ")}`),s.push(""),s}function Be(n){return[`### ${n}`]}function He(n){return n.toLowerCase().replace(" am","a").replace(" pm","p")}function je(n,e,s){let t=n.title||"Untitled",r=O.getInstance().getTypeIcon(n.type),o=e?He(e):'"';return`${n.id} ${o} ${r} ${t}`}function We(n,e,s,t){let r=[],o=n.title||"Untitled",i=O.getInstance().getTypeIcon(n.type),a=e?He(e):'"',{readTokens:d,discoveryDisplay:m}=x(n,t);r.push(`**${n.id}** ${a} ${i} **${o}**`),s&&r.push(s);let u=[];return t.showReadTokens&&u.push(`~${d}t`),t.showWorkTokens&&u.push(m),u.length>0&&r.push(u.join(" ")),r.push(""),r}function Ve(n,e){return[`S${n.id} ${n.request||"Session started"} (${e})`]}function F(n,e){return e?[`**${n}**: ${e}`,""]:[]}function qe(n){return n.assistantMessage?["","---","","**Previously**","",`A: ${n.assistantMessage}`,""]:[]}function Ye(n,e){return["",`Access ${Math.round(n/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function Ke(n){return`# $CMEM ${n} ${ke()}

No previous sessions found.`}function Je(){let n=new Date,e=n.toLocaleDateString("en-CA"),s=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),t=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${s} ${t}`}function ze(n){return["",`${E.bright}${E.cyan}[${n}] recent context, ${Je()}${E.reset}`,`${E.gray}${"\u2500".repeat(60)}${E.reset}`,""]}function Qe(){let e=O.getInstance().getActiveMode().observation_types.map(s=>`${s.emoji} ${s.id}`).join(" | ");return[`${E.dim}Legend: session-request | ${e}${E.reset}`,""]}function Ze(){return[`${E.bright}Column Key${E.reset}`,`${E.dim}  Read: Tokens to read this observation (cost to learn it now)${E.reset}`,`${E.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${E.reset}`,""]}function es(){return[`${E.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${E.reset}`,"",`${E.dim}When you need implementation details, rationale, or debugging context:${E.reset}`,`${E.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${E.reset}`,`${E.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${E.reset}`,`${E.dim}  - Trust this index over re-reading code for past decisions and learnings${E.reset}`,""]}function ss(n,e){let s=[];if(s.push(`${E.bright}${E.cyan}Context Economics${E.reset}`),s.push(`${E.dim}  Loading: ${n.totalObservations} observations (${n.totalReadTokens.toLocaleString()} tokens to read)${E.reset}`),s.push(`${E.dim}  Work investment: ${n.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${E.reset}`),n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let t="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?t+=`${n.savings.toLocaleString()} tokens (${n.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?t+=`${n.savings.toLocaleString()} tokens`:t+=`${n.savingsPercent}% reduction from reuse`,s.push(`${E.green}${t}${E.reset}`)}return s.push(""),s}function ts(n){return[`${E.bright}${E.cyan}${n}${E.reset}`,""]}function rs(n){return[`${E.dim}${n}${E.reset}`]}function ns(n,e,s,t){let r=n.title||"Untitled",o=O.getInstance().getTypeIcon(n.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=x(n,t),m=s?`${E.dim}${e}${E.reset}`:" ".repeat(e.length),u=t.showReadTokens&&i>0?`${E.dim}(~${i}t)${E.reset}`:"",p=t.showWorkTokens&&a>0?`${E.dim}(${d} ${a.toLocaleString()}t)${E.reset}`:"";return`  ${E.dim}#${n.id}${E.reset}  ${m}  ${o}  ${r} ${u} ${p}`}function os(n,e,s,t,r){let o=[],i=n.title||"Untitled",a=O.getInstance().getTypeIcon(n.type),{readTokens:d,discoveryTokens:m,workEmoji:u}=x(n,r),p=s?`${E.dim}${e}${E.reset}`:" ".repeat(e.length),l=r.showReadTokens&&d>0?`${E.dim}(~${d}t)${E.reset}`:"",g=r.showWorkTokens&&m>0?`${E.dim}(${u} ${m.toLocaleString()}t)${E.reset}`:"";return o.push(`  ${E.dim}#${n.id}${E.reset}  ${p}  ${a}  ${E.bright}${i}${E.reset}`),t&&o.push(`    ${E.dim}${t}${E.reset}`),(l||g)&&o.push(`    ${l} ${g}`),o.push(""),o}function is(n,e){let s=`${n.request||"Session started"} (${e})`;return[`${E.yellow}#S${n.id}${E.reset} ${s}`,""]}function k(n,e,s){return e?[`${s}${n}:${E.reset} ${e}`,""]:[]}function as(n){return n.assistantMessage?["","---","",`${E.bright}${E.magenta}Previously${E.reset}`,"",`${E.dim}A: ${n.assistantMessage}${E.reset}`,""]:[]}function ds(n,e){let s=Math.round(n/1e3);return["",`${E.dim}Access ${s}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${E.reset}`]}function _s(n){return`
${E.bright}${E.cyan}[${n}] recent context, ${Je()}${E.reset}
${E.gray}${"\u2500".repeat(60)}${E.reset}

${E.dim}No previous sessions found for this project yet.${E.reset}
`}function Es(n,e,s,t){let r=[];return t?r.push(...ze(n)):r.push(...we(n)),t?r.push(...Qe()):r.push(...Xe()),t?r.push(...Ze()):r.push(...Pe()),t?r.push(...es()):r.push(...Ge()),W(s)&&(t?r.push(...ss(e,s)):r.push(...$e(e,s))),r}var _e=D(require("path"),1);function K(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[]}catch(e){return _.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:n?.substring(0,50)},e),[]}}function Ee(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function me(n){return new Date(n).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function us(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function ms(n,e){return _e.default.isAbsolute(n)?_e.default.relative(e,n):n}function cs(n,e,s){let t=K(n);if(t.length>0)return ms(t[0],e);if(s){let r=K(s);if(r.length>0)return ms(r[0],e)}return"General"}function Bs(n){let e=new Map;for(let t of n){let r=t.type==="observation"?t.data.created_at:t.data.displayTime,o=us(r);e.has(o)||e.set(o,[]),e.get(o).push(t)}let s=Array.from(e.entries()).sort((t,r)=>{let o=new Date(t[0]).getTime(),i=new Date(r[0]).getTime();return o-i});return new Map(s)}function ps(n,e){return e.fullObservationField==="narrative"?n.narrative:n.facts?K(n.facts).join(`
`):null}function Hs(n,e,s,t){let r=[];r.push(...Be(n));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=Ee(a.displayTime);r.push(...Ve(a,d))}else{let a=i.data,d=me(a.created_at),u=d!==o?d:"";if(o=d,s.has(a.id)){let l=ps(a,t);r.push(...We(a,u,l,t))}else r.push(je(a,u,t))}return r}function js(n,e,s,t,r){let o=[];o.push(...ts(n));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let m=d.data,u=Ee(m.displayTime);o.push(...is(m,u))}else{let m=d.data,u=cs(m.files_modified,r,m.files_read),p=me(m.created_at),l=p!==a;a=p;let g=s.has(m.id);if(u!==i&&(o.push(...rs(u)),i=u),g){let R=ps(m,t);o.push(...os(m,p,l,R,t))}else o.push(ns(m,p,l,t))}return o.push(""),o}function Ws(n,e,s,t,r,o){return o?js(n,e,s,t,r):Hs(n,e,s,t)}function ls(n,e,s,t,r){let o=[],i=Bs(n);for(let[a,d]of i)o.push(...Ws(a,d,e,s,t,r));return o}function Ts(n,e,s){return!(!n.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||s&&e.created_at_epoch<=s.created_at_epoch)}function gs(n,e){let s=[];return e?(s.push(...k("Investigated",n.investigated,E.blue)),s.push(...k("Learned",n.learned,E.yellow)),s.push(...k("Completed",n.completed,E.green)),s.push(...k("Next Steps",n.next_steps,E.magenta))):(s.push(...F("Investigated",n.investigated)),s.push(...F("Learned",n.learned)),s.push(...F("Completed",n.completed)),s.push(...F("Next Steps",n.next_steps))),s}function bs(n,e){return e?as(n):qe(n)}function fs(n,e,s){return!W(e)||n.totalDiscoveryTokens<=0||n.savings<=0?[]:s?ds(n.totalDiscoveryTokens,n.totalReadTokens):Ye(n.totalDiscoveryTokens,n.totalReadTokens)}var Vs=Ns.default.join((0,Ss.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function qs(){try{return new B}catch(n){if(n.code==="ERR_DLOPEN_FAILED"){try{(0,Rs.unlinkSync)(Vs)}catch(e){_.debug("SYSTEM","Marker file cleanup failed (may not exist)",{},e)}return _.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw n}}function Ys(n,e){return e?_s(n):Ke(n)}function Ks(n,e,s,t,r,o,i){let a=[],d=ne(e);a.push(...Es(n,d,t,i));let m=s.slice(0,t.sessionCount),u=xe(m,s),p=de(e,u),l=Fe(e,t.fullObservationCount);a.push(...ls(p,l,t,r,i));let g=s[0],R=e[0];Ts(t,g,R)&&a.push(...gs(g,i));let f=ae(e,t,o,r);return a.push(...bs(f,i)),a.push(...fs(d,t,i)),a.join(`
`).trimEnd()}async function ue(n,e=!1){let s=se(),t=n?.cwd??process.cwd(),r=Ie(t),o=n?.platform_source,i=n?.projects||[r];n?.full&&(s.totalObservationCount=999999,s.sessionCount=999999);let a=qs();if(!a)return"";try{let d=i.length>1?Me(a,i,s,o):oe(a,r,s,o),m=i.length>1?Ue(a,i,s,o):ie(a,r,s,o);return d.length===0&&m.length===0?Ys(r,e):Ks(r,d,m,s,t,n?.session_id,e)}finally{a.close()}}0&&(module.exports={generateContext});
