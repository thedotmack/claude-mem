"use strict";var gt=Object.create;var k=Object.defineProperty;var Tt=Object.getOwnPropertyDescriptor;var ft=Object.getOwnPropertyNames;var St=Object.getPrototypeOf,bt=Object.prototype.hasOwnProperty;var ht=(s,e)=>{for(var t in e)k(s,t,{get:e[t],enumerable:!0})},ne=(s,e,t,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of ft(e))!bt.call(s,n)&&n!==t&&k(s,n,{get:()=>e[n],enumerable:!(r=Tt(e,n))||r.enumerable});return s};var N=(s,e,t)=>(t=s!=null?gt(St(s)):{},ne(e||!s||!s.__esModule?k(t,"default",{value:s,enumerable:!0}):t,s)),Ot=s=>ne(k({},"__esModule",{value:!0}),s);var wt={};ht(wt,{generateContext:()=>se});module.exports=Ot(wt);var mt=N(require("path"),1),_t=require("os"),Et=require("fs");var oe=N(require("better-sqlite3"),1),U=class{_db;constructor(e,t){this._db=new oe.default(e)}run(e){this._db.exec(e)}query(e){return this._db.prepare(e)}prepare(e){return this._db.prepare(e)}transaction(e){return this._db.transaction(e)}close(){this._db.close()}};var b=require("path"),ce=require("os"),le=require("fs");var me=require("url");var R=require("fs"),w=require("path"),de=require("os");var ie="bugfix,feature,refactor,discovery,decision,change",ae="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var y=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_PROVIDER:"claude",CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",CLAUDE_MEM_GEMINI_API_KEY:"",CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_MODEL:"xiaomi/mimo-v2-flash:free",CLAUDE_MEM_OPENAI_COMPAT_SITE_URL:"",CLAUDE_MEM_OPENAI_COMPAT_APP_NAME:"claude-mem",CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES:"20",CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS:"100000",CLAUDE_MEM_DATA_DIR:(0,w.join)((0,de.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:ie,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:ae,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,R.existsSync)(e)){let d=this.getAllDefaults();try{let u=(0,w.dirname)(e);(0,R.existsSync)(u)||(0,R.mkdirSync)(u,{recursive:!0}),(0,R.writeFileSync)(e,JSON.stringify(d,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(u){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,u)}return d}let t=(0,R.readFileSync)(e,"utf-8"),r=JSON.parse(t),n=r;if(r.env&&typeof r.env=="object"){n=r.env;try{(0,R.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(d){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,d)}}let o=!1,i={CLAUDE_MEM_OPENROUTER_API_KEY:"CLAUDE_MEM_OPENAI_COMPAT_API_KEY",CLAUDE_MEM_OPENROUTER_BASE_URL:"CLAUDE_MEM_OPENAI_COMPAT_BASE_URL",CLAUDE_MEM_OPENROUTER_MODEL:"CLAUDE_MEM_OPENAI_COMPAT_MODEL",CLAUDE_MEM_OPENROUTER_SITE_URL:"CLAUDE_MEM_OPENAI_COMPAT_SITE_URL",CLAUDE_MEM_OPENROUTER_APP_NAME:"CLAUDE_MEM_OPENAI_COMPAT_APP_NAME",CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES",CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS"};for(let[d,u]of Object.entries(i))n[d]!==void 0&&n[u]===void 0&&(n[u]=n[d],delete n[d],o=!0);if(n.CLAUDE_MEM_PROVIDER==="openrouter"&&(n.CLAUDE_MEM_PROVIDER="openai-compat",o=!0),o)try{(0,R.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated OpenRouter settings to OpenAI-compat:",e)}catch(d){console.warn("[SETTINGS] Failed to auto-migrate OpenRouter\u2192OpenAI-compat settings:",e,d)}let a={...this.DEFAULTS};for(let d of Object.keys(this.DEFAULTS))if(n[d]!==void 0){let u=n[d];a[d]=typeof u=="string"?u:typeof u=="object"?JSON.stringify(u):String(u)}return a}catch(t){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t),this.getAllDefaults()}}};var I=require("fs"),L=require("path"),ue=require("os"),W=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(W||{}),pe=(0,L.join)((0,ue.homedir)(),".claude-mem"),Y=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,L.join)(pe,"logs");(0,I.existsSync)(e)||(0,I.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,L.join)(e,`claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,L.join)(pe,"settings.json");if((0,I.existsSync)(e)){let t=(0,I.readFileSync)(e,"utf-8"),n=(JSON.parse(t).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=W[n]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,t){return`obs-${String(e)}-${String(t)}`}sessionId(e){return`session-${String(e)}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${String(e.stack)}`:e.message;if(Array.isArray(e))return`[${String(e.length)} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${String(t.length)} keys: ${t.slice(0,3).join(", ")}...}`}return typeof e=="object"?JSON.stringify(e):typeof e=="function"?`[Function: ${e.name||"anonymous"}]`:String(e)}formatTool(e,t){if(!t)return e;let r=t;if(typeof t=="string")try{r=JSON.parse(t)}catch{r=t}let n=i=>typeof i=="object"&&i!==null,o=i=>typeof i=="string"?i:typeof i=="object"?JSON.stringify(i):String(i);if(e==="Bash"&&n(r)&&r.command)return`${e}(${o(r.command)})`;if(n(r)&&r.file_path)return`${e}(${o(r.file_path)})`;if(n(r)&&r.notebook_path)return`${e}(${o(r.notebook_path)})`;if(e==="Glob"&&n(r)&&r.pattern)return`${e}(${o(r.pattern)})`;if(e==="Grep"&&n(r)&&r.pattern)return`${e}(${o(r.pattern)})`;if(n(r)&&r.url)return`${e}(${o(r.url)})`;if(n(r)&&r.query)return`${e}(${o(r.query)})`;if(e==="Task"&&n(r)){if(r.subagent_type)return`${e}(${o(r.subagent_type)})`;if(r.description)return`${e}(${o(r.description)})`}return e==="Skill"&&n(r)&&r.skill?`${e}(${o(r.skill)})`:e==="LSP"&&n(r)&&r.operation?`${e}(${o(r.operation)})`:e}formatTimestamp(e){let t=e.getFullYear(),r=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${String(t)}-${r}-${n} ${o}:${i}:${a}.${d}`}log(e,t,r,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=W[e].padEnd(5),d=t.padEnd(6),u="";n?.correlationId?u=`[${n.correlationId}] `:n?.sessionId&&(u=`[session-${String(n.sessionId)}] `);let l="";o!=null&&(o instanceof Error?l=this.getLevel()===0?`
${o.message}
${String(o.stack)}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?l=`
`+JSON.stringify(o,null,2):l=" "+this.formatData(o));let m="";if(n){let{sessionId:E,memorySessionId:T,correlationId:h,..._}=n;Object.keys(_).length>0&&(m=` {${Object.entries(_).map(([f,C])=>`${f}=${String(C)}`).join(", ")}}`)}let g=`[${i}] [${a}] [${d}] ${u}${r}${m}${l}`;if(this.logFilePath)try{(0,I.appendFileSync)(this.logFilePath,g+`
`,"utf8")}catch(E){process.stderr.write(`[LOGGER] Failed to write to log file: ${String(E)}
`)}else process.stderr.write(g+`
`)}debug(e,t,r,n){this.log(0,e,t,r,n)}info(e,t,r,n){this.log(1,e,t,r,n)}warn(e,t,r,n){this.log(2,e,t,r,n)}error(e,t,r,n){this.log(3,e,t,r,n)}dataIn(e,t,r,n){this.info(e,`\u2192 ${t}`,r,n)}dataOut(e,t,r,n){this.info(e,`\u2190 ${t}`,r,n)}success(e,t,r,n){this.info(e,`\u2713 ${t}`,r,n)}failure(e,t,r,n){this.error(e,`\u2717 ${t}`,r,n)}timing(e,t,r,n){this.info(e,`\u23F1 ${t}`,n,{duration:`${String(r)}ms`})}happyPathError(e,t,r,n,o=""){let u=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),l=u?`${String(u[1].split("/").pop())}:${u[2]}`:"unknown",m={...r,location:l};return this.warn(e,`[HAPPY-PATH] ${t}`,m,n),o}},c=new Y;var At={};function Ct(){return typeof __dirname<"u"?__dirname:(0,b.dirname)((0,me.fileURLToPath)(At.url))}var Rt=Ct(),A=y.get("CLAUDE_MEM_DATA_DIR"),V=process.env.CLAUDE_CONFIG_DIR||(0,b.join)((0,ce.homedir)(),".claude"),Wt=(0,b.join)(A,"archives"),Yt=(0,b.join)(A,"logs"),Vt=(0,b.join)(A,"trash"),qt=(0,b.join)(A,"backups"),Kt=(0,b.join)(A,"modes"),Jt=(0,b.join)(A,"settings.json"),_e=(0,b.join)(A,"claude-mem.db"),Qt=(0,b.join)(A,"vector-db"),zt=(0,b.join)(A,"observer-sessions"),Zt=(0,b.join)(V,"settings.json"),er=(0,b.join)(V,"commands"),tr=(0,b.join)(V,"CLAUDE.md");function Ee(s){(0,le.mkdirSync)(s,{recursive:!0})}function ge(){return(0,b.join)(Rt,"..")}function $(s){return!s.request.trim()&&!s.investigated.trim()&&!s.learned.trim()&&!s.completed.trim()&&!s.next_steps.trim()}var P=class{db;constructor(e=_e){e!==":memory:"&&Ee(A),this.db=new U(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn()}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(r=>r.version)):0)===0&&(c.info("DB","Initializing fresh database with migration004"),this.db.run(`
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
      `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),c.info("DB","Migration004 applied successfully"))}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),c.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(d=>d.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),c.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(d=>d.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),c.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(d=>d.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),c.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}c.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),c.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}c.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),c.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}c.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),c.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}c.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),c.debug("DB","Successfully created user_prompts table with FTS5 support")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),c.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),c.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}c.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),c.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;c.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,r=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(l=>l.name===o);return a.some(l=>l.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),c.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(c.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};r("sdk_sessions","claude_session_id","content_session_id")&&t++,r("sdk_sessions","sdk_session_id","memory_session_id")&&t++,r("pending_messages","claude_session_id","content_session_id")&&t++,r("observations","sdk_session_id","memory_session_id")&&t++,r("session_summaries","sdk_session_id","memory_session_id")&&t++,r("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?c.debug("DB",`Successfully renamed ${String(t)} session ID columns`):c.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),c.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}updateMemorySessionId(e,t){this.db.prepare(`
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
    `).all().map(r=>r.project)}getLatestUserPrompt(e){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o,type:i,concepts:a,files:d}=t,u=r==="date_asc"?"ASC":"DESC",l=n?`LIMIT ${String(n)}`:"",m=e.map(()=>"?").join(","),g=[...e],E=[];if(o&&(E.push("project = ?"),g.push(o)),i)if(Array.isArray(i)){let _=i.map(()=>"?").join(",");E.push(`type IN (${_})`),g.push(...i)}else E.push("type = ?"),g.push(i);if(a){let _=Array.isArray(a)?a:[a],S=_.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");g.push(..._),E.push(`(${S.join(" OR ")})`)}if(d){let _=Array.isArray(d)?d:[d],S=_.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");_.forEach(f=>{g.push(`%${f}%`,`%${f}%`)}),E.push(`(${S.join(" OR ")})`)}let T=E.length>0?`WHERE id IN (${m}) AND ${E.join(" AND ")}`:`WHERE id IN (${m})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${T}
      ORDER BY created_at_epoch ${u}
      ${l}
    `).all(...g)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let r=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).all(e),n=new Set,o=new Set;for(let i of r){if(i.files_read){let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(d=>n.add(d))}if(i.files_modified){let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(d=>o.add(d))}}return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e).count}createSDKSession(e,t,r){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, 'active')
    `).run(e,t,r,n.toISOString(),o),t&&this.db.prepare(`
        UPDATE sdk_sessions SET project = ?
        WHERE content_session_id = ? AND (project IS NULL OR project = '')
      `).run(t,e),r&&this.db.prepare(`
        UPDATE sdk_sessions SET user_prompt = ?
        WHERE content_session_id = ? AND (user_prompt IS NULL OR user_prompt = '')
      `).run(r,e),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,t,r){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,r,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,r,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),l=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),n||null,o,d,a);return{id:Number(l.lastInsertRowid),createdAtEpoch:a}}storeSummary(e,t,r,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString();if($(r))return c.warn("DB","Skipping empty summary insert",{memorySessionId:e}),{id:0,createdAtEpoch:a};let l=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,o,d,a);return{id:Number(l.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,r,n,o,i=0,a){let d=a??Date.now(),u=new Date(d).toISOString();return this.db.transaction(()=>{let m=[],g=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let T of r){let h=g.run(e,t,T.type,T.title,T.subtitle,JSON.stringify(T.facts),T.narrative,JSON.stringify(T.concepts),JSON.stringify(T.files_read),JSON.stringify(T.files_modified),o||null,i,u,d);m.push(Number(h.lastInsertRowid))}let E=null;if(n)if($(n))c.warn("DB","Skipping empty summary insert",{memorySessionId:e});else{let h=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,u,d);E=Number(h.lastInsertRowid)}return{observationIds:m,summaryId:E,createdAtEpoch:d}})()}storeObservationsAndMarkComplete(e,t,r,n,o,i,a,d=0,u){let l=u??Date.now(),m=new Date(l).toISOString();return this.db.transaction(()=>{let E=[],T=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let S of r){let f=T.run(e,t,S.type,S.title,S.subtitle,JSON.stringify(S.facts),S.narrative,JSON.stringify(S.concepts),JSON.stringify(S.files_read),JSON.stringify(S.files_modified),a||null,d,m,l);E.push(Number(f.lastInsertRowid))}let h;if(n)if($(n))c.warn("DB","Skipping empty summary insert",{memorySessionId:e});else{let f=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,a||null,d,m,l);h=Number(f.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(l,o),{observationIds:E,summaryId:h,createdAtEpoch:l}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o}=t,i=r==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${String(n)}`:"",d=e.map(()=>"?").join(","),u=[...e],l=o?`WHERE id IN (${d}) AND project = ?`:`WHERE id IN (${d})`;return o&&u.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${l}
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...u)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:o}=t,i=r==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${String(n)}`:"",d=e.map(()=>"?").join(","),u=[...e],l=o?"AND s.project = ?":"";return o&&u.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${d}) ${l}
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...u)}getTimelineAroundTimestamp(e,t=10,r=10,n){return this.getTimelineAroundObservation(null,e,t,r,n)}getTimelineAroundObservation(e,t,r=10,n=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],d,u;if(e!==null){let _=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,S=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let f=this.db.prepare(_).all(e,...a,r+1),C=this.db.prepare(S).all(e,...a,n+1);if(f.length===0&&C.length===0)return{observations:[],sessions:[],prompts:[]};d=f.length>0?f[f.length-1].created_at_epoch:t,u=C.length>0?C[C.length-1].created_at_epoch:t}catch(f){return c.error("DB","Error getting boundary observations",void 0,{error:f,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let _=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,S=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let f=this.db.prepare(_).all(t,...a,r),C=this.db.prepare(S).all(t,...a,n+1);if(f.length===0&&C.length===0)return{observations:[],sessions:[],prompts:[]};d=f.length>0?f[f.length-1].created_at_epoch:t,u=C.length>0?C[C.length-1].created_at_epoch:t}catch(f){return c.error("DB","Error getting boundary timestamps",void 0,{error:f,project:o}),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,m=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,g=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,E=this.db.prepare(l).all(d,u,...a),T=this.db.prepare(m).all(d,u,...a),h=this.db.prepare(g).all(d,u,...a);return{observations:E,sessions:T.map(_=>({id:_.id,memory_session_id:_.memory_session_id,project:_.project,request:_.request,completed:_.completed,next_steps:_.next_steps,created_at:_.created_at,created_at_epoch:_.created_at_epoch})),prompts:h.map(_=>({id:_.id,content_session_id:_.content_session_id,prompt_number:_.prompt_number,prompt_text:_.prompt_text,project:_.project,created_at:_.created_at,created_at_epoch:_.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
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
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var Te=N(require("path"),1);function fe(s){if(!s||s.trim()==="")return c.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:s}),"unknown-project";let e=Te.default.basename(s);if(e===""){if(process.platform==="win32"){let r=s.match(/^([A-Z]):\\/i);if(r){let o=`drive-${r[1].toUpperCase()}`;return c.info("PROJECT_NAME","Drive root detected",{cwd:s,projectName:o}),o}}return c.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:s}),"unknown-project"}return e}var Se=N(require("path"),1),be=require("os");var v=require("fs"),F=require("path");var O=class s{static instance=null;activeMode=null;modesDir;constructor(){let e=ge(),t=[(0,F.join)(e,"modes"),(0,F.join)(e,"..","plugin","modes")],r=t.find(n=>(0,v.existsSync)(n));this.modesDir=r||t[0]}static getInstance(){return s.instance||(s.instance=new s),s.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let r={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?r[n]=this.deepMerge(i,o):r[n]=o}return r}loadModeFile(e){let t=(0,F.join)(this.modesDir,`${e}.json`);if(!(0,v.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let r=(0,v.readFileSync)(t,"utf-8");return JSON.parse(r)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,c.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(u=>u.id),concepts:d.observation_concepts.map(u=>u.id)}),d}catch{if(c.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:r,overrideId:n}=t,o;try{o=this.loadMode(r)}catch{c.warn("SYSTEM",`Parent mode '${r}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),c.debug("SYSTEM",`Loaded override file: ${n} for parent ${r}`)}catch{return c.warn("SYSTEM",`Override file '${n}' not found, using parent mode '${r}' only`),this.activeMode=o,o}let a=this.deepMerge(o,i);return this.activeMode=a,c.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${r} + ${n})`,void 0,{parent:r,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(r=>r.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(r=>r.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(r=>r.id===e)?.label||e}};function q(){let s=Se.default.join((0,be.homedir)(),".claude-mem","settings.json"),e=y.loadFromFile(s),t=e.CLAUDE_MEM_MODE,r=t==="code"||t.startsWith("code--"),n,o;if(r)n=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(i=>i.trim()).filter(Boolean)),o=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(i=>i.trim()).filter(Boolean));else{let i=O.getInstance().getActiveMode();n=new Set(i.observation_types.map(a=>a.id)),o=new Set(i.observation_concepts.map(a=>a.id))}return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:n,observationConcepts:o,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var p={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},he=4,K=1;function J(s){let e=(s.title?.length||0)+(s.subtitle?.length||0)+(s.narrative?.length||0)+JSON.stringify(s.facts||[]).length;return Math.ceil(e/he)}function Q(s){let e=s.length,t=s.reduce((i,a)=>i+J(a),0),r=s.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=r-t,o=r>0?Math.round(n/r*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:r,savings:n,savingsPercent:o}}function It(s){return O.getInstance().getWorkEmoji(s)}function M(s,e){let t=J(s),r=s.discovery_tokens||0,n=It(s.type),o=r>0?`${n} ${r.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:r,discoveryDisplay:o,workEmoji:n}}function j(s){return s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent}var Oe=N(require("path"),1),Ce=require("os"),X=require("fs");function z(s,e,t){let r=Array.from(t.observationTypes),n=r.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(",");return s.db.prepare(`
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
  `).all(e,...r,...o,t.totalObservationCount)}function Z(s,e,t){return s.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(e,t.sessionCount+K)}function Re(s,e,t){let r=Array.from(t.observationTypes),n=r.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return s.db.prepare(`
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
  `).all(...e,...r,...o,t.totalObservationCount)}function Ae(s,e,t){let r=e.map(()=>"?").join(",");return s.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch, project
    FROM session_summaries
    WHERE project IN (${r})
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...e,t.sessionCount+K)}function Nt(s){return s.replace(/\//g,"-")}function yt(s){try{if(!(0,X.existsSync)(s))return{userMessage:"",assistantMessage:""};let e=(0,X.readFileSync)(s,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim()),r="";for(let n=t.length-1;n>=0;n--)try{let o=t[n];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let a="";for(let d of i.message.content)d.type==="text"&&(a+=d.text??"");if(a=a.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),a){r=a;break}}}catch(o){c.debug("PARSER","Skipping malformed transcript line",{lineIndex:n},o);continue}return{userMessage:"",assistantMessage:r}}catch(e){return c.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:s},e),{userMessage:"",assistantMessage:""}}}function ee(s,e,t,r){if(!e.showLastMessage||s.length===0)return{userMessage:"",assistantMessage:""};let n=s.find(d=>d.memory_session_id!==t);if(!n)return{userMessage:"",assistantMessage:""};let o=n.memory_session_id,i=Nt(r),a=Oe.default.join((0,Ce.homedir)(),".claude","projects",i,`${o}.jsonl`);return yt(a)}function Ie(s,e){let t=e[0]?.id;return s.map((r,n)=>{let o=n===0?null:e[n+1];return{...r,displayEpoch:o?o.created_at_epoch:r.created_at_epoch,displayTime:o?o.created_at:r.created_at,shouldShowLink:r.id!==t}})}function te(s,e){let t=[...s.map(r=>({type:"observation",data:r})),...e.map(r=>({type:"summary",data:r}))];return t.sort((r,n)=>{let o=r.type==="observation"?r.data.created_at_epoch:r.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function Ne(s,e){return new Set(s.slice(0,e).map(t=>t.id))}function ye(){let s=new Date,e=s.toLocaleDateString("en-CA"),t=s.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),r=s.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${String(r)}`}function Me(s){return[`# [${s}] recent context, ${ye()}`,""]}function Le(){return[`**Legend:** session-request | ${O.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ")}`,""]}function ve(){return["**Column Key**:","- **Read**: Tokens to read this observation (cost to learn it now)","- **Work**: Tokens spent on work that produced this record ( research, building, deciding)",""]}function De(){return["**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.","","When you need implementation details, rationale, or debugging context:","- Use MCP tools (search, get_observations) to fetch full observations on-demand","- Critical types ( bugfix, decision) often need detailed fetching","- Trust this index over re-reading code for past decisions and learnings",""]}function xe(s,e){let t=[];if(t.push("**Context Economics**:"),t.push(`- Loading: ${String(s.totalObservations)} observations (${s.totalReadTokens.toLocaleString()} tokens to read)`),t.push(`- Work investment: ${s.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions`),s.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let r="- Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?r+=`${s.savings.toLocaleString()} tokens (${String(s.savingsPercent)}% reduction from reuse)`:e.showSavingsAmount?r+=`${s.savings.toLocaleString()} tokens`:r+=`${String(s.savingsPercent)}% reduction from reuse`,t.push(r)}return t.push(""),t}function ke(s){return[`### ${s}`,""]}function Ue(s){return[`**${s}**`,"| ID | Time | T | Title | Read | Work |","|----|------|---|-------|------|------|"]}function we(s,e,t){let r=s.title||"Untitled",n=O.getInstance().getTypeIcon(s.type),{readTokens:o,discoveryDisplay:i}=M(s,t),a=t.showReadTokens?`~${String(o)}`:"",d=t.showWorkTokens?i:"";return`| #${String(s.id)} | ${e||'"'} | ${n} | ${r} | ${a} | ${d} |`}function $e(s,e,t,r){let n=[],o=s.title||"Untitled",i=O.getInstance().getTypeIcon(s.type),{readTokens:a,discoveryDisplay:d}=M(s,r);n.push(`**#${String(s.id)}** ${e||'"'} ${i} **${o}**`),t&&(n.push(""),n.push(t),n.push(""));let u=[];return r.showReadTokens&&u.push(`Read: ~${String(a)}`),r.showWorkTokens&&u.push(`Work: ${d}`),u.length>0&&n.push(u.join(", ")),n.push(""),n}function Pe(s,e){let t=`${s.request||"Session started"} (${e})`;return[`**#S${String(s.id)}** ${t}`,""]}function D(s,e){return e?[`**${s}**: ${e}`,""]:[]}function Fe(s){return s.assistantMessage?["","---","","**Previously**","",`A: ${s.assistantMessage}`,""]:[]}function je(s,e){let t=Math.round(s/1e3);return["",`Access ${String(t)}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use MCP search tools to access memories by ID.`]}function Xe(s){return`# [${s}] recent context, ${ye()}

No previous sessions found for this project yet.`}function Be(){let s=new Date,e=s.toLocaleDateString("en-CA"),t=s.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),r=s.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${String(r)}`}function He(s){return["",`${p.bright}${p.cyan}[${s}] recent context, ${Be()}${p.reset}`,`${p.gray}${"\u2500".repeat(60)}${p.reset}`,""]}function Ge(){let e=O.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${p.dim}Legend: session-request | ${e}${p.reset}`,""]}function We(){return[`${p.bright}Column Key${p.reset}`,`${p.dim}  Read: Tokens to read this observation (cost to learn it now)${p.reset}`,`${p.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${p.reset}`,""]}function Ye(){return[`${p.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${p.reset}`,"",`${p.dim}When you need implementation details, rationale, or debugging context:${p.reset}`,`${p.dim}  - Use MCP tools (search, get_observations) to fetch full observations on-demand${p.reset}`,`${p.dim}  - Critical types ( bugfix, decision) often need detailed fetching${p.reset}`,`${p.dim}  - Trust this index over re-reading code for past decisions and learnings${p.reset}`,""]}function Ve(s,e){let t=[];if(t.push(`${p.bright}${p.cyan}Context Economics${p.reset}`),t.push(`${p.dim}  Loading: ${String(s.totalObservations)} observations (${s.totalReadTokens.toLocaleString()} tokens to read)${p.reset}`),t.push(`${p.dim}  Work investment: ${s.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${p.reset}`),s.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let r="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?r+=`${s.savings.toLocaleString()} tokens (${String(s.savingsPercent)}% reduction from reuse)`:e.showSavingsAmount?r+=`${s.savings.toLocaleString()} tokens`:r+=`${String(s.savingsPercent)}% reduction from reuse`,t.push(`${p.green}${r}${p.reset}`)}return t.push(""),t}function qe(s){return[`${p.bright}${p.cyan}${s}${p.reset}`,""]}function Ke(s){return[`${p.dim}${s}${p.reset}`]}function Je(s,e,t,r){let n=s.title||"Untitled",o=O.getInstance().getTypeIcon(s.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=M(s,r),u=t?`${p.dim}${e}${p.reset}`:" ".repeat(e.length),l=r.showReadTokens&&i>0?`${p.dim}(~${String(i)}t)${p.reset}`:"",m=r.showWorkTokens&&a>0?`${p.dim}(${d} ${a.toLocaleString()}t)${p.reset}`:"";return`  ${p.dim}#${String(s.id)}${p.reset}  ${u}  ${o}  ${n} ${l} ${m}`}function Qe(s,e,t,r,n){let o=[],i=s.title||"Untitled",a=O.getInstance().getTypeIcon(s.type),{readTokens:d,discoveryTokens:u,workEmoji:l}=M(s,n),m=t?`${p.dim}${e}${p.reset}`:" ".repeat(e.length),g=n.showReadTokens&&d>0?`${p.dim}(~${String(d)}t)${p.reset}`:"",E=n.showWorkTokens&&u>0?`${p.dim}(${l} ${u.toLocaleString()}t)${p.reset}`:"";return o.push(`  ${p.dim}#${String(s.id)}${p.reset}  ${m}  ${a}  ${p.bright}${i}${p.reset}`),r&&o.push(`    ${p.dim}${r}${p.reset}`),(g||E)&&o.push(`    ${g} ${E}`),o.push(""),o}function ze(s,e){let t=`${s.request||"Session started"} (${e})`;return[`${p.yellow}#S${String(s.id)}${p.reset} ${t}`,""]}function x(s,e,t){return e?[`${t}${s}:${p.reset} ${e}`,""]:[]}function Ze(s){return s.assistantMessage?["","---","",`${p.bright}${p.magenta}Previously${p.reset}`,"",`${p.dim}A: ${s.assistantMessage}${p.reset}`,""]:[]}function et(s,e){let t=Math.round(s/1e3);return["",`${p.dim}Access ${String(t)}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use MCP search tools to access memories by ID.${p.reset}`]}function tt(s){return`
${p.bright}${p.cyan}[${s}] recent context, ${Be()}${p.reset}
${p.gray}${"\u2500".repeat(60)}${p.reset}

${p.dim}No previous sessions found for this project yet.${p.reset}
`}function rt(s,e,t,r){let n=[];return r?n.push(...He(s)):n.push(...Me(s)),r?n.push(...Ge()):n.push(...Le()),r?n.push(...We()):n.push(...ve()),r?n.push(...Ye()):n.push(...De()),j(t)&&(r?n.push(...Ve(e,t)):n.push(...xe(e,t))),n}var re=N(require("path"),1);function G(s){if(!s)return[];try{let e=JSON.parse(s);return Array.isArray(e)?e:[]}catch(e){return c.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:s.substring(0,50)},e),[]}}function nt(s){return new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ot(s){return new Date(s).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function it(s){return new Date(s).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function st(s,e){return re.default.isAbsolute(s)?re.default.relative(e,s):s}function at(s,e,t){let r=G(s);if(r.length>0)return st(r[0],e);if(t){let n=G(t);if(n.length>0)return st(n[0],e)}return"General"}function Mt(s){let e=new Map;for(let r of s){let n=r.type==="observation"?r.data.created_at:r.data.displayTime,o=it(n);e.has(o)||e.set(o,[]),e.get(o)?.push(r)}let t=Array.from(e.entries()).sort((r,n)=>{let o=new Date(r[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function Lt(s,e){return e.fullObservationField==="narrative"?s.narrative:s.facts?G(s.facts).join(`
`):null}function vt(s,e,t,r,n,o){let i=[];o?i.push(...qe(s)):i.push(...ke(s));let a=null,d="",u=!1;for(let l of e)if(l.type==="summary"){u&&(i.push(""),u=!1,a=null,d="");let m=l.data,g=nt(m.displayTime);o?i.push(...ze(m,g)):i.push(...Pe(m,g))}else{let m=l.data,g=at(m.files_modified,n,m.files_read),E=ot(m.created_at),T=E!==d,h=T?E:"";d=E;let _=t.has(m.id);if(g!==a&&(u&&i.push(""),o?i.push(...Ke(g)):i.push(...Ue(g)),a=g,u=!0),_){let S=Lt(m,r);o?i.push(...Qe(m,E,T,S,r)):(u&&(i.push(""),u=!1),i.push(...$e(m,h,S,r)),a=null)}else o?i.push(Je(m,E,T,r)):i.push(we(m,h,r))}return u&&i.push(""),i}function dt(s,e,t,r,n){let o=[],i=Mt(s);for(let[a,d]of i)o.push(...vt(a,d,e,t,r,n));return o}function pt(s,e,t){return!(!s.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function ut(s,e){let t=[];return e?(t.push(...x("Investigated",s.investigated,p.blue)),t.push(...x("Learned",s.learned,p.yellow)),t.push(...x("Completed",s.completed,p.green)),t.push(...x("Next Steps",s.next_steps,p.magenta))):(t.push(...D("Investigated",s.investigated)),t.push(...D("Learned",s.learned)),t.push(...D("Completed",s.completed)),t.push(...D("Next Steps",s.next_steps))),t}function ct(s,e){return e?Ze(s):Fe(s)}function lt(s,e,t){return!j(e)||s.totalDiscoveryTokens<=0||s.savings<=0?[]:t?et(s.totalDiscoveryTokens,s.totalReadTokens):je(s.totalDiscoveryTokens,s.totalReadTokens)}var Dt=mt.default.join((0,_t.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function xt(){try{return new P}catch(s){if(s instanceof Error&&"code"in s&&s.code==="ERR_DLOPEN_FAILED"){try{(0,Et.unlinkSync)(Dt)}catch(e){c.debug("SYSTEM","Marker file cleanup failed (may not exist)",{},e)}return c.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw s}}function kt(s,e){return e?tt(s):Xe(s)}function Ut(s,e,t,r,n,o,i){let a=[],d=Q(e);a.push(...rt(s,d,r,i));let u=t.slice(0,r.sessionCount),l=Ie(u,t),m=te(e,l),g=Ne(e,r.fullObservationCount);a.push(...dt(m,g,r,n,i));let E=t[0],T=e[0];pt(r,E,T)&&a.push(...ut(E,i));let h=ee(e,r,o,n);return a.push(...ct(h,i)),a.push(...lt(d,r,i)),a.join(`
`).trimEnd()}function se(s,e=!1){let t=q(),r=s?.cwd??process.cwd(),n=fe(r),o=s?.projects||[n],i=xt();if(!i)return"";try{let a=o.length>1?Re(i,o,t):z(i,n,t),d=o.length>1?Ae(i,o,t):Z(i,n,t);return a.length===0&&d.length===0?kt(n,e):Ut(n,a,d,t,r,s?.session_id,e)}finally{i.close()}}0&&(module.exports={generateContext});
