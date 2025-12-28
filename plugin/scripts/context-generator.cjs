"use strict";var We=Object.create;var Z=Object.defineProperty;var Ye=Object.getOwnPropertyDescriptor;var Ve=Object.getOwnPropertyNames;var Ke=Object.getPrototypeOf,qe=Object.prototype.hasOwnProperty;var Je=(d,e)=>{for(var t in e)Z(d,t,{get:e[t],enumerable:!0})},be=(d,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Ve(e))!qe.call(d,r)&&r!==t&&Z(d,r,{get:()=>e[r],enumerable:!(s=Ye(e,r))||s.enumerable});return d};var de=(d,e,t)=>(t=d!=null?We(Ke(d)):{},be(e||!d||!d.__esModule?Z(t,"default",{value:d,enumerable:!0}):t,d)),Qe=d=>be(Z({},"__esModule",{value:!0}),d);var ut={};Je(ut,{generateContext:()=>_t,getAllSessionSavings:()=>nt,getSessionSavings:()=>rt});module.exports=Qe(ut);var re=de(require("path"),1),ne=require("os"),H=require("fs");var ye=require("bun:sqlite");var R=require("path"),Le=require("os"),Ie=require("fs");var Ce=require("url");var G=require("fs"),Ne=require("path"),Ae=require("os");var Re="bugfix,feature,refactor,discovery,decision,change",Oe="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var B=require("fs"),ee=require("path"),ce=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(ce||{}),pe=class{level=null;useColor;logFilePath=null;constructor(){this.useColor=process.stdout.isTTY??!1,this.initializeLogFile()}initializeLogFile(){try{let e=D.get("CLAUDE_MEM_DATA_DIR"),t=(0,ee.join)(e,"logs");(0,B.existsSync)(t)||(0,B.mkdirSync)(t,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,ee.join)(t,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}getLevel(){if(this.level===null)try{let e=D.get("CLAUDE_MEM_DATA_DIR"),t=(0,ee.join)(e,"settings.json"),r=D.loadFromFile(t).CLAUDE_MEM_LOG_LEVEL.toUpperCase();this.level=ce[r]??1}catch(e){console.error("[LOGGER] Failed to load settings, using INFO level:",e),this.level=1}return this.level}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;let s=typeof t=="string"?JSON.parse(t):t;if(e==="Bash"&&s.command)return`${e}(${s.command})`;if(s.file_path)return`${e}(${s.file_path})`;if(s.notebook_path)return`${e}(${s.notebook_path})`;if(e==="Glob"&&s.pattern)return`${e}(${s.pattern})`;if(e==="Grep"&&s.pattern)return`${e}(${s.pattern})`;if(s.url)return`${e}(${s.url})`;if(s.query)return`${e}(${s.query})`;if(e==="Task"){if(s.subagent_type)return`${e}(${s.subagent_type})`;if(s.description)return`${e}(${s.description})`}return e==="Skill"&&s.skill?`${e}(${s.skill})`:e==="LSP"&&s.operation?`${e}(${s.operation})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),c=String(e.getMinutes()).padStart(2,"0"),p=String(e.getSeconds()).padStart(2,"0"),a=String(e.getMilliseconds()).padStart(3,"0");return`${t}-${s}-${r} ${o}:${c}:${p}.${a}`}log(e,t,s,r,o){if(e<this.getLevel())return;let c=this.formatTimestamp(new Date),p=ce[e].padEnd(5),a=t.padEnd(6),_="";r?.correlationId?_=`[${r.correlationId}] `:r?.sessionId&&(_=`[session-${r.sessionId}] `);let E="";o!=null&&(o instanceof Error?E=this.getLevel()===0?`
${o.message}
${o.stack}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?E=`
`+JSON.stringify(o,null,2):E=" "+this.formatData(o));let g="";if(r){let{sessionId:T,sdkSessionId:O,correlationId:m,...n}=r;Object.keys(n).length>0&&(g=` {${Object.entries(n).map(([A,I])=>`${A}=${I}`).join(", ")}}`)}let b=`[${c}] [${p}] [${a}] ${_}${s}${g}${E}`;if(this.logFilePath)try{(0,B.appendFileSync)(this.logFilePath,b+`
`,"utf8")}catch(T){process.stderr.write(`[LOGGER] Failed to write to log file: ${T}
`)}else process.stderr.write(b+`
`)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}error(e,t,s,r){this.log(3,e,t,s,r)}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}timing(e,t,s,r){this.info(e,`\u23F1 ${t}`,r,{duration:`${s}ms`})}happyPathError(e,t,s,r,o=""){let _=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),E=_?`${_[1].split("/").pop()}:${_[2]}`:"unknown",g={...s,location:E};return this.warn(e,`[HAPPY-PATH] ${t}`,g,r),o}},l=new pe;var D=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENROUTER_API_KEY:"",CLAUDE_MEM_OPENROUTER_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENROUTER_SITE_URL:"",CLAUDE_MEM_OPENROUTER_APP_NAME:"claude-mem",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"100000",CLAUDE_MEM_DATA_DIR:(0,Ne.join)((0,Ae.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:Re,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:Oe,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_SURPRISE_ENABLED:"true",CLAUDE_MEM_SURPRISE_THRESHOLD:"0.3",CLAUDE_MEM_SURPRISE_LOOKBACK_DAYS:"30",CLAUDE_MEM_MOMENTUM_ENABLED:"true",CLAUDE_MEM_MOMENTUM_DURATION_MINUTES:"5"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,G.existsSync)(e))return this.getAllDefaults();let t=(0,G.readFileSync)(e,"utf-8"),s=JSON.parse(t),r=s;if(s.env&&typeof s.env=="object"){r=s.env;try{(0,G.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),l.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(c){l.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},c)}}let o={...this.DEFAULTS};for(let c of Object.keys(this.DEFAULTS))r[c]!==void 0&&(o[c]=r[c]);return o}catch(t){return l.warn("SETTINGS","Failed to load settings, using defaults",{settingsPath:e},t),this.getAllDefaults()}}};var et={};function ze(){return typeof __dirname<"u"?__dirname:(0,R.dirname)((0,Ce.fileURLToPath)(et.url))}var Ze=ze(),y=D.get("CLAUDE_MEM_DATA_DIR"),_e=process.env.CLAUDE_CONFIG_DIR||(0,R.join)((0,Le.homedir)(),".claude"),At=(0,R.join)(y,"archives"),Lt=(0,R.join)(y,"logs"),It=(0,R.join)(y,"trash"),Ct=(0,R.join)(y,"backups"),Mt=(0,R.join)(y,"modes"),vt=(0,R.join)(y,"settings.json"),Me=(0,R.join)(y,"claude-mem.db"),Dt=(0,R.join)(y,"vector-db"),yt=(0,R.join)(_e,"settings.json"),Ut=(0,R.join)(_e,"commands"),$t=(0,R.join)(_e,"CLAUDE.md");function ve(d){(0,Ie.mkdirSync)(d,{recursive:!0})}function De(){return(0,R.join)(Ze,"..")}var Y=class{db;constructor(e=Me){e!==":memory:"&&ve(y),this.db=new ye.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.createMemoryAccessTracking()}initializeSchema(){try{this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(s=>s.version)):0)===0&&(l.info("DB","Initializing fresh database with migration004"),this.db.run(`
          CREATE TABLE IF NOT EXISTS sdk_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            claude_session_id TEXT UNIQUE NOT NULL,
            sdk_session_id TEXT UNIQUE,
            project TEXT NOT NULL,
            user_prompt TEXT,
            started_at TEXT NOT NULL,
            started_at_epoch INTEGER NOT NULL,
            completed_at TEXT,
            completed_at_epoch INTEGER,
            status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
          );

          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(claude_session_id);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(sdk_session_id);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
          CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

          CREATE TABLE IF NOT EXISTS observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT NOT NULL,
            project TEXT NOT NULL,
            text TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery')),
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL,
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(sdk_session_id);
          CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
          CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
          CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

          CREATE TABLE IF NOT EXISTS session_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT UNIQUE NOT NULL,
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
            FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
          CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
          CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),l.info("DB","Migration004 applied successfully"))}catch(e){throw l.error("DB","Schema initialization error",void 0,e instanceof Error?e:new Error(String(e))),e}}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),l.info("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),l.info("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),l.info("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),l.info("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}l.info("DB","Removing UNIQUE constraint from session_summaries.sdk_session_id"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sdk_session_id TEXT NOT NULL,
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
          FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
        )
      `),this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, sdk_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, created_at, created_at_epoch
        FROM session_summaries
      `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),l.info("DB","Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(r){throw this.db.run("ROLLBACK"),r}}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}l.info("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),l.info("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}l.info("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sdk_session_id TEXT NOT NULL,
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
          FOREIGN KEY(sdk_session_id) REFERENCES sdk_sessions(sdk_session_id) ON DELETE CASCADE
        )
      `),this.db.run(`
        INSERT INTO observations_new
        SELECT id, sdk_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               created_at, created_at_epoch
        FROM observations
      `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(sdk_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),l.info("DB","Successfully made observations.text nullable")}catch(r){throw this.db.run("ROLLBACK"),r}}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}l.info("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
        CREATE TABLE user_prompts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          claude_session_id TEXT NOT NULL,
          prompt_number INTEGER NOT NULL,
          prompt_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(claude_session_id) REFERENCES sdk_sessions(claude_session_id) ON DELETE CASCADE
        );

        CREATE INDEX idx_user_prompts_claude_session ON user_prompts(claude_session_id);
        CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
        CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
        CREATE INDEX idx_user_prompts_lookup ON user_prompts(claude_session_id, prompt_number);
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),l.info("DB","Successfully created user_prompts table with FTS5 support")}catch(s){throw this.db.run("ROLLBACK"),s}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(c=>c.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.info("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(c=>c.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.info("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw l.error("DB","Discovery tokens migration error",void 0,e),e}}createPendingMessagesTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}l.info("DB","Creating pending_messages table"),this.db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          claude_session_id TEXT NOT NULL,
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(claude_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),l.info("DB","pending_messages table created successfully")}catch(e){throw l.error("DB","Pending messages table migration error",void 0,e),e}}createMemoryAccessTracking(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;console.log("[SessionStore] Creating memory access tracking..."),this.db.run("BEGIN TRANSACTION");try{this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_access'").all().length===0&&(this.db.run(`
            CREATE TABLE memory_access (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              memory_id INTEGER NOT NULL,
              timestamp INTEGER NOT NULL,
              context TEXT,
              FOREIGN KEY (memory_id) REFERENCES observations(id) ON DELETE CASCADE
            )
          `),this.db.run("CREATE INDEX idx_memory_access_memory_id ON memory_access(memory_id)"),this.db.run("CREATE INDEX idx_memory_access_timestamp ON memory_access(timestamp DESC)"),this.db.run("CREATE INDEX idx_memory_access_memory_timestamp ON memory_access(memory_id, timestamp DESC)"),console.log("[SessionStore] Created memory_access table"));let s=this.db.query("PRAGMA table_info(observations)").all(),r=s.some(a=>a.name==="importance_score"),o=s.some(a=>a.name==="access_count"),c=s.some(a=>a.name==="last_accessed"),p=s.some(a=>a.name==="surprise_score");r||(this.db.run("ALTER TABLE observations ADD COLUMN importance_score REAL DEFAULT 0.5"),console.log("[SessionStore] Added importance_score column to observations")),o||(this.db.run("ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0"),console.log("[SessionStore] Added access_count column to observations")),c||(this.db.run("ALTER TABLE observations ADD COLUMN last_accessed INTEGER"),console.log("[SessionStore] Added last_accessed column to observations")),p||(this.db.run("ALTER TABLE observations ADD COLUMN surprise_score REAL DEFAULT 0.5"),console.log("[SessionStore] Added surprise_score column to observations")),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),console.log("[SessionStore] Memory access tracking migration completed successfully")}catch(t){throw this.db.run("ROLLBACK"),t}}catch(e){throw console.error("[SessionStore] Memory access tracking migration error:",e.message),e}}getRecentSummaries(e,t=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentSummariesWithSessionInfo(e,t=3){return this.db.prepare(`
      SELECT
        sdk_session_id, request, learned, completed, next_steps,
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
        up.claude_session_id,
        s.project,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
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
        s.sdk_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.claude_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getRecentSessionsWithStatus(e,t=3){return this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.sdk_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.sdk_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.sdk_session_id = sum.sdk_session_id
        WHERE s.project = ? AND s.sdk_session_id IS NOT NULL
        GROUP BY s.sdk_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(e,t)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o,type:c,concepts:p,files:a}=t,_=s==="date_asc"?"ASC":"DESC",E=r?`LIMIT ${r}`:"",g=e.map(()=>"?").join(","),b=[...e],T=[];if(o&&(T.push("project = ?"),b.push(o)),c)if(Array.isArray(c)){let n=c.map(()=>"?").join(",");T.push(`type IN (${n})`),b.push(...c)}else T.push("type = ?"),b.push(c);if(p){let n=Array.isArray(p)?p:[p],L=n.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");b.push(...n),T.push(`(${L.join(" OR ")})`)}if(a){let n=Array.isArray(a)?a:[a],L=n.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");n.forEach(A=>{b.push(`%${A}%`,`%${A}%`)}),T.push(`(${L.join(" OR ")})`)}let O=T.length>0?`WHERE id IN (${g}) AND ${T.join(" AND ")}`:`WHERE id IN (${g})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${O}
      ORDER BY created_at_epoch ${_}
      ${E}
    `).all(...b)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let s=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),r=new Set,o=new Set;for(let c of s){if(c.files_read){let p=JSON.parse(c.files_read);Array.isArray(p)&&p.forEach(a=>r.add(a))}if(c.files_modified){let p=JSON.parse(c.files_modified);Array.isArray(p)&&p.forEach(a=>o.add(a))}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE sdk_session_id IN (${t})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE claude_session_id = ?
    `).get(e).count}createSDKSession(e,t,s){let r=new Date,o=r.getTime();return this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,t,s,r.toISOString(),o),this.db.prepare("SELECT id FROM sdk_sessions WHERE claude_session_id = ?").get(e).id}saveUserPrompt(e,t,s){let r=new Date,o=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,s,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,r,o=0,c){let p=c??Date.now(),a=new Date(p).toISOString(),E=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),r||null,o,a,p);return{id:Number(E.lastInsertRowid),createdAtEpoch:p}}storeSummary(e,t,s,r,o=0,c){let p=c??Date.now(),a=new Date(p).toISOString(),E=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,r||null,o,a,p);return{id:Number(E.lastInsertRowid),createdAtEpoch:p}}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o}=t,c=s==="date_asc"?"ASC":"DESC",p=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(","),_=[...e],E=o?`WHERE id IN (${a}) AND project = ?`:`WHERE id IN (${a})`;return o&&_.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${E}
      ORDER BY created_at_epoch ${c}
      ${p}
    `).all(..._)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:r,project:o}=t,c=s==="date_asc"?"ASC":"DESC",p=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(","),_=[...e],E=o?"AND s.project = ?":"";return o&&_.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a}) ${E}
      ORDER BY up.created_at_epoch ${c}
      ${p}
    `).all(..._)}getTimelineAroundTimestamp(e,t=10,s=10,r){return this.getTimelineAroundObservation(null,e,t,s,r)}getTimelineAroundObservation(e,t,s=10,r=10,o){let c=o?"AND project = ?":"",p=o?[o]:[],a,_;if(e!==null){let T=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${c}
        ORDER BY id DESC
        LIMIT ?
      `,O=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${c}
        ORDER BY id ASC
        LIMIT ?
      `;try{let m=this.db.prepare(T).all(e,...p,s+1),n=this.db.prepare(O).all(e,...p,r+1);if(m.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};a=m.length>0?m[m.length-1].created_at_epoch:t,_=n.length>0?n[n.length-1].created_at_epoch:t}catch(m){return l.error("DB","Error getting boundary observations",void 0,{error:m,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let T=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${c}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,O=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${c}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let m=this.db.prepare(T).all(t,...p,s),n=this.db.prepare(O).all(t,...p,r+1);if(m.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};a=m.length>0?m[m.length-1].created_at_epoch:t,_=n.length>0?n[n.length-1].created_at_epoch:t}catch(m){return l.error("DB","Error getting boundary timestamps",void 0,{error:m,project:o}),{observations:[],sessions:[],prompts:[]}}}let E=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${c}
      ORDER BY created_at_epoch ASC
    `,g=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${c}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${c.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let T=this.db.prepare(E).all(a,_,...p),O=this.db.prepare(g).all(a,_,...p),m=this.db.prepare(b).all(a,_,...p);return{observations:T,sessions:O.map(n=>({id:n.id,sdk_session_id:n.sdk_session_id,project:n.project,request:n.request,completed:n.completed,next_steps:n.next_steps,created_at:n.created_at,created_at_epoch:n.created_at_epoch})),prompts:m.map(n=>({id:n.id,claude_session_id:n.claude_session_id,prompt_number:n.prompt_number,prompt_text:n.prompt_text,project:n.project,created_at:n.created_at,created_at_epoch:n.created_at_epoch}))}}catch(T){return l.error("DB","Error querying timeline records",void 0,{error:T,project:o}),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
      SELECT
        p.id,
        p.claude_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.claude_session_id = s.claude_session_id
      WHERE p.id = ?
      LIMIT 1
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        p.id,
        p.claude_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.claude_session_id = s.claude_session_id
      WHERE p.id IN (${t})
      ORDER BY p.created_at_epoch DESC
    `).all(...e)}getSessionSummaryById(e){return this.db.prepare(`
      SELECT
        id,
        sdk_session_id,
        claude_session_id,
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
    `).get(e)||null}close(){this.db.close()}importSdkSession(e){let t=this.db.prepare("SELECT id FROM sdk_sessions WHERE claude_session_id = ?").get(e.claude_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        claude_session_id, sdk_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.claude_session_id,e.sdk_session_id,e.project,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let t=this.db.prepare("SELECT id FROM session_summaries WHERE sdk_session_id = ?").get(e.sdk_session_id);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        sdk_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sdk_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let t=this.db.prepare(`
      SELECT id FROM observations
      WHERE sdk_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.sdk_session_id,e.title,e.created_at_epoch);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        sdk_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sdk_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importUserPrompt(e){let t=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
    `).get(e.claude_session_id,e.prompt_number);return t?{imported:!1,id:t.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        claude_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.claude_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var ue=de(require("path"),1);function le(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function Ue(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function $e(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ke(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function tt(d,e){return ue.default.isAbsolute(d)?ue.default.relative(e,d):d}function xe(d,e){let t=le(d);return t.length>0?tt(t[0],e):"General"}var we=de(require("path"),1);function Fe(d){if(!d||d.trim()==="")return l.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:d}),"unknown-project";let e=we.default.basename(d);if(e===""){if(process.platform==="win32"){let s=d.match(/^([A-Z]):\\/i);if(s){let o=`drive-${s[1].toUpperCase()}`;return l.info("PROJECT_NAME","Drive root detected",{cwd:d,projectName:o}),o}}return l.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:d}),"unknown-project"}return e}var V=require("fs"),te=require("path");var x=class d{static instance=null;activeMode=null;modesDir;constructor(){let e=De(),t=[(0,te.join)(e,"modes"),(0,te.join)(e,"..","plugin","modes")],s=t.find(r=>(0,V.existsSync)(r));this.modesDir=s||t[0]}static getInstance(){return d.instance||(d.instance=new d),d.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let r in t){let o=t[r],c=e[r];this.isPlainObject(o)&&this.isPlainObject(c)?s[r]=this.deepMerge(c,o):s[r]=o}return s}loadModeFile(e){let t=(0,te.join)(this.modesDir,`${e}.json`);if(!(0,V.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,V.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let a=this.loadModeFile(e);return this.activeMode=a,l.debug("SYSTEM",`Loaded mode: ${a.name} (${e})`,void 0,{types:a.observation_types.map(_=>_.id),concepts:a.observation_concepts.map(_=>_.id)}),a}catch{if(l.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:r}=t,o;try{o=this.loadMode(s)}catch{l.warn("SYSTEM",`Parent mode '${s}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let c;try{c=this.loadModeFile(r),l.debug("SYSTEM",`Loaded override file: ${r} for parent ${s}`)}catch{return l.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${s}' only`),this.activeMode=o,o}if(!c)return l.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${s}' only`),this.activeMode=o,o;let p=this.deepMerge(o,c);return this.activeMode=p,l.debug("SYSTEM",`Loaded mode with inheritance: ${p.name} (${e} = ${s} + ${r})`,void 0,{parent:s,override:r,types:p.observation_types.map(a=>a.id),concepts:p.observation_concepts.map(a=>a.id)}),p}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(s=>s.id===e)?.label||e}};var K=new Map;function st(d){let e=null;try{e=new Y;let t=Pe(),s=Array.from(t.observationTypes),r=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),c=o.map(()=>"?").join(","),p=e.db.prepare(`
      SELECT
        id, title, subtitle, narrative, facts, discovery_tokens
      FROM observations
      WHERE project = ?
        AND type IN (${r})
        AND EXISTS (
          SELECT 1 FROM json_each(concepts)
          WHERE value IN (${c})
        )
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(d,...s,...o,t.totalObservationCount);if(p.length===0)return e.close(),null;let a=p.length,_=p.reduce((O,m)=>{let n=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length;return O+Math.ceil(n/Ee)},0),E=p.reduce((O,m)=>O+(m.discovery_tokens||0),0),g=E-_,b=E>0?Math.round(g/E*100):0;e.close();let T={project:d,totalObservations:a,totalReadTokens:_,totalDiscoveryTokens:E,savings:g,savingsPercent:b,calculatedAt:Date.now()};return K.set(d,T),T}catch{return e?.close(),null}}function rt(d){if(d){let t=K.get(d);return t||st(d)}let e=null;for(let t of K.values())(!e||t.calculatedAt>e.calculatedAt)&&(e=t);return e}function nt(){return Array.from(K.values())}var it=re.default.join((0,ne.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Pe(){let d=re.default.join((0,ne.homedir)(),".claude-mem","settings.json"),e=D.loadFromFile(d),t=e.CLAUDE_MEM_MODE,s=t==="code"||t.startsWith("code--"),r,o;if(s)r=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(c=>c.trim()).filter(Boolean)),o=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(c=>c.trim()).filter(Boolean));else{let c=x.getInstance().getActiveMode();r=new Set(c.observation_types.map(p=>p.id)),o=new Set(c.observation_concepts.map(p=>p.id))}return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:r,observationConcepts:o,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var Ee=4,ot=1,i={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function at(d,e){let t=[],s=new Map;for(let a of d){let _=a.type;s.has(_)||s.set(_,[]),s.get(_).push(a)}if(s.size===0)return t;let r=["feature","bugfix","decision","refactor","change","discovery"],o=Array.from(s.keys()).sort((a,_)=>{let E=r.indexOf(a),g=r.indexOf(_);return(E===-1?999:E)-(g===-1?999:g)}),c=x.getInstance().getActiveMode(),p=new Map(c.observation_types.map(a=>[a.id,a.emoji]));e?(t.push(`${i.bright}${i.green}\u{1F4CB} Quick Status Reference${i.reset}`),t.push(`${i.dim}(Use this to answer "what's done/pending" questions without running searches)${i.reset}`),t.push("")):(t.push("\u{1F4CB} **Quick Status Reference**"),t.push(`*(Use this to answer "what's done/pending" questions without running searches)*`),t.push(""));for(let a of o){let _=s.get(a),E=p.get(a)||"\u{1F4DD}",g=_.slice(0,5).map(b=>b.title||"Untitled");e?t.push(`${E} **${a}** (${_.length}): ${g.join(", ")}${_.length>5?"...":""}`):t.push(`- ${E} **${a}** (${_.length}): ${g.join(", ")}${_.length>5?"...":""}`)}return t.push(""),t}function dt(d,e,t){let s=[];return t?(s.push(`${i.bright}${i.yellow}\u26A1 Context Usage Guide${i.reset}`),s.push(`${i.dim}\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${i.reset}`),s.push(`${i.dim}\u2502 \u2705 USE THIS CONTEXT for:                                     \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 "What's been done?" / "What's completed?"              \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 "What did we decide about X?"                          \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 "What bugs were fixed?"                                \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 History/status questions \u2192 0 additional tokens         \u2502${i.reset}`),s.push(`${i.dim}\u2502                                                             \u2502${i.reset}`),s.push(`${i.dim}\u2502 \u{1F527} USE TOOLS only for:                                      \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 Reading actual code implementation                     \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 Searching for specific patterns in files               \u2502${i.reset}`),s.push(`${i.dim}\u2502    \u2022 Making code changes                                    \u2502${i.reset}`),s.push(`${i.dim}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${i.reset}`)):(s.push("\u26A1 **Context Usage Guide**"),s.push(""),s.push("| Question Type | Action | Cost |"),s.push("|---------------|--------|------|"),s.push(`| "What's done/pending?" | \u2705 Use this context | 0 tokens |`),s.push('| "What did we decide?" | \u2705 Use this context | 0 tokens |'),s.push('| "Review past work" | \u2705 Use this context | 0 tokens |'),s.push("| Read code details | \u{1F527} Use tools | ~5-10k tokens |"),s.push("| Search for patterns | \u{1F527} Use tools | ~5-10k tokens |"),s.push("| Make code changes | \u{1F527} Use tools | varies |")),s.push(""),s}function se(d,e,t,s){return e?s?[`${t}${d}:${i.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}function ct(d){return d.replace(/\//g,"-")}function pt(d){try{if(!(0,H.existsSync)(d))return{userMessage:"",assistantMessage:""};let e=(0,H.readFileSync)(d,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(r=>r.trim()),s="";for(let r=t.length-1;r>=0;r--)try{let o=t[r];if(!o.includes('"type":"assistant"'))continue;let c=JSON.parse(o);if(c.type==="assistant"&&c.message?.content&&Array.isArray(c.message.content)){let p="";for(let a of c.message.content)a.type==="text"&&(p+=a.text);if(p=p.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),p){s=p;break}}}catch{continue}return{userMessage:"",assistantMessage:s}}catch(e){return l.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:d},e),{userMessage:"",assistantMessage:""}}}async function _t(d,e=!1){let t=Pe(),s=d?.cwd??process.cwd(),r=Fe(s),o=null;try{o=new Y}catch(L){if(L.code==="ERR_DLOPEN_FAILED"){try{(0,H.unlinkSync)(it)}catch{}return l.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),""}throw L}let c=Array.from(t.observationTypes),p=c.map(()=>"?").join(","),a=Array.from(t.observationConcepts),_=a.map(()=>"?").join(","),E=o.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${p})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${_})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,...c,...a,t.totalObservationCount),g=o.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,t.sessionCount+ot),b="",T="";if(t.showLastMessage&&E.length>0){let L=d?.session_id,A=E.find(I=>I.sdk_session_id!==L);if(A){let I=A.sdk_session_id,U=ct(s),N=re.default.join((0,ne.homedir)(),".claude","projects",U,`${I}.jsonl`),C=pt(N);b=C.userMessage,T=C.assistantMessage}}if(E.length===0&&g.length===0)return o?.close(),e?`
${i.bright}${i.cyan}[${r}] recent context${i.reset}
${i.gray}${"\u2500".repeat(60)}${i.reset}

${i.dim}No previous sessions found for this project yet.${i.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let O=g.slice(0,t.sessionCount),m=E,n=[];if(e?(n.push(""),n.push(`${i.bright}${i.cyan}[${r}] recent context${i.reset}`),n.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),m.length>0){let A=x.getInstance().getActiveMode().observation_types.map(u=>`${u.emoji} ${u.id}`).join(" | ");e?n.push(`${i.dim}Legend: \u{1F3AF} session-request | ${A}${i.reset}`):n.push(`**Legend:** \u{1F3AF} session-request | ${A}`),n.push(""),e?(n.push(`${i.bright}\u{1F4A1} Column Key${i.reset}`),n.push(`${i.dim}  Read: Tokens to read this observation (cost to learn it now)${i.reset}`),n.push(`${i.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${i.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${i.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${i.reset}`),n.push(""),n.push(`${i.dim}When you need implementation details, rationale, or debugging context:${i.reset}`),n.push(`${i.dim}  - Use the mem-search skill to fetch full observations on-demand${i.reset}`),n.push(`${i.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${i.reset}`),n.push(`${i.dim}  - Trust this index over re-reading code for past decisions and learnings${i.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let I=E.length,U=E.reduce((u,S)=>{let f=(S.title?.length||0)+(S.subtitle?.length||0)+(S.narrative?.length||0)+JSON.stringify(S.facts||[]).length;return u+Math.ceil(f/Ee)},0),N=E.reduce((u,S)=>u+(S.discovery_tokens||0),0),C=N-U,W=N>0?Math.round(C/N*100):0;K.set(r,{project:r,totalObservations:I,totalReadTokens:U,totalDiscoveryTokens:N,savings:C,savingsPercent:W,calculatedAt:Date.now()});let me=t.showReadTokens||t.showWorkTokens||t.showSavingsAmount||t.showSavingsPercent;if(me)if(e){if(n.push(`${i.bright}${i.cyan}\u{1F4CA} Context Economics${i.reset}`),n.push(`${i.dim}  Loading: ${I} observations (${U.toLocaleString()} tokens to read)${i.reset}`),n.push(`${i.dim}  Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions${i.reset}`),N>0&&(t.showSavingsAmount||t.showSavingsPercent)){let u="  Your savings: ";t.showSavingsAmount&&t.showSavingsPercent?u+=`${C.toLocaleString()} tokens (${W}% reduction from reuse)`:t.showSavingsAmount?u+=`${C.toLocaleString()} tokens`:u+=`${W}% reduction from reuse`,n.push(`${i.green}${u}${i.reset}`)}n.push("")}else{if(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${I} observations (${U.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions`),N>0&&(t.showSavingsAmount||t.showSavingsPercent)){let u="- Your savings: ";t.showSavingsAmount&&t.showSavingsPercent?u+=`${C.toLocaleString()} tokens (${W}% reduction from reuse)`:t.showSavingsAmount?u+=`${C.toLocaleString()} tokens`:u+=`${W}% reduction from reuse`,n.push(u)}n.push("")}n.push(...dt(I,U,e)),n.push(...at(E,e));let Xe=g[0]?.id,je=O.map((u,S)=>{let f=S===0?null:g[S+1];return{...u,displayEpoch:f?f.created_at_epoch:u.created_at_epoch,displayTime:f?f.created_at:u.created_at,shouldShowLink:u.id!==Xe}}),Be=new Set(E.slice(0,t.fullObservationCount).map(u=>u.id)),ge=[...m.map(u=>({type:"observation",data:u})),...je.map(u=>({type:"summary",data:u}))];ge.sort((u,S)=>{let f=u.type==="observation"?u.data.created_at_epoch:u.data.displayEpoch,$=S.type==="observation"?S.data.created_at_epoch:S.data.displayEpoch;return f-$});let q=new Map;for(let u of ge){let S=u.type==="observation"?u.data.created_at:u.data.displayTime,f=ke(S);q.has(f)||q.set(f,[]),q.get(f).push(u)}let Ge=Array.from(q.entries()).sort((u,S)=>{let f=new Date(u[0]).getTime(),$=new Date(S[0]).getTime();return f-$});for(let[u,S]of Ge){e?(n.push(`${i.bright}${i.cyan}${u}${i.reset}`),n.push("")):(n.push(`### ${u}`),n.push(""));let f=null,$="",w=!1;for(let ie of S)if(ie.type==="summary"){w&&(n.push(""),w=!1,f=null,$="");let h=ie.data,F=`${h.request||"Session started"} (${Ue(h.displayTime)})`;e?n.push(`\u{1F3AF} ${i.yellow}#S${h.id}${i.reset} ${F}`):n.push(`**\u{1F3AF} #S${h.id}** ${F}`),n.push("")}else{let h=ie.data,F=xe(h.files_modified,s);F!==f&&(w&&n.push(""),e?n.push(`${i.dim}${F}${i.reset}`):n.push(`**${F}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),f=F,w=!0,$="");let P=$e(h.created_at),J=h.title||"Untitled",Q=x.getInstance().getTypeIcon(h.type),He=(h.title?.length||0)+(h.subtitle?.length||0)+(h.narrative?.length||0)+JSON.stringify(h.facts||[]).length,X=Math.ceil(He/Ee),j=h.discovery_tokens||0,oe=x.getInstance().getWorkEmoji(h.type),he=j>0?`${oe} ${j.toLocaleString()}`:"-",ae=P!==$,Se=ae?P:"";if($=P,Be.has(h.id)){let k=t.fullObservationField==="narrative"?h.narrative:h.facts?le(h.facts).join(`
`):null;if(e){let v=ae?`${i.dim}${P}${i.reset}`:" ".repeat(P.length),z=t.showReadTokens&&X>0?`${i.dim}(~${X}t)${i.reset}`:"",fe=t.showWorkTokens&&j>0?`${i.dim}(${oe} ${j.toLocaleString()}t)${i.reset}`:"";n.push(`  ${i.dim}#${h.id}${i.reset}  ${v}  ${Q}  ${i.bright}${J}${i.reset}`),k&&n.push(`    ${i.dim}${k}${i.reset}`),(z||fe)&&n.push(`    ${z} ${fe}`),n.push("")}else{w&&(n.push(""),w=!1),n.push(`**#${h.id}** ${Se||"\u2033"} ${Q} **${J}**`),k&&(n.push(""),n.push(k),n.push(""));let v=[];t.showReadTokens&&v.push(`Read: ~${X}`),t.showWorkTokens&&v.push(`Work: ${he}`),v.length>0&&n.push(v.join(", ")),n.push(""),f=null}}else if(e){let k=ae?`${i.dim}${P}${i.reset}`:" ".repeat(P.length),v=t.showReadTokens&&X>0?`${i.dim}(~${X}t)${i.reset}`:"",z=t.showWorkTokens&&j>0?`${i.dim}(${oe} ${j.toLocaleString()}t)${i.reset}`:"";n.push(`  ${i.dim}#${h.id}${i.reset}  ${k}  ${Q}  ${J} ${v} ${z}`)}else{let k=t.showReadTokens?`~${X}`:"",v=t.showWorkTokens?he:"";n.push(`| #${h.id} | ${Se||"\u2033"} | ${Q} | ${J} | ${k} | ${v} |`)}}w&&n.push("")}let M=g[0],Te=E[0];if(t.showLastSummary&&M&&(M.investigated||M.learned||M.completed||M.next_steps)&&(!Te||M.created_at_epoch>Te.created_at_epoch)&&(n.push(...se("Investigated",M.investigated,i.blue,e)),n.push(...se("Learned",M.learned,i.yellow,e)),n.push(...se("Completed",M.completed,i.green,e)),n.push(...se("Next Steps",M.next_steps,i.magenta,e))),T&&(n.push(""),n.push("---"),n.push(""),e?(n.push(`${i.bright}${i.magenta}\u{1F4CB} Previously${i.reset}`),n.push(""),n.push(`${i.dim}A: ${T}${i.reset}`)):(n.push("**\u{1F4CB} Previously**"),n.push(""),n.push(`A: ${T}`)),n.push("")),me&&N>0&&C>0){let u=Math.round(N/1e3);n.push(""),e?n.push(`${i.dim}\u{1F4B0} Access ${u}k tokens of past research & decisions for just ${U.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${i.reset}`):n.push(`\u{1F4B0} Access ${u}k tokens of past research & decisions for just ${U.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return o?.close(),n.join(`
`).trimEnd()}0&&(module.exports={generateContext,getAllSessionSavings,getSessionSavings});
