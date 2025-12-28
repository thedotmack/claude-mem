"use strict";var Ge=Object.create;var J=Object.defineProperty;var Be=Object.getOwnPropertyDescriptor;var He=Object.getOwnPropertyNames;var We=Object.getPrototypeOf,Ye=Object.prototype.hasOwnProperty;var Ve=(c,e)=>{for(var s in e)J(c,s,{get:e[s],enumerable:!0})},he=(c,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of He(e))!Ye.call(c,r)&&r!==s&&J(c,r,{get:()=>e[r],enumerable:!(t=Be(e,r))||t.enumerable});return c};var ie=(c,e,s)=>(s=c!=null?Ge(We(c)):{},he(e||!c||!c.__esModule?J(s,"default",{value:c,enumerable:!0}):s,c)),Ke=c=>he(J({},"__esModule",{value:!0}),c);var cs={};Ve(cs,{generateContext:()=>ds,getAllSessionSavings:()=>es,getSessionSavings:()=>Ze});module.exports=Ke(cs);var se=ie(require("path"),1),te=require("os"),B=require("fs");var ve=require("bun:sqlite");var f=require("path"),Oe=require("os"),Ne=require("fs");var Ae=require("url");var G=require("fs"),fe=require("path"),Re=require("os");var Se="bugfix,feature,refactor,discovery,decision,change",be="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var ae=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(ae||{}),de=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let e=U.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=ae[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),d=String(e.getMinutes()).padStart(2,"0"),p=String(e.getSeconds()).padStart(2,"0"),a=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${r} ${i}:${d}:${p}.${a}`}log(e,s,t,r,i){if(e<this.getLevel())return;let d=this.formatTimestamp(new Date),p=ae[e].padEnd(5),a=s.padEnd(6),u="";r?.correlationId?u=`[${r.correlationId}] `:r?.sessionId&&(u=`[session-${r.sessionId}] `);let l="";i!=null&&(this.getLevel()===0&&typeof i=="object"?l=`
`+JSON.stringify(i,null,2):l=" "+this.formatData(i));let m="";if(r){let{sessionId:g,sdkSessionId:A,correlationId:T,...n}=r;Object.keys(n).length>0&&(m=` {${Object.entries(n).map(([N,L])=>`${N}=${L}`).join(", ")}}`)}let R=`[${d}] [${p}] [${a}] ${u}${t}${m}${l}`;e===3?console.error(R):console.log(R)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}happyPathError(e,s,t,r,i=""){let u=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),l=u?`${u[1].split("/").pop()}:${u[2]}`:"unknown",m={...t,location:l};return this.warn(e,`[HAPPY-PATH] ${s}`,m,r),i}},b=new de;var U=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_DATA_DIR:(0,fe.join)((0,Re.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:Se,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:be,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_SURPRISE_ENABLED:"true",CLAUDE_MEM_SURPRISE_THRESHOLD:"0.3",CLAUDE_MEM_SURPRISE_LOOKBACK_DAYS:"30",CLAUDE_MEM_MOMENTUM_ENABLED:"true",CLAUDE_MEM_MOMENTUM_DURATION_MINUTES:"5"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,G.existsSync)(e))return this.getAllDefaults();let s=(0,G.readFileSync)(e,"utf-8"),t=JSON.parse(s),r=t;if(t.env&&typeof t.env=="object"){r=t.env;try{(0,G.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),b.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(d){b.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},d)}}let i={...this.DEFAULTS};for(let d of Object.keys(this.DEFAULTS))r[d]!==void 0&&(i[d]=r[d]);return i}catch(s){return b.warn("SETTINGS","Failed to load settings, using defaults",{settingsPath:e},s),this.getAllDefaults()}}};var Qe={};function qe(){return typeof __dirname<"u"?__dirname:(0,f.dirname)((0,Ae.fileURLToPath)(Qe.url))}var Je=qe(),y=U.get("CLAUDE_MEM_DATA_DIR"),ce=process.env.CLAUDE_CONFIG_DIR||(0,f.join)((0,Oe.homedir)(),".claude"),Rs=(0,f.join)(y,"archives"),Os=(0,f.join)(y,"logs"),Ns=(0,f.join)(y,"trash"),As=(0,f.join)(y,"backups"),Is=(0,f.join)(y,"modes"),Ls=(0,f.join)(y,"settings.json"),Ie=(0,f.join)(y,"claude-mem.db"),Cs=(0,f.join)(y,"vector-db"),vs=(0,f.join)(ce,"settings.json"),Ms=(0,f.join)(ce,"commands"),ys=(0,f.join)(ce,"CLAUDE.md");function Le(c){(0,Ne.mkdirSync)(c,{recursive:!0})}function Ce(){return(0,f.join)(Je,"..")}var Q=class{db;constructor(e=Ie){e!==":memory:"&&Le(y),this.db=new ve.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.createMemoryAccessTracking()}initializeSchema(){try{this.db.run(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.log("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.log("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(a=>a.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.log("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.log("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.log("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(r){throw this.db.run("ROLLBACK"),r}}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.log("[SessionStore] Adding hierarchical fields to observations table..."),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.log("[SessionStore] Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.log("[SessionStore] Making observations.text nullable..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.log("[SessionStore] Successfully made observations.text nullable")}catch(r){throw this.db.run("ROLLBACK"),r}}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.log("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.log("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.run("ROLLBACK"),t}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(d=>d.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(d=>d.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}createPendingMessagesTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}console.log("[SessionStore] Creating pending_messages table..."),this.db.run(`
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
          `),this.db.run("CREATE INDEX idx_memory_access_memory_id ON memory_access(memory_id)"),this.db.run("CREATE INDEX idx_memory_access_timestamp ON memory_access(timestamp DESC)"),this.db.run("CREATE INDEX idx_memory_access_memory_timestamp ON memory_access(memory_id, timestamp DESC)"),console.log("[SessionStore] Created memory_access table"));let t=this.db.query("PRAGMA table_info(observations)").all(),r=t.some(a=>a.name==="importance_score"),i=t.some(a=>a.name==="access_count"),d=t.some(a=>a.name==="last_accessed"),p=t.some(a=>a.name==="surprise_score");r||(this.db.run("ALTER TABLE observations ADD COLUMN importance_score REAL DEFAULT 0.5"),console.log("[SessionStore] Added importance_score column to observations")),i||(this.db.run("ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0"),console.log("[SessionStore] Added access_count column to observations")),d||(this.db.run("ALTER TABLE observations ADD COLUMN last_accessed INTEGER"),console.log("[SessionStore] Added last_accessed column to observations")),p||(this.db.run("ALTER TABLE observations ADD COLUMN surprise_score REAL DEFAULT 0.5"),console.log("[SessionStore] Added surprise_score column to observations")),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),console.log("[SessionStore] Memory access tracking migration completed successfully")}catch(s){throw this.db.run("ROLLBACK"),s}}catch(e){throw console.error("[SessionStore] Memory access tracking migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:i,type:d,concepts:p,files:a}=s,u=t==="date_asc"?"ASC":"DESC",l=r?`LIMIT ${r}`:"",m=e.map(()=>"?").join(","),R=[...e],g=[];if(i&&(g.push("project = ?"),R.push(i)),d)if(Array.isArray(d)){let n=d.map(()=>"?").join(",");g.push(`type IN (${n})`),R.push(...d)}else g.push("type = ?"),R.push(d);if(p){let n=Array.isArray(p)?p:[p],I=n.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");R.push(...n),g.push(`(${I.join(" OR ")})`)}if(a){let n=Array.isArray(a)?a:[a],I=n.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");n.forEach(N=>{R.push(`%${N}%`,`%${N}%`)}),g.push(`(${I.join(" OR ")})`)}let A=g.length>0?`WHERE id IN (${m}) AND ${g.join(" AND ")}`:`WHERE id IN (${m})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${A}
      ORDER BY created_at_epoch ${u}
      ${l}
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
    `).all(e),r=new Set,i=new Set;for(let d of t){if(d.files_read){let p=JSON.parse(d.files_read);Array.isArray(p)&&p.forEach(a=>r.add(a))}if(d.files_modified){let p=JSON.parse(d.files_modified);Array.isArray(p)&&p.forEach(a=>i.add(a))}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e).count}createSDKSession(e,s,t){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),i),this.db.prepare("SELECT id FROM sdk_sessions WHERE claude_session_id = ?").get(e).id}saveUserPrompt(e,s,t){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,i=0,d){let p=d??Date.now(),a=new Date(p).toISOString(),l=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,i,a,p);return{id:Number(l.lastInsertRowid),createdAtEpoch:p}}storeSummary(e,s,t,r,i=0,d){let p=d??Date.now(),a=new Date(p).toISOString(),l=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,i,a,p);return{id:Number(l.lastInsertRowid),createdAtEpoch:p}}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:i}=s,d=t==="date_asc"?"ASC":"DESC",p=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(","),u=[...e],l=i?`WHERE id IN (${a}) AND project = ?`:`WHERE id IN (${a})`;return i&&u.push(i),this.db.prepare(`
      SELECT * FROM session_summaries
      ${l}
      ORDER BY created_at_epoch ${d}
      ${p}
    `).all(...u)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:i}=s,d=t==="date_asc"?"ASC":"DESC",p=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(","),u=[...e],l=i?"AND s.project = ?":"";return i&&u.push(i),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a}) ${l}
      ORDER BY up.created_at_epoch ${d}
      ${p}
    `).all(...u)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let d=i?"AND project = ?":"",p=i?[i]:[],a,u;if(e!==null){let g=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${d}
        ORDER BY id DESC
        LIMIT ?
      `,A=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${d}
        ORDER BY id ASC
        LIMIT ?
      `;try{let T=this.db.prepare(g).all(e,...p,t+1),n=this.db.prepare(A).all(e,...p,r+1);if(T.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};a=T.length>0?T[T.length-1].created_at_epoch:s,u=n.length>0?n[n.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary observations:",T.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}else{let g=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${d}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,A=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${d}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let T=this.db.prepare(g).all(s,...p,t),n=this.db.prepare(A).all(s,...p,r+1);if(T.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};a=T.length>0?T[T.length-1].created_at_epoch:s,u=n.length>0?n[n.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary timestamps:",T.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,m=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,R=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${d.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let g=this.db.prepare(l).all(a,u,...p),A=this.db.prepare(m).all(a,u,...p),T=this.db.prepare(R).all(a,u,...p);return{observations:g,sessions:A.map(n=>({id:n.id,sdk_session_id:n.sdk_session_id,project:n.project,request:n.request,completed:n.completed,next_steps:n.next_steps,created_at:n.created_at,created_at_epoch:n.created_at_epoch})),prompts:T.map(n=>({id:n.id,claude_session_id:n.claude_session_id,prompt_number:n.prompt_number,prompt_text:n.prompt_text,project:n.project,created_at:n.created_at,created_at_epoch:n.created_at_epoch}))}}catch(g){return console.error("[SessionStore] Error querying timeline records:",g.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
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
    `).run(e.claude_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var pe=ie(require("path"),1);function _e(c){if(!c)return[];try{let e=JSON.parse(c);return Array.isArray(e)?e:[]}catch{return[]}}function Me(c){return new Date(c).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ye(c){return new Date(c).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function De(c){return new Date(c).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function ze(c,e){return pe.default.isAbsolute(c)?pe.default.relative(e,c):c}function $e(c,e){let s=_e(c);return s.length>0?ze(s[0],e):"General"}var ke=ie(require("path"),1);function Ue(c){if(!c||c.trim()==="")return b.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:c}),"unknown-project";let e=ke.default.basename(c);if(e===""){if(process.platform==="win32"){let t=c.match(/^([A-Z]):\\/i);if(t){let i=`drive-${t[1].toUpperCase()}`;return b.info("PROJECT_NAME","Drive root detected",{cwd:c,projectName:i}),i}}return b.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:c}),"unknown-project"}return e}var W=require("fs"),z=require("path");var x=class c{static instance=null;activeMode=null;modesDir;constructor(){let e=Ce(),s=[(0,z.join)(e,"modes"),(0,z.join)(e,"..","plugin","modes")],t=s.find(r=>(0,W.existsSync)(r));this.modesDir=t||s[0]}static getInstance(){return c.instance||(c.instance=new c),c.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let t={...e};for(let r in s){let i=s[r],d=e[r];this.isPlainObject(i)&&this.isPlainObject(d)?t[r]=this.deepMerge(d,i):t[r]=i}return t}loadModeFile(e){let s=(0,z.join)(this.modesDir,`${e}.json`);if(!(0,W.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let t=(0,W.readFileSync)(s,"utf-8");return JSON.parse(t)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let a=this.loadModeFile(e);return this.activeMode=a,b.debug("SYSTEM",`Loaded mode: ${a.name} (${e})`,void 0,{types:a.observation_types.map(u=>u.id),concepts:a.observation_concepts.map(u=>u.id)}),a}catch{if(b.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:t,overrideId:r}=s,i;try{i=this.loadMode(t)}catch{b.warn("SYSTEM",`Parent mode '${t}' not found for ${e}, falling back to 'code'`),i=this.loadMode("code")}let d;try{d=this.loadModeFile(r),b.debug("SYSTEM",`Loaded override file: ${r} for parent ${t}`)}catch{return b.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${t}' only`),this.activeMode=i,i}if(!d)return b.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${t}' only`),this.activeMode=i,i;let p=this.deepMerge(i,d);return this.activeMode=p,b.debug("SYSTEM",`Loaded mode with inheritance: ${p.name} (${e} = ${t} + ${r})`,void 0,{parent:t,override:r,types:p.observation_types.map(a=>a.id),concepts:p.observation_concepts.map(a=>a.id)}),p}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(t=>t.id===e)?.label||e}};var ee=new Map;function Ze(c){if(c)return ee.get(c)||null;let e=null;for(let s of ee.values())(!e||s.calculatedAt>e.calculatedAt)&&(e=s);return e}function es(){return Array.from(ee.values())}var ss=se.default.join((0,te.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function ts(){let c=se.default.join((0,te.homedir)(),".claude-mem","settings.json"),e=U.loadFromFile(c),s=e.CLAUDE_MEM_MODE,t=s==="code"||s.startsWith("code--"),r,i;if(t)r=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(d=>d.trim()).filter(Boolean)),i=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(d=>d.trim()).filter(Boolean));else{let d=x.getInstance().getActiveMode();r=new Set(d.observation_types.map(p=>p.id)),i=new Set(d.observation_concepts.map(p=>p.id))}return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:r,observationConcepts:i,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var xe=4,rs=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function ns(c,e){let s=[],t=new Map;for(let a of c){let u=a.type;t.has(u)||t.set(u,[]),t.get(u).push(a)}if(t.size===0)return s;let r=["feature","bugfix","decision","refactor","change","discovery"],i=Array.from(t.keys()).sort((a,u)=>{let l=r.indexOf(a),m=r.indexOf(u);return(l===-1?999:l)-(m===-1?999:m)}),d=x.getInstance().getActiveMode(),p=new Map(d.observation_types.map(a=>[a.id,a.emoji]));e?(s.push(`${o.bright}${o.green}\u{1F4CB} Quick Status Reference${o.reset}`),s.push(`${o.dim}(Use this to answer "what's done/pending" questions without running searches)${o.reset}`),s.push("")):(s.push("\u{1F4CB} **Quick Status Reference**"),s.push(`*(Use this to answer "what's done/pending" questions without running searches)*`),s.push(""));for(let a of i){let u=t.get(a),l=p.get(a)||"\u{1F4DD}",m=u.slice(0,5).map(R=>R.title||"Untitled");e?s.push(`${l} **${a}** (${u.length}): ${m.join(", ")}${u.length>5?"...":""}`):s.push(`- ${l} **${a}** (${u.length}): ${m.join(", ")}${u.length>5?"...":""}`)}return s.push(""),s}function os(c,e,s){let t=[];return s?(t.push(`${o.bright}${o.yellow}\u26A1 Context Usage Guide${o.reset}`),t.push(`${o.dim}\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510${o.reset}`),t.push(`${o.dim}\u2502 \u2705 USE THIS CONTEXT for:                                     \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 "What's been done?" / "What's completed?"              \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 "What did we decide about X?"                          \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 "What bugs were fixed?"                                \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 History/status questions \u2192 0 additional tokens         \u2502${o.reset}`),t.push(`${o.dim}\u2502                                                             \u2502${o.reset}`),t.push(`${o.dim}\u2502 \u{1F527} USE TOOLS only for:                                      \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 Reading actual code implementation                     \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 Searching for specific patterns in files               \u2502${o.reset}`),t.push(`${o.dim}\u2502    \u2022 Making code changes                                    \u2502${o.reset}`),t.push(`${o.dim}\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518${o.reset}`)):(t.push("\u26A1 **Context Usage Guide**"),t.push(""),t.push("| Question Type | Action | Cost |"),t.push("|---------------|--------|------|"),t.push(`| "What's done/pending?" | \u2705 Use this context | 0 tokens |`),t.push('| "What did we decide?" | \u2705 Use this context | 0 tokens |'),t.push('| "Review past work" | \u2705 Use this context | 0 tokens |'),t.push("| Read code details | \u{1F527} Use tools | ~5-10k tokens |"),t.push("| Search for patterns | \u{1F527} Use tools | ~5-10k tokens |"),t.push("| Make code changes | \u{1F527} Use tools | varies |")),t.push(""),t}function Z(c,e,s,t){return e?t?[`${s}${c}:${o.reset} ${e}`,""]:[`**${c}**: ${e}`,""]:[]}function is(c){return c.replace(/\//g,"-")}function as(c){try{if(!(0,B.existsSync)(c))return{userMessage:"",assistantMessage:""};let e=(0,B.readFileSync)(c,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim()),t="";for(let r=s.length-1;r>=0;r--)try{let i=s[r];if(!i.includes('"type":"assistant"'))continue;let d=JSON.parse(i);if(d.type==="assistant"&&d.message?.content&&Array.isArray(d.message.content)){let p="";for(let a of d.message.content)a.type==="text"&&(p+=a.text);if(p=p.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),p){t=p;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return b.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:c},e),{userMessage:"",assistantMessage:""}}}async function ds(c,e=!1){let s=ts(),t=c?.cwd??process.cwd(),r=Ue(t),i=null;try{i=new Q}catch(I){if(I.code==="ERR_DLOPEN_FAILED"){try{(0,B.unlinkSync)(ss)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw I}let d=Array.from(s.observationTypes),p=d.map(()=>"?").join(","),a=Array.from(s.observationConcepts),u=a.map(()=>"?").join(","),l=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${p})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${u})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,...d,...a,s.totalObservationCount),m=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,s.sessionCount+rs),R="",g="";if(s.showLastMessage&&l.length>0){let I=c?.session_id,N=l.find(L=>L.sdk_session_id!==I);if(N){let L=N.sdk_session_id,D=is(t),O=se.default.join((0,te.homedir)(),".claude","projects",D,`${L}.jsonl`),C=as(O);R=C.userMessage,g=C.assistantMessage}}if(l.length===0&&m.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${r}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let A=m.slice(0,s.sessionCount),T=l,n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}[${r}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),T.length>0){let N=x.getInstance().getActiveMode().observation_types.map(_=>`${_.emoji} ${_.id}`).join(" | ");e?n.push(`${o.dim}Legend: \u{1F3AF} session-request | ${N}${o.reset}`):n.push(`**Legend:** \u{1F3AF} session-request | ${N}`),n.push(""),e?(n.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),n.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),n.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),n.push(""),n.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),n.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),n.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),n.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let L=l.length,D=l.reduce((_,h)=>{let S=(h.title?.length||0)+(h.subtitle?.length||0)+(h.narrative?.length||0)+JSON.stringify(h.facts||[]).length;return _+Math.ceil(S/xe)},0),O=l.reduce((_,h)=>_+(h.discovery_tokens||0),0),C=O-D,H=O>0?Math.round(C/O*100):0;ee.set(r,{project:r,totalObservations:L,totalReadTokens:D,totalDiscoveryTokens:O,savings:C,savingsPercent:H,calculatedAt:Date.now()});let ue=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(ue)if(e){if(n.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),n.push(`${o.dim}  Loading: ${L} observations (${D.toLocaleString()} tokens to read)${o.reset}`),n.push(`${o.dim}  Work investment: ${O.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),O>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${C.toLocaleString()} tokens (${H}% reduction from reuse)`:s.showSavingsAmount?_+=`${C.toLocaleString()} tokens`:_+=`${H}% reduction from reuse`,n.push(`${o.green}${_}${o.reset}`)}n.push("")}else{if(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${L} observations (${D.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${O.toLocaleString()} tokens spent on research, building, and decisions`),O>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${C.toLocaleString()} tokens (${H}% reduction from reuse)`:s.showSavingsAmount?_+=`${C.toLocaleString()} tokens`:_+=`${H}% reduction from reuse`,n.push(_)}n.push("")}n.push(...os(L,D,e)),n.push(...ns(l,e));let we=m[0]?.id,Fe=A.map((_,h)=>{let S=h===0?null:m[h+1];return{..._,displayEpoch:S?S.created_at_epoch:_.created_at_epoch,displayTime:S?S.created_at:_.created_at,shouldShowLink:_.id!==we}}),Xe=new Set(l.slice(0,s.fullObservationCount).map(_=>_.id)),le=[...T.map(_=>({type:"observation",data:_})),...Fe.map(_=>({type:"summary",data:_}))];le.sort((_,h)=>{let S=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch,$=h.type==="observation"?h.data.created_at_epoch:h.data.displayEpoch;return S-$});let Y=new Map;for(let _ of le){let h=_.type==="observation"?_.data.created_at:_.data.displayTime,S=De(h);Y.has(S)||Y.set(S,[]),Y.get(S).push(_)}let Pe=Array.from(Y.entries()).sort((_,h)=>{let S=new Date(_[0]).getTime(),$=new Date(h[0]).getTime();return S-$});for(let[_,h]of Pe){e?(n.push(`${o.bright}${o.cyan}${_}${o.reset}`),n.push("")):(n.push(`### ${_}`),n.push(""));let S=null,$="",w=!1;for(let re of h)if(re.type==="summary"){w&&(n.push(""),w=!1,S=null,$="");let E=re.data,F=`${E.request||"Session started"} (${Me(E.displayTime)})`;e?n.push(`\u{1F3AF} ${o.yellow}#S${E.id}${o.reset} ${F}`):n.push(`**\u{1F3AF} #S${E.id}** ${F}`),n.push("")}else{let E=re.data,F=$e(E.files_modified,t);F!==S&&(w&&n.push(""),e?n.push(`${o.dim}${F}${o.reset}`):n.push(`**${F}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),S=F,w=!0,$="");let X=ye(E.created_at),V=E.title||"Untitled",K=x.getInstance().getTypeIcon(E.type),je=(E.title?.length||0)+(E.subtitle?.length||0)+(E.narrative?.length||0)+JSON.stringify(E.facts||[]).length,P=Math.ceil(je/xe),j=E.discovery_tokens||0,ne=x.getInstance().getWorkEmoji(E.type),Ee=j>0?`${ne} ${j.toLocaleString()}`:"-",oe=X!==$,ge=oe?X:"";if($=X,Xe.has(E.id)){let k=s.fullObservationField==="narrative"?E.narrative:E.facts?_e(E.facts).join(`
`):null;if(e){let M=oe?`${o.dim}${X}${o.reset}`:" ".repeat(X.length),q=s.showReadTokens&&P>0?`${o.dim}(~${P}t)${o.reset}`:"",Te=s.showWorkTokens&&j>0?`${o.dim}(${ne} ${j.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${E.id}${o.reset}  ${M}  ${K}  ${o.bright}${V}${o.reset}`),k&&n.push(`    ${o.dim}${k}${o.reset}`),(q||Te)&&n.push(`    ${q} ${Te}`),n.push("")}else{w&&(n.push(""),w=!1),n.push(`**#${E.id}** ${ge||"\u2033"} ${K} **${V}**`),k&&(n.push(""),n.push(k),n.push(""));let M=[];s.showReadTokens&&M.push(`Read: ~${P}`),s.showWorkTokens&&M.push(`Work: ${Ee}`),M.length>0&&n.push(M.join(", ")),n.push(""),S=null}}else if(e){let k=oe?`${o.dim}${X}${o.reset}`:" ".repeat(X.length),M=s.showReadTokens&&P>0?`${o.dim}(~${P}t)${o.reset}`:"",q=s.showWorkTokens&&j>0?`${o.dim}(${ne} ${j.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${E.id}${o.reset}  ${k}  ${K}  ${V} ${M} ${q}`)}else{let k=s.showReadTokens?`~${P}`:"",M=s.showWorkTokens?Ee:"";n.push(`| #${E.id} | ${ge||"\u2033"} | ${K} | ${V} | ${k} | ${M} |`)}}w&&n.push("")}let v=m[0],me=l[0];if(s.showLastSummary&&v&&(v.investigated||v.learned||v.completed||v.next_steps)&&(!me||v.created_at_epoch>me.created_at_epoch)&&(n.push(...Z("Investigated",v.investigated,o.blue,e)),n.push(...Z("Learned",v.learned,o.yellow,e)),n.push(...Z("Completed",v.completed,o.green,e)),n.push(...Z("Next Steps",v.next_steps,o.magenta,e))),g&&(n.push(""),n.push("---"),n.push(""),e?(n.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),n.push(""),n.push(`${o.dim}A: ${g}${o.reset}`)):(n.push("**\u{1F4CB} Previously**"),n.push(""),n.push(`A: ${g}`)),n.push("")),ue&&O>0&&C>0){let _=Math.round(O/1e3);n.push(""),e?n.push(`${o.dim}\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${D.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):n.push(`\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${D.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),n.join(`
`).trimEnd()}0&&(module.exports={generateContext,getAllSessionSavings,getSessionSavings});
