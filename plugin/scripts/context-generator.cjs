"use strict";var Pe=Object.create;var q=Object.defineProperty;var We=Object.getOwnPropertyDescriptor;var He=Object.getOwnPropertyNames;var Ge=Object.getPrototypeOf,Be=Object.prototype.hasOwnProperty;var Ye=(a,e)=>{for(var s in e)q(a,s,{get:e[s],enumerable:!0})},ge=(a,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of He(e))!Be.call(a,n)&&n!==s&&q(a,n,{get:()=>e[n],enumerable:!(t=We(e,n))||t.enumerable});return a};var ne=(a,e,s)=>(s=a!=null?Pe(Ge(a)):{},ge(e||!a||!a.__esModule?q(s,"default",{value:a,enumerable:!0}):s,a)),Ve=a=>ge(q({},"__esModule",{value:!0}),a);var ns={};Ye(ns,{generateContext:()=>rs});module.exports=Ve(ns);var Z=ne(require("path"),1),ee=require("os"),H=require("fs");var Ce=require("bun:sqlite");var f=require("path"),Re=require("os"),Oe=require("fs");var Ne=require("url");var W=require("fs"),be=require("path"),fe=require("os");var he="bugfix,feature,refactor,discovery,decision,change",Se="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var ie=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(ie||{}),oe=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let e=$.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=ie[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}catch{return e}}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),d=String(e.getMinutes()).padStart(2,"0"),c=String(e.getSeconds()).padStart(2,"0"),_=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${n} ${o}:${d}:${c}.${_}`}log(e,s,t,n,o){if(e<this.getLevel())return;let d=this.formatTimestamp(new Date),c=ie[e].padEnd(5),_=s.padEnd(6),u="";n?.correlationId?u=`[${n.correlationId}] `:n?.sessionId&&(u=`[session-${n.sessionId}] `);let l="";o!=null&&(this.getLevel()===0&&typeof o=="object"?l=`
`+JSON.stringify(o,null,2):l=" "+this.formatData(o));let E="";if(n){let{sessionId:T,sdkSessionId:I,correlationId:g,...r}=n;Object.keys(r).length>0&&(E=` {${Object.entries(r).map(([N,D])=>`${N}=${D}`).join(", ")}}`)}let R=`[${d}] [${c}] [${_}] ${u}${t}${E}${l}`;e===3?console.error(R):console.log(R)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}error(e,s,t,n){this.log(3,e,s,t,n)}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}timing(e,s,t,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${t}ms`})}happyPathError(e,s,t,n,o=""){let u=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),l=u?`${u[1].split("/").pop()}:${u[2]}`:"unknown",E={...t,location:l};return this.warn(e,`[HAPPY-PATH] ${s}`,E,n),o}},b=new oe;var $=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:(0,be.join)((0,fe.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:he,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:Se,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,W.existsSync)(e))return this.getAllDefaults();let s=(0,W.readFileSync)(e,"utf-8"),t=JSON.parse(s),n=t;if(t.env&&typeof t.env=="object"){n=t.env;try{(0,W.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),b.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(d){b.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},d)}}let o={...this.DEFAULTS};for(let d of Object.keys(this.DEFAULTS))n[d]!==void 0&&(o[d]=n[d]);return o}catch(s){return b.warn("SETTINGS","Failed to load settings, using defaults",{settingsPath:e},s),this.getAllDefaults()}}};var Je={};function Ke(){return typeof __dirname<"u"?__dirname:(0,f.dirname)((0,Ne.fileURLToPath)(Je.url))}var qe=Ke(),v=$.get("CLAUDE_MEM_DATA_DIR"),ae=process.env.CLAUDE_CONFIG_DIR||(0,f.join)((0,Re.homedir)(),".claude"),gs=(0,f.join)(v,"archives"),hs=(0,f.join)(v,"logs"),Ss=(0,f.join)(v,"trash"),bs=(0,f.join)(v,"backups"),fs=(0,f.join)(v,"modes"),Rs=(0,f.join)(v,"settings.json"),Ae=(0,f.join)(v,"claude-mem.db"),Os=(0,f.join)(v,"vector-db"),Ns=(0,f.join)(ae,"settings.json"),As=(0,f.join)(ae,"commands"),Is=(0,f.join)(ae,"CLAUDE.md");function Ie(a){(0,Oe.mkdirSync)(a,{recursive:!0})}function Le(){return(0,f.join)(qe,"..","..")}var J=class{db;constructor(){Ie(v),this.db=new Ce.Database(Ae),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable()}initializeSchema(){try{this.db.run(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.log("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.log("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(_=>_.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.log("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(_=>_.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(_=>_.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.log("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(claude_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),console.log("[SessionStore] pending_messages table created successfully")}catch(e){throw console.error("[SessionStore] Pending messages table migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o,type:d,concepts:c,files:_}=s,u=t==="date_asc"?"ASC":"DESC",l=n?`LIMIT ${n}`:"",E=e.map(()=>"?").join(","),R=[...e],T=[];if(o&&(T.push("project = ?"),R.push(o)),d)if(Array.isArray(d)){let r=d.map(()=>"?").join(",");T.push(`type IN (${r})`),R.push(...d)}else T.push("type = ?"),R.push(d);if(c){let r=Array.isArray(c)?c:[c],O=r.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");R.push(...r),T.push(`(${O.join(" OR ")})`)}if(_){let r=Array.isArray(_)?_:[_],O=r.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");r.forEach(N=>{R.push(`%${N}%`,`%${N}%`)}),T.push(`(${O.join(" OR ")})`)}let I=T.length>0?`WHERE id IN (${E}) AND ${T.join(" AND ")}`:`WHERE id IN (${E})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${I}
      ORDER BY created_at_epoch ${u}
      ${l}
    `).all(...R)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,o=new Set;for(let d of t){if(d.files_read){let c=JSON.parse(d.files_read);Array.isArray(c)&&c.forEach(_=>n.add(_))}if(d.files_modified){let c=JSON.parse(d.files_modified);Array.isArray(c)&&c.forEach(_=>o.add(_))}}return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).all(...e)}findActiveSDKSession(e){return this.db.prepare(`
      SELECT id, sdk_session_id, project, worker_port
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(e)||null}findAnySDKSession(e){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE claude_session_id = ?
      LIMIT 1
    `).get(e)||null}reactivateSession(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(s,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||1}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let n=new Date,o=n.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,n.toISOString(),o);return c.lastInsertRowid===0||c.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):c.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(b.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,t){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,o=0){let d=new Date,c=d.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,d.toISOString(),c),console.log(`[SessionStore] Auto-created session record for session_id: ${e}`));let E=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),n||null,o,d.toISOString(),c);return{id:Number(E.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,t,n,o=0){let d=new Date,c=d.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,d.toISOString(),c),console.log(`[SessionStore] Auto-created session record for session_id: ${e}`));let E=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,o,d.toISOString(),c);return{id:Number(E.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o}=s,d=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",_=e.map(()=>"?").join(","),u=[...e],l=o?`WHERE id IN (${_}) AND project = ?`:`WHERE id IN (${_})`;return o&&u.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${l}
      ORDER BY created_at_epoch ${d}
      ${c}
    `).all(...u)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n,project:o}=s,d=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",_=e.map(()=>"?").join(","),u=[...e],l=o?"AND s.project = ?":"";return o&&u.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${_}) ${l}
      ORDER BY up.created_at_epoch ${d}
      ${c}
    `).all(...u)}getTimelineAroundTimestamp(e,s=10,t=10,n){return this.getTimelineAroundObservation(null,e,s,t,n)}getTimelineAroundObservation(e,s,t=10,n=10,o){let d=o?"AND project = ?":"",c=o?[o]:[],_,u;if(e!==null){let T=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${d}
        ORDER BY id DESC
        LIMIT ?
      `,I=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${d}
        ORDER BY id ASC
        LIMIT ?
      `;try{let g=this.db.prepare(T).all(e,...c,t+1),r=this.db.prepare(I).all(e,...c,n+1);if(g.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};_=g.length>0?g[g.length-1].created_at_epoch:s,u=r.length>0?r[r.length-1].created_at_epoch:s}catch(g){return console.error("[SessionStore] Error getting boundary observations:",g.message,o?`(project: ${o})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}else{let T=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${d}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,I=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${d}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let g=this.db.prepare(T).all(s,...c,t),r=this.db.prepare(I).all(s,...c,n+1);if(g.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};_=g.length>0?g[g.length-1].created_at_epoch:s,u=r.length>0?r[r.length-1].created_at_epoch:s}catch(g){return console.error("[SessionStore] Error getting boundary timestamps:",g.message,o?`(project: ${o})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,E=`
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
    `;try{let T=this.db.prepare(l).all(_,u,...c),I=this.db.prepare(E).all(_,u,...c),g=this.db.prepare(R).all(_,u,...c);return{observations:T,sessions:I.map(r=>({id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,request:r.request,completed:r.completed,next_steps:r.next_steps,created_at:r.created_at,created_at_epoch:r.created_at_epoch})),prompts:g.map(r=>({id:r.id,claude_session_id:r.claude_session_id,prompt_number:r.prompt_number,prompt_text:r.prompt_text,project:r.project,created_at:r.created_at,created_at_epoch:r.created_at_epoch}))}}catch(T){return console.error("[SessionStore] Error querying timeline records:",T.message,o?`(project: ${o})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
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
    `).run(e.claude_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var de=ne(require("path"),1);function ce(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function ve(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ye(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function De(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Qe(a,e){return de.default.isAbsolute(a)?de.default.relative(e,a):a}function Me(a,e){let s=ce(a);return s.length>0?Qe(s[0],e):"General"}var ke=ne(require("path"),1);function $e(a){if(!a||a.trim()==="")return b.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:a}),"unknown-project";let e=ke.default.basename(a);if(e===""){if(process.platform==="win32"){let t=a.match(/^([A-Z]):\\/i);if(t){let o=`drive-${t[1].toUpperCase()}`;return b.info("PROJECT_NAME","Drive root detected",{cwd:a,projectName:o}),o}}return b.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:a}),"unknown-project"}return e}var Q=require("fs"),pe=require("path");var U=class a{static instance=null;activeMode=null;modesDir;constructor(){this.modesDir=(0,pe.join)(Le(),"modes")}static getInstance(){return a.instance||(a.instance=new a),a.instance}loadMode(e){let s=(0,pe.join)(this.modesDir,`${e}.json`);if(!(0,Q.existsSync)(s)){if(b.warn("SYSTEM",`Mode file not found: ${s}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}try{let t=(0,Q.readFileSync)(s,"utf-8"),n=JSON.parse(t);return this.activeMode=n,b.debug("SYSTEM",`Loaded mode: ${n.name} (${e})`,void 0,{types:n.observation_types.map(o=>o.id),concepts:n.observation_concepts.map(o=>o.id)}),n}catch(t){if(b.error("SYSTEM",`Failed to load mode: ${s}`,void 0,t),e==="code")throw t;return this.loadMode("code")}}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(t=>t.id===e)?.label||e}};var ze=Z.default.join((0,ee.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ze(){let a=Z.default.join((0,ee.homedir)(),".claude-mem","settings.json"),e=$.loadFromFile(a);try{return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(s=>s.trim()).filter(Boolean)),observationConcepts:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(s=>s.trim()).filter(Boolean)),fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(s){return b.warn("WORKER","Failed to load context settings, using defaults",{},s),{totalObservationCount:50,fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(U.getInstance().getObservationTypes().map(t=>t.id)),observationConcepts:new Set(U.getInstance().getObservationConcepts().map(t=>t.id)),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1}}}var Ue=4,es=1,i={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function z(a,e,s,t){return e?t?[`${s}${a}:${i.reset} ${e}`,""]:[`**${a}**: ${e}`,""]:[]}function ss(a){return a.replace(/\//g,"-")}function ts(a){try{if(!(0,H.existsSync)(a))return{userMessage:"",assistantMessage:""};let e=(0,H.readFileSync)(a,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),t="";for(let n=s.length-1;n>=0;n--)try{let o=s[n];if(!o.includes('"type":"assistant"'))continue;let d=JSON.parse(o);if(d.type==="assistant"&&d.message?.content&&Array.isArray(d.message.content)){let c="";for(let _ of d.message.content)_.type==="text"&&(c+=_.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){t=c;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return b.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:a},e),{userMessage:"",assistantMessage:""}}}async function rs(a,e=!1){let s=Ze(),t=a?.cwd??process.cwd(),n=$e(t),o=null;try{o=new J}catch(O){if(O.code==="ERR_DLOPEN_FAILED"){try{(0,H.unlinkSync)(ze)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw O}let d=Array.from(s.observationTypes),c=d.map(()=>"?").join(","),_=Array.from(s.observationConcepts),u=_.map(()=>"?").join(","),l=o.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${c})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${u})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...d,..._,s.totalObservationCount),E=o.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+es),R="",T="";if(s.showLastMessage&&l.length>0)try{let O=a?.session_id,N=l.find(D=>D.sdk_session_id!==O);if(N){let D=N.sdk_session_id,x=ss(t),A=Z.default.join((0,ee.homedir)(),".claude","projects",x,`${D}.jsonl`),y=ts(A);R=y.userMessage,T=y.assistantMessage}}catch{}if(l.length===0&&E.length===0)return o?.close(),e?`
${i.bright}${i.cyan}[${n}] recent context${i.reset}
${i.gray}${"\u2500".repeat(60)}${i.reset}

${i.dim}No previous sessions found for this project yet.${i.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let I=E.slice(0,s.sessionCount),g=l,r=[];if(e?(r.push(""),r.push(`${i.bright}${i.cyan}[${n}] recent context${i.reset}`),r.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),r.push("")):(r.push(`# [${n}] recent context`),r.push("")),g.length>0){let N=U.getInstance().getActiveMode().observation_types.map(p=>`${p.emoji} ${p.id}`).join(" | ");e?r.push(`${i.dim}Legend: \u{1F3AF} session-request | ${N}${i.reset}`):r.push(`**Legend:** \u{1F3AF} session-request | ${N}`),r.push(""),e?(r.push(`${i.bright}\u{1F4A1} Column Key${i.reset}`),r.push(`${i.dim}  Read: Tokens to read this observation (cost to learn it now)${i.reset}`),r.push(`${i.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${i.reset}`)):(r.push("\u{1F4A1} **Column Key**:"),r.push("- **Read**: Tokens to read this observation (cost to learn it now)"),r.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),r.push(""),e?(r.push(`${i.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${i.reset}`),r.push(""),r.push(`${i.dim}When you need implementation details, rationale, or debugging context:${i.reset}`),r.push(`${i.dim}  - Use the mem-search skill to fetch full observations on-demand${i.reset}`),r.push(`${i.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${i.reset}`),r.push(`${i.dim}  - Trust this index over re-reading code for past decisions and learnings${i.reset}`)):(r.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),r.push(""),r.push("When you need implementation details, rationale, or debugging context:"),r.push("- Use the mem-search skill to fetch full observations on-demand"),r.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),r.push("- Trust this index over re-reading code for past decisions and learnings")),r.push("");let D=l.length,x=l.reduce((p,h)=>{let S=(h.title?.length||0)+(h.subtitle?.length||0)+(h.narrative?.length||0)+JSON.stringify(h.facts||[]).length;return p+Math.ceil(S/Ue)},0),A=l.reduce((p,h)=>p+(h.discovery_tokens||0),0),y=A-x,G=A>0?Math.round(y/A*100):0,_e=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(_e)if(e){if(r.push(`${i.bright}${i.cyan}\u{1F4CA} Context Economics${i.reset}`),r.push(`${i.dim}  Loading: ${D} observations (${x.toLocaleString()} tokens to read)${i.reset}`),r.push(`${i.dim}  Work investment: ${A.toLocaleString()} tokens spent on research, building, and decisions${i.reset}`),A>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${y.toLocaleString()} tokens (${G}% reduction from reuse)`:s.showSavingsAmount?p+=`${y.toLocaleString()} tokens`:p+=`${G}% reduction from reuse`,r.push(`${i.green}${p}${i.reset}`)}r.push("")}else{if(r.push("\u{1F4CA} **Context Economics**:"),r.push(`- Loading: ${D} observations (${x.toLocaleString()} tokens to read)`),r.push(`- Work investment: ${A.toLocaleString()} tokens spent on research, building, and decisions`),A>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${y.toLocaleString()} tokens (${G}% reduction from reuse)`:s.showSavingsAmount?p+=`${y.toLocaleString()} tokens`:p+=`${G}% reduction from reuse`,r.push(p)}r.push("")}let xe=E[0]?.id,we=I.map((p,h)=>{let S=h===0?null:E[h+1];return{...p,displayEpoch:S?S.created_at_epoch:p.created_at_epoch,displayTime:S?S.created_at:p.created_at,shouldShowLink:p.id!==xe}}),Fe=new Set(l.slice(0,s.fullObservationCount).map(p=>p.id)),ue=[...g.map(p=>({type:"observation",data:p})),...we.map(p=>({type:"summary",data:p}))];ue.sort((p,h)=>{let S=p.type==="observation"?p.data.created_at_epoch:p.data.displayEpoch,M=h.type==="observation"?h.data.created_at_epoch:h.data.displayEpoch;return S-M});let B=new Map;for(let p of ue){let h=p.type==="observation"?p.data.created_at:p.data.displayTime,S=De(h);B.has(S)||B.set(S,[]),B.get(S).push(p)}let Xe=Array.from(B.entries()).sort((p,h)=>{let S=new Date(p[0]).getTime(),M=new Date(h[0]).getTime();return S-M});for(let[p,h]of Xe){e?(r.push(`${i.bright}${i.cyan}${p}${i.reset}`),r.push("")):(r.push(`### ${p}`),r.push(""));let S=null,M="",w=!1;for(let se of h)if(se.type==="summary"){w&&(r.push(""),w=!1,S=null,M="");let m=se.data,F=`${m.request||"Session started"} (${ve(m.displayTime)})`;e?r.push(`\u{1F3AF} ${i.yellow}#S${m.id}${i.reset} ${F}`):r.push(`**\u{1F3AF} #S${m.id}** ${F}`),r.push("")}else{let m=se.data,F=Me(m.files_modified,t);F!==S&&(w&&r.push(""),e?r.push(`${i.dim}${F}${i.reset}`):r.push(`**${F}**`),e||(r.push("| ID | Time | T | Title | Read | Work |"),r.push("|----|------|---|-------|------|------|")),S=F,w=!0,M="");let X=ye(m.created_at),Y=m.title||"Untitled",V=U.getInstance().getTypeIcon(m.type),je=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length,j=Math.ceil(je/Ue),P=m.discovery_tokens||0,te=U.getInstance().getWorkEmoji(m.type),me=P>0?`${te} ${P.toLocaleString()}`:"-",re=X!==M,Ee=re?X:"";if(M=X,Fe.has(m.id)){let k=s.fullObservationField==="narrative"?m.narrative:m.facts?ce(m.facts).join(`
`):null;if(e){let C=re?`${i.dim}${X}${i.reset}`:" ".repeat(X.length),K=s.showReadTokens&&j>0?`${i.dim}(~${j}t)${i.reset}`:"",Te=s.showWorkTokens&&P>0?`${i.dim}(${te} ${P.toLocaleString()}t)${i.reset}`:"";r.push(`  ${i.dim}#${m.id}${i.reset}  ${C}  ${V}  ${i.bright}${Y}${i.reset}`),k&&r.push(`    ${i.dim}${k}${i.reset}`),(K||Te)&&r.push(`    ${K} ${Te}`),r.push("")}else{w&&(r.push(""),w=!1),r.push(`**#${m.id}** ${Ee||"\u2033"} ${V} **${Y}**`),k&&(r.push(""),r.push(k),r.push(""));let C=[];s.showReadTokens&&C.push(`Read: ~${j}`),s.showWorkTokens&&C.push(`Work: ${me}`),C.length>0&&r.push(C.join(", ")),r.push(""),S=null}}else if(e){let k=re?`${i.dim}${X}${i.reset}`:" ".repeat(X.length),C=s.showReadTokens&&j>0?`${i.dim}(~${j}t)${i.reset}`:"",K=s.showWorkTokens&&P>0?`${i.dim}(${te} ${P.toLocaleString()}t)${i.reset}`:"";r.push(`  ${i.dim}#${m.id}${i.reset}  ${k}  ${V}  ${Y} ${C} ${K}`)}else{let k=s.showReadTokens?`~${j}`:"",C=s.showWorkTokens?me:"";r.push(`| #${m.id} | ${Ee||"\u2033"} | ${V} | ${Y} | ${k} | ${C} |`)}}w&&r.push("")}let L=E[0],le=l[0];if(s.showLastSummary&&L&&(L.investigated||L.learned||L.completed||L.next_steps)&&(!le||L.created_at_epoch>le.created_at_epoch)&&(r.push(...z("Investigated",L.investigated,i.blue,e)),r.push(...z("Learned",L.learned,i.yellow,e)),r.push(...z("Completed",L.completed,i.green,e)),r.push(...z("Next Steps",L.next_steps,i.magenta,e))),T&&(r.push(""),r.push("---"),r.push(""),e?(r.push(`${i.bright}${i.magenta}\u{1F4CB} Previously${i.reset}`),r.push(""),r.push(`${i.dim}A: ${T}${i.reset}`)):(r.push("**\u{1F4CB} Previously**"),r.push(""),r.push(`A: ${T}`)),r.push("")),_e&&A>0&&y>0){let p=Math.round(A/1e3);r.push(""),e?r.push(`${i.dim}\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${x.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${i.reset}`):r.push(`\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${x.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return o?.close(),r.join(`
`).trimEnd()}0&&(module.exports={generateContext});
