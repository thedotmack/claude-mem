"use strict";var Ge=Object.create;var Q=Object.defineProperty;var We=Object.getOwnPropertyDescriptor;var He=Object.getOwnPropertyNames;var Ye=Object.getPrototypeOf,Ve=Object.prototype.hasOwnProperty;var Ke=(d,e)=>{for(var t in e)Q(d,t,{get:e[t],enumerable:!0})},fe=(d,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of He(e))!Ve.call(d,r)&&r!==t&&Q(d,r,{get:()=>e[r],enumerable:!(s=We(e,r))||s.enumerable});return d};var ae=(d,e,t)=>(t=d!=null?Ge(Ye(d)):{},fe(e||!d||!d.__esModule?Q(t,"default",{value:d,enumerable:!0}):t,d)),qe=d=>fe(Q({},"__esModule",{value:!0}),d);var ot={};Ke(ot,{generateContext:()=>it});module.exports=qe(ot);var se=ae(require("path"),1),re=require("os"),W=require("fs");var Me=require("bun:sqlite");var b=require("path"),Ne=require("os"),Ae=require("fs");var Ie=require("url");var G=require("fs"),Oe=require("path"),Re=require("os");var Se="bugfix,feature,refactor,discovery,decision,change",be="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var j=require("fs"),z=require("path"),de=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(de||{}),_e=class{level=null;useColor;logFilePath=null;constructor(){this.useColor=process.stdout.isTTY??!1,this.initializeLogFile()}initializeLogFile(){try{let e=C.get("CLAUDE_MEM_DATA_DIR"),t=(0,z.join)(e,"logs");(0,j.existsSync)(t)||(0,j.mkdirSync)(t,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,z.join)(t,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}getLevel(){if(this.level===null)try{let e=C.get("CLAUDE_MEM_DATA_DIR"),t=(0,z.join)(e,"settings.json"),r=C.loadFromFile(t).CLAUDE_MEM_LOG_LEVEL.toUpperCase();this.level=de[r]??1}catch(e){console.error("[LOGGER] Failed to load settings, using INFO level:",e),this.level=1}return this.level}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=typeof t=="string"?JSON.parse(t):t;if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),a=String(e.getMinutes()).padStart(2,"0"),_=String(e.getSeconds()).padStart(2,"0"),c=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${r} ${i}:${a}:${_}.${c}`}log(e,t,s,r,i){if(e<this.getLevel())return;let a=this.formatTimestamp(new Date),_=de[e].padEnd(5),c=t.padEnd(6),l="";r?.correlationId?l=`[${r.correlationId}] `:r?.sessionId&&(l=`[session-${r.sessionId}] `);let u="";i!=null&&(i instanceof Error?u=this.getLevel()===0?`
${i.message}
${i.stack}`:` ${i.message}`:this.getLevel()===0&&typeof i=="object"?u=`
`+JSON.stringify(i,null,2):u=" "+this.formatData(i));let S="";if(r){let{sessionId:E,memorySessionId:A,correlationId:g,...n}=r;Object.keys(n).length>0&&(S=` {${Object.entries(n).map(([R,v])=>`${R}=${v}`).join(", ")}}`)}let O=`[${a}] [${_}] [${c}] ${l}${s}${S}${u}`;if(this.logFilePath)try{(0,j.appendFileSync)(this.logFilePath,O+`
`,"utf8")}catch(E){process.stderr.write(`[LOGGER] Failed to write to log file: ${E}
`)}else process.stderr.write(O+`
`)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}error(e,t,s,r){this.log(3,e,t,s,r)}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}timing(e,t,s,r){this.info(e,`\u23F1 ${t}`,r,{duration:`${s}ms`})}happyPathError(e,t,s,r,i=""){let l=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=l?`${l[1].split("/").pop()}:${l[2]}`:"unknown",S={...s,location:u};return this.warn(e,`[HAPPY-PATH] ${t}`,S,r),i}},p=new _e;var C=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_OPENAI_COMPATIBLE_PROFILES:"[]",CLAUDE_MEM_OPENAI_COMPATIBLE_ACTIVE_PROFILE:"",CLAUDE_MEM_DATA_DIR:(0,Oe.join)((0,Re.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:Se,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:be,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,G.existsSync)(e))return this.getAllDefaults();let t=(0,G.readFileSync)(e,"utf-8"),s=JSON.parse(t),r=s;if(s.env&&typeof s.env=="object"){r=s.env;try{(0,G.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),p.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(a){p.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},a)}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))r[a]!==void 0&&(i[a]=r[a]);return i}catch(t){return p.warn("SETTINGS","Failed to load settings, using defaults",{settingsPath:e},t),this.getAllDefaults()}}};var ze={};function Je(){return typeof __dirname<"u"?__dirname:(0,b.dirname)((0,Ie.fileURLToPath)(ze.url))}var Qe=Je(),M=C.get("CLAUDE_MEM_DATA_DIR"),ce=process.env.CLAUDE_CONFIG_DIR||(0,b.join)((0,Ne.homedir)(),".claude"),ft=(0,b.join)(M,"archives"),St=(0,b.join)(M,"logs"),bt=(0,b.join)(M,"trash"),Ot=(0,b.join)(M,"backups"),Rt=(0,b.join)(M,"modes"),Nt=(0,b.join)(M,"settings.json"),Le=(0,b.join)(M,"claude-mem.db"),At=(0,b.join)(M,"vector-db"),It=(0,b.join)(ce,"settings.json"),Lt=(0,b.join)(ce,"commands"),yt=(0,b.join)(ce,"CLAUDE.md");function ye(d){(0,Ae.mkdirSync)(d,{recursive:!0})}function Ce(){return(0,b.join)(Qe,"..")}var Z=class{db;constructor(e=Le){e!==":memory:"&&ye(M),this.db=new Me.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename()}initializeSchema(){try{this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(s=>s.version)):0)===0&&(p.info("DB","Initializing fresh database with migration004"),this.db.run(`
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
            type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
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
            FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
          CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
          CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),p.info("DB","Migration004 applied successfully"))}catch(e){throw p.error("DB","Schema initialization error",void 0,e),e}}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),p.info("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(c=>c.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),p.info("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(c=>c.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),p.info("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(c=>c.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),p.info("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}p.info("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),p.info("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}catch(r){throw this.db.run("ROLLBACK"),r}}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}p.info("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),p.info("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}p.info("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),p.info("DB","Successfully made observations.text nullable")}catch(r){throw this.db.run("ROLLBACK"),r}}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}p.info("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),p.info("DB","Successfully created user_prompts table with FTS5 support")}catch(s){throw this.db.run("ROLLBACK"),s}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),p.info("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),p.info("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw p.error("DB","Discovery tokens migration error",void 0,e),e}}createPendingMessagesTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}p.info("DB","Creating pending_messages table"),this.db.run(`
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),p.info("DB","pending_messages table created successfully")}catch(e){throw p.error("DB","Pending messages table migration error",void 0,e),e}}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;p.info("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(r,i,a)=>{try{let _=this.db.query(`PRAGMA table_info(${r})`).all(),c=_.some(u=>u.name===i);return _.some(u=>u.name===a)?!1:c?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${i} TO ${a}`),p.info("DB",`Renamed ${r}.${i} to ${a}`),!0):(p.warn("DB",`Column ${i} not found in ${r}, skipping rename`),!1)}catch(_){return p.warn("DB",`Could not rename ${r}.${i}: ${_.message}`),!1}};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?p.info("DB",`Successfully renamed ${t} session ID columns`):p.info("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:i,type:a,concepts:_,files:c}=t,l=s==="date_asc"?"ASC":"DESC",u=r?`LIMIT ${r}`:"",S=e.map(()=>"?").join(","),O=[...e],E=[];if(i&&(E.push("project = ?"),O.push(i)),a)if(Array.isArray(a)){let n=a.map(()=>"?").join(",");E.push(`type IN (${n})`),O.push(...a)}else E.push("type = ?"),O.push(a);if(_){let n=Array.isArray(_)?_:[_],I=n.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");O.push(...n),E.push(`(${I.join(" OR ")})`)}if(c){let n=Array.isArray(c)?c:[c],I=n.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");n.forEach(R=>{O.push(`%${R}%`,`%${R}%`)}),E.push(`(${I.join(" OR ")})`)}let A=E.length>0?`WHERE id IN (${S}) AND ${E.join(" AND ")}`:`WHERE id IN (${S})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${A}
      ORDER BY created_at_epoch ${l}
      ${u}
    `).all(...O)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),r=new Set,i=new Set;for(let a of s){if(a.files_read){let _=JSON.parse(a.files_read);Array.isArray(_)&&_.forEach(c=>r.add(c))}if(a.files_modified){let _=JSON.parse(a.files_modified);Array.isArray(_)&&_.forEach(c=>i.add(c))}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project, user_prompt,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${t})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,t,s){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,t,s,r.toISOString(),i),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,t,s){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,s,r.toISOString(),i).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,r,i=0,a){let _=a??Date.now(),c=new Date(_).toISOString(),u=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),r||null,i,c,_);return{id:Number(u.lastInsertRowid),createdAtEpoch:_}}storeSummary(e,t,s,r,i=0,a){let _=a??Date.now(),c=new Date(_).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,r||null,i,c,_);return{id:Number(u.lastInsertRowid),createdAtEpoch:_}}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:i}=t,a=s==="date_asc"?"ASC":"DESC",_=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(","),l=[...e],u=i?`WHERE id IN (${c}) AND project = ?`:`WHERE id IN (${c})`;return i&&l.push(i),this.db.prepare(`
      SELECT * FROM session_summaries
      ${u}
      ORDER BY created_at_epoch ${a}
      ${_}
    `).all(...l)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:i}=t,a=s==="date_asc"?"ASC":"DESC",_=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(","),l=[...e],u=i?"AND s.project = ?":"";return i&&l.push(i),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${c}) ${u}
      ORDER BY up.created_at_epoch ${a}
      ${_}
    `).all(...l)}getTimelineAroundTimestamp(e,t=10,s=10,r){return this.getTimelineAroundObservation(null,e,t,s,r)}getTimelineAroundObservation(e,t,s=10,r=10,i){let a=i?"AND project = ?":"",_=i?[i]:[],c,l;if(e!==null){let E=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${a}
        ORDER BY id DESC
        LIMIT ?
      `,A=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${a}
        ORDER BY id ASC
        LIMIT ?
      `;try{let g=this.db.prepare(E).all(e,..._,s+1),n=this.db.prepare(A).all(e,..._,r+1);if(g.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};c=g.length>0?g[g.length-1].created_at_epoch:t,l=n.length>0?n[n.length-1].created_at_epoch:t}catch(g){return p.error("DB","Error getting boundary observations",void 0,{error:g,project:i}),{observations:[],sessions:[],prompts:[]}}}else{let E=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${a}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,A=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${a}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let g=this.db.prepare(E).all(t,..._,s),n=this.db.prepare(A).all(t,..._,r+1);if(g.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};c=g.length>0?g[g.length-1].created_at_epoch:t,l=n.length>0?n[n.length-1].created_at_epoch:t}catch(g){return p.error("DB","Error getting boundary timestamps",void 0,{error:g,project:i}),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,S=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,O=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let E=this.db.prepare(u).all(c,l,..._),A=this.db.prepare(S).all(c,l,..._),g=this.db.prepare(O).all(c,l,..._);return{observations:E,sessions:A.map(n=>({id:n.id,memory_session_id:n.memory_session_id,project:n.project,request:n.request,completed:n.completed,next_steps:n.next_steps,created_at:n.created_at,created_at_epoch:n.created_at_epoch})),prompts:g.map(n=>({id:n.id,content_session_id:n.content_session_id,prompt_number:n.prompt_number,prompt_text:n.prompt_text,project:n.project,created_at:n.created_at,created_at_epoch:n.created_at_epoch}))}}catch(E){return p.error("DB","Error querying timeline records",void 0,{error:E,project:i}),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
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
    `).get(e)||null}close(){this.db.close()}importSdkSession(e){let t=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
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
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var pe=ae(require("path"),1);function me(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function De(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ve(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function $e(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ze(d,e){return pe.default.isAbsolute(d)?pe.default.relative(e,d):d}function Ue(d,e){let t=me(d);return t.length>0?Ze(t[0],e):"General"}var ke=ae(require("path"),1);function xe(d){if(!d||d.trim()==="")return p.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:d}),"unknown-project";let e=ke.default.basename(d);if(e===""){if(process.platform==="win32"){let s=d.match(/^([A-Z]):\\/i);if(s){let i=`drive-${s[1].toUpperCase()}`;return p.info("PROJECT_NAME","Drive root detected",{cwd:d,projectName:i}),i}}return p.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:d}),"unknown-project"}return e}var H=require("fs"),ee=require("path");var P=class d{static instance=null;activeMode=null;modesDir;constructor(){let e=Ce(),t=[(0,ee.join)(e,"modes"),(0,ee.join)(e,"..","plugin","modes")],s=t.find(r=>(0,H.existsSync)(r));this.modesDir=s||t[0]}static getInstance(){return d.instance||(d.instance=new d),d.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let r in t){let i=t[r],a=e[r];this.isPlainObject(i)&&this.isPlainObject(a)?s[r]=this.deepMerge(a,i):s[r]=i}return s}loadModeFile(e){let t=(0,ee.join)(this.modesDir,`${e}.json`);if(!(0,H.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,H.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let c=this.loadModeFile(e);return this.activeMode=c,p.debug("SYSTEM",`Loaded mode: ${c.name} (${e})`,void 0,{types:c.observation_types.map(l=>l.id),concepts:c.observation_concepts.map(l=>l.id)}),c}catch{if(p.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:r}=t,i;try{i=this.loadMode(s)}catch{p.warn("SYSTEM",`Parent mode '${s}' not found for ${e}, falling back to 'code'`),i=this.loadMode("code")}let a;try{a=this.loadModeFile(r),p.debug("SYSTEM",`Loaded override file: ${r} for parent ${s}`)}catch{return p.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${s}' only`),this.activeMode=i,i}if(!a)return p.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${s}' only`),this.activeMode=i,i;let _=this.deepMerge(i,a);return this.activeMode=_,p.debug("SYSTEM",`Loaded mode with inheritance: ${_.name} (${e} = ${s} + ${r})`,void 0,{parent:s,override:r,types:_.observation_types.map(c=>c.id),concepts:_.observation_concepts.map(c=>c.id)}),_}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(s=>s.id===e)?.label||e}};var et=se.default.join((0,re.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function tt(){let d=se.default.join((0,re.homedir)(),".claude-mem","settings.json"),e=C.loadFromFile(d),t=e.CLAUDE_MEM_MODE,s=t==="code"||t.startsWith("code--"),r,i;if(s)r=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(a=>a.trim()).filter(Boolean)),i=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(a=>a.trim()).filter(Boolean));else{let a=P.getInstance().getActiveMode();r=new Set(a.observation_types.map(_=>_.id)),i=new Set(a.observation_concepts.map(_=>_.id))}return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:r,observationConcepts:i,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var we=4,st=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function te(d,e,t,s){return e?s?[`${t}${d}:${o.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}function rt(d){return d.replace(/\//g,"-")}function nt(d){try{if(!(0,W.existsSync)(d))return{userMessage:"",assistantMessage:""};let e=(0,W.readFileSync)(d,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(r=>r.trim()),s="";for(let r=t.length-1;r>=0;r--)try{let i=t[r];if(!i.includes('"type":"assistant"'))continue;let a=JSON.parse(i);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let _="";for(let c of a.message.content)c.type==="text"&&(_+=c.text);if(_=_.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),_){s=_;break}}}catch{continue}return{userMessage:"",assistantMessage:s}}catch(e){return p.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:d},e),{userMessage:"",assistantMessage:""}}}async function it(d,e=!1){let t=tt(),s=d?.cwd??process.cwd(),r=xe(s),i=null;try{i=new Z}catch(I){if(I.code==="ERR_DLOPEN_FAILED"){try{(0,W.unlinkSync)(et)}catch{}return p.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),""}throw I}let a=Array.from(t.observationTypes),_=a.map(()=>"?").join(","),c=Array.from(t.observationConcepts),l=c.map(()=>"?").join(","),u=i.db.prepare(`
    SELECT
      id, memory_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${_})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${l})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,...a,...c,t.totalObservationCount),S=i.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,t.sessionCount+st),O="",E="";if(t.showLastMessage&&u.length>0){let I=d?.session_id,R=u.find(v=>v.memory_session_id!==I);if(R){let v=R.memory_session_id,k=rt(s),N=se.default.join((0,re.homedir)(),".claude","projects",k,`${v}.jsonl`),D=nt(N);O=D.userMessage,E=D.assistantMessage}}if(u.length===0&&S.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${r}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let A=S.slice(0,t.sessionCount),g=u,n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}[${r}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),g.length>0){let R=P.getInstance().getActiveMode().observation_types.map(m=>`${m.emoji} ${m.id}`).join(" | ");e?n.push(`${o.dim}Legend: \u{1F3AF} session-request | ${R}${o.reset}`):n.push(`**Legend:** \u{1F3AF} session-request | ${R}`),n.push(""),e?(n.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),n.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),n.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),n.push(""),n.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),n.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),n.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),n.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let v=u.length,k=u.reduce((m,h)=>{let f=(h.title?.length||0)+(h.subtitle?.length||0)+(h.narrative?.length||0)+JSON.stringify(h.facts||[]).length;return m+Math.ceil(f/we)},0),N=u.reduce((m,h)=>m+(h.discovery_tokens||0),0),D=N-k,Y=N>0?Math.round(D/N*100):0,ue=t.showReadTokens||t.showWorkTokens||t.showSavingsAmount||t.showSavingsPercent;if(ue)if(e){if(n.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),n.push(`${o.dim}  Loading: ${v} observations (${k.toLocaleString()} tokens to read)${o.reset}`),n.push(`${o.dim}  Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),N>0&&(t.showSavingsAmount||t.showSavingsPercent)){let m="  Your savings: ";t.showSavingsAmount&&t.showSavingsPercent?m+=`${D.toLocaleString()} tokens (${Y}% reduction from reuse)`:t.showSavingsAmount?m+=`${D.toLocaleString()} tokens`:m+=`${Y}% reduction from reuse`,n.push(`${o.green}${m}${o.reset}`)}n.push("")}else{if(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${v} observations (${k.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions`),N>0&&(t.showSavingsAmount||t.showSavingsPercent)){let m="- Your savings: ";t.showSavingsAmount&&t.showSavingsPercent?m+=`${D.toLocaleString()} tokens (${Y}% reduction from reuse)`:t.showSavingsAmount?m+=`${D.toLocaleString()} tokens`:m+=`${Y}% reduction from reuse`,n.push(m)}n.push("")}let Fe=S[0]?.id,Pe=A.map((m,h)=>{let f=h===0?null:S[h+1];return{...m,displayEpoch:f?f.created_at_epoch:m.created_at_epoch,displayTime:f?f.created_at:m.created_at,shouldShowLink:m.id!==Fe}}),Xe=new Set(u.slice(0,t.fullObservationCount).map(m=>m.id)),le=[...g.map(m=>({type:"observation",data:m})),...Pe.map(m=>({type:"summary",data:m}))];le.sort((m,h)=>{let f=m.type==="observation"?m.data.created_at_epoch:m.data.displayEpoch,$=h.type==="observation"?h.data.created_at_epoch:h.data.displayEpoch;return f-$});let V=new Map;for(let m of le){let h=m.type==="observation"?m.data.created_at:m.data.displayTime,f=$e(h);V.has(f)||V.set(f,[]),V.get(f).push(m)}let Be=Array.from(V.entries()).sort((m,h)=>{let f=new Date(m[0]).getTime(),$=new Date(h[0]).getTime();return f-$});for(let[m,h]of Be){e?(n.push(`${o.bright}${o.cyan}${m}${o.reset}`),n.push("")):(n.push(`### ${m}`),n.push(""));let f=null,$="",x=!1;for(let ne of h)if(ne.type==="summary"){x&&(n.push(""),x=!1,f=null,$="");let T=ne.data,w=`${T.request||"Session started"} (${De(T.displayTime)})`;e?n.push(`\u{1F3AF} ${o.yellow}#S${T.id}${o.reset} ${w}`):n.push(`**\u{1F3AF} #S${T.id}** ${w}`),n.push("")}else{let T=ne.data,w=Ue(T.files_modified,s);w!==f&&(x&&n.push(""),e?n.push(`${o.dim}${w}${o.reset}`):n.push(`**${w}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),f=w,x=!0,$="");let F=ve(T.created_at),K=T.title||"Untitled",q=P.getInstance().getTypeIcon(T.type),je=(T.title?.length||0)+(T.subtitle?.length||0)+(T.narrative?.length||0)+JSON.stringify(T.facts||[]).length,X=Math.ceil(je/we),B=T.discovery_tokens||0,ie=P.getInstance().getWorkEmoji(T.type),Te=B>0?`${ie} ${B.toLocaleString()}`:"-",oe=F!==$,ge=oe?F:"";if($=F,Xe.has(T.id)){let U=t.fullObservationField==="narrative"?T.narrative:T.facts?me(T.facts).join(`
`):null;if(e){let y=oe?`${o.dim}${F}${o.reset}`:" ".repeat(F.length),J=t.showReadTokens&&X>0?`${o.dim}(~${X}t)${o.reset}`:"",he=t.showWorkTokens&&B>0?`${o.dim}(${ie} ${B.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${T.id}${o.reset}  ${y}  ${q}  ${o.bright}${K}${o.reset}`),U&&n.push(`    ${o.dim}${U}${o.reset}`),(J||he)&&n.push(`    ${J} ${he}`),n.push("")}else{x&&(n.push(""),x=!1),n.push(`**#${T.id}** ${ge||"\u2033"} ${q} **${K}**`),U&&(n.push(""),n.push(U),n.push(""));let y=[];t.showReadTokens&&y.push(`Read: ~${X}`),t.showWorkTokens&&y.push(`Work: ${Te}`),y.length>0&&n.push(y.join(", ")),n.push(""),f=null}}else if(e){let U=oe?`${o.dim}${F}${o.reset}`:" ".repeat(F.length),y=t.showReadTokens&&X>0?`${o.dim}(~${X}t)${o.reset}`:"",J=t.showWorkTokens&&B>0?`${o.dim}(${ie} ${B.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${T.id}${o.reset}  ${U}  ${q}  ${K} ${y} ${J}`)}else{let U=t.showReadTokens?`~${X}`:"",y=t.showWorkTokens?Te:"";n.push(`| #${T.id} | ${ge||"\u2033"} | ${q} | ${K} | ${U} | ${y} |`)}}x&&n.push("")}let L=S[0],Ee=u[0];if(t.showLastSummary&&L&&(L.investigated||L.learned||L.completed||L.next_steps)&&(!Ee||L.created_at_epoch>Ee.created_at_epoch)&&(n.push(...te("Investigated",L.investigated,o.blue,e)),n.push(...te("Learned",L.learned,o.yellow,e)),n.push(...te("Completed",L.completed,o.green,e)),n.push(...te("Next Steps",L.next_steps,o.magenta,e))),E&&(n.push(""),n.push("---"),n.push(""),e?(n.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),n.push(""),n.push(`${o.dim}A: ${E}${o.reset}`)):(n.push("**\u{1F4CB} Previously**"),n.push(""),n.push(`A: ${E}`)),n.push("")),ue&&N>0&&D>0){let m=Math.round(N/1e3);n.push(""),e?n.push(`${o.dim}\u{1F4B0} Access ${m}k tokens of past research & decisions for just ${k.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):n.push(`\u{1F4B0} Access ${m}k tokens of past research & decisions for just ${k.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),n.join(`
`).trimEnd()}0&&(module.exports={generateContext});
