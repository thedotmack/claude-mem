"use strict";var Rt=Object.create;var w=Object.defineProperty;var Mt=Object.getOwnPropertyDescriptor;var Nt=Object.getOwnPropertyNames;var Lt=Object.getPrototypeOf,yt=Object.prototype.hasOwnProperty;var vt=(r,e)=>{for(var t in e)w(r,t,{get:e[t],enumerable:!0})},de=(r,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Nt(e))!yt.call(r,n)&&n!==t&&w(r,n,{get:()=>e[n],enumerable:!(s=Mt(e,n))||s.enumerable});return r};var M=(r,e,t)=>(t=r!=null?Rt(Lt(r)):{},de(e||!r||!r.__esModule?w(t,"default",{value:r,enumerable:!0}):t,r)),Dt=r=>de(w({},"__esModule",{value:!0}),r);var Yt={};vt(Yt,{generateContext:()=>ae,generateContextWithMeta:()=>Y});module.exports=Dt(Yt);var Ot=M(require("path"),1),It=require("fs");var J=M(require("path"),1),me=require("os");var Ee=require("child_process"),ge=require("util");var R=require("fs"),y=require("path"),pe=require("os"),q=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(q||{}),ce=(0,y.join)((0,pe.homedir)(),".magic-claude-mem"),K=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,y.join)(ce,"logs");(0,R.existsSync)(e)||(0,R.mkdirSync)(e,{recursive:!0});let t=new Date().toISOString().split("T")[0];this.logFilePath=(0,y.join)(e,`magic-claude-mem-${t}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,y.join)(ce,"settings.json");if((0,R.existsSync)(e)){let t=(0,R.readFileSync)(e,"utf-8"),n=(JSON.parse(t).MAGIC_CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=q[n]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,t){return`obs-${String(e)}-${String(t)}`}sessionId(e){return`session-${String(e)}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${String(e.stack)}`:e.message;if(Array.isArray(e))return`[${String(e.length)} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${String(t.length)} keys: ${t.slice(0,3).join(", ")}...}`}return typeof e=="object"?JSON.stringify(e):typeof e=="function"?`[Function: ${e.name||"anonymous"}]`:String(e)}formatTool(e,t){if(!t)return e;let s=t;if(typeof t=="string")try{s=JSON.parse(t)}catch{s=t}let n=i=>typeof i=="object"&&i!==null,o=i=>typeof i=="string"?i:typeof i=="object"?JSON.stringify(i):String(i);if(e==="Bash"&&n(s)&&s.command)return`${e}(${o(s.command)})`;if(n(s)&&s.file_path)return`${e}(${o(s.file_path)})`;if(n(s)&&s.notebook_path)return`${e}(${o(s.notebook_path)})`;if(e==="Glob"&&n(s)&&s.pattern)return`${e}(${o(s.pattern)})`;if(e==="Grep"&&n(s)&&s.pattern)return`${e}(${o(s.pattern)})`;if(n(s)&&s.url)return`${e}(${o(s.url)})`;if(n(s)&&s.query)return`${e}(${o(s.query)})`;if(e==="Task"&&n(s)){if(s.subagent_type)return`${e}(${o(s.subagent_type)})`;if(s.description)return`${e}(${o(s.description)})`}return e==="Skill"&&n(s)&&s.skill?`${e}(${o(s.skill)})`:e==="LSP"&&n(s)&&s.operation?`${e}(${o(s.operation)})`:e}formatTimestamp(e){let t=e.getFullYear(),s=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),o=String(e.getHours()).padStart(2,"0"),i=String(e.getMinutes()).padStart(2,"0"),a=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${String(t)}-${s}-${n} ${o}:${i}:${a}.${d}`}log(e,t,s,n,o){if(e<this.getLevel())return;this.ensureLogFileInitialized();let i=this.formatTimestamp(new Date),a=q[e].padEnd(5),d=t.padEnd(6),c="";n?.correlationId?c=`[${n.correlationId}] `:n?.sessionId&&(c=`[session-${String(n.sessionId)}] `);let u="";o!=null&&(o instanceof Error?u=this.getLevel()===0?`
${o.message}
${String(o.stack)}`:` ${o.message}`:this.getLevel()===0&&typeof o=="object"?u=`
`+JSON.stringify(o,null,2):u=" "+this.formatData(o));let _="";if(n){let{sessionId:E,memorySessionId:T,correlationId:b,...m}=n;Object.keys(m).length>0&&(_=` {${Object.entries(m).map(([f,A])=>`${f}=${String(A)}`).join(", ")}}`)}let g=`[${i}] [${a}] [${d}] ${c}${s}${_}${u}`;if(this.logFilePath)try{(0,R.appendFileSync)(this.logFilePath,g+`
`,"utf8")}catch(E){process.stderr.write(`[LOGGER] Failed to write to log file: ${String(E)}
`)}else process.stderr.write(g+`
`)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}error(e,t,s,n){this.log(3,e,t,s,n)}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}timing(e,t,s,n){this.info(e,`\u23F1 ${t}`,n,{duration:`${String(s)}ms`})}happyPathError(e,t,s,n,o=""){let c=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),u=c?`${String(c[1].split("/").pop())}:${c[2]}`:"unknown",_={...s,location:u};return this.warn(e,`[HAPPY-PATH] ${t}`,_,n),o}},l=new K;var O=require("fs"),U=require("path"),_e=require("os");var ue="bugfix,feature,refactor,discovery,decision,change",le="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var N=class{static DEFAULTS={MAGIC_CLAUDE_MEM_MODEL:"claude-haiku-4-5",MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",MAGIC_CLAUDE_MEM_WORKER_PORT:"37777",MAGIC_CLAUDE_MEM_WORKER_HOST:"127.0.0.1",MAGIC_CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",MAGIC_CLAUDE_MEM_PROVIDER:"claude",MAGIC_CLAUDE_MEM_CLAUDE_AUTH_METHOD:"cli",MAGIC_CLAUDE_MEM_GEMINI_API_KEY:"",MAGIC_CLAUDE_MEM_GEMINI_MODEL:"gemini-2.5-flash-lite",MAGIC_CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:"true",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY:"",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_BASE_URL:"",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL:"xiaomi/mimo-v2-flash:free",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL:"",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME:"magic-claude-mem",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES:"20",MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS:"100000",MAGIC_CLAUDE_MEM_DATA_DIR:(0,U.join)((0,_e.homedir)(),".magic-claude-mem"),MAGIC_CLAUDE_MEM_LOG_LEVEL:"INFO",MAGIC_CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",MAGIC_CLAUDE_MEM_MODE:"code",MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:ue,MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:le,MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",MAGIC_CLAUDE_MEM_EFFORT:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let t=this.get(e);return parseInt(t,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,O.existsSync)(e)){let c=this.getAllDefaults();try{let u=(0,U.dirname)(e);(0,O.existsSync)(u)||(0,O.mkdirSync)(u,{recursive:!0}),(0,O.writeFileSync)(e,JSON.stringify(c,null,2),"utf-8"),console.log("[SETTINGS] Created settings file with defaults:",e)}catch(u){console.warn("[SETTINGS] Failed to create settings file, using in-memory defaults:",e,u)}return c}let t=(0,O.readFileSync)(e,"utf-8"),s=JSON.parse(t),n=s;if(s.env&&typeof s.env=="object"){n=s.env;try{(0,O.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated settings file from nested to flat schema:",e)}catch(c){console.warn("[SETTINGS] Failed to auto-migrate settings file:",e,c)}}let o=!1,i={MAGIC_CLAUDE_MEM_OPENROUTER_API_KEY:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY",MAGIC_CLAUDE_MEM_OPENROUTER_BASE_URL:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_BASE_URL",MAGIC_CLAUDE_MEM_OPENROUTER_MODEL:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL",MAGIC_CLAUDE_MEM_OPENROUTER_SITE_URL:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL",MAGIC_CLAUDE_MEM_OPENROUTER_APP_NAME:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME",MAGIC_CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MAX_CONTEXT_MESSAGES",MAGIC_CLAUDE_MEM_OPENROUTER_MAX_TOKENS:"MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MAX_TOKENS"};for(let[c,u]of Object.entries(i))n[c]!==void 0&&n[u]===void 0&&(n[u]=n[c],delete n[c],o=!0);if(n.MAGIC_CLAUDE_MEM_PROVIDER==="openrouter"&&(n.MAGIC_CLAUDE_MEM_PROVIDER="openai-compat",o=!0),o)try{(0,O.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated OpenRouter settings to OpenAI-compat:",e)}catch(c){console.warn("[SETTINGS] Failed to auto-migrate OpenRouter\u2192OpenAI-compat settings:",e,c)}let a=!1;for(let c of Object.keys(n))if(c.startsWith("CLAUDE_MEM_")&&!c.startsWith("MAGIC_CLAUDE_MEM_")){let u=`MAGIC_${c}`;n[u]===void 0&&(n[u]=n[c]),delete n[c],a=!0}if(a)try{(0,O.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated CLAUDE_MEM_* keys to MAGIC_CLAUDE_MEM_*:",e)}catch(c){console.warn("[SETTINGS] Failed to auto-migrate CLAUDE_MEM_* settings:",e,c)}if(n.MAGIC_CLAUDE_MEM_MODEL==="claude-sonnet-4-5"){n.MAGIC_CLAUDE_MEM_MODEL="claude-haiku-4-5";try{(0,O.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),console.log("[SETTINGS] Migrated default model from claude-sonnet-4-5 to claude-haiku-4-5:",e)}catch(c){console.warn("[SETTINGS] Failed to auto-migrate default model:",e,c)}}let d={...this.DEFAULTS};for(let c of Object.keys(this.DEFAULTS))if(n[c]!==void 0){let u=n[c];d[c]=typeof u=="string"?u:typeof u=="object"?JSON.stringify(u):String(u)}return d}catch(t){return console.warn("[SETTINGS] Failed to load settings, using defaults:",e,t),this.getAllDefaults()}}};var ts=(0,ge.promisify)(Ee.execFile);function xt(){return typeof __dirname<"u"?J.default.resolve(__dirname,".."):J.default.join((0,me.homedir)(),".claude","plugins","marketplaces","magic-claude-mem")}var Te=xt();var Se=M(require("better-sqlite3"),1),$=class{_db;constructor(e,t){this._db=new Se.default(e)}run(e){this._db.exec(e)}query(e){return this._db.prepare(e)}prepare(e){return this._db.prepare(e)}transaction(e){return this._db.transaction(e)}close(){this._db.close()}};var C=require("path"),fe=require("os"),Ce=require("fs");var be=require("url");var Ut={};function kt(){return typeof __dirname<"u"?__dirname:(0,C.dirname)((0,be.fileURLToPath)(Ut.url))}var wt=kt(),I=N.get("MAGIC_CLAUDE_MEM_DATA_DIR"),z=process.env.CLAUDE_CONFIG_DIR||(0,C.join)((0,fe.homedir)(),".claude"),is=(0,C.join)(I,"archives"),as=(0,C.join)(I,"logs"),ds=(0,C.join)(I,"trash"),cs=(0,C.join)(I,"backups"),ps=(0,C.join)(I,"modes"),us=(0,C.join)(I,"settings.json"),he=(0,C.join)(I,"magic-claude-mem.db"),ls=(0,C.join)(I,"vector-db"),_s=(0,C.join)(I,"observer-sessions"),ms=(0,C.join)(z,"settings.json"),Es=(0,C.join)(z,"commands"),gs=(0,C.join)(z,"CLAUDE.md");function Ae(r){(0,Ce.mkdirSync)(r,{recursive:!0})}function Oe(){return(0,C.join)(wt,"..")}function Ie(r){return r.prepare(`
    SELECT id, content_session_id, project, user_prompt, started_at_epoch
    FROM sdk_sessions
    WHERE status = 'active'
    ORDER BY started_at_epoch DESC
  `).all()}function Re(r,e){let t=new Date;return r.prepare(`
    UPDATE sdk_sessions
    SET
      status = 'completed',
      completed_at = ?,
      completed_at_epoch = ?
    WHERE id = ? AND status = 'active'
  `).run(t.toISOString(),t.getTime(),e).changes>0}function Me(r,e){let t=new Date;return r.prepare(`
    UPDATE sdk_sessions
    SET
      status = 'completed',
      completed_at = ?,
      completed_at_epoch = ?
    WHERE status = 'active' AND started_at_epoch < ?
  `).run(t.toISOString(),t.getTime(),e).changes}function P(r){return!r.request.trim()&&!r.investigated.trim()&&!r.learned.trim()&&!r.completed.trim()&&!r.next_steps.trim()}var Q=M(require("path"),1);function G(r){if(!r)return[];try{let e=JSON.parse(r);return Array.isArray(e)?e:[]}catch(e){return l.debug("PARSER","Failed to parse JSON array, using empty fallback",{preview:r.substring(0,50)},e),[]}}function Le(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ye(r){return new Date(r).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ve(r){return new Date(r).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ne(r,e){return Q.default.isAbsolute(r)?Q.default.relative(e,r):r}function De(r,e,t){let s=G(r);if(s.length>0)return Ne(s[0],e);if(t){let n=G(t);if(n.length>0)return Ne(n[0],e)}return"General"}function v(r){return r?Math.ceil(r.length/4):0}function F(r){return v(r.narrative??null)+v(r.title??null)+v(r.facts??null)+v(r.concepts??null)+v(r.text??null)}var j=class{db;constructor(e=he){e!==":memory:"&&Ae(I),this.db=new $(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.addCompositeIndexes(),this.ensureReadTokensColumn(),this.createContextInjectionsTable(),this.ensureSubprocessPidColumn(),this.recreateFTSTablesWithUnicode61()}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(s=>s.version)):0)===0&&(l.info("DB","Initializing fresh database with migration004"),this.db.run(`
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
      `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),l.info("DB","Migration004 applied successfully"))}ensureWorkerPortColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),l.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(d=>d.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),l.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(d=>d.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),l.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(d=>d.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),l.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}l.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),l.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}l.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),l.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}l.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),l.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}l.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
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
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),l.debug("DB","Successfully created user_prompts table with FTS5 support")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),l.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}l.debug("DB","Creating pending_messages table"),this.db.run(`
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
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),l.debug("DB","pending_messages table created successfully")}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;l.debug("DB","Checking session ID columns for semantic clarity rename");let t=0,s=(n,o,i)=>{let a=this.db.query(`PRAGMA table_info(${n})`).all(),d=a.some(u=>u.name===o);return a.some(u=>u.name===i)?!1:d?(this.db.run(`ALTER TABLE ${n} RENAME COLUMN ${o} TO ${i}`),l.debug("DB",`Renamed ${n}.${o} to ${i}`),!0):(l.warn("DB",`Column ${o} not found in ${n}, skipping rename`),!1)};s("sdk_sessions","claude_session_id","content_session_id")&&t++,s("sdk_sessions","sdk_session_id","memory_session_id")&&t++,s("pending_messages","claude_session_id","content_session_id")&&t++,s("observations","sdk_session_id","memory_session_id")&&t++,s("session_summaries","sdk_session_id","memory_session_id")&&t++,s("user_prompts","claude_session_id","content_session_id")&&t++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),t>0?l.debug("DB",`Successfully renamed ${String(t)} session ID columns`):l.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(n=>n.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),l.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}addCompositeIndexes(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)||(this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_session_epoch ON observations(memory_session_id, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_session_project ON observations(memory_session_id, project)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_session_summaries_session_epoch ON session_summaries(memory_session_id, created_at_epoch DESC)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_session_summaries_session_project ON session_summaries(memory_session_id, project)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),l.debug("DB","Added composite indexes for observations and session_summaries"))}ensureReadTokensColumn(){this.db.query("PRAGMA table_info(observations)").all().some(s=>s.name==="read_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN read_tokens INTEGER DEFAULT 0"),this.db.run(`
        UPDATE observations SET read_tokens = (
          COALESCE(LENGTH(narrative), 0) +
          COALESCE(LENGTH(title), 0) +
          COALESCE(LENGTH(facts), 0) +
          COALESCE(LENGTH(concepts), 0) +
          COALESCE(LENGTH(text), 0) + 3
        ) / 4
      `),l.debug("DB","Added and backfilled read_tokens column on observations"))}createContextInjectionsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(22))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='context_injections'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run(`
      CREATE TABLE IF NOT EXISTS context_injections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        project TEXT NOT NULL,
        observation_ids TEXT NOT NULL,
        total_read_tokens INTEGER NOT NULL,
        injection_source TEXT NOT NULL CHECK(injection_source IN ('session_start', 'prompt_submit', 'mcp_search')),
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_injections_project ON context_injections(project);
      CREATE INDEX IF NOT EXISTS idx_context_injections_created ON context_injections(created_at_epoch DESC);
      CREATE INDEX IF NOT EXISTS idx_context_injections_source ON context_injections(injection_source);
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString()),l.debug("DB","context_injections table created")}ensureSubprocessPidColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="subprocess_pid")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN subprocess_pid INTEGER"),l.debug("DB","Added subprocess_pid column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}recreateFTSTablesWithUnicode61(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)||(this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_fts"),this.db.run(`
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title,
        narrative,
        facts,
        concepts,
        subtitle,
        text,
        content='observations',
        content_rowid='id',
        tokenize='unicode61'
      )
    `),this.db.run(`
      INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
      SELECT id, COALESCE(title,''), COALESCE(narrative,''), COALESCE(facts,''), COALESCE(concepts,''), COALESCE(subtitle,''), COALESCE(text,'')
      FROM observations
    `),this.db.run(`
      CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''), COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''));
      END
    `),this.db.run(`
      CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES('delete', old.id, COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''), COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''));
      END
    `),this.db.run(`
      CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES('delete', old.id, COALESCE(old.title,''), COALESCE(old.narrative,''), COALESCE(old.facts,''), COALESCE(old.concepts,''), COALESCE(old.subtitle,''), COALESCE(old.text,''));
        INSERT INTO observations_fts(rowid, title, narrative, facts, concepts, subtitle, text)
        VALUES (new.id, COALESCE(new.title,''), COALESCE(new.narrative,''), COALESCE(new.facts,''), COALESCE(new.concepts,''), COALESCE(new.subtitle,''), COALESCE(new.text,''));
      END
    `),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE IF EXISTS session_summaries_fts"),this.db.run(`
      CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
        request,
        investigated,
        learned,
        completed,
        next_steps,
        notes,
        content='session_summaries',
        content_rowid='id',
        tokenize='unicode61'
      )
    `),this.db.run(`
      INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
      SELECT id, COALESCE(request,''), COALESCE(investigated,''), COALESCE(learned,''), COALESCE(completed,''), COALESCE(next_steps,''), COALESCE(notes,'')
      FROM session_summaries
    `),this.db.run(`
      CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
      END
    `),this.db.run(`
      CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
      END
    `),this.db.run(`
      CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES('delete', old.id, COALESCE(old.request,''), COALESCE(old.investigated,''), COALESCE(old.learned,''), COALESCE(old.completed,''), COALESCE(old.next_steps,''), COALESCE(old.notes,''));
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        VALUES (new.id, COALESCE(new.request,''), COALESCE(new.investigated,''), COALESCE(new.learned,''), COALESCE(new.completed,''), COALESCE(new.next_steps,''), COALESCE(new.notes,''));
      END
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()),l.debug("DB","FTS5 tables recreated with unicode61 tokenizer (migration 24)"))}updateSubprocessPid(e,t){this.db.prepare("UPDATE sdk_sessions SET subprocess_pid = ? WHERE id = ?").run(t,e)}clearSubprocessPid(e){this.db.prepare("UPDATE sdk_sessions SET subprocess_pid = NULL WHERE id = ?").run(e)}getStalePids(){return this.db.prepare(`
      SELECT id as sessionDbId, subprocess_pid as pid
      FROM sdk_sessions
      WHERE status = 'active' AND subprocess_pid IS NOT NULL
    `).all()}updateMemorySessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(t,e)}completeSession(e){let t=Date.now();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?, subprocess_pid = NULL
      WHERE id = ? AND status = 'active'
    `).run(new Date(t).toISOString(),t,e)}getActiveSessions(){return Ie(this.db)}closeActiveSessionById(e){return Re(this.db,e)}closeStaleSessionsOlderThan(e){return Me(this.db,e)}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o,type:i,concepts:a,files:d}=t,c=s==="date_asc"?"ASC":"DESC",u=n?`LIMIT ${String(n)}`:"",_=e.map(()=>"?").join(","),g=[...e],E=[];if(o&&(E.push("project = ?"),g.push(o)),i)if(Array.isArray(i)){let m=i.map(()=>"?").join(",");E.push(`type IN (${m})`),g.push(...i)}else E.push("type = ?"),g.push(i);if(a){let m=Array.isArray(a)?a:[a],S=m.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");g.push(...m),E.push(`(${S.join(" OR ")})`)}if(d){let m=Array.isArray(d)?d:[d],S=m.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");m.forEach(f=>{g.push(`%${f}%`,`%${f}%`)}),E.push(`(${S.join(" OR ")})`)}let T=E.length>0?`WHERE id IN (${_}) AND ${E.join(" AND ")}`:`WHERE id IN (${_})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${T}
      ORDER BY created_at_epoch ${c}
      ${u}
    `).all(...g)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),n=new Set,o=new Set;for(let i of s){if(i.files_read){let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(d=>n.add(d))}if(i.files_modified){let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(d=>o.add(d))}}return{filesRead:Array.from(n),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e).count}createSDKSession(e,t,s){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, 'active')
    `).run(e,t,s,n.toISOString(),o),t&&this.db.prepare(`
        UPDATE sdk_sessions SET project = ?
        WHERE content_session_id = ?
      `).run(t,e),s&&this.db.prepare(`
        UPDATE sdk_sessions SET user_prompt = ?
        WHERE content_session_id = ? AND (user_prompt IS NULL OR user_prompt = '')
      `).run(s,e),this.db.prepare(`
      UPDATE sdk_sessions SET status = 'active'
      WHERE content_session_id = ? AND status = 'completed'
    `).run(e),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}saveUserPrompt(e,t,s){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,s,n.toISOString(),o).lastInsertRowid}getUserPrompt(e,t){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,t)?.prompt_text??null}storeObservation(e,t,s,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString(),c=F({narrative:s.narrative,title:s.title,facts:JSON.stringify(s.facts),concepts:JSON.stringify(s.concepts),text:null}),_=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, read_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),n||null,o,c,d,a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}storeSummary(e,t,s,n,o=0,i){let a=i??Date.now(),d=new Date(a).toISOString();if(P(s))return l.warn("DB","Skipping empty summary insert",{memorySessionId:e}),{id:0,createdAtEpoch:a};let u=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,n||null,o,d,a);return{id:Number(u.lastInsertRowid),createdAtEpoch:a}}storeObservations(e,t,s,n,o,i=0,a){let d=a??Date.now(),c=new Date(d).toISOString();return this.db.transaction(()=>{let _=[],g=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, read_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let T of s){let b=F({narrative:T.narrative,title:T.title,facts:JSON.stringify(T.facts),concepts:JSON.stringify(T.concepts),text:null}),m=g.run(e,t,T.type,T.title,T.subtitle,JSON.stringify(T.facts),T.narrative,JSON.stringify(T.concepts),JSON.stringify(T.files_read),JSON.stringify(T.files_modified),o||null,i,b,c,d);_.push(Number(m.lastInsertRowid))}let E=null;if(n)if(P(n))l.warn("DB","Skipping empty summary insert",{memorySessionId:e});else{let b=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,o||null,i,c,d);E=Number(b.lastInsertRowid)}return{observationIds:_,summaryId:E,createdAtEpoch:d}})()}storeObservationsAndMarkComplete(e,t,s,n,o,i,a,d=0,c){let u=c??Date.now(),_=new Date(u).toISOString();return this.db.transaction(()=>{let E=[],T=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, read_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let S of s){let f=F({narrative:S.narrative,title:S.title,facts:JSON.stringify(S.facts),concepts:JSON.stringify(S.concepts),text:null}),A=T.run(e,t,S.type,S.title,S.subtitle,JSON.stringify(S.facts),S.narrative,JSON.stringify(S.concepts),JSON.stringify(S.files_read),JSON.stringify(S.files_modified),a||null,d,f,_,u);E.push(Number(A.lastInsertRowid))}let b;if(n)if(P(n))l.warn("DB","Skipping empty summary insert",{memorySessionId:e});else{let f=this.db.prepare(`
            INSERT INTO session_summaries
            (memory_session_id, project, request, investigated, learned, completed,
             next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(e,t,n.request,n.investigated,n.learned,n.completed,n.next_steps,n.notes,a||null,d,_,u);b=Number(f.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(u,o),{observationIds:E,summaryId:b,createdAtEpoch:u}})()}getSessionSummariesByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o}=t,i=s==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${String(n)}`:"",d=e.map(()=>"?").join(","),c=[...e],u=o?`WHERE id IN (${d}) AND project = ?`:`WHERE id IN (${d})`;return o&&c.push(o),this.db.prepare(`
      SELECT * FROM session_summaries
      ${u}
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...c)}getUserPromptsByIds(e,t={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:n,project:o}=t,i=s==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${String(n)}`:"",d=e.map(()=>"?").join(","),c=[...e],u=o?"AND s.project = ?":"";return o&&c.push(o),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${d}) ${u}
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...c)}getTimelineAroundTimestamp(e,t=10,s=10,n){return this.getTimelineAroundObservation(null,e,t,s,n)}getTimelineAroundObservation(e,t,s=10,n=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],d,c;if(e!==null){let m=`
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
      `;try{let f=this.db.prepare(m).all(e,...a,s+1),A=this.db.prepare(S).all(e,...a,n+1);if(f.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};d=f.length>0?f[f.length-1].created_at_epoch:t,c=A.length>0?A[A.length-1].created_at_epoch:t}catch(f){return l.error("DB","Error getting boundary observations",void 0,{error:f,project:o}),{observations:[],sessions:[],prompts:[]}}}else{let m=`
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
      `;try{let f=this.db.prepare(m).all(t,...a,s),A=this.db.prepare(S).all(t,...a,n+1);if(f.length===0&&A.length===0)return{observations:[],sessions:[],prompts:[]};d=f.length>0?f[f.length-1].created_at_epoch:t,c=A.length>0?A[A.length-1].created_at_epoch:t}catch(f){return l.error("DB","Error getting boundary timestamps",void 0,{error:f,project:o}),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,_=`
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
    `,E=this.db.prepare(u).all(d,c,...a),T=this.db.prepare(_).all(d,c,...a),b=this.db.prepare(g).all(d,c,...a);return{observations:E,sessions:T.map(m=>({id:m.id,memory_session_id:m.memory_session_id,project:m.project,request:m.request,completed:m.completed,next_steps:m.next_steps,created_at:m.created_at,created_at_epoch:m.created_at_epoch})),prompts:b.map(m=>({id:m.id,content_session_id:m.content_session_id,prompt_number:m.prompt_number,prompt_text:m.prompt_text,project:m.project,created_at:m.created_at,created_at_epoch:m.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
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
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var xe=M(require("path"),1);function ke(r){if(!r||r.trim()==="")return l.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:r}),"unknown-project";let e=xe.default.basename(r);if(e===""){if(process.platform==="win32"){let s=r.match(/^([A-Z]):\\/i);if(s){let o=`drive-${s[1].toUpperCase()}`;return l.info("PROJECT_NAME","Drive root detected",{cwd:r,projectName:o}),o}}return l.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:r}),"unknown-project"}return e}var we=M(require("path"),1),Ue=require("os");var D=require("fs"),X=require("path");var h=class r{static instance=null;activeMode=null;modesDir;constructor(){let e=Oe(),t=[(0,X.join)(e,"modes"),(0,X.join)(e,"..","plugin","modes")],s=t.find(n=>(0,D.existsSync)(n));this.modesDir=s||t[0]}static getInstance(){return r.instance||(r.instance=new r),r.instance}parseInheritance(e){let t=e.split("--");if(t.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(t.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:t[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,t){let s={...e};for(let n in t){let o=t[n],i=e[n];this.isPlainObject(o)&&this.isPlainObject(i)?s[n]=this.deepMerge(i,o):s[n]=o}return s}loadModeFile(e){let t=(0,X.join)(this.modesDir,`${e}.json`);if(!(0,D.existsSync)(t))throw new Error(`Mode file not found: ${t}`);let s=(0,D.readFileSync)(t,"utf-8");return JSON.parse(s)}loadMode(e){let t=this.parseInheritance(e);if(!t.hasParent)try{let d=this.loadModeFile(e);return this.activeMode=d,l.debug("SYSTEM",`Loaded mode: ${d.name} (${e})`,void 0,{types:d.observation_types.map(c=>c.id),concepts:d.observation_concepts.map(c=>c.id)}),d}catch{if(l.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:s,overrideId:n}=t,o;try{o=this.loadMode(s)}catch{l.warn("SYSTEM",`Parent mode '${s}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(n),l.debug("SYSTEM",`Loaded override file: ${n} for parent ${s}`)}catch{return l.warn("SYSTEM",`Override file '${n}' not found, using parent mode '${s}' only`),this.activeMode=o,o}let a=this.deepMerge(o,i);return this.activeMode=a,l.debug("SYSTEM",`Loaded mode with inheritance: ${a.name} (${e} = ${s} + ${n})`,void 0,{parent:s,override:n,types:a.observation_types.map(d=>d.id),concepts:a.observation_concepts.map(d=>d.id)}),a}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(s=>s.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(s=>s.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(t=>t.id===e)}getTypeLabel(e){return this.getObservationTypes().find(s=>s.id===e)?.label||e}};function Z(){let r=we.default.join((0,Ue.homedir)(),".magic-claude-mem","settings.json"),e=N.loadFromFile(r),t=e.MAGIC_CLAUDE_MEM_MODE,s=t==="code"||t.startsWith("code--"),n,o;if(s)n=new Set(e.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(i=>i.trim()).filter(Boolean)),o=new Set(e.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(i=>i.trim()).filter(Boolean));else{let i=h.getInstance().getActiveMode();n=new Set(i.observation_types.map(a=>a.id)),o=new Set(i.observation_concepts.map(a=>a.id))}return{totalObservationCount:parseInt(e.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:n,observationConcepts:o,fullObservationField:e.MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var p={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},$e=4,ee=1;function te(r){let e=(r.title?.length||0)+(r.subtitle?.length||0)+(r.narrative?.length||0)+JSON.stringify(r.facts||[]).length;return Math.ceil(e/$e)}function se(r){let e=r.length,t=r.reduce((i,a)=>i+te(a),0),s=r.reduce((i,a)=>i+(a.discovery_tokens||0),0),n=s-t,o=s>0?Math.round(n/s*100):0;return{totalObservations:e,totalReadTokens:t,totalDiscoveryTokens:s,savings:n,savingsPercent:o}}function $t(r){return h.getInstance().getWorkEmoji(r)}function L(r,e){let t=te(r),s=r.discovery_tokens||0,n=$t(r.type),o=s>0?`${n} ${s.toLocaleString()}`:"-";return{readTokens:t,discoveryTokens:s,discoveryDisplay:o,workEmoji:n}}function B(r){return r.showReadTokens||r.showWorkTokens||r.showSavingsAmount||r.showSavingsPercent}var Pe=M(require("path"),1),Ge=require("os"),W=require("fs");function re(r,e,t){let s=Array.from(t.observationTypes),n=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(",");return r.db.prepare(`
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
  `).all(e,...s,...o,t.totalObservationCount)}function ne(r,e,t){return r.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(e,t.sessionCount+ee)}function Fe(r,e,t){let s=Array.from(t.observationTypes),n=s.map(()=>"?").join(","),o=Array.from(t.observationConcepts),i=o.map(()=>"?").join(","),a=e.map(()=>"?").join(",");return r.db.prepare(`
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
  `).all(...e,...s,...o,t.totalObservationCount)}function je(r,e,t){let s=e.map(()=>"?").join(",");return r.db.prepare(`
    SELECT id, memory_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch, project
    FROM session_summaries
    WHERE project IN (${s})
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...e,t.sessionCount+ee)}function Pt(r){return r.replace(/\//g,"-")}function Gt(r){try{if(!(0,W.existsSync)(r))return{userMessage:"",assistantMessage:""};let e=(0,W.readFileSync)(r,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let t=e.split(`
`).filter(n=>n.trim()),s="";for(let n=t.length-1;n>=0;n--)try{let o=t[n];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let a="";for(let d of i.message.content)d.type==="text"&&(a+=d.text??"");if(a=a.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),a){s=a;break}}}catch(o){l.debug("PARSER","Skipping malformed transcript line",{lineIndex:n},o);continue}return{userMessage:"",assistantMessage:s}}catch(e){return l.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:r},e),{userMessage:"",assistantMessage:""}}}function oe(r,e,t,s){if(!e.showLastMessage||r.length===0)return{userMessage:"",assistantMessage:""};let n=r.find(d=>d.memory_session_id!==t);if(!n)return{userMessage:"",assistantMessage:""};let o=n.memory_session_id,i=Pt(s),a=Pe.default.join((0,Ge.homedir)(),".claude","projects",i,`${o}.jsonl`);return Gt(a)}function Xe(r,e){let t=e[0]?.id;return r.map((s,n)=>{let o=n===0?null:e[n+1];return{...s,displayEpoch:o?o.created_at_epoch:s.created_at_epoch,displayTime:o?o.created_at:s.created_at,shouldShowLink:s.id!==t}})}function ie(r,e){let t=[...r.map(s=>({type:"observation",data:s})),...e.map(s=>({type:"summary",data:s}))];return t.sort((s,n)=>{let o=s.type==="observation"?s.data.created_at_epoch:s.data.displayEpoch,i=n.type==="observation"?n.data.created_at_epoch:n.data.displayEpoch;return o-i}),t}function Be(r,e){return new Set(r.slice(0,e).map(t=>t.id))}function We(){let r=new Date,e=r.toLocaleDateString("en-CA"),t=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${String(s)}`}function He(r){return[`# [${r}] recent context, ${We()}`,""]}function Ve(){return[`**Legend:** session-request | ${h.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ")}`,""]}function Ye(){return["**Column Key**:","- **Read**: Tokens to read this observation (cost to learn it now)","- **Work**: Tokens spent on work that produced this record ( research, building, deciding)",""]}function qe(){return["**Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.","","When you need implementation details, rationale, or debugging context:","- Use MCP tools (search, get_observations) to fetch full observations on-demand","- Critical types ( bugfix, decision) often need detailed fetching","- Trust this index over re-reading code for past decisions and learnings",""]}function Ke(r,e){let t=[];if(t.push("**Context Economics**:"),t.push(`- Loading: ${String(r.totalObservations)} observations (${r.totalReadTokens.toLocaleString()} tokens to read)`),t.push(`- Work investment: ${r.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions`),r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="- Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${r.savings.toLocaleString()} tokens (${String(r.savingsPercent)}% reduction from reuse)`:e.showSavingsAmount?s+=`${r.savings.toLocaleString()} tokens`:s+=`${String(r.savingsPercent)}% reduction from reuse`,t.push(s)}return t.push(""),t}function Je(r){return[`### ${r}`,""]}function ze(r){return[`**${r}**`,"| ID | Time | T | Title | Read | Work |","|----|------|---|-------|------|------|"]}function Qe(r,e,t){let s=r.title||"Untitled",n=h.getInstance().getTypeIcon(r.type),{readTokens:o,discoveryDisplay:i}=L(r,t),a=t.showReadTokens?`~${String(o)}`:"",d=t.showWorkTokens?i:"";return`| #${String(r.id)} | ${e||'"'} | ${n} | ${s} | ${a} | ${d} |`}function Ze(r,e,t,s){let n=[],o=r.title||"Untitled",i=h.getInstance().getTypeIcon(r.type),{readTokens:a,discoveryDisplay:d}=L(r,s);n.push(`**#${String(r.id)}** ${e||'"'} ${i} **${o}**`),t&&(n.push(""),n.push(t),n.push(""));let c=[];return s.showReadTokens&&c.push(`Read: ~${String(a)}`),s.showWorkTokens&&c.push(`Work: ${d}`),c.length>0&&n.push(c.join(", ")),n.push(""),n}function et(r,e){let t=`${r.request||"Session started"} (${e})`;return[`**#S${String(r.id)}** ${t}`,""]}function x(r,e){return e?[`**${r}**: ${e}`,""]:[]}function tt(r){return r.assistantMessage?["","---","","**Previously**","",`A: ${r.assistantMessage}`,""]:[]}function st(r,e){let t=Math.round(r/1e3);return["",`Access ${String(t)}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use MCP search tools to access memories by ID.`]}function rt(r){return`# [${r}] recent context, ${We()}

No previous sessions found for this project yet.`}function nt(){let r=new Date,e=r.toLocaleDateString("en-CA"),t=r.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0}).toLowerCase().replace(" ",""),s=r.toLocaleTimeString("en-US",{timeZoneName:"short"}).split(" ").pop();return`${e} ${t} ${String(s)}`}function ot(r){return["",`${p.bright}${p.cyan}[${r}] recent context, ${nt()}${p.reset}`,`${p.gray}${"\u2500".repeat(60)}${p.reset}`,""]}function it(){let e=h.getInstance().getActiveMode().observation_types.map(t=>`${t.emoji} ${t.id}`).join(" | ");return[`${p.dim}Legend: session-request | ${e}${p.reset}`,""]}function at(){return[`${p.bright}Column Key${p.reset}`,`${p.dim}  Read: Tokens to read this observation (cost to learn it now)${p.reset}`,`${p.dim}  Work: Tokens spent on work that produced this record ( research, building, deciding)${p.reset}`,""]}function dt(){return[`${p.dim}Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${p.reset}`,"",`${p.dim}When you need implementation details, rationale, or debugging context:${p.reset}`,`${p.dim}  - Use MCP tools (search, get_observations) to fetch full observations on-demand${p.reset}`,`${p.dim}  - Critical types ( bugfix, decision) often need detailed fetching${p.reset}`,`${p.dim}  - Trust this index over re-reading code for past decisions and learnings${p.reset}`,""]}function ct(r,e){let t=[];if(t.push(`${p.bright}${p.cyan}Context Economics${p.reset}`),t.push(`${p.dim}  Loading: ${String(r.totalObservations)} observations (${r.totalReadTokens.toLocaleString()} tokens to read)${p.reset}`),t.push(`${p.dim}  Work investment: ${r.totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${p.reset}`),r.totalDiscoveryTokens>0&&(e.showSavingsAmount||e.showSavingsPercent)){let s="  Your savings: ";e.showSavingsAmount&&e.showSavingsPercent?s+=`${r.savings.toLocaleString()} tokens (${String(r.savingsPercent)}% reduction from reuse)`:e.showSavingsAmount?s+=`${r.savings.toLocaleString()} tokens`:s+=`${String(r.savingsPercent)}% reduction from reuse`,t.push(`${p.green}${s}${p.reset}`)}return t.push(""),t}function pt(r){return[`${p.bright}${p.cyan}${r}${p.reset}`,""]}function ut(r){return[`${p.dim}${r}${p.reset}`]}function lt(r,e,t,s){let n=r.title||"Untitled",o=h.getInstance().getTypeIcon(r.type),{readTokens:i,discoveryTokens:a,workEmoji:d}=L(r,s),c=t?`${p.dim}${e}${p.reset}`:" ".repeat(e.length),u=s.showReadTokens&&i>0?`${p.dim}(~${String(i)}t)${p.reset}`:"",_=s.showWorkTokens&&a>0?`${p.dim}(${d} ${a.toLocaleString()}t)${p.reset}`:"";return`  ${p.dim}#${String(r.id)}${p.reset}  ${c}  ${o}  ${n} ${u} ${_}`}function _t(r,e,t,s,n){let o=[],i=r.title||"Untitled",a=h.getInstance().getTypeIcon(r.type),{readTokens:d,discoveryTokens:c,workEmoji:u}=L(r,n),_=t?`${p.dim}${e}${p.reset}`:" ".repeat(e.length),g=n.showReadTokens&&d>0?`${p.dim}(~${String(d)}t)${p.reset}`:"",E=n.showWorkTokens&&c>0?`${p.dim}(${u} ${c.toLocaleString()}t)${p.reset}`:"";return o.push(`  ${p.dim}#${String(r.id)}${p.reset}  ${_}  ${a}  ${p.bright}${i}${p.reset}`),s&&o.push(`    ${p.dim}${s}${p.reset}`),(g||E)&&o.push(`    ${g} ${E}`),o.push(""),o}function mt(r,e){let t=`${r.request||"Session started"} (${e})`;return[`${p.yellow}#S${String(r.id)}${p.reset} ${t}`,""]}function k(r,e,t){return e?[`${t}${r}:${p.reset} ${e}`,""]:[]}function Et(r){return r.assistantMessage?["","---","",`${p.bright}${p.magenta}Previously${p.reset}`,"",`${p.dim}A: ${r.assistantMessage}${p.reset}`,""]:[]}function gt(r,e){let t=Math.round(r/1e3);return["",`${p.dim}Access ${String(t)}k tokens of past research & decisions for just ${e.toLocaleString()}t. Use MCP search tools to access memories by ID.${p.reset}`]}function Tt(r){return`
${p.bright}${p.cyan}[${r}] recent context, ${nt()}${p.reset}
${p.gray}${"\u2500".repeat(60)}${p.reset}

${p.dim}No previous sessions found for this project yet.${p.reset}
`}function St(r,e,t,s){let n=[];return s?n.push(...ot(r)):n.push(...He(r)),s?n.push(...it()):n.push(...Ve()),s?n.push(...at()):n.push(...Ye()),s?n.push(...dt()):n.push(...qe()),B(t)&&(s?n.push(...ct(e,t)):n.push(...Ke(e,t))),n}function Ft(r){let e=new Map;for(let s of r){let n=s.type==="observation"?s.data.created_at:s.data.displayTime,o=ve(n);e.has(o)||e.set(o,[]),e.get(o)?.push(s)}let t=Array.from(e.entries()).sort((s,n)=>{let o=new Date(s[0]).getTime(),i=new Date(n[0]).getTime();return o-i});return new Map(t)}function jt(r,e){return e.fullObservationField==="narrative"?r.narrative:r.facts?G(r.facts).join(`
`):null}function Xt(r,e,t,s,n,o){let i=[];o?i.push(...pt(r)):i.push(...Je(r));let a=null,d="",c=!1;for(let u of e)if(u.type==="summary"){c&&(i.push(""),c=!1,a=null,d="");let _=u.data,g=Le(_.displayTime);o?i.push(...mt(_,g)):i.push(...et(_,g))}else{let _=u.data,g=De(_.files_modified,n,_.files_read),E=ye(_.created_at),T=E!==d,b=T?E:"";d=E;let m=t.has(_.id);if(g!==a&&(c&&i.push(""),o?i.push(...ut(g)):i.push(...ze(g)),a=g,c=!0),m){let S=jt(_,s);o?i.push(..._t(_,E,T,S,s)):(c&&(i.push(""),c=!1),i.push(...Ze(_,b,S,s)),a=null)}else o?i.push(lt(_,E,T,s)):i.push(Qe(_,b,s))}return c&&i.push(""),i}function ft(r,e,t,s,n){let o=[],i=Ft(r);for(let[a,d]of i)o.push(...Xt(a,d,e,t,s,n));return o}function Ct(r,e,t){return!(!r.showLastSummary||!e||!!!(e.investigated||e.learned||e.completed||e.next_steps)||t&&e.created_at_epoch<=t.created_at_epoch)}function bt(r,e){let t=[];return e?(t.push(...k("Investigated",r.investigated,p.blue)),t.push(...k("Learned",r.learned,p.yellow)),t.push(...k("Completed",r.completed,p.green)),t.push(...k("Next Steps",r.next_steps,p.magenta))):(t.push(...x("Investigated",r.investigated)),t.push(...x("Learned",r.learned)),t.push(...x("Completed",r.completed)),t.push(...x("Next Steps",r.next_steps))),t}function ht(r,e){return e?Et(r):tt(r)}function At(r,e,t){return!B(e)||r.totalDiscoveryTokens<=0||r.savings<=0?[]:t?gt(r.totalDiscoveryTokens,r.totalReadTokens):st(r.totalDiscoveryTokens,r.totalReadTokens)}var Bt=Ot.default.join(Te,".install-version");function Wt(){try{return new j}catch(r){if(r instanceof Error&&"code"in r&&r.code==="ERR_DLOPEN_FAILED"){try{(0,It.unlinkSync)(Bt)}catch(e){l.debug("SYSTEM","Marker file cleanup failed (may not exist)",{},e)}return l.error("SYSTEM","Native module rebuild needed - restart Claude Code to auto-fix"),null}throw r}}function Ht(r,e){return e?Tt(r):rt(r)}function Vt(r,e,t,s,n,o,i,a){let d=[];d.push(...St(r,a,s,i));let c=t.slice(0,s.sessionCount),u=Xe(c,t),_=ie(e,u),g=Be(e,s.fullObservationCount);d.push(...ft(_,g,s,n,i));let E=t[0],T=e[0];Ct(s,E,T)&&d.push(...bt(E,i));let b=oe(e,s,o,n);return d.push(...ht(b,i)),d.push(...At(a,s,i)),d.join(`
`).trimEnd()}function ae(r,e=!1){return Y(r,e).text}function Y(r,e=!1){let t=Z(),s=r?.cwd??process.cwd(),n=ke(s),o=r?.projects||[n],i=Wt();if(!i)return{text:"",observationIds:[],totalReadTokens:0};try{let a=o.length>1?Fe(i,o,t):re(i,n,t),d=o.length>1?je(i,o,t):ne(i,n,t);if(a.length===0&&d.length===0)return{text:Ht(n,e),observationIds:[],totalReadTokens:0};let c=a.map(_=>_.id),u=se(a);return{text:Vt(n,a,d,t,s,r?.session_id,e,u),observationIds:c,totalReadTokens:u.totalReadTokens}}finally{i.close()}}0&&(module.exports={generateContext,generateContextWithMeta});
