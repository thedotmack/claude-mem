"use strict";var It=Object.create;var X=Object.defineProperty;var Lt=Object.getOwnPropertyDescriptor;var Mt=Object.getOwnPropertyNames;var Dt=Object.getPrototypeOf,vt=Object.prototype.hasOwnProperty;var yt=(n,e)=>{for(var t in e)X(n,t,{get:e[t],enumerable:!0})},Te=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Mt(e))!vt.call(n,r)&&r!==t&&X(n,r,{get:()=>e[r],enumerable:!(s=Lt(e,r))||s.enumerable});return n};var y=(n,e,t)=>(t=n!=null?It(Dt(n)):{},Te(e||!n||!n.__esModule?X(t,"default",{value:n,enumerable:!0}):t,n)),Ut=n=>Te(X({},"__esModule",{value:!0}),n);var Zt={};yt(Zt,{generateContext:()=>Ee});module.exports=Ut(Zt);var Ot=y(require("path"),1),Rt=require("os"),Nt=require("fs");var Ce=require("bun:sqlite");var h=require("path"),te=require("os"),H=require("fs");var he=require("url");var L=require("fs"),U=require("path"),Se=require("os"),Z=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Z||{}),fe=(0,U.join)((0,Se.homedir)(),".claude-mem"),ee=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,U.join)(fe,"logs");(0,L.existsSync)(e)||(0,L.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,U.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,U.join)(fe,"settings.json");if((0,L.existsSync)(e)){let t=(0,L.readFileSync)(e,"utf-8"),r=(JSON.parse(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=Z[r]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${r} ${o}:${i}:${a}.${d}`}log(e,t,s,r,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=Z[e].padEnd(5),d=t.padEnd(6),c="";r?.correlationId?c=`[${r.correlationId}] `:r?.sessionId&&(c=`[session-${r.sessionId}] `);let _="";o!=null&&(o instanceof Error?_=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?_=`
`+JSON.stringify(o,null,2):_=" "+this.formatData(o));let l="";if(r){let{sessionId:g,memorySessionId:S,correlationId:b,...p}=r;Object.keys(p).length>0&&(l=` {${Object.entries(p).map(([T,f])=>`${T}=${f}`).join(", ")}}`)}let E=`[${i}] [${a}] [${d}] ${c}${s}${l}${_}`;if(this.logFilePath)try{(0,L.appendFileSync)(this.logFilePath,E+`
`,"utf8")}catch(g){process.stderr.write(`[LOGGER] Failed to write to log file: ${g}
`)}else process.stderr.write(E+`
`)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}error(e,t,s,r){this.log(3,e,t,s,r)}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}timing(e,t,s,r){this.info(e,`\u23F1 ${t}`,r,{duration:`${s}ms`})}happyPathError(e,t,s,r,o=""){let c=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),_=c?`${c[1].split("/").pop()}:${c[2]}`:"unknown",l={...s,location:_};return this.warn(e,`[HAPPY-PATH] ${t}`,l,r),o}},m=new ee;var Ft={};function xt(){return typeof __dirname<"u"?__dirname:(0,h.dirname)((0,he.fileURLToPath)(Ft.url))}var kt=xt();function $t(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let n=(0,h.join)((0,te.homedir)(),".claude-mem"),e=(0,h.join)(n,"settings.json");try{if((0,H.existsSync)(e)){let{readFileSync:t}=require("fs"),s=JSON.parse(t(e,"utf-8")),r=s.env??s;if(r.CLAUDE_MEM_DATA_DIR)return r.CLAUDE_MEM_DATA_DIR}}catch{}return n}var C=$t(),D=process.env.CLAUDE_CONFIG_DIR||(0,h.join)((0,te.homedir)(),".claude"),ns=(0,h.join)(D,"plugins","marketplaces","thedotmack"),os=(0,h.join)(C,"archives"),is=(0,h.join)(C,"logs"),as=(0,h.join)(C,"trash"),ds=(0,h.join)(C,"backups"),us=(0,h.join)(C,"modes"),cs=(0,h.join)(C,"settings.json"),be=(0,h.join)(C,"claude-mem.db"),_s=(0,h.join)(C,"vector-db"),ms=(0,h.join)(C,"observer-sessions"),ls=(0,h.join)(D,"settings.json"),ps=(0,h.join)(D,"commands"),Es=(0,h.join)(D,"CLAUDE.md");function Ae(n){(0,H.mkdirSync)(n,{recursive:!0})}function Oe(){return(0,h.join)(kt,"..")}var Re=require("crypto");var wt=3e4;function j(n,e,t){return(0,Re.createHash)("sha256").update([n||"",e||"",t||""].join("\0")).digest("hex").slice(0,16)}function G(n,e,t,s){let r=t-wt;return n.prepare("SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ? AND node IS ?").get(e,r,s??null)}function se(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[String(e)]}catch{return[n]}}var A="claude";function Pt(n){return n.trim().toLowerCase().replace(/\s+/g,"-")}function v(n){if(!n)return A;let e=Pt(n);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:A}function Ne(n){let e=["claude","codex","cursor"];return[...n].sort((t,s)=>{let r=e.indexOf(t),o=e.indexOf(s);return r!==-1||o!==-1?r===-1?1:o===-1?-1:r-o:t.localeCompare(s)})}function Xt(n,e){return{customTitle:n,platformSource:e?v(e):void 0}}var B=class{db;_currentNode=null;_currentPlatform=null;_currentInstance=null;_currentLlmSource=null;setLocalProvenance(e,t,s,r){this._currentNode=e,this._currentPlatform=t,this._currentInstance=s,this._currentLlmSource=r??null}constructor(e=be){e!==":memory:"&&Ae(C),this.db=new Ce.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns(),this.addObservationProvenanceColumns(),this.addSummaryProvenanceColumns()}initializeSchema(){this.db.run(`
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
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(s=>s.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),m.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),m.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),m.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),m.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(s=>s.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}m.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),m.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}m.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),m.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}m.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
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
      `)}catch(s){m.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},s)}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),m.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),m.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),m.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}m.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),m.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;m.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(r,o,i)=>{let a=this.db.query(`PRAGMA table_info(${r})`).all(),d=a.some(_=>_.name===o);return a.some(_=>_.name===i)?!1:d?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${o} TO ${i}`),m.debug("DB",`Renamed ${r}.${o} to ${i}`),!0):(m.warn("DB",`Column ${o} not found in ${r}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?m.debug("DB",`Successfully renamed ${t} session ID columns`):m.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),m.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addOnUpdateCascadeToForeignKeys(){if(!this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)){m.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new");let t=new Set(this.db.prepare("PRAGMA table_info(observations)").all().map(p=>p.name)),s=[],r=[];t.has("content_hash")&&(s.push("content_hash TEXT"),r.push("content_hash")),t.has("node")&&(s.push("node TEXT"),r.push("node")),t.has("platform")&&(s.push("platform TEXT"),r.push("platform")),t.has("instance")&&(s.push("instance TEXT"),r.push("instance")),t.has("llm_source")&&(s.push("llm_source TEXT"),r.push("llm_source")),t.has("generated_by_model")&&(s.push("generated_by_model TEXT"),r.push("generated_by_model")),t.has("relevance_count")&&(s.push("relevance_count INTEGER DEFAULT 0"),r.push("relevance_count"));let o=s.length>0?`,
          ${s.join(`,
          `)}`:"",i="id, memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch",a=r.length>0?`${i}, ${r.join(", ")}`:i;this.db.run(`
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
          created_at_epoch INTEGER NOT NULL${o},
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `),this.db.run(`
        INSERT INTO observations_new
        SELECT ${a}
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
        `),this.db.run("DROP TABLE IF EXISTS session_summaries_new");let c=new Set(this.db.prepare("PRAGMA table_info(session_summaries)").all().map(p=>p.name)),_=[],l=[];c.has("node")&&(_.push("node TEXT"),l.push("node")),c.has("platform")&&(_.push("platform TEXT"),l.push("platform")),c.has("instance")&&(_.push("instance TEXT"),l.push("instance")),c.has("llm_source")&&(_.push("llm_source TEXT"),l.push("llm_source"));let E=_.length>0?`,
          ${_.join(`,
          `)}`:"",g="id, memory_session_id, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at, created_at_epoch",S=l.length>0?`${g}, ${l.join(", ")}`:g;this.db.run(`
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
          created_at_epoch INTEGER NOT NULL${E},
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `),this.db.run(`
        INSERT INTO session_summaries_new
        SELECT ${S}
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
        `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),m.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(t){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),t}}}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),m.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),m.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let t=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(i=>i.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&t&&r||(t||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${A}'`),m.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${A}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),t=e.some(r=>r.name==="generated_by_model"),s=e.some(r=>r.name==="relevance_count");t&&s||(t||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),s||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}addObservationProvenanceColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(27),t=[{name:"observations",pragma:"PRAGMA table_info(observations)"},{name:"sdk_sessions",pragma:"PRAGMA table_info(sdk_sessions)"},{name:"user_prompts",pragma:"PRAGMA table_info(user_prompts)"}],s=["node","platform","instance","llm_source"];for(let{name:r,pragma:o}of t){let i=this.db.query(o).all(),a=new Set(i.map(d=>d.name));for(let d of s)a.has(d)||(r==="observations"?this.db.run(`ALTER TABLE observations ADD COLUMN ${d} TEXT`):r==="sdk_sessions"?this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN ${d} TEXT`):r==="user_prompts"&&this.db.run(`ALTER TABLE user_prompts ADD COLUMN ${d} TEXT`))}this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_node ON observations(node)"),e||(m.debug("DB","Added node/platform/instance/llm_source origin tracking to observations, sdk_sessions, user_prompts"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(27,new Date().toISOString()))}addSummaryProvenanceColumns(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(28),t=this.db.query("PRAGMA table_info(session_summaries)").all(),s=new Set(t.map(r=>r.name));for(let r of["node","platform","instance","llm_source"])s.has(r)||this.db.run(`ALTER TABLE session_summaries ADD COLUMN ${r} TEXT`);e||(m.debug("DB","Added node, platform, instance, llm_source columns to session_summaries table"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()))}updateMemorySessionId(e,t){this.db.prepare(`
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
    `,r=[];return t&&(s+=" AND COALESCE(platform_source, ?) = ?",r.push(A,t)),s+=" ORDER BY project ASC",this.db.prepare(s).all(...r).map(i=>i.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${A}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      GROUP BY COALESCE(platform_source, '${A}'), project
      ORDER BY latest_epoch DESC
    `).all(),t=[],s=new Set,r={};for(let i of e){let a=v(i.platform_source);r[a]||(r[a]=[]),r[a].includes(i.project)||r[a].push(i.project),s.has(i.project)||(s.add(i.project),t.push(i.project))}let o=Ne(Object.keys(r));return{projects:t,sources:o,projectsBySource:Object.fromEntries(o.map(i=>[i,r[i]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o,type:i,concepts:a,files:d}=t,c=s==="date_asc"?"ASC":"DESC",_=r?`LIMIT ${r}`:"",l=e.map(()=>"?").join(","),E=[...e],g=[];if(o&&(g.push("project = ?"),E.push(o)),i)if(Array.isArray(i)){let p=i.map(()=>"?").join(",");g.push(`type IN (${p})`),E.push(...i)}else g.push("type = ?"),E.push(i);if(a){let p=Array.isArray(a)?a:[a],R=p.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");E.push(...p),g.push(`(${R.join(" OR ")})`)}if(d){let p=Array.isArray(d)?d:[d],R=p.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");p.forEach(T=>{E.push(`%${T}%`,`%${T}%`)}),g.push(`(${R.join(" OR ")})`)}let S=g.length>0?`WHERE id IN (${l}) AND ${g.join(" AND ")}`:`WHERE id IN (${l})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${S}
      ORDER BY created_at_epoch ${c}
      ${_}
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
    `).all(e),r=new Set,o=new Set;for(let i of s)se(i.files_read).forEach(a=>r.add(a)),se(i.files_modified).forEach(a=>o.add(a));return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${A}') as platform_source,
             user_prompt, custom_title
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
    `).get(e).count}createSDKSession(e,t,s,r,o){let i=new Date,a=i.getTime(),d=Xt(r,o),c=d.platformSource??A,_=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(_){if(t&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(t,e),d.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(d.customTitle,e),d.platformSource){let E=_.platform_source?.trim()?v(_.platform_source):void 0;if(!E)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(d.platformSource,e);else if(E!==d.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${E}, received=${d.platformSource}`)}return _.id}return this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,t,c,s,d.customTitle||null,i.toISOString(),a),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,t,s,r,o,i,a){let d=new Date,c=d.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, node, platform, instance, llm_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s,d.toISOString(),c,r||(this._currentNode??null),o||(this._currentPlatform??null),i||(this._currentInstance??null),a||(this._currentLlmSource??null)).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,r,o=0,i,a,d,c,_,l){let E=i??Date.now(),g=new Date(E).toISOString(),S=j(e,s.title,s.narrative),b=G(this.db,S,E,d);if(b)return{id:b.id,createdAtEpoch:b.created_at_epoch};let R=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model, node, platform, instance, llm_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),r||null,o,S,g,E,a||null,d||null,c||null,_||null,l||null);return{id:Number(R.lastInsertRowid),createdAtEpoch:E}}storeSummary(e,t,s,r,o=0,i,a,d,c,_){let l=i??Date.now(),E=new Date(l).toISOString(),S=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
       node, platform, instance, llm_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,r||null,o,E,l,a??null,d??null,c??null,_??null);return{id:Number(S.lastInsertRowid),createdAtEpoch:l}}storeObservations(e,t,s,r,o,i=0,a,d,c,_,l,E){let g=a??Date.now(),S=new Date(g).toISOString();return this.db.transaction(()=>{let p=[],R=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model, node, platform, instance, llm_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let f of s){let M=j(e,f.title,f.narrative),Q=G(this.db,M,g,c);if(Q){p.push(Q.id);continue}let N=R.run(e,t,f.type,f.title,f.subtitle,JSON.stringify(f.facts),f.narrative,JSON.stringify(f.concepts),JSON.stringify(f.files_read),JSON.stringify(f.files_modified),o||null,i,M,S,g,d||null,c??null,_??null,l??null,E??null);p.push(Number(N.lastInsertRowid))}let T=null;if(r){let M=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
           node, platform, instance, llm_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,o||null,i,S,g,c??null,_??null,l??null,E??null);T=Number(M.lastInsertRowid)}return{observationIds:p,summaryId:T,createdAtEpoch:g}})()}storeObservationsAndMarkComplete(e,t,s,r,o,i,a,d=0,c,_,l,E,g,S){let b=c??Date.now(),p=new Date(b).toISOString();return this.db.transaction(()=>{let T=[],f=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model, node, platform, instance, llm_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let N of s){let P=j(e,N.title,N.narrative),ge=G(this.db,P,b,l);if(ge){T.push(ge.id);continue}let Ct=f.run(e,t,N.type,N.title,N.subtitle,JSON.stringify(N.facts),N.narrative,JSON.stringify(N.concepts),JSON.stringify(N.files_read),JSON.stringify(N.files_modified),a||null,d,P,p,b,_||null,l??null,E??null,g??null,S??null);T.push(Number(Ct.lastInsertRowid))}let M;if(r){let P=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch,
           node, platform, instance, llm_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,a||null,d,p,b,l??null,E??null,g??null,S??null);M=Number(P.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(b,o),{observationIds:T,summaryId:M,createdAtEpoch:b}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o}=t,i=s==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),c=[...e],_=o?`WHERE id IN (${d}) AND project = ?`:`WHERE id IN (${d})`;return o&&c.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${_}
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...c)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o}=t,i=s==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),c=[...e],_=o?"AND s.project = ?":"";return o&&c.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${d}) ${_}
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...c)}getTimelineAroundTimestamp(e,t=10,s=10,r){return this.getTimelineAroundObservation(null,e,t,s,r)}getTimelineAroundObservation(e,t,s=10,r=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],d,c;if(e!==null){let p=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,R=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let T=this.db.prepare(p).all(e,...a,s+1),f=this.db.prepare(R).all(e,...a,r+1);if(T.length===0&&f.length===0)return{observations:[],sessions:[],prompts:[]};d=T.length>0?T[T.length-1].created_at_epoch:t,c=f.length>0?f[f.length-1].created_at_epoch:t}catch(T){return m.error("DB","Error getting boundary observations",void 0,{error:T,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let p=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,R=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let T=this.db.prepare(p).all(t,...a,s),f=this.db.prepare(R).all(t,...a,r+1);if(T.length===0&&f.length===0)return{observations:[],sessions:[],prompts:[]};d=T.length>0?T[T.length-1].created_at_epoch:t,c=f.length>0?f[f.length-1].created_at_epoch:t}catch(T){return m.error("DB","Error getting boundary timestamps",void 0,{error:T,project:o}),{observations:[],sessions:[],prompts:[]}}}let _=`
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
    `,g=this.db.prepare(_).all(d,c,...a),S=this.db.prepare(l).all(d,c,...a),b=this.db.prepare(E).all(d,c,...a);return{observations:g,sessions:S.map(p=>({id:p.id,memory_session_id:p.memory_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:b.map(p=>({id:p.id,content_session_id:p.content_session_id,prompt_number:p.prompt_number,prompt_text:p.prompt_text,project:p.project,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
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
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}rebuildObservationsFTSIndex(){this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')")}importUserPrompt(e){let t=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Ie=require("os"),Le=y(require("path"),1);function Ht(n){return n==="~"||n.startsWith("~/")?n.replace(/^~/,(0,Ie.homedir)()):n}function Me(n){if(!n||n.trim()==="")return m.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:n}),"unknown-project";let e=Ht(n),t=Le.default.basename(e);if(t===""){if(process.platform==="win32"){let r=n.match(/^([A-Z]):\\/i);if(r){let i=`drive-${r[1].toUpperCase()}`;return m.info("PROJECT_NAME","Drive root detected",{cwd:n,projectName:i}),i}}return m.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:n}),"unknown-project"}return t}var De=y(require("path"),1),ve=require("os");var I=require("fs"),x=require("path"),re=require("os"),W=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-6",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_GEMINI_MAX_TOKENS:"100000",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_DATA_DIR:(0,x.join)((0,re.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"false",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_FULL_COUNT:"0",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT:"true",CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:"false",CLAUDE_MEM_FOLDER_USE_LOCAL_MD:"false",CLAUDE_MEM_TRANSCRIPTS_ENABLED:"true",CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH:(0,x.join)((0,re.homedir)(),".claude-mem","transcript-watch.json"),CLAUDE_MEM_MAX_CONCURRENT_AGENTS:"2",CLAUDE_MEM_EXCLUDED_PROJECTS:"",CLAUDE_MEM_FOLDER_MD_EXCLUDE:"[]",CLAUDE_MEM_SEMANTIC_INJECT:"false",CLAUDE_MEM_SEMANTIC_INJECT_LIMIT:"5",CLAUDE_MEM_TIER_ROUTING_ENABLED:"true",CLAUDE_MEM_TIER_SIMPLE_MODEL:"haiku",CLAUDE_MEM_TIER_SUMMARY_MODEL:"",CLAUDE_MEM_CHROMA_ENABLED:"true",CLAUDE_MEM_CHROMA_MODE:"local",CLAUDE_MEM_CHROMA_HOST:"127.0.0.1",CLAUDE_MEM_CHROMA_PORT:"8000",CLAUDE_MEM_CHROMA_SSL:"false",CLAUDE_MEM_CHROMA_API_KEY:"",CLAUDE_MEM_CHROMA_TENANT:"default_tenant",CLAUDE_MEM_CHROMA_DATABASE:"default_database",CLAUDE_MEM_NETWORK_MODE:"standalone",CLAUDE_MEM_SERVER_HOST:"",CLAUDE_MEM_SERVER_PORT:"37777",CLAUDE_MEM_AUTH_TOKEN:"",CLAUDE_MEM_NODE_NAME:"",CLAUDE_MEM_INSTANCE_NAME:"",CLAUDE_MEM_LLM_SOURCE:"",CLAUDE_MEM_SETTINGS_SYNC_ENABLED:"true",CLAUDE_MEM_SETTINGS_SYNC_INTERVAL_MS:"60000"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]??this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){let t=this.get(e);return t==="true"||t===!0}static applyEnvOverrides(e){let t={...e};for(let s of Object.keys(this.DEFAULTS))process.env[s]!==void 0&&(t[s]=process.env[s]);return t}static loadFromFile(e){try{if(!(0,I.existsSync)(e)){let i=this.getAllDefaults();try{let a=(0,x.dirname)(e);(0,I.existsSync)(a)||(0,I.mkdirSync)(a,{recursive:!0}),(0,I.writeFileSync)(e,JSON.stringify(i,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(a){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,a)}return this.applyEnvOverrides(i)}let t=(0,I.readFileSync)(e,"utf-8"),s=JSON.parse(t),r=s;if(s.env&&typeof s.env=="object"){r=s.env;try{(0,I.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(i){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,i)}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))r[i]!==void 0&&(o[i]=r[i]);return this.applyEnvOverrides(o)}catch(t){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t),this.applyEnvOverrides(this.getAllDefaults())}}};var k=require("fs"),Y=require("path");var O=class n{static instance=null;activeMode=null;modesDir;constructor(){let e=Oe(),t=[(0,Y.join)(e,"modes"),(0,Y.join)(e,"..","plugin","modes")],s=t.find(r=>(0,k.existsSync)(r));this.modesDir=s||t[0]}static getInstance(){return n.instance||(n.instance=new n),n.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let r in t){let o=t[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?s[r]=this.deepMerge(i,o):s[r]=o}return s}loadModeFile(e){let t=(0,Y.join)(this.modesDir,`${e}.json`);if(!(0,k.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,k.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,m.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(c=>c.id),concepts:d.observation_concepts.map(c=>c.id)}),d}catch{if(m.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:r}=t,o;try{o=this.loadMode(s)}catch{m.warn("SYSTEM",`Parent mode '${s}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),m.debug("SYSTEM",`Loaded override file: ${r} for parent ${s}`)}catch{return m.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${s}' only`),this.activeMode=o,o}if(!i)return m.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${s}' only`),this.activeMode=o,o;let a=this.deepMerge(o,i);return this.activeMode=a,m.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${s} + ${r})`,void 0,{parent:s,override:r,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(s=>s.id===e)?.label||e}};function ne(){let n=De.default.join((0,ve.homedir)(),".claude-mem","settings.json"),e=W.loadFromFile(n),t=O.getInstance().getActiveMode(),s=new Set(t.observation_types.map(o=>o.id)),r=new Set(t.observation_concepts.map(o=>o.id));return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:s,observationConcepts:r,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var u={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},ye=4,oe=1;function ie(n){let e=(n.title?.length||0)+(n.subtitle?.length||0)+(n.narrative?.length||0)+JSON.stringify(n.facts||[]).length;return Math.ceil(e/ye)}function ae(n){let e=n.length,t=n.reduce((i,a)=>i+ie(a),0),s=n.reduce((i,a)=>i+(a.discovery_tokens||0),0),r=s-t,o=s>0?Math.round(r/s*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:s,savings:r,savingsPercent:o}}function jt(n){return O.getInstance().getWorkEmoji(n)}function $(n,e){let t=ie(n),s=n.discovery_tokens||0,r=jt(n.type),o=s>0?`${r} ${s.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:s,discoveryDisplay:o,workEmoji:r}}function V(n){return n.showReadTokens||n.showWorkTokens||n.showSavingsAmount||n.showSavingsPercent}var xe=y(require("path"),1),q=require("fs");var Ue=/<system-reminder>[\s\S]*?<\/system-reminder>/g;function de(n,e,t,s){let r=Array.from(t.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(t.observationConcepts),a=i.map(()=>"?").join(",");return n.db.prepare(`
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
      ${s?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(e,...r,...i,...s?[s]:[],t.totalObservationCount)}function ue(n,e,t,s){return n.db.prepare(`
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
      ${s?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(e,...s?[s]:[],t.sessionCount+oe)}function ke(n,e,t,s){let r=Array.from(t.observationTypes),o=r.map(()=>"?").join(","),i=Array.from(t.observationConcepts),a=i.map(()=>"?").join(","),d=e.map(()=>"?").join(",");return n.db.prepare(`
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
      ${s?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...r,...i,...s?[s]:[],t.totalObservationCount)}function $e(n,e,t,s){let r=e.map(()=>"?").join(",");return n.db.prepare(`
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
      ${s?"AND COALESCE(s.platform_source, 'claude') = ?":""}
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...e,...s?[s]:[],t.sessionCount+oe)}function Gt(n){return n.replace(/\//g,"-")}function Bt(n){try{if(!(0,q.existsSync)(n))return{userMessage:"",assistantMessage:""};let e=(0,q.readFileSync)(n,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(r=>r.trim()),s="";for(let r=t.length-1;r>=0;r--)try{let o=t[r];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let a="";for(let d of i.message.content)d.type==="text"&&(a+=d.text);if(a=a.replace(Ue,"").trim(),a){s=a;break}}}catch(o){m.debug("PARSER","Skipping malformed transcript line",{lineIndex:r},o);continue}return{userMessage:"",assistantMessage:s}}catch(e){return m.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:n},e),{userMessage:"",assistantMessage:""}}}function ce(n,e,t,s){if(!e.showLastMessage||n.length===0)return{userMessage:"",assistantMessage:""};let r=n.find(d=>d.memory_session_id!==t);if(!r)return{userMessage:"",assistantMessage:""};let o=r.memory_session_id,i=Gt(s),a=xe.default.join(D,"projects",i,`${o}.jsonl`);return Bt(a)}function Fe(n,e){let t=e[0]?.id;return n.map((s,r)=>{let o=r===0?null:e[r+1];return{...s,displayEpoch:o?o.created_at_epoch:s.created_at_epoch,displayTime:o?o.created_at:s.created_at,shouldShowLink:s.id!==t}})}function _e(n,e){let t=[...n.map(s=>({type:"observation",data:s})),...e.map(s=>({type:"summary",data:s}))];return t.sort((s,r)=>{let o=s.type==="observation"?s.data.created_at_epoch:s.data.displayEpoch,i=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch;return o-i}),t}function we(n,e){return new Set(n.slice(0,e).map(t=>t.id))}function Pe(){let n=new Date,e=n.toLocaleDateString("en-CA"),t=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function Xe(n){return[`# $CMEM ${n} ${Pe()}`,""]}function He(){return[`Legend: \u{1F3AF}session ${O.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji}${t.id}`).join(" ")}`,"Format: ID TIME TYPE TITLE","Fetch details: get_observations([IDs]) | Search: mem-search skill",""]}function je(){return[]}function Ge(){return[]}function Be(n,e){let t=[],s=[`${n.totalObservations} obs (${n.totalReadTokens.toLocaleString()}t read)`,`${n.totalDiscoveryTokens.toLocaleString()}t work`];return n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)&&(e.showSavingsPercent?s.push(`${n.savingsPercent}% savings`):e.showSavingsAmount&&s.push(`${n.savings.toLocaleString()}t saved`)),t.push(`Stats: ${s.join(" | ")}`),t.push(""),t}function We(n){return[`### ${n}`]}function Ye(n){return n.toLowerCase().replace(" am","a").replace(" pm","p")}function Ve(n,e,t){let s=n.title||"Untitled",r=O.getInstance().getTypeIcon(n.type),o=e?Ye(e):'"';return`${n.id} ${o} ${r} ${s}`}function qe(n,e,t,s){let r=[],o=n.title||"Untitled",i=O.getInstance().getTypeIcon(n.type),a=e?Ye(e):'"',{readTokens:d,discoveryDisplay:c}=$(n,s);r.push(`**${n.id}** ${a} ${i} **${o}**`),t&&r.push(t);let _=[];return s.showReadTokens&&_.push(`~${d}t`),s.showWorkTokens&&_.push(c),_.length>0&&r.push(_.join(" ")),r.push(""),r}function Ke(n,e){return[`S${n.id} ${n.request||"Session started"} (${e})`]}function F(n,e){return e?[`**${n}**: ${e}`,""]:[]}function Je(n){return n.assistantMessage?["","---","","**Previously**","",`A: ${n.assistantMessage}`,""]:[]}function ze(n,e){return["",`Access ${Math.round(n/1e3)}k tokens of past work via get_observations([IDs]) or mem-search skill.`]}function Qe(n){return`# $CMEM ${n} ${Pe()}

No previous sessions found.`}function Ze(){let n=new Date,e=n.toLocaleDateString("en-CA"),t=n.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=n.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${s}`}function et(n){return["",`${u.bright}${u.cyan}[${n}] recent context, ${Ze()}${u.reset}`,`${u.gray}${"\u2500".repeat(60)}${u.reset}`,""]}function tt(){let e=O.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${u.dim}Legend: session-request | ${e}${u.reset}`,""]}function st(){return[`${u.bright}Column Key${u.reset}`,`${u.dim}  Read: Tokens to read this observation (cost to learn it now)${u.reset}`,`${u.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${u.reset}`,""]}function rt(){return[`${u.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${u.reset}`,"",`${u.dim}When you need implementation details, rationale, or debugging context:${u.reset}`,`${u.dim}  - Fetch by ID: get_observations([IDs]) for observations visible in this index${u.reset}`,`${u.dim}  - Search history: Use the mem-search skill for past decisions, bugs, and deeper research${u.reset}`,`${u.dim}  - Trust this index over re-reading code for past decisions and learnings${u.reset}`,""]}function nt(n,e){let t=[];if(t.push(`${u.bright}${u.cyan}Context Economics${u.reset}`),t.push(`${u.dim}  Loading: ${n.totalObservations} observations (${n.totalReadTokens.toLocaleString()} tokens to read)${u.reset}`),t.push(`${u.dim}  Work investment: ${n.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${u.reset}`),n.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${n.savings.toLocaleString()} tokens (${n.savingsPercent}% reduction from reuse)`:e.showSavingsAmount?s+=`${n.savings.toLocaleString()} tokens`:s+=`${n.savingsPercent}% reduction from reuse`,t.push(`${u.green}${s}${u.reset}`)}return t.push(""),t}function ot(n){return[`${u.bright}${u.cyan}${n}${u.reset}`,""]}function it(n){return[`${u.dim}${n}${u.reset}`]}function at(n,e,t,s){let r=n.title||"Untitled",o=O.getInstance().getTypeIcon(n.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=$(n,s),c=t?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),_=s.showReadTokens&&i>0?`${u.dim}(~${i}t)${u.reset}`:"",l=s.showWorkTokens&&a>0?`${u.dim}(${d} ${a.toLocaleString()}t)${u.reset}`:"";return`  ${u.dim}#${n.id}${u.reset}  ${c}  ${o}  ${r} ${_} ${l}`}function dt(n,e,t,s,r){let o=[],i=n.title||"Untitled",a=O.getInstance().getTypeIcon(n.type),{readTokens:d,discoveryTokens:c,workEmoji:_}=$(n,r),l=t?`${u.dim}${e}${u.reset}`:" ".repeat(e.length),E=r.showReadTokens&&d>0?`${u.dim}(~${d}t)${u.reset}`:"",g=r.showWorkTokens&&c>0?`${u.dim}(${_} ${c.toLocaleString()}t)${u.reset}`:"";return o.push(`  ${u.dim}#${n.id}${u.reset}  ${l}  ${a}  ${u.bright}${i}${u.reset}`),s&&o.push(`    ${u.dim}${s}${u.reset}`),(E||g)&&o.push(`    ${E} ${g}`),o.push(""),o}function ut(n,e){let t=`${n.request||"Session started"} (${e})`;return[`${u.yellow}#S${n.id}${u.reset} ${t}`,""]}function w(n,e,t){return e?[`${t}${n}:${u.reset} ${e}`,""]:[]}function ct(n){return n.assistantMessage?["","---","",`${u.bright}${u.magenta}Previously${u.reset}`,"",`${u.dim}A: ${n.assistantMessage}${u.reset}`,""]:[]}function _t(n,e){let t=Math.round(n/1e3);return["",`${u.dim}Access ${t}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use the claude-mem skill to access memories by ID.${u.reset}`]}function mt(n){return`
${u.bright}${u.cyan}[${n}] recent context, ${Ze()}${u.reset}
${u.gray}${"\u2500".repeat(60)}${u.reset}

${u.dim}No previous sessions found for this project yet.${u.reset}
`}function lt(n,e,t,s){let r=[];return s?r.push(...et(n)):r.push(...Xe(n)),s?r.push(...tt()):r.push(...He()),s?r.push(...st()):r.push(...je()),s?r.push(...rt()):r.push(...Ge()),V(t)&&(s?r.push(...nt(e,t)):r.push(...Be(e,t))),r}var me=y(require("path"),1);function z(n){if(!n)return[];try{let e=JSON.parse(n);return Array.isArray(e)?e:[]}catch(e){return m.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:n?.substring(0,50)},e),[]}}function le(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function pe(n){return new Date(n).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Et(n){return new Date(n).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function pt(n,e){return me.default.isAbsolute(n)?me.default.relative(e,n):n}function gt(n,e,t){let s=z(n);if(s.length>0)return pt(s[0],e);if(t){let r=z(t);if(r.length>0)return pt(r[0],e)}return"General"}function Wt(n){let e=new Map;for(let s of n){let r=s.type==="observation"?s.data.created_at:s.data.displayTime,o=Et(r);e.has(o)||e.set(o,[]),e.get(o).push(s)}let t=Array.from(e.entries()).sort((s,r)=>{let o=new Date(s[0]).getTime(),i=new Date(r[0]).getTime();return o-i});return new Map(t)}function Tt(n,e){return e.fullObservationField==="narrative"?n.narrative:n.facts?z(n.facts).join(`
`):null}function Yt(n,e,t,s){let r=[];r.push(...We(n));let o="";for(let i of e)if(i.type==="summary"){let a=i.data,d=le(a.displayTime);r.push(...Ke(a,d))}else{let a=i.data,d=pe(a.created_at),_=d!==o?d:"";if(o=d,t.has(a.id)){let E=Tt(a,s);r.push(...qe(a,_,E,s))}else r.push(Ve(a,_,s))}return r}function Vt(n,e,t,s,r){let o=[];o.push(...ot(n));let i=null,a="";for(let d of e)if(d.type==="summary"){i=null,a="";let c=d.data,_=le(c.displayTime);o.push(...ut(c,_))}else{let c=d.data,_=gt(c.files_modified,r,c.files_read),l=pe(c.created_at),E=l!==a;a=l;let g=t.has(c.id);if(_!==i&&(o.push(...it(_)),i=_),g){let S=Tt(c,s);o.push(...dt(c,l,E,S,s))}else o.push(at(c,l,E,s))}return o.push(""),o}function qt(n,e,t,s,r,o){return o?Vt(n,e,t,s,r):Yt(n,e,t,s)}function ft(n,e,t,s,r){let o=[],i=Wt(n);for(let[a,d]of i)o.push(...qt(a,d,e,t,s,r));return o}function St(n,e,t){return!(!n.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function ht(n,e){let t=[];return e?(t.push(...w("Investigated",n.investigated,u.blue)),t.push(...w("Learned",n.learned,u.yellow)),t.push(...w("Completed",n.completed,u.green)),t.push(...w("Next Steps",n.next_steps,u.magenta))):(t.push(...F("Investigated",n.investigated)),t.push(...F("Learned",n.learned)),t.push(...F("Completed",n.completed)),t.push(...F("Next Steps",n.next_steps))),t}function bt(n,e){return e?ct(n):Je(n)}function At(n,e,t){return!V(e)||n.totalDiscoveryTokens<=0||n.savings<=0?[]:t?_t(n.totalDiscoveryTokens,n.totalReadTokens):ze(n.totalDiscoveryTokens,n.totalReadTokens)}var Kt=Ot.default.join((0,Rt.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Jt(){try{return new B}catch(n){if(n.code==="ERR_DLOPEN_FAILED"){try{(0,Nt.unlinkSync)(Kt)}catch(e){m.debug("SYSTEM","Marker file cleanup failed (may not exist)",{},e)}return m.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw n}}function zt(n,e){return e?mt(n):Qe(n)}function Qt(n,e,t,s,r,o,i){let a=[],d=ae(e);a.push(...lt(n,d,s,i));let c=t.slice(0,s.sessionCount),_=Fe(c,t),l=_e(e,_),E=we(e,s.fullObservationCount);a.push(...ft(l,E,s,r,i));let g=t[0],S=e[0];St(s,g,S)&&a.push(...ht(g,i));let b=ce(e,s,o,r);return a.push(...bt(b,i)),a.push(...At(d,s,i)),a.join(`
`).trimEnd()}async function Ee(n,e=!1){let t=ne(),s=n?.cwd??process.cwd(),r=Me(s),o=n?.platform_source,i=n?.projects||[r];n?.full&&(t.totalObservationCount=999999,t.sessionCount=999999);let a=Jt();if(!a)return"";try{let d=i.length>1?ke(a,i,t,o):de(a,r,t,o),c=i.length>1?$e(a,i,t,o):ue(a,r,t,o);return d.length===0&&c.length===0?zt(r,e):Qt(r,d,c,t,s,n?.session_id,e)}finally{a.close()}}0&&(module.exports={generateContext});
