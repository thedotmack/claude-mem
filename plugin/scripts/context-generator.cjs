"use strict";var St=Object.create;var w=Object.defineProperty;var bt=Object.getOwnPropertyDescriptor;var ht=Object.getOwnPropertyNames;var Ot=Object.getPrototypeOf,Rt=Object.prototype.hasOwnProperty;var Ct=(r,e)=>{for(var t in e)w(r,t,{get:e[t],enumerable:!0})},pe=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of ht(e))!Rt.call(r,n)&&n!==t&&w(r,n,{get:()=>e[n],enumerable:!(s=bt(e,n))||s.enumerable});return r};var L=(r,e,t)=>(t=r!=null?St(Ot(r)):{},pe(e||!r||!r.__esModule?w(t,"default",{value:r,enumerable:!0}):t,r)),Nt=r=>pe(w({},"__esModule",{value:!0}),r);var Gt={};Ct(Gt,{generateContext:()=>_e});module.exports=Nt(Gt);var Et=L(require("path"),1),Tt=require("os"),gt=require("fs");var Se=require("bun:sqlite");var S=require("path"),Q=require("os"),$=require("fs");var le=require("url");var A=require("fs"),y=require("path"),ue=require("os"),K=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(K||{}),me=(0,y.join)((0,ue.homedir)(),".claude-mem"),J=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,y.join)(me,"logs");(0,A.existsSync)(e)||(0,A.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,y.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,y.join)(me,"settings.json");if((0,A.existsSync)(e)){let t=(0,A.readFileSync)(e,"utf-8"),n=(JSON.parse(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=K[n]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${n} ${o}:${i}:${a}.${_}`}log(e,t,s,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=K[e].padEnd(5),_=t.padEnd(6),c="";n?.correlationId?c=`[${n.correlationId}] `:n?.sessionId&&(c=`[session-${n.sessionId}] `);let m="";o!=null&&(o instanceof Error?m=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?m=`
`+JSON.stringify(o,null,2):m=" "+this.formatData(o));let l="";if(n){let{sessionId:T,memorySessionId:b,correlationId:I,...u}=n;Object.keys(u).length>0&&(l=` {${Object.entries(u).map(([g,h])=>`${g}=${h}`).join(", ")}}`)}let E=`[${i}] [${a}] [${_}] ${c}${s}${l}${m}`;if(this.logFilePath)try{(0,A.appendFileSync)(this.logFilePath,E+`
`,"utf8")}catch(T){process.stderr.write(`[LOGGER] Failed to write to log file: ${T}
`)}else process.stderr.write(E+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}error(e,t,s,n){this.log(3,e,t,s,n)}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}timing(e,t,s,n){this.info(e,`\u23F1 ${t}`,n,{duration:`${s}ms`})}happyPathError(e,t,s,n,o=""){let c=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),m=c?`${c[1].split("/").pop()}:${c[2]}`:"unknown",l={...s,location:m};return this.warn(e,`[HAPPY-PATH] ${t}`,l,n),o}},p=new J;var Lt={};function At(){return typeof __dirname<"u"?__dirname:(0,S.dirname)((0,le.fileURLToPath)(Lt.url))}var It=At();function Mt(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let r=(0,S.join)((0,Q.homedir)(),".claude-mem"),e=(0,S.join)(r,"settings.json");try{if((0,$.existsSync)(e)){let{readFileSync:t}=require("fs"),s=JSON.parse(t(e,"utf-8")),n=s.env??s;if(n.CLAUDE_MEM_DATA_DIR)return n.CLAUDE_MEM_DATA_DIR}}catch{}return r}var C=Mt(),M=process.env.CLAUDE_CONFIG_DIR||(0,S.join)((0,Q.homedir)(),".claude"),Vt=(0,S.join)(M,"plugins","marketplaces","thedotmack"),qt=(0,S.join)(C,"archives"),Kt=(0,S.join)(C,"logs"),Jt=(0,S.join)(C,"trash"),Qt=(0,S.join)(C,"backups"),zt=(0,S.join)(C,"modes"),Zt=(0,S.join)(C,"settings.json"),Ee=(0,S.join)(C,"claude-mem.db"),es=(0,S.join)(C,"vector-db"),ts=(0,S.join)(C,"observer-sessions"),ss=(0,S.join)(M,"settings.json"),rs=(0,S.join)(M,"commands"),ns=(0,S.join)(M,"CLAUDE.md");function Te(r){(0,$.mkdirSync)(r,{recursive:!0})}function ge(){return(0,S.join)(It,"..")}var fe=require("crypto");var yt=3e4;function F(r,e,t){return(0,fe.createHash)("sha256").update((r||"")+(e||"")+(t||"")).digest("hex").slice(0,16)}function P(r,e,t){let s=t-yt;return r.prepare("SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?").get(e,s)}var X=class{db;constructor(e=Ee){e!==":memory:"&&Te(C),this.db=new Se.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn()}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),p.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),p.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),p.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),p.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(s=>s.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}p.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),p.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}p.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),p.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}p.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),p.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}p.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
      `)}catch(s){p.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},s)}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),p.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),p.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),p.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}p.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),p.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;p.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),_=a.some(m=>m.name===o);return a.some(m=>m.name===i)?!1:_?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),p.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(p.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?p.debug("DB",`Successfully renamed ${t} session ID columns`):p.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),p.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(!this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)){p.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
        `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),p.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(t){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),t}}}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),p.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),p.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}ensureMemorySessionIdRegistered(e,t){let s=this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(e);if(!s)throw new Error(`Session ${e} not found in sdk_sessions`);s.memory_session_id!==t&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(t,e),p.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:s.memory_session_id,newId:t}))}getRecentSummaries(e,t=10){return this.db.prepare(`
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
      SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
      FROM observations
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentSummaries(e=50){return this.db.prepare(`
      SELECT id, request, investigated, learned, completed, next_steps,
             files_read, files_edited, notes, project, prompt_number,
             created_at, created_at_epoch
      FROM session_summaries
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentUserPrompts(e=100){return this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(){return this.db.prepare(`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `).all().map(s=>s.project)}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project
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
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o,type:i,concepts:a,files:_}=t,c=s==="date_asc"?"ASC":"DESC",m=n?`LIMIT ${n}`:"",l=e.map(()=>"?").join(","),E=[...e],T=[];if(o&&(T.push("project = ?"),E.push(o)),i)if(Array.isArray(i)){let u=i.map(()=>"?").join(",");T.push(`type IN (${u})`),E.push(...i)}else T.push("type = ?"),E.push(i);if(a){let u=Array.isArray(a)?a:[a],f=u.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");E.push(...u),T.push(`(${f.join(" OR ")})`)}if(_){let u=Array.isArray(_)?_:[_],f=u.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");u.forEach(g=>{E.push(`%${g}%`,`%${g}%`)}),T.push(`(${f.join(" OR ")})`)}let b=T.length>0?`WHERE id IN (${l}) AND ${T.join(" AND ")}`:`WHERE id IN (${l})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${b}
      ORDER BY created_at_epoch ${c}
      ${m}
    `).all(...E)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),n=new Set,o=new Set;for(let i of s){if(i.files_read){let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(_=>n.add(_))}if(i.files_modified){let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(_=>o.add(_))}}return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${t})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,t,s,n){let o=new Date,i=o.getTime(),a=this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);return a?(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(t,e),n&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(n,e),a.id):(this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,n||null,o.toISOString(),i),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id)}saveUserPrompt(e,t,s){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,s,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,n,o=0,i){let a=i??Date.now(),_=new Date(a).toISOString(),c=F(e,s.title,s.narrative),m=P(this.db,c,a);if(m)return{id:m.id,createdAtEpoch:m.created_at_epoch};let E=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),n||null,o,c,_,a);return{id:Number(E.lastInsertRowid),createdAtEpoch:a}}storeSummary(e,t,s,n,o=0,i){let a=i??Date.now(),_=new Date(a).toISOString(),m=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,n||null,o,_,a);return{id:Number(m.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,o,i=0,a,_,c,m){let l=a??Date.now(),E=new Date(l).toISOString();return this.db.transaction(()=>{let b=[],I=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         node, platform, instance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let f of s){let g=F(e,f.title,f.narrative),h=P(this.db,g,l);if(h){b.push(h.id);continue}let R=I.run(e,t,f.type,f.title,f.subtitle,JSON.stringify(f.facts),f.narrative,JSON.stringify(f.concepts),JSON.stringify(f.files_read),JSON.stringify(f.files_modified),o||null,i,g,E,l,_??null,c??null,m??null);b.push(Number(R.lastInsertRowid))}let u=null;if(n){let g=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,E,l);u=Number(g.lastInsertRowid)}return{observationIds:b,summaryId:u,createdAtEpoch:l}})()}storeObservationsAndMarkComplete(e,t,s,n,o,i,a,_=0,c,m,l,E){let T=c??Date.now(),b=new Date(T).toISOString();return this.db.transaction(()=>{let u=[],f=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         node, platform, instance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let R of s){let k=F(e,R.title,R.narrative),ce=P(this.db,k,T);if(ce){u.push(ce.id);continue}let ft=f.run(e,t,R.type,R.title,R.subtitle,JSON.stringify(R.facts),R.narrative,JSON.stringify(R.concepts),JSON.stringify(R.files_read),JSON.stringify(R.files_modified),a||null,_,k,b,T,m??null,l??null,E??null);u.push(Number(ft.lastInsertRowid))}let g;if(n){let k=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,a||null,_,b,T);g=Number(k.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(T,o),{observationIds:u,summaryId:g,createdAtEpoch:T}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o}=t,i=s==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${n}`:"",_=e.map(()=>"?").join(","),c=[...e],m=o?`WHERE id IN (${_}) AND project = ?`:`WHERE id IN (${_})`;return o&&c.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${m}
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...c)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o}=t,i=s==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${n}`:"",_=e.map(()=>"?").join(","),c=[...e],m=o?"AND s.project = ?":"";return o&&c.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${_}) ${m}
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...c)}getTimelineAroundTimestamp(e,t=10,s=10,n){return this.getTimelineAroundObservation(null,e,t,s,n)}getTimelineAroundObservation(e,t,s=10,n=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],_,c;if(e!==null){let u=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let g=this.db.prepare(u).all(e,...a,s+1),h=this.db.prepare(f).all(e,...a,n+1);if(g.length===0&&h.length===0)return{observations:[],sessions:[],prompts:[]};_=g.length>0?g[g.length-1].created_at_epoch:t,c=h.length>0?h[h.length-1].created_at_epoch:t}catch(g){return p.error("DB","Error getting boundary observations",void 0,{error:g,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let u=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let g=this.db.prepare(u).all(t,...a,s),h=this.db.prepare(f).all(t,...a,n+1);if(g.length===0&&h.length===0)return{observations:[],sessions:[],prompts:[]};_=g.length>0?g[g.length-1].created_at_epoch:t,c=h.length>0?h[h.length-1].created_at_epoch:t}catch(g){return p.error("DB","Error getting boundary timestamps",void 0,{error:g,project:o}),{observations:[],sessions:[],prompts:[]}}}let m=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,l=`
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
    `,T=this.db.prepare(m).all(_,c,...a),b=this.db.prepare(l).all(_,c,...a),I=this.db.prepare(E).all(_,c,...a);return{observations:T,sessions:b.map(u=>({id:u.id,memory_session_id:u.memory_session_id,project:u.project,request:u.request,completed:u.completed,next_steps:u.next_steps,created_at:u.created_at,created_at_epoch:u.created_at_epoch})),prompts:I.map(u=>({id:u.id,content_session_id:u.content_session_id,prompt_number:u.prompt_number,prompt_text:u.prompt_text,project:u.project,created_at:u.created_at,created_at_epoch:u.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
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
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(t,s,e,o.toISOString(),o.getTime()),p.info("SESSION","Created manual session",{memorySessionId:t,project:e}),t}close(){this.db.close()}importSdkSession(e){let t=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let t=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
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
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importUserPrompt(e){let t=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var be=L(require("path"),1);function he(r){if(!r||r.trim()==="")return p.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:r}),"unknown-project";let e=be.default.basename(r);if(e===""){if(process.platform==="win32"){let s=r.match(/^([A-Z]):\\/i);if(s){let o=`drive-${s[1].toUpperCase()}`;return p.info("PROJECT_NAME","Drive root detected",{cwd:r,projectName:o}),o}}return p.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:r}),"unknown-project"}return e}var Re=L(require("path"),1),Ce=require("os");var N=require("fs"),G=require("path"),Oe=require("os"),j=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_DATA_DIR:(0,G.join)((0,Oe.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_NETWORK_MODE:"standalone",CLAUDE_MEM_SERVER_HOST:"",CLAUDE_MEM_SERVER_PORT:"37777",CLAUDE_MEM_NODE_NAME:"",CLAUDE_MEM_INSTANCE_NAME:"",CLAUDE_MEM_AUTH_TOKEN:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){let t=this.get(e);return t==="true"||t===!0}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e){try{if(!(0,N.existsSync)(e)){let i=this.getAllDefaults();try{let a=(0,G.dirname)(e);(0,N.existsSync)(a)||(0,N.mkdirSync)(a,{recursive:!0}),(0,N.writeFileSync)(e,JSON.stringify(i,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(a){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,a)}return this.applyEnvOverrides(i)}let t=(0,N.readFileSync)(e,"utf-8"),s=JSON.parse(t),n=s;if(s.env&&typeof s.env=="object"){n=s.env;try{(0,N.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(i){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,i)}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))n[i]!==void 0&&(o[i]=n[i]);return this.applyEnvOverrides(o)}catch(t){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t),this.applyEnvOverrides(this.getAllDefaults())}}};var v=require("fs"),H=require("path");var O=class r{static instance=null;activeMode=null;modesDir;constructor(){let e=ge(),t=[(0,H.join)(e,"modes"),(0,H.join)(e,"..","plugin","modes")],s=t.find(n=>(0,v.existsSync)(n));this.modesDir=s||t[0]}static getInstance(){return r.instance||(r.instance=new r),r.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?s[n]=this.deepMerge(i,o):s[n]=o}return s}loadModeFile(e){let t=(0,H.join)(this.modesDir,`${e}.json`);if(!(0,v.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,v.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let _=this.loadModeFile(e);return this.activeMode=_,p.debug("SYSTEM",`Loaded mode: ${_.name} (${e})`,void 0,{types:_.observation_types.map(c=>c.id),concepts:_.observation_concepts.map(c=>c.id)}),_}catch{if(p.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:n}=t,o;try{o=this.loadMode(s)}catch{p.warn("SYSTEM",`Parent mode '${s}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),p.debug("SYSTEM",`Loaded override file: ${n} for parent ${s}`)}catch{return p.warn("SYSTEM",`Override file '${n}' not found, using parent mode '${s}' only`),this.activeMode=o,o}if(!i)return p.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${s}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,p.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${s} + ${n})`,void 0,{parent:s,override:n,types:a.observation_types.map(_=>_.id),concepts:a.observation_concepts.map(_=>_.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(s=>s.id===e)?.label||e}};function z(){let r=Re.default.join((0,Ce.homedir)(),".claude-mem","settings.json"),e=j.loadFromFile(r),t=O.getInstance().getActiveMode(),s=new Set(t.observation_types.map(o=>o.id)),n=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:s,observationConcepts:n,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var d={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},Ne=4,Z=1;function ee(r){let e=(r.title?.length||0)+(r.subtitle?.length||0)+(r.narrative?.length||0)+JSON.stringify(r.facts||[]).length;return Math.ceil(e/Ne)}function te(r){let e=r.length,t=r.reduce((i,a)=>i+ee(a),0),s=r.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=s-t,o=s>0?Math.round(n/s*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:s,savings:n,savingsPercent:o}}function vt(r){return O.getInstance().getWorkEmoji(r)}function D(r,e){let t=ee(r),s=r.discovery_tokens||0,n=vt(r.type),o=s>0?`${n} ${s.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:s,discoveryDisplay:o,workEmoji:n}}function B(r){return r.showReadTokens||r.showWorkTokens||r.showSavingsAmount||r.showSavingsPercent}var Ae=L(require("path"),1),W=require("fs");function se(r,e,t){let s=Array.from(t.observationTypes),n=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(",");return r.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${n})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${i})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(e,...s,...o,t.totalObservationCount)}function re(r,e,t){return r.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(e,t.sessionCount+Z)}function Ie(r,e,t){let s=Array.from(t.observationTypes),n=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return r.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch, project
    FROM observations
    WHERE project IN (${a})
      AND type IN (${n})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${i})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...e,...s,...o,t.totalObservationCount)}function Me(r,e,t){let s=e.map(()=>"?").join(",");return r.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch, project
    FROM session_summaries
    WHERE project IN (${s})
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...e,t.sessionCount+Z)}function Dt(r){return r.replace(/\//g,"-")}function Ut(r){try{if(!(0,W.existsSync)(r))return{userMessage:"",assistantMessage:""};let e=(0,W.readFileSync)(r,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim()),s="";for(let n=t.length-1;n>=0;n--)try{let o=t[n];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let a="";for(let _ of i.message.content)_.type==="text"&&(a+=_.text);if(a=a.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),a){s=a;break}}}catch(o){p.debug("PARSER","Skipping malformed transcript line",{lineIndex:n},o);continue}return{userMessage:"",assistantMessage:s}}catch(e){return p.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r},e),{userMessage:"",assistantMessage:""}}}function ne(r,e,t,s){if(!e.showLastMessage||r.length===0)return{userMessage:"",assistantMessage:""};let n=r.find(_=>_.memory_session_id!==t);if(!n)return{userMessage:"",assistantMessage:""};let o=n.memory_session_id,i=Dt(s),a=Ae.default.join(M,"projects",i,`${o}.jsonl`);return Ut(a)}function Le(r,e){let t=e[0]?.id;return r.map((s,n)=>{let o=n===0?null:e[n+1];return{...s,displayEpoch:o?o.created_at_epoch:s.created_at_epoch,displayTime:o?o.created_at:s.created_at,shouldShowLink:s.id!==t}})}function oe(r,e){let t=[...r.map(s=>({type:"observation",data:s})),...e.map(s=>({type:"summary",data:s}))];return t.sort((s,n)=>{let o=s.type==="observation"?s.data.created_at_epoch:s.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function ye(r,e){return new Set(r.slice(0,e).map(t=>t.id))}function ve(){let r=new Date,e=r.toLocaleDateString("en-CA"),t=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function De(r){return[`# $CMEM ${r} ${ve()}`,""]}function Ue(){return[`Legend: \u{1F3AF}session ${O.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji}${t.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function xe(){return[]}function ke(){return[]}function we(r,e){let t=[],s=[`${r.totalObservations} obs (${r.totalReadTokens.toLocaleString()}t read)`,`${r.totalDiscoveryTokens.toLocaleString()}t work`];return r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?s.push(`${r.savingsPercent}% savings`):e.showSavingsAmount&&s.push(`${r.savings.toLocaleString()}t saved`)),t.push(`Stats: ${s.join(" | ")}`),t.push(""),t}function $e(r){return[`### ${r}`]}function Fe(r){return r.toLowerCase().replace(" am","a").replace(" pm","p")}function Pe(r,e,t){let s=r.title||"Untitled",n=O.getInstance().getTypeIcon(r.type),o=e?Fe(e):'"';return`${r.id} ${o} ${n} ${s}`}function Xe(r,e,t,s){let n=[],o=r.title||"Untitled",i=O.getInstance().getTypeIcon(r.type),a=e?Fe(e):'"',{readTokens:_,discoveryDisplay:c}=D(r,s);n.push(`**${r.id}** ${a} ${i} **${o}**`),t&&n.push(t);let m=[];return s.showReadTokens&&m.push(`~${_}t`),s.showWorkTokens&&m.push(c),m.length>0&&n.push(m.join(" ")),n.push(""),n}function je(r,e){return[`S${r.id} ${r.request||"Session started"} (${e})`]}function U(r,e){return e?[`**${r}**: ${e}`,""]:[]}function Ge(r){return r.assistantMessage?["","---","","**Previously**","",`A: ${r.assistantMessage}`,""]:[]}function He(r,e){return["",`Access ${Math.round(r/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function Be(r){return`# $CMEM ${r} ${ve()}

No previous sessions found.`}function We(){let r=new Date,e=r.toLocaleDateString("en-CA"),t=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function Ye(r){return["",`${d.bright}${d.cyan}[${r}] recent context, ${We()}${d.reset}`,`${d.gray}${"\u2500".repeat(60)}${d.reset}`,""]}function Ve(){let e=O.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${d.dim}Legend: session-request | ${e}${d.reset}`,""]}function qe(){return[`${d.bright}Column Key${d.reset}`,`${d.dim}  Read: Tokens to read this observation (cost to learn it now)${d.reset}`,`${d.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${d.reset}`,""]}function Ke(){return[`${d.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${d.reset}`,"",`${d.dim}When you need implementation details, rationale, or debugging context:${d.reset}`,`${d.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${d.reset}`,`${d.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${d.reset}`,`${d.dim}  - Trust this index over re-reading code for past decisions and learnings${d.reset}`,""]}function Je(r,e){let t=[];if(t.push(`${d.bright}${d.cyan}Context Economics${d.reset}`),t.push(`${d.dim}  Loading: ${r.totalObservations} observations (${r.totalReadTokens.toLocaleString()} tokens to read)${d.reset}`),t.push(`${d.dim}  Work investment: ${r.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${d.reset}`),r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${r.savings.toLocaleString()} tokens (${r.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?s+=`${r.savings.toLocaleString()} tokens`:s+=`${r.savingsPercent}% reduction from reuse`,t.push(`${d.green}${s}${d.reset}`)}return t.push(""),t}function Qe(r){return[`${d.bright}${d.cyan}${r}${d.reset}`,""]}function ze(r){return[`${d.dim}${r}${d.reset}`]}function Ze(r,e,t,s){let n=r.title||"Untitled",o=O.getInstance().getTypeIcon(r.type),{readTokens:i,discoveryTokens:a,workEmoji:_}=D(r,s),c=t?`${d.dim}${e}${d.reset}`:" ".repeat(e.length),m=s.showReadTokens&&i>0?`${d.dim}(~${i}t)${d.reset}`:"",l=s.showWorkTokens&&a>0?`${d.dim}(${_} ${a.toLocaleString()}t)${d.reset}`:"";return`  ${d.dim}#${r.id}${d.reset}  ${c}  ${o}  ${n} ${m} ${l}`}function et(r,e,t,s,n){let o=[],i=r.title||"Untitled",a=O.getInstance().getTypeIcon(r.type),{readTokens:_,discoveryTokens:c,workEmoji:m}=D(r,n),l=t?`${d.dim}${e}${d.reset}`:" ".repeat(e.length),E=n.showReadTokens&&_>0?`${d.dim}(~${_}t)${d.reset}`:"",T=n.showWorkTokens&&c>0?`${d.dim}(${m} ${c.toLocaleString()}t)${d.reset}`:"";return o.push(`  ${d.dim}#${r.id}${d.reset}  ${l}  ${a}  ${d.bright}${i}${d.reset}`),s&&o.push(`    ${d.dim}${s}${d.reset}`),(E||T)&&o.push(`    ${E} ${T}`),o.push(""),o}function tt(r,e){let t=`${r.request||"Session started"} (${e})`;return[`${d.yellow}#S${r.id}${d.reset} ${t}`,""]}function x(r,e,t){return e?[`${t}${r}:${d.reset} ${e}`,""]:[]}function st(r){return r.assistantMessage?["","---","",`${d.bright}${d.magenta}Previously${d.reset}`,"",`${d.dim}A: ${r.assistantMessage}${d.reset}`,""]:[]}function rt(r,e){let t=Math.round(r/1e3);return["",`${d.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${d.reset}`]}function nt(r){return`
${d.bright}${d.cyan}[${r}] recent context, ${We()}${d.reset}
${d.gray}${"\u2500".repeat(60)}${d.reset}

${d.dim}No previous sessions found for this project yet.${d.reset}
`}function ot(r,e,t,s){let n=[];return s?n.push(...Ye(r)):n.push(...De(r)),s?n.push(...Ve()):n.push(...Ue()),s?n.push(...qe()):n.push(...xe()),s?n.push(...Ke()):n.push(...ke()),B(t)&&(s?n.push(...Je(e,t)):n.push(...we(e,t))),n}var ie=L(require("path"),1);function q(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[]}catch(e){return p.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:r?.substring(0,50)},e),[]}}function ae(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function de(r){return new Date(r).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function at(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function it(r,e){return ie.default.isAbsolute(r)?ie.default.relative(e,r):r}function dt(r,e,t){let s=q(r);if(s.length>0)return it(s[0],e);if(t){let n=q(t);if(n.length>0)return it(n[0],e)}return"General"}function xt(r){let e=new Map;for(let s of r){let n=s.type==="observation"?s.data.created_at:s.data.displayTime,o=at(n);e.has(o)||e.set(o,[]),e.get(o).push(s)}let t=Array.from(e.entries()).sort((s,n)=>{let o=new Date(s[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function _t(r,e){return e.fullObservationField==="narrative"?r.narrative:r.facts?q(r.facts).join(`
`):null}function kt(r,e,t,s){let n=[];n.push(...$e(r));let o="";for(let i of e)if(i.type==="summary"){o="";let a=i.data,_=ae(a.displayTime);n.push(...je(a,_))}else{let a=i.data,_=de(a.created_at),m=_!==o?_:"";if(o=_,t.has(a.id)){let E=_t(a,s);n.push(...Xe(a,m,E,s))}else n.push(Pe(a,m,s))}return n}function wt(r,e,t,s,n){let o=[];o.push(...Qe(r));let i=null,a="";for(let _ of e)if(_.type==="summary"){i=null,a="";let c=_.data,m=ae(c.displayTime);o.push(...tt(c,m))}else{let c=_.data,m=dt(c.files_modified,n,c.files_read),l=de(c.created_at),E=l!==a;a=l;let T=t.has(c.id);if(m!==i&&(o.push(...ze(m)),i=m),T){let b=_t(c,s);o.push(...et(c,l,E,b,s))}else o.push(Ze(c,l,E,s))}return o.push(""),o}function $t(r,e,t,s,n,o){return o?wt(r,e,t,s,n):kt(r,e,t,s)}function ct(r,e,t,s,n){let o=[],i=xt(r);for(let[a,_]of i)o.push(...$t(a,_,e,t,s,n));return o}function pt(r,e,t){return!(!r.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function mt(r,e){let t=[];return e?(t.push(...x("Investigated",r.investigated,d.blue)),t.push(...x("Learned",r.learned,d.yellow)),t.push(...x("Completed",r.completed,d.green)),t.push(...x("Next Steps",r.next_steps,d.magenta))):(t.push(...U("Investigated",r.investigated)),t.push(...U("Learned",r.learned)),t.push(...U("Completed",r.completed)),t.push(...U("Next Steps",r.next_steps))),t}function ut(r,e){return e?st(r):Ge(r)}function lt(r,e,t){return!B(e)||r.totalDiscoveryTokens<=0||r.savings<=0?[]:t?rt(r.totalDiscoveryTokens,r.totalReadTokens):He(r.totalDiscoveryTokens,r.totalReadTokens)}var Ft=Et.default.join((0,Tt.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Pt(){try{return new X}catch(r){if(r.code==="ERR_DLOPEN_FAILED"){try{(0,gt.unlinkSync)(Ft)}catch(e){p.debug("SYSTEM","Marker file cleanup failed (may not exist)",{},e)}return p.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw r}}function Xt(r,e){return e?nt(r):Be(r)}function jt(r,e,t,s,n,o,i){let a=[],_=te(e);a.push(...ot(r,_,s,i));let c=t.slice(0,s.sessionCount),m=Le(c,t),l=oe(e,m),E=ye(e,s.fullObservationCount);a.push(...ct(l,E,s,n,i));let T=t[0],b=e[0];pt(s,T,b)&&a.push(...mt(T,i));let I=ne(e,s,o,n);return a.push(...ut(I,i)),a.push(...lt(_,s,i)),a.join(`
`).trimEnd()}async function _e(r,e=!1){let t=z(),s=r?.cwd??process.cwd(),n=he(s),o=r?.projects||[n];r?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let i=Pt();if(!i)return"";try{let a=o.length>1?Ie(i,o,t):se(i,n,t),_=o.length>1?Me(i,o,t):re(i,n,t);return a.length===0&&_.length===0?Xt(n,e):jt(n,a,_,t,s,r?.session_id,e)}finally{i.close()}}0&&(module.exports={generateContext});
