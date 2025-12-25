"use strict";var je=Object.create;var J=Object.defineProperty;var Be=Object.getOwnPropertyDescriptor;var Ge=Object.getOwnPropertyNames;var He=Object.getPrototypeOf,We=Object.prototype.hasOwnProperty;var Ye=(d,e)=>{for(var s in e)J(d,s,{get:e[s],enumerable:!0})},ge=(d,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Ge(e))!We.call(d,n)&&n!==s&&J(d,n,{get:()=>e[n],enumerable:!(t=Be(e,n))||t.enumerable});return d};var oe=(d,e,s)=>(s=d!=null?je(He(d)):{},ge(e||!d||!d.__esModule?J(s,"default",{value:d,enumerable:!0}):s,d)),Ve=d=>ge(J({},"__esModule",{value:!0}),d);var ns={};Ye(ns,{generateContext:()=>rs});module.exports=Ve(ns);var ee=oe(require("path"),1),se=require("os"),G=require("fs");var Ce=require("bun:sqlite");var f=require("path"),Re=require("os"),Oe=require("fs");var Ne=require("url");var B=require("fs"),be=require("path"),fe=require("os");var he="bugfix,feature,refactor,discovery,decision,change",Se="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var ie=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(ie||{}),ae=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let e=$.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=ie[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),a=String(e.getMinutes()).padStart(2,"0"),c=String(e.getSeconds()).padStart(2,"0"),p=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${n} ${o}:${a}:${c}.${p}`}log(e,s,t,n,o){if(e<this.getLevel())return;let a=this.formatTimestamp(new Date),c=ie[e].padEnd(5),p=s.padEnd(6),l="";n?.correlationId?l=`[${n.correlationId}] `:n?.sessionId&&(l=`[session-${n.sessionId}] `);let u="";o!=null&&(this.getLevel()===0&&typeof o=="object"?u=`
`+JSON.stringify(o,null,2):u=" "+this.formatData(o));let b="";if(n){let{sessionId:E,sdkSessionId:A,correlationId:T,...r}=n;Object.keys(r).length>0&&(b=` {${Object.entries(r).map(([O,M])=>`${O}=${M}`).join(", ")}}`)}let R=`[${a}] [${c}] [${p}] ${l}${t}${b}${u}`;e===3?console.error(R):console.log(R)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}error(e,s,t,n){this.log(3,e,s,t,n)}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}timing(e,s,t,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${t}ms`})}happyPathError(e,s,t,n,o=""){let l=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=l?`${l[1].split("/").pop()}:${l[2]}`:"unknown",b={...t,location:u};return this.warn(e,`[HAPPY-PATH] ${s}`,b,n),o}},S=new ae;var $=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:(0,be.join)((0,fe.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:he,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:Se,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_SURPRISE_ENABLED:"true",CLAUDE_MEM_SURPRISE_THRESHOLD:"0.3",CLAUDE_MEM_SURPRISE_LOOKBACK_DAYS:"30",CLAUDE_MEM_MOMENTUM_ENABLED:"true",CLAUDE_MEM_MOMENTUM_DURATION_MINUTES:"5"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,B.existsSync)(e))return this.getAllDefaults();let s=(0,B.readFileSync)(e,"utf-8"),t=JSON.parse(s),n=t;if(t.env&&typeof t.env=="object"){n=t.env;try{(0,B.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),S.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(a){S.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},a)}}let o={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))n[a]!==void 0&&(o[a]=n[a]);return o}catch(s){return S.warn("SETTINGS","Failed to load settings, using defaults",{settingsPath:e},s),this.getAllDefaults()}}};var Je={};function Ke(){return typeof __dirname<"u"?__dirname:(0,f.dirname)((0,Ne.fileURLToPath)(Je.url))}var qe=Ke(),v=$.get("CLAUDE_MEM_DATA_DIR"),de=process.env.CLAUDE_CONFIG_DIR||(0,f.join)((0,Re.homedir)(),".claude"),gs=(0,f.join)(v,"archives"),hs=(0,f.join)(v,"logs"),Ss=(0,f.join)(v,"trash"),bs=(0,f.join)(v,"backups"),fs=(0,f.join)(v,"modes"),Rs=(0,f.join)(v,"settings.json"),Ae=(0,f.join)(v,"claude-mem.db"),Os=(0,f.join)(v,"vector-db"),Ns=(0,f.join)(de,"settings.json"),As=(0,f.join)(de,"commands"),Is=(0,f.join)(de,"CLAUDE.md");function Ie(d){(0,Oe.mkdirSync)(d,{recursive:!0})}function Le(){return(0,f.join)(qe,"..")}var Q=class{db;constructor(e=Ae){e!==":memory:"&&Ie(v),this.db=new Ce.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.createMemoryAccessTracking()}initializeSchema(){try{this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(t=>t.version)):0)===0&&(console.log("[SessionStore] Initializing fresh database with migration004..."),this.db.run(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.log("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.log("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(p=>p.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.log("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(p=>p.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(p=>p.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.log("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.log("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(n){throw this.db.run("ROLLBACK"),n}}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.log("[SessionStore] Adding hierarchical fields to observations table..."),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.log("[SessionStore] Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.log("[SessionStore] Making observations.text nullable..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.log("[SessionStore] Successfully made observations.text nullable")}catch(n){throw this.db.run("ROLLBACK"),n}}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.log("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.log("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.run("ROLLBACK"),t}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}createPendingMessagesTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}console.log("[SessionStore] Creating pending_messages table..."),this.db.run(`
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(claude_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),console.log("[SessionStore] pending_messages table created successfully")}catch(e){throw console.error("[SessionStore] Pending messages table migration error:",e.message),e}}createMemoryAccessTracking(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;console.log("[SessionStore] Creating memory access tracking..."),this.db.run("BEGIN TRANSACTION");try{this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_access'").all().length===0&&(this.db.run(`
            CREATE TABLE memory_access (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              memory_id INTEGER NOT NULL,
              timestamp INTEGER NOT NULL,
              context TEXT,
              FOREIGN KEY (memory_id) REFERENCES observations(id) ON DELETE CASCADE
            )
          `),this.db.run("CREATE INDEX idx_memory_access_memory_id ON memory_access(memory_id)"),this.db.run("CREATE INDEX idx_memory_access_timestamp ON memory_access(timestamp DESC)"),this.db.run("CREATE INDEX idx_memory_access_memory_timestamp ON memory_access(memory_id, timestamp DESC)"),console.log("[SessionStore] Created memory_access table"));let t=this.db.query("PRAGMA table_info(observations)").all(),n=t.some(c=>c.name==="importance_score"),o=t.some(c=>c.name==="access_count"),a=t.some(c=>c.name==="last_accessed");n||(this.db.run("ALTER TABLE observations ADD COLUMN importance_score REAL DEFAULT 0.5"),console.log("[SessionStore] Added importance_score column to observations")),o||(this.db.run("ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0"),console.log("[SessionStore] Added access_count column to observations")),a||(this.db.run("ALTER TABLE observations ADD COLUMN last_accessed INTEGER"),console.log("[SessionStore] Added last_accessed column to observations")),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),console.log("[SessionStore] Memory access tracking migration completed successfully")}catch(s){throw this.db.run("ROLLBACK"),s}}catch(e){throw console.error("[SessionStore] Memory access tracking migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentSummariesWithSessionInfo(e,s=3){return this.db.prepare(`
      SELECT
        sdk_session_id, request, learned, completed, next_steps,
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
    `).all().map(t=>t.project)}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.sdk_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.claude_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).all(e,s)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o,type:a,concepts:c,files:p}=s,l=t==="date_asc"?"ASC":"DESC",u=n?`LIMIT ${n}`:"",b=e.map(()=>"?").join(","),R=[...e],E=[];if(o&&(E.push("project = ?"),R.push(o)),a)if(Array.isArray(a)){let r=a.map(()=>"?").join(",");E.push(`type IN (${r})`),R.push(...a)}else E.push("type = ?"),R.push(a);if(c){let r=Array.isArray(c)?c:[c],I=r.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");R.push(...r),E.push(`(${I.join(" OR ")})`)}if(p){let r=Array.isArray(p)?p:[p],I=r.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");r.forEach(O=>{R.push(`%${O}%`,`%${O}%`)}),E.push(`(${I.join(" OR ")})`)}let A=E.length>0?`WHERE id IN (${b}) AND ${E.join(" AND ")}`:`WHERE id IN (${b})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${A}
      ORDER BY created_at_epoch ${l}
      ${u}
    `).all(...R)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,o=new Set;for(let a of t){if(a.files_read){let c=JSON.parse(a.files_read);Array.isArray(c)&&c.forEach(p=>n.add(p))}if(a.files_modified){let c=JSON.parse(a.files_modified);Array.isArray(c)&&c.forEach(p=>o.add(p))}}return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE sdk_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE claude_session_id = ?
    `).get(e).count}createSDKSession(e,s,t){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,n.toISOString(),o),this.db.prepare("SELECT id FROM sdk_sessions WHERE claude_session_id = ?").get(e).id}saveUserPrompt(e,s,t){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,o=0,a){let c=a??Date.now(),p=new Date(c).toISOString(),u=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),n||null,o,p,c);return{id:Number(u.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,t,n,o=0,a){let c=a??Date.now(),p=new Date(c).toISOString(),u=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,o,p,c);return{id:Number(u.lastInsertRowid),createdAtEpoch:c}}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o}=s,a=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",p=e.map(()=>"?").join(","),l=[...e],u=o?`WHERE id IN (${p}) AND project = ?`:`WHERE id IN (${p})`;return o&&l.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${u}
      ORDER BY created_at_epoch ${a}
      ${c}
    `).all(...l)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o}=s,a=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",p=e.map(()=>"?").join(","),l=[...e],u=o?"AND s.project = ?":"";return o&&l.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${p}) ${u}
      ORDER BY up.created_at_epoch ${a}
      ${c}
    `).all(...l)}getTimelineAroundTimestamp(e,s=10,t=10,n){return this.getTimelineAroundObservation(null,e,s,t,n)}getTimelineAroundObservation(e,s,t=10,n=10,o){let a=o?"AND project = ?":"",c=o?[o]:[],p,l;if(e!==null){let E=`
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
      `;try{let T=this.db.prepare(E).all(e,...c,t+1),r=this.db.prepare(A).all(e,...c,n+1);if(T.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};p=T.length>0?T[T.length-1].created_at_epoch:s,l=r.length>0?r[r.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary observations:",T.message,o?`(project: ${o})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}else{let E=`
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
      `;try{let T=this.db.prepare(E).all(s,...c,t),r=this.db.prepare(A).all(s,...c,n+1);if(T.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};p=T.length>0?T[T.length-1].created_at_epoch:s,l=r.length>0?r[r.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary timestamps:",T.message,o?`(project: ${o})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,R=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let E=this.db.prepare(u).all(p,l,...c),A=this.db.prepare(b).all(p,l,...c),T=this.db.prepare(R).all(p,l,...c);return{observations:E,sessions:A.map(r=>({id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,request:r.request,completed:r.completed,next_steps:r.next_steps,created_at:r.created_at,created_at_epoch:r.created_at_epoch})),prompts:T.map(r=>({id:r.id,claude_session_id:r.claude_session_id,prompt_number:r.prompt_number,prompt_text:r.prompt_text,project:r.project,created_at:r.created_at,created_at_epoch:r.created_at_epoch}))}}catch(E){return console.error("[SessionStore] Error querying timeline records:",E.message,o?`(project: ${o})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
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
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
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
      WHERE p.id IN (${s})
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
    `).get(e)||null}close(){this.db.close()}importSdkSession(e){let s=this.db.prepare("SELECT id FROM sdk_sessions WHERE claude_session_id = ?").get(e.claude_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        claude_session_id, sdk_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.claude_session_id,e.sdk_session_id,e.project,e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE sdk_session_id = ?").get(e.sdk_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        sdk_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sdk_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let s=this.db.prepare(`
      SELECT id FROM observations
      WHERE sdk_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.sdk_session_id,e.title,e.created_at_epoch);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        sdk_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.sdk_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importUserPrompt(e){let s=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
    `).get(e.claude_session_id,e.prompt_number);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        claude_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.claude_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var ce=oe(require("path"),1);function pe(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function ve(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ye(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Me(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Qe(d,e){return ce.default.isAbsolute(d)?ce.default.relative(e,d):d}function De(d,e){let s=pe(d);return s.length>0?Qe(s[0],e):"General"}var ke=oe(require("path"),1);function $e(d){if(!d||d.trim()==="")return S.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:d}),"unknown-project";let e=ke.default.basename(d);if(e===""){if(process.platform==="win32"){let t=d.match(/^([A-Z]):\\/i);if(t){let o=`drive-${t[1].toUpperCase()}`;return S.info("PROJECT_NAME","Drive root detected",{cwd:d,projectName:o}),o}}return S.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:d}),"unknown-project"}return e}var H=require("fs"),z=require("path");var X=class d{static instance=null;activeMode=null;modesDir;constructor(){let e=Le(),s=[(0,z.join)(e,"modes"),(0,z.join)(e,"..","plugin","modes")],t=s.find(n=>(0,H.existsSync)(n));this.modesDir=t||s[0]}static getInstance(){return d.instance||(d.instance=new d),d.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let t={...e};for(let n in s){let o=s[n],a=e[n];this.isPlainObject(o)&&this.isPlainObject(a)?t[n]=this.deepMerge(a,o):t[n]=o}return t}loadModeFile(e){let s=(0,z.join)(this.modesDir,`${e}.json`);if(!(0,H.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let t=(0,H.readFileSync)(s,"utf-8");return JSON.parse(t)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let p=this.loadModeFile(e);return this.activeMode=p,S.debug("SYSTEM",`Loaded mode: ${p.name} (${e})`,void 0,{types:p.observation_types.map(l=>l.id),concepts:p.observation_concepts.map(l=>l.id)}),p}catch{if(S.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:t,overrideId:n}=s,o;try{o=this.loadMode(t)}catch{S.warn("SYSTEM",`Parent mode '${t}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let a;try{a=this.loadModeFile(n),S.debug("SYSTEM",`Loaded override file: ${n} for parent ${t}`)}catch{return S.warn("SYSTEM",`Override file '${n}' not found, using parent mode '${t}' only`),this.activeMode=o,o}if(!a)return S.warn("SYSTEM",`Invalid override file: ${n}, using parent mode '${t}' only`),this.activeMode=o,o;let c=this.deepMerge(o,a);return this.activeMode=c,S.debug("SYSTEM",`Loaded mode with inheritance: ${c.name} (${e} = ${t} + ${n})`,void 0,{parent:t,override:n,types:c.observation_types.map(p=>p.id),concepts:c.observation_concepts.map(p=>p.id)}),c}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(t=>t.id===e)?.label||e}};var ze=ee.default.join((0,se.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ze(){let d=ee.default.join((0,se.homedir)(),".claude-mem","settings.json"),e=$.loadFromFile(d),s=e.CLAUDE_MEM_MODE,t=s==="code"||s.startsWith("code--"),n,o;if(t)n=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(a=>a.trim()).filter(Boolean)),o=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(a=>a.trim()).filter(Boolean));else{let a=X.getInstance().getActiveMode();n=new Set(a.observation_types.map(c=>c.id)),o=new Set(a.observation_concepts.map(c=>c.id))}return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:n,observationConcepts:o,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var Ue=4,es=1,i={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Z(d,e,s,t){return e?t?[`${s}${d}:${i.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}function ss(d){return d.replace(/\//g,"-")}function ts(d){try{if(!(0,G.existsSync)(d))return{userMessage:"",assistantMessage:""};let e=(0,G.readFileSync)(d,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),t="";for(let n=s.length-1;n>=0;n--)try{let o=s[n];if(!o.includes('"type":"assistant"'))continue;let a=JSON.parse(o);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let c="";for(let p of a.message.content)p.type==="text"&&(c+=p.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){t=c;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return S.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:d},e),{userMessage:"",assistantMessage:""}}}async function rs(d,e=!1){let s=Ze(),t=d?.cwd??process.cwd(),n=$e(t),o=null;try{o=new Q}catch(I){if(I.code==="ERR_DLOPEN_FAILED"){try{(0,G.unlinkSync)(ze)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw I}let a=Array.from(s.observationTypes),c=a.map(()=>"?").join(","),p=Array.from(s.observationConcepts),l=p.map(()=>"?").join(","),u=o.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${c})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${l})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...a,...p,s.totalObservationCount),b=o.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+es),R="",E="";if(s.showLastMessage&&u.length>0){let I=d?.session_id,O=u.find(M=>M.sdk_session_id!==I);if(O){let M=O.sdk_session_id,U=ss(t),N=ee.default.join((0,se.homedir)(),".claude","projects",U,`${M}.jsonl`),y=ts(N);R=y.userMessage,E=y.assistantMessage}}if(u.length===0&&b.length===0)return o?.close(),e?`
${i.bright}${i.cyan}[${n}] recent context${i.reset}
${i.gray}${"\u2500".repeat(60)}${i.reset}

${i.dim}No previous sessions found for this project yet.${i.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let A=b.slice(0,s.sessionCount),T=u,r=[];if(e?(r.push(""),r.push(`${i.bright}${i.cyan}[${n}] recent context${i.reset}`),r.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),r.push("")):(r.push(`# [${n}] recent context`),r.push("")),T.length>0){let O=X.getInstance().getActiveMode().observation_types.map(_=>`${_.emoji} ${_.id}`).join(" | ");e?r.push(`${i.dim}Legend: \u{1F3AF} session-request | ${O}${i.reset}`):r.push(`**Legend:** \u{1F3AF} session-request | ${O}`),r.push(""),e?(r.push(`${i.bright}\u{1F4A1} Column Key${i.reset}`),r.push(`${i.dim}  Read: Tokens to read this observation (cost to learn it now)${i.reset}`),r.push(`${i.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${i.reset}`)):(r.push("\u{1F4A1} **Column Key**:"),r.push("- **Read**: Tokens to read this observation (cost to learn it now)"),r.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),r.push(""),e?(r.push(`${i.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${i.reset}`),r.push(""),r.push(`${i.dim}When you need implementation details, rationale, or debugging context:${i.reset}`),r.push(`${i.dim}  - Use the mem-search skill to fetch full observations on-demand${i.reset}`),r.push(`${i.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${i.reset}`),r.push(`${i.dim}  - Trust this index over re-reading code for past decisions and learnings${i.reset}`)):(r.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),r.push(""),r.push("When you need implementation details, rationale, or debugging context:"),r.push("- Use the mem-search skill to fetch full observations on-demand"),r.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),r.push("- Trust this index over re-reading code for past decisions and learnings")),r.push("");let M=u.length,U=u.reduce((_,g)=>{let h=(g.title?.length||0)+(g.subtitle?.length||0)+(g.narrative?.length||0)+JSON.stringify(g.facts||[]).length;return _+Math.ceil(h/Ue)},0),N=u.reduce((_,g)=>_+(g.discovery_tokens||0),0),y=N-U,W=N>0?Math.round(y/N*100):0,_e=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(_e)if(e){if(r.push(`${i.bright}${i.cyan}\u{1F4CA} Context Economics${i.reset}`),r.push(`${i.dim}  Loading: ${M} observations (${U.toLocaleString()} tokens to read)${i.reset}`),r.push(`${i.dim}  Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions${i.reset}`),N>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${y.toLocaleString()} tokens (${W}% reduction from reuse)`:s.showSavingsAmount?_+=`${y.toLocaleString()} tokens`:_+=`${W}% reduction from reuse`,r.push(`${i.green}${_}${i.reset}`)}r.push("")}else{if(r.push("\u{1F4CA} **Context Economics**:"),r.push(`- Loading: ${M} observations (${U.toLocaleString()} tokens to read)`),r.push(`- Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions`),N>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${y.toLocaleString()} tokens (${W}% reduction from reuse)`:s.showSavingsAmount?_+=`${y.toLocaleString()} tokens`:_+=`${W}% reduction from reuse`,r.push(_)}r.push("")}let xe=b[0]?.id,we=A.map((_,g)=>{let h=g===0?null:b[g+1];return{..._,displayEpoch:h?h.created_at_epoch:_.created_at_epoch,displayTime:h?h.created_at:_.created_at,shouldShowLink:_.id!==xe}}),Fe=new Set(u.slice(0,s.fullObservationCount).map(_=>_.id)),le=[...T.map(_=>({type:"observation",data:_})),...we.map(_=>({type:"summary",data:_}))];le.sort((_,g)=>{let h=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch,D=g.type==="observation"?g.data.created_at_epoch:g.data.displayEpoch;return h-D});let Y=new Map;for(let _ of le){let g=_.type==="observation"?_.data.created_at:_.data.displayTime,h=Me(g);Y.has(h)||Y.set(h,[]),Y.get(h).push(_)}let Xe=Array.from(Y.entries()).sort((_,g)=>{let h=new Date(_[0]).getTime(),D=new Date(g[0]).getTime();return h-D});for(let[_,g]of Xe){e?(r.push(`${i.bright}${i.cyan}${_}${i.reset}`),r.push("")):(r.push(`### ${_}`),r.push(""));let h=null,D="",x=!1;for(let te of g)if(te.type==="summary"){x&&(r.push(""),x=!1,h=null,D="");let m=te.data,w=`${m.request||"Session started"} (${ve(m.displayTime)})`;e?r.push(`\u{1F3AF} ${i.yellow}#S${m.id}${i.reset} ${w}`):r.push(`**\u{1F3AF} #S${m.id}** ${w}`),r.push("")}else{let m=te.data,w=De(m.files_modified,t);w!==h&&(x&&r.push(""),e?r.push(`${i.dim}${w}${i.reset}`):r.push(`**${w}**`),e||(r.push("| ID | Time | T | Title | Read | Work |"),r.push("|----|------|---|-------|------|------|")),h=w,x=!0,D="");let F=ye(m.created_at),V=m.title||"Untitled",K=X.getInstance().getTypeIcon(m.type),Pe=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length,P=Math.ceil(Pe/Ue),j=m.discovery_tokens||0,re=X.getInstance().getWorkEmoji(m.type),me=j>0?`${re} ${j.toLocaleString()}`:"-",ne=F!==D,Ee=ne?F:"";if(D=F,Fe.has(m.id)){let k=s.fullObservationField==="narrative"?m.narrative:m.facts?pe(m.facts).join(`
`):null;if(e){let C=ne?`${i.dim}${F}${i.reset}`:" ".repeat(F.length),q=s.showReadTokens&&P>0?`${i.dim}(~${P}t)${i.reset}`:"",Te=s.showWorkTokens&&j>0?`${i.dim}(${re} ${j.toLocaleString()}t)${i.reset}`:"";r.push(`  ${i.dim}#${m.id}${i.reset}  ${C}  ${K}  ${i.bright}${V}${i.reset}`),k&&r.push(`    ${i.dim}${k}${i.reset}`),(q||Te)&&r.push(`    ${q} ${Te}`),r.push("")}else{x&&(r.push(""),x=!1),r.push(`**#${m.id}** ${Ee||"\u2033"} ${K} **${V}**`),k&&(r.push(""),r.push(k),r.push(""));let C=[];s.showReadTokens&&C.push(`Read: ~${P}`),s.showWorkTokens&&C.push(`Work: ${me}`),C.length>0&&r.push(C.join(", ")),r.push(""),h=null}}else if(e){let k=ne?`${i.dim}${F}${i.reset}`:" ".repeat(F.length),C=s.showReadTokens&&P>0?`${i.dim}(~${P}t)${i.reset}`:"",q=s.showWorkTokens&&j>0?`${i.dim}(${re} ${j.toLocaleString()}t)${i.reset}`:"";r.push(`  ${i.dim}#${m.id}${i.reset}  ${k}  ${K}  ${V} ${C} ${q}`)}else{let k=s.showReadTokens?`~${P}`:"",C=s.showWorkTokens?me:"";r.push(`| #${m.id} | ${Ee||"\u2033"} | ${K} | ${V} | ${k} | ${C} |`)}}x&&r.push("")}let L=b[0],ue=u[0];if(s.showLastSummary&&L&&(L.investigated||L.learned||L.completed||L.next_steps)&&(!ue||L.created_at_epoch>ue.created_at_epoch)&&(r.push(...Z("Investigated",L.investigated,i.blue,e)),r.push(...Z("Learned",L.learned,i.yellow,e)),r.push(...Z("Completed",L.completed,i.green,e)),r.push(...Z("Next Steps",L.next_steps,i.magenta,e))),E&&(r.push(""),r.push("---"),r.push(""),e?(r.push(`${i.bright}${i.magenta}\u{1F4CB} Previously${i.reset}`),r.push(""),r.push(`${i.dim}A: ${E}${i.reset}`)):(r.push("**\u{1F4CB} Previously**"),r.push(""),r.push(`A: ${E}`)),r.push("")),_e&&N>0&&y>0){let _=Math.round(N/1e3);r.push(""),e?r.push(`${i.dim}\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${U.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${i.reset}`):r.push(`\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${U.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return o?.close(),r.join(`
`).trimEnd()}0&&(module.exports={generateContext});
