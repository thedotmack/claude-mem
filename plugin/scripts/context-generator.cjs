"use strict";var Be=Object.create;var q=Object.defineProperty;var Ge=Object.getOwnPropertyDescriptor;var je=Object.getOwnPropertyNames;var Ye=Object.getPrototypeOf,Ke=Object.prototype.hasOwnProperty;var Ve=(d,e)=>{for(var s in e)q(d,s,{get:e[s],enumerable:!0})},ge=(d,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of je(e))!Ke.call(d,r)&&r!==s&&q(d,r,{get:()=>e[r],enumerable:!(t=Ge(e,r))||t.enumerable});return d};var ie=(d,e,s)=>(s=d!=null?Be(Ye(d)):{},ge(e||!d||!d.__esModule?q(s,"default",{value:d,enumerable:!0}):s,d)),Je=d=>ge(q({},"__esModule",{value:!0}),d);var os={};Ve(os,{generateContext:()=>ns});module.exports=Je(os);var se=ie(require("path"),1),te=require("os"),B=require("fs");var ye=require("bun:sqlite");var h=require("path"),fe=require("os"),Le=require("fs");var Ie=require("url");var H=require("fs"),Re=require("path"),Ne=require("os");var Se="bugfix,feature,refactor,discovery,decision,change",he="how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off";var be=require("crypto");var Q=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(Q||{}),ae=class{level=null;useColor;dbSink=null;logBuffer=[];flushTimer=null;bufferSize=50;flushIntervalMs=5e3;isInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}initializeDatabaseSink(e){this.isInitialized||(this.dbSink=e,this.isInitialized=!0,this.flushTimer=setInterval(()=>this.flushBuffer(),this.flushIntervalMs),process.on("beforeExit",()=>this.flushBuffer()),process.on("SIGINT",()=>{this.flushBuffer(),process.exit(0)}),process.on("SIGTERM",()=>{this.flushBuffer(),process.exit(0)}))}get isDatabaseLoggingEnabled(){return this.dbSink!==null}flushBuffer(){if(this.logBuffer.length===0||!this.dbSink)return;let e=[...this.logBuffer];this.logBuffer=[];try{this.dbSink.storeSystemLogBatch(e)}catch{console.error("[Logger] Failed to flush logs to database")}}createErrorHash(e,s){let t=e.replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/g,"TIMESTAMP").replace(/\b\d+\b/g,"NUM").replace(/\/[\w\/.-]+/g,"PATH").substring(0,200);return(0,be.createHash)("md5").update(`${s}:${t}`).digest("hex").substring(0,16)}getLevel(){if(this.level===null){let e=w.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=Q[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,o){if(e<this.getLevel())return;let i=new Date,c=i.toISOString().replace("T"," ").substring(0,23),l=Q[e].padEnd(5),p=s.padEnd(6),u="";r?.correlationId?u=`[${r.correlationId}] `:r?.sessionId&&(u=`[session-${r.sessionId}] `);let b="";o!=null&&(this.getLevel()===0&&typeof o=="object"?b=`
`+JSON.stringify(o,null,2):b=" "+this.formatData(o));let A="";if(r){let{sessionId:O,sdkSessionId:m,correlationId:n,...f}=r;Object.keys(f).length>0&&(A=` {${Object.entries(f).map(([M,v])=>`${M}=${v}`).join(", ")}}`)}let R=`[${c}] [${l}] [${p}] ${u}${t}${A}${b}`;if(e===3?console.error(R):console.log(R),this.dbSink&&e>=1){let O=Q[e],m;if(o instanceof Error&&(m=o.stack),this.logBuffer.push({level:O,component:s,message:t,context:r?{...r}:void 0,data:o instanceof Error?{message:o.message,name:o.name}:o,errorStack:m,timestamp:i}),e===3&&this.dbSink){let n=this.createErrorHash(t,s);try{this.dbSink.trackErrorPattern(n,t,s)}catch{}}this.logBuffer.length>=this.bufferSize&&this.flushBuffer()}}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},T=new ae;var w=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:(0,Re.join)((0,Ne.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_MODE:"code",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:Se,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:he,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false",CLAUDE_MEM_SLACK_ENABLED:"false",CLAUDE_MEM_SLACK_BOT_TOKEN:"",CLAUDE_MEM_SLACK_APP_TOKEN:"",CLAUDE_MEM_SLACK_CHANNEL_ID:"",CLAUDE_MEM_SLACK_NOTIFY_ON_QUESTIONS:"true",CLAUDE_MEM_SLACK_SESSION_EXPIRY_HOURS:"24",CLAUDE_MEM_INTERACTION_MODE:"auto",CLAUDE_MEM_SLACK_SHARE_SUMMARIES:"false",CLAUDE_MEM_SLACK_SHARE_TYPES:""};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){try{if(!(0,H.existsSync)(e))return this.getAllDefaults();let s=(0,H.readFileSync)(e,"utf-8"),t=JSON.parse(s),r=t;if(t.env&&typeof t.env=="object"){r=t.env;try{(0,H.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),T.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(i){T.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},i)}}let o={...this.DEFAULTS};for(let i of Object.keys(this.DEFAULTS))r[i]!==void 0&&(o[i]=r[i]);return o}catch(s){return T.warn("SETTINGS","Failed to load settings, using defaults",{settingsPath:e},s),this.getAllDefaults()}}};var Qe={};function qe(){return typeof __dirname<"u"?__dirname:(0,h.dirname)((0,Ie.fileURLToPath)(Qe.url))}var Oe=qe(),D=w.get("CLAUDE_MEM_DATA_DIR"),ce=process.env.CLAUDE_CONFIG_DIR||(0,h.join)((0,fe.homedir)(),".claude"),Ss=(0,h.join)(D,"archives"),hs=(0,h.join)(D,"logs"),bs=(0,h.join)(D,"trash"),Rs=(0,h.join)(D,"backups"),Ns=(0,h.join)(D,"settings.json"),Ae=(0,h.join)(D,"claude-mem.db"),Os=(0,h.join)(D,"vector-db"),fs=(0,h.join)(ce,"settings.json"),Ls=(0,h.join)(ce,"commands"),Is=(0,h.join)(ce,"CLAUDE.md");function Ce(d){(0,Le.mkdirSync)(d,{recursive:!0})}function ve(){let d=(0,h.join)(Oe,".."),e=(0,h.basename)(d);return/^\d+\.\d+\.\d+$/.test(e)?d:(0,h.join)(Oe,"..","..")}var z=class{db;constructor(){Ce(D),this.db=new ye.Database(Ae),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.createObservationAccessTable(),this.createWaitingSessionsTable(),this.createScheduledContinuationsTable(),this.addWaitingSessionsResponseSource(),this.createSystemLoggingTables()}initializeSchema(){try{this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(t=>t.version)):0)===0&&(console.error("[SessionStore] Initializing fresh database with migration004..."),this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(l=>l.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(l=>l.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(l=>l.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec(`
          INSERT INTO session_summaries_new
          SELECT id, sdk_session_id, project, request, investigated, learned,
                 completed, next_steps, files_read, files_edited, notes,
                 prompt_number, created_at, created_at_epoch
          FROM session_summaries
        `),this.db.exec("DROP TABLE session_summaries"),this.db.exec("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.exec(`
          CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(sdk_session_id);
          CREATE INDEX idx_session_summaries_project ON session_summaries(project);
          CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(r){throw this.db.exec("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.pragma("table_info(observations)").some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.pragma("table_info(observations)").find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec(`
          INSERT INTO observations_new
          SELECT id, sdk_session_id, project, text, type, title, subtitle, facts,
                 narrative, concepts, files_read, files_modified, prompt_number,
                 created_at, created_at_epoch
          FROM observations
        `),this.db.exec("DROP TABLE observations"),this.db.exec("ALTER TABLE observations_new RENAME TO observations"),this.db.exec(`
          CREATE INDEX idx_observations_sdk_session ON observations(sdk_session_id);
          CREATE INDEX idx_observations_project ON observations(project);
          CREATE INDEX idx_observations_type ON observations(type);
          CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.error("[SessionStore] Successfully made observations.text nullable")}catch(r){throw this.db.exec("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.pragma("table_info(user_prompts)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.error("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec(`
          CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
            prompt_text,
            content='user_prompts',
            content_rowid='id'
          );
        `),this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}createPendingMessagesTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}console.log("[SessionStore] Creating pending_messages table..."),this.db.run(`
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(claude_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),console.log("[SessionStore] pending_messages table created successfully")}catch(e){throw console.error("[SessionStore] Pending messages table migration error:",e.message),e}}createObservationAccessTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;if(this.db.pragma("table_info(observation_access)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString());return}console.error("[SessionStore] Creating observation_access table for usage tracking..."),this.db.exec(`
        CREATE TABLE observation_access (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id INTEGER NOT NULL,
          access_type TEXT NOT NULL CHECK(access_type IN ('context_injection', 'search_result', 'manual_view')),
          accessed_at TEXT NOT NULL,
          accessed_at_epoch INTEGER NOT NULL,
          sdk_session_id TEXT,
          FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_observation_access_obs ON observation_access(observation_id);
        CREATE INDEX idx_observation_access_epoch ON observation_access(accessed_at_epoch DESC);
        CREATE INDEX idx_observation_access_type ON observation_access(access_type);
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString()),console.error("[SessionStore] Successfully created observation_access table")}catch(e){console.error("[SessionStore] Migration error (create observation_access table):",e.message)}}createWaitingSessionsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;if(this.db.pragma("table_info(waiting_sessions)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString());return}console.error("[SessionStore] Creating waiting_sessions table for Slack notifications..."),this.db.exec(`
        CREATE TABLE waiting_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          claude_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          cwd TEXT NOT NULL,
          question TEXT,
          full_message TEXT,
          transcript_path TEXT,
          slack_thread_ts TEXT,
          slack_channel_id TEXT,
          status TEXT CHECK(status IN ('waiting', 'responded', 'expired', 'cancelled')) NOT NULL DEFAULT 'waiting',
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          responded_at TEXT,
          responded_at_epoch INTEGER,
          response_text TEXT,
          expires_at_epoch INTEGER NOT NULL
        );

        CREATE INDEX idx_waiting_sessions_claude_id ON waiting_sessions(claude_session_id);
        CREATE INDEX idx_waiting_sessions_status ON waiting_sessions(status);
        CREATE INDEX idx_waiting_sessions_slack_thread ON waiting_sessions(slack_thread_ts);
        CREATE INDEX idx_waiting_sessions_expires ON waiting_sessions(expires_at_epoch);
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString()),console.error("[SessionStore] Successfully created waiting_sessions table")}catch(e){console.error("[SessionStore] Migration error (create waiting_sessions table):",e.message)}}createScheduledContinuationsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;if(this.db.pragma("table_info(scheduled_continuations)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString());return}console.error("[SessionStore] Creating scheduled_continuations table..."),this.db.exec(`
        CREATE TABLE scheduled_continuations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          claude_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          cwd TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          scheduled_at_epoch INTEGER NOT NULL,
          reason TEXT CHECK(reason IN ('rate_limit', 'user_scheduled', 'other')) NOT NULL DEFAULT 'other',
          prompt TEXT NOT NULL DEFAULT 'continue',
          status TEXT CHECK(status IN ('pending', 'executed', 'cancelled', 'failed')) NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          executed_at TEXT,
          executed_at_epoch INTEGER
        );

        CREATE INDEX idx_scheduled_continuations_status ON scheduled_continuations(status);
        CREATE INDEX idx_scheduled_continuations_scheduled ON scheduled_continuations(scheduled_at_epoch);
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString()),console.error("[SessionStore] Successfully created scheduled_continuations table")}catch(e){console.error("[SessionStore] Migration error (create scheduled_continuations table):",e.message)}}addWaitingSessionsResponseSource(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(15))return;this.db.pragma("table_info(waiting_sessions)").some(r=>r.name==="response_source")||(console.error("[SessionStore] Adding response_source column to waiting_sessions..."),this.db.exec(`
          ALTER TABLE waiting_sessions ADD COLUMN response_source TEXT CHECK(response_source IN ('slack', 'local', 'api'));
        `),console.error("[SessionStore] Successfully added response_source column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(15,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error (add response_source column):",e.message)}}createSystemLoggingTables(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;let s=this.db.pragma("table_info(system_logs)"),t=this.db.pragma("table_info(error_patterns)");if(s.length>0&&t.length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}console.error("[SessionStore] Creating system_logs and error_patterns tables for self-aware logging..."),s.length===0&&(this.db.exec(`
          CREATE TABLE system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            level TEXT NOT NULL CHECK(level IN ('DEBUG', 'INFO', 'WARN', 'ERROR')),
            component TEXT NOT NULL,
            message TEXT NOT NULL,
            context TEXT,
            data TEXT,
            error_stack TEXT,
            created_at TEXT NOT NULL,
            created_at_epoch INTEGER NOT NULL
          );

          CREATE INDEX idx_system_logs_level ON system_logs(level);
          CREATE INDEX idx_system_logs_component ON system_logs(component);
          CREATE INDEX idx_system_logs_created ON system_logs(created_at_epoch DESC);
          CREATE INDEX idx_system_logs_level_created ON system_logs(level, created_at_epoch DESC);
        `),console.error("[SessionStore] Created system_logs table")),t.length===0&&(this.db.exec(`
          CREATE TABLE error_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            error_hash TEXT UNIQUE NOT NULL,
            error_message TEXT NOT NULL,
            component TEXT NOT NULL,
            first_seen_epoch INTEGER NOT NULL,
            last_seen_epoch INTEGER NOT NULL,
            occurrence_count INTEGER DEFAULT 1,
            is_resolved INTEGER DEFAULT 0,
            resolution_notes TEXT,
            auto_resolution TEXT
          );

          CREATE INDEX idx_error_patterns_hash ON error_patterns(error_hash);
          CREATE INDEX idx_error_patterns_component ON error_patterns(component);
          CREATE INDEX idx_error_patterns_count ON error_patterns(occurrence_count DESC);
          CREATE INDEX idx_error_patterns_resolved ON error_patterns(is_resolved);
        `),console.error("[SessionStore] Created error_patterns table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),console.error("[SessionStore] Successfully created system logging tables")}catch(e){console.error("[SessionStore] Migration error (create system logging tables):",e.message)}}storeSystemLog(e,s,t,r,o,i){try{let c=new Date;return this.db.prepare(`
        INSERT INTO system_logs (level, component, message, context, data, error_stack, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(e,s,t,r?JSON.stringify(r):null,o!==void 0?JSON.stringify(o):null,i||null,c.toISOString(),c.getTime()).lastInsertRowid}catch(c){return console.error("[SessionStore] Failed to store system log:",c.message),-1}}storeSystemLogBatch(e){if(e.length===0)return 0;try{let s=this.db.prepare(`
        INSERT INTO system_logs (level, component, message, context, data, error_stack, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);return this.db.transaction(r=>{let o=0;for(let i of r)s.run(i.level,i.component,i.message,i.context?JSON.stringify(i.context):null,i.data!==void 0?JSON.stringify(i.data):null,i.errorStack||null,i.timestamp.toISOString(),i.timestamp.getTime()),o++;return o})(e)}catch(s){return console.error("[SessionStore] Failed to store system log batch:",s.message),0}}trackErrorPattern(e,s,t){try{let r=Date.now(),o=this.db.prepare(`
        SELECT id, occurrence_count FROM error_patterns WHERE error_hash = ?
      `).get(e);return o?(this.db.prepare(`
          UPDATE error_patterns
          SET last_seen_epoch = ?, occurrence_count = occurrence_count + 1
          WHERE id = ?
        `).run(r,o.id),{id:o.id,isNew:!1,occurrenceCount:o.occurrence_count+1}):{id:this.db.prepare(`
        INSERT INTO error_patterns (error_hash, error_message, component, first_seen_epoch, last_seen_epoch, occurrence_count)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(e,s,t,r,r).lastInsertRowid,isNew:!0,occurrenceCount:1}}catch(r){return console.error("[SessionStore] Failed to track error pattern:",r.message),{id:-1,isNew:!1,occurrenceCount:0}}}getRecentSystemLogs(e={}){let{level:s,component:t,limit:r=100,since:o}=e,i=[],c=[];s&&(i.push("level = ?"),c.push(s)),t&&(i.push("component = ?"),c.push(t)),o&&(i.push("created_at_epoch >= ?"),c.push(o));let l=i.length>0?`WHERE ${i.join(" AND ")}`:"",p=this.db.prepare(`
      SELECT * FROM system_logs
      ${l}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `);return c.push(r),p.all(...c)}getErrorPatterns(e={}){let{resolved:s,component:t,limit:r=50,minOccurrences:o=1}=e,i=["occurrence_count >= ?"],c=[o];s!==void 0&&(i.push("is_resolved = ?"),c.push(s?1:0)),t&&(i.push("component = ?"),c.push(t));let l=`WHERE ${i.join(" AND ")}`,p=this.db.prepare(`
      SELECT * FROM error_patterns
      ${l}
      ORDER BY occurrence_count DESC, last_seen_epoch DESC
      LIMIT ?
    `);return c.push(r),p.all(...c)}resolveErrorPattern(e,s,t){try{return this.db.prepare(`
        UPDATE error_patterns
        SET is_resolved = 1, resolution_notes = ?, auto_resolution = ?
        WHERE error_hash = ?
      `).run(s,t?JSON.stringify(t):null,e).changes>0}catch(r){return console.error("[SessionStore] Failed to resolve error pattern:",r.message),!1}}getSystemHealthSummary(){try{let e=Date.now()-864e5,s=this.db.prepare("SELECT COUNT(*) as count FROM system_logs").get().count,t=this.db.prepare("SELECT COUNT(*) as count FROM system_logs WHERE level = ? AND created_at_epoch >= ?").get("ERROR",e).count,r=this.db.prepare("SELECT COUNT(*) as count FROM system_logs WHERE level = ? AND created_at_epoch >= ?").get("WARN",e).count,o=this.db.prepare("SELECT COUNT(*) as count FROM error_patterns WHERE is_resolved = 0").get().count,i=this.db.prepare(`
        SELECT error_message as message, occurrence_count as count, component
        FROM error_patterns
        WHERE is_resolved = 0
        ORDER BY occurrence_count DESC
        LIMIT 5
      `).all(),c=this.db.prepare(`
        SELECT component, COUNT(*) as count
        FROM system_logs
        WHERE level = 'ERROR' AND created_at_epoch >= ?
        GROUP BY component
        ORDER BY count DESC
      `).all(e),l={};for(let p of c)l[p.component]=p.count;return{totalLogs:s,errorCount24h:t,warnCount24h:r,unresolvedPatterns:o,topErrors:i,componentErrorCounts:l}}catch(e){return console.error("[SessionStore] Failed to get system health summary:",e.message),{totalLogs:0,errorCount24h:0,warnCount24h:0,unresolvedPatterns:0,topErrors:[],componentErrorCounts:{}}}}cleanupOldSystemLogs(e=30){try{let s=Date.now()-e*24*60*60*1e3;return this.db.prepare(`
        DELETE FROM system_logs WHERE created_at_epoch < ?
      `).run(s).changes}catch(s){return console.error("[SessionStore] Failed to cleanup old system logs:",s.message),0}}logObservationAccess(e,s,t){try{let r=new Date;this.db.prepare(`
        INSERT INTO observation_access (observation_id, access_type, accessed_at, accessed_at_epoch, sdk_session_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(e,s,r.toISOString(),Math.floor(r.getTime()/1e3),t||null)}catch(r){console.error("[SessionStore] Failed to log observation access:",r.message)}}logObservationAccessBatch(e,s,t){if(e.length!==0)try{let r=new Date,o=r.toISOString(),i=Math.floor(r.getTime()/1e3),c=this.db.prepare(`
        INSERT INTO observation_access (observation_id, access_type, accessed_at, accessed_at_epoch, sdk_session_id)
        VALUES (?, ?, ?, ?, ?)
      `);this.db.transaction(p=>{for(let u of p)c.run(u,s,o,i,t||null)})(e)}catch(r){console.error("[SessionStore] Failed to log observation access batch:",r.message)}}getObservationUsageStats(e){try{let t=this.db.prepare(`
        SELECT access_type, COUNT(*) as count
        FROM observation_access
        WHERE observation_id = ?
        GROUP BY access_type
      `).all(e),r={},o=0;for(let l of t)r[l.access_type]=l.count,o+=l.count;let c=this.db.prepare(`
        SELECT accessed_at
        FROM observation_access
        WHERE observation_id = ?
        ORDER BY accessed_at_epoch DESC
        LIMIT 1
      `).get(e);return{totalAccesses:o,byType:r,lastAccessed:c?.accessed_at||null}}catch(s){return console.error("[SessionStore] Failed to get observation usage stats:",s.message),{totalAccesses:0,byType:{},lastAccessed:null}}}getMostUsedObservations(e=50,s){try{let t=s?`
          SELECT
            o.id, o.title, o.subtitle, o.type, o.project, o.created_at_epoch,
            COUNT(oa.id) as usageCount,
            MAX(oa.accessed_at) as lastAccessed
          FROM observations o
          LEFT JOIN observation_access oa ON o.id = oa.observation_id
          WHERE o.project = ?
          GROUP BY o.id
          ORDER BY usageCount DESC, o.created_at_epoch DESC
          LIMIT ?
        `:`
          SELECT
            o.id, o.title, o.subtitle, o.type, o.project, o.created_at_epoch,
            COUNT(oa.id) as usageCount,
            MAX(oa.accessed_at) as lastAccessed
          FROM observations o
          LEFT JOIN observation_access oa ON o.id = oa.observation_id
          GROUP BY o.id
          ORDER BY usageCount DESC, o.created_at_epoch DESC
          LIMIT ?
        `,r=this.db.prepare(t);return s?r.all(s,e):r.all(e)}catch(t){return console.error("[SessionStore] Failed to get most used observations:",t.message),[]}}getObservationUsageTimeline(e,s=20){try{return this.db.prepare(`
        SELECT accessed_at, access_type, sdk_session_id
        FROM observation_access
        WHERE observation_id = ?
        ORDER BY accessed_at_epoch DESC
        LIMIT ?
      `).all(e,s)}catch(t){return console.error("[SessionStore] Failed to get observation usage timeline:",t.message),[]}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${o}
      ${i}
    `).all(...e)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),r=new Set,o=new Set;for(let i of t){if(i.files_read)try{let c=JSON.parse(i.files_read);Array.isArray(c)&&c.forEach(l=>r.add(l))}catch{}if(i.files_modified)try{let c=JSON.parse(i.files_modified);Array.isArray(c)&&c.forEach(l=>o.add(l))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}findActiveSDKSession(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,o=r.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),o);return c.lastInsertRowid===0||c.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):c.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(T.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,t){let r=new Date,o=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),o).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,o=0){let i=new Date,c=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,o,i.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,t,r,o=0){let i=new Date,c=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,o,i.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${o}
      ${i}
    `).all(...e)}getLatestSessionSummary(e){return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${c})
      ORDER BY up.created_at_epoch ${o}
      ${i}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,o){let i=o?"AND project = ?":"",c=o?[o]:[],l,p;if(e!==null){let R=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,O=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let m=this.db.prepare(R).all(e,...c,t+1),n=this.db.prepare(O).all(e,...c,r+1);if(m.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};l=m.length>0?m[m.length-1].created_at_epoch:s,p=n.length>0?n[n.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary observations:",m.message),{observations:[],sessions:[],prompts:[]}}}else{let R=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,O=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let m=this.db.prepare(R).all(s,...c,t),n=this.db.prepare(O).all(s,...c,r+1);if(m.length===0&&n.length===0)return{observations:[],sessions:[],prompts:[]};l=m.length>0?m[m.length-1].created_at_epoch:s,p=n.length>0?n[n.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary timestamps:",m.message),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,A=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let R=this.db.prepare(u).all(l,p,...c),O=this.db.prepare(b).all(l,p,...c),m=this.db.prepare(A).all(l,p,...c);return{observations:R,sessions:O.map(n=>({id:n.id,sdk_session_id:n.sdk_session_id,project:n.project,request:n.request,completed:n.completed,next_steps:n.next_steps,created_at:n.created_at,created_at_epoch:n.created_at_epoch})),prompts:m.map(n=>({id:n.id,claude_session_id:n.claude_session_id,project:n.project,prompt:n.prompt_text,created_at:n.created_at,created_at_epoch:n.created_at_epoch}))}}catch(R){return console.error("[SessionStore] Error querying timeline records:",R.message),{observations:[],sessions:[],prompts:[]}}}createWaitingSession(e,s,t,r,o,i,c=24){let l=new Date,p=l.getTime(),u=p+c*60*60*1e3;return this.db.prepare(`
      INSERT INTO waiting_sessions
      (claude_session_id, project, cwd, question, full_message, transcript_path,
       status, created_at, created_at_epoch, expires_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)
    `).run(e,s,t,r,o,i,l.toISOString(),p,u).lastInsertRowid}updateWaitingSessionSlackThread(e,s,t){this.db.prepare(`
      UPDATE waiting_sessions
      SET slack_thread_ts = ?, slack_channel_id = ?
      WHERE id = ?
    `).run(s,t,e)}getWaitingSessionBySlackThread(e){return this.db.prepare(`
      SELECT * FROM waiting_sessions
      WHERE slack_thread_ts = ? AND status = 'waiting'
      LIMIT 1
    `).get(e)}getRespondedSessionBySlackThread(e){return this.db.prepare(`
      SELECT * FROM waiting_sessions
      WHERE slack_thread_ts = ? AND status = 'responded'
      ORDER BY responded_at_epoch DESC
      LIMIT 1
    `).get(e)}getWaitingSessionById(e){return this.db.prepare(`
      SELECT * FROM waiting_sessions WHERE id = ?
    `).get(e)}getWaitingSessionsForClaudeSession(e){return this.db.prepare(`
      SELECT * FROM waiting_sessions
      WHERE claude_session_id = ? AND status = 'waiting'
      ORDER BY created_at_epoch DESC
    `).all(e)}getPendingWaitingSessions(){let e=Date.now();return this.db.prepare(`
      SELECT * FROM waiting_sessions
      WHERE status = 'waiting' AND expires_at_epoch > ?
      ORDER BY created_at_epoch DESC
    `).all(e)}markWaitingSessionResponded(e,s,t="slack"){let r=new Date;this.db.prepare(`
      UPDATE waiting_sessions
      SET status = 'responded', responded_at = ?, responded_at_epoch = ?, response_text = ?, response_source = ?
      WHERE id = ?
    `).run(r.toISOString(),r.getTime(),s,t,e)}markWaitingSessionExpired(e){this.db.prepare(`
      UPDATE waiting_sessions SET status = 'expired' WHERE id = ?
    `).run(e)}markWaitingSessionCancelled(e){this.db.prepare(`
      UPDATE waiting_sessions SET status = 'cancelled' WHERE id = ?
    `).run(e)}expireOldWaitingSessions(){let e=Date.now();return this.db.prepare(`
      UPDATE waiting_sessions
      SET status = 'expired'
      WHERE status = 'waiting' AND expires_at_epoch <= ?
    `).run(e).changes}close(){this.db.close()}};var de=ie(require("path"),1);function le(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function De(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Me(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Ue(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function ze(d,e){return de.default.isAbsolute(d)?de.default.relative(e,d):d}function ke(d,e){let s=le(d);return s.length>0?ze(s[0],e):"General"}var we=ie(require("path"),1);function xe(d){if(!d||d.trim()==="")return T.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:d}),"unknown-project";let e=we.default.basename(d);if(e===""){if(process.platform==="win32"){let t=d.match(/^([A-Z]):\\/i);if(t){let o=`drive-${t[1].toUpperCase()}`;return T.info("PROJECT_NAME","Drive root detected",{cwd:d,projectName:o}),o}}return T.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:d}),"unknown-project"}return e}var G=require("fs"),Z=require("path");var X=class d{static instance=null;activeMode=null;modesDir;constructor(){let e=ve(),s=[(0,Z.join)(e,"modes"),(0,Z.join)(e,"..","plugin","modes")],t=s.find(r=>(0,G.existsSync)(r));this.modesDir=t||s[0]}static getInstance(){return d.instance||(d.instance=new d),d.instance}parseInheritance(e){let s=e.split("--");if(s.length===1)return{hasParent:!1,parentId:"",overrideId:""};if(s.length>2)throw new Error(`Invalid mode inheritance: ${e}. Only one level of inheritance supported (parent--override)`);return{hasParent:!0,parentId:s[0],overrideId:e}}isPlainObject(e){return e!==null&&typeof e=="object"&&!Array.isArray(e)}deepMerge(e,s){let t={...e};for(let r in s){let o=s[r],i=e[r];this.isPlainObject(o)&&this.isPlainObject(i)?t[r]=this.deepMerge(i,o):t[r]=o}return t}loadModeFile(e){let s=(0,Z.join)(this.modesDir,`${e}.json`);if(!(0,G.existsSync)(s))throw new Error(`Mode file not found: ${s}`);let t=(0,G.readFileSync)(s,"utf-8");return JSON.parse(t)}loadMode(e){let s=this.parseInheritance(e);if(!s.hasParent)try{let l=this.loadModeFile(e);return this.activeMode=l,T.debug("SYSTEM",`Loaded mode: ${l.name} (${e})`,void 0,{types:l.observation_types.map(p=>p.id),concepts:l.observation_concepts.map(p=>p.id)}),l}catch{if(T.warn("SYSTEM",`Mode file not found: ${e}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}let{parentId:t,overrideId:r}=s,o;try{o=this.loadMode(t)}catch{T.warn("SYSTEM",`Parent mode '${t}' not found for ${e}, falling back to 'code'`),o=this.loadMode("code")}let i;try{i=this.loadModeFile(r),T.debug("SYSTEM",`Loaded override file: ${r} for parent ${t}`)}catch{return T.warn("SYSTEM",`Override file '${r}' not found, using parent mode '${t}' only`),this.activeMode=o,o}if(!i)return T.warn("SYSTEM",`Invalid override file: ${r}, using parent mode '${t}' only`),this.activeMode=o,o;let c=this.deepMerge(o,i);return this.activeMode=c,T.debug("SYSTEM",`Loaded mode with inheritance: ${c.name} (${e} = ${t} + ${r})`,void 0,{parent:t,override:r,types:c.observation_types.map(l=>l.id),concepts:c.observation_concepts.map(l=>l.id)}),c}getActiveMode(){if(!this.activeMode)throw new Error("No mode loaded. Call loadMode() first.");return this.activeMode}getObservationTypes(){return this.getActiveMode().observation_types}getObservationConcepts(){return this.getActiveMode().observation_concepts}getTypeIcon(e){return this.getObservationTypes().find(t=>t.id===e)?.emoji||"\u{1F4DD}"}getWorkEmoji(e){return this.getObservationTypes().find(t=>t.id===e)?.work_emoji||"\u{1F4DD}"}validateType(e){return this.getObservationTypes().some(s=>s.id===e)}getTypeLabel(e){return this.getObservationTypes().find(t=>t.id===e)?.label||e}};var Ze=se.default.join((0,te.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function es(){let d=se.default.join((0,te.homedir)(),".claude-mem","settings.json"),e=w.loadFromFile(d),s=e.CLAUDE_MEM_MODE,t=s==="code"||s.startsWith("code--"),r,o;if(t)r=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(i=>i.trim()).filter(Boolean)),o=new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(i=>i.trim()).filter(Boolean));else{let i=X.getInstance().getActiveMode();r=new Set(i.observation_types.map(c=>c.id)),o=new Set(i.observation_concepts.map(c=>c.id))}return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:r,observationConcepts:o,fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}var $e=4,ss=1,a={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function ee(d,e,s,t){return e?t?[`${s}${d}:${a.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}function ts(d){return d.replace(/\//g,"-")}function rs(d){try{if(!(0,B.existsSync)(d))return{userMessage:"",assistantMessage:""};let e=(0,B.readFileSync)(d,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim()),t="";for(let r=s.length-1;r>=0;r--)try{let o=s[r];if(!o.includes('"type":"assistant"'))continue;let i=JSON.parse(o);if(i.type==="assistant"&&i.message?.content&&Array.isArray(i.message.content)){let c="";for(let l of i.message.content)l.type==="text"&&(c+=l.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){t=c;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return T.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:d},e),{userMessage:"",assistantMessage:""}}}async function ns(d,e=!1){let s=es(),t=d?.cwd??process.cwd(),r=xe(t),o=null;try{o=new z}catch(f){if(f.code==="ERR_DLOPEN_FAILED"){try{(0,B.unlinkSync)(Ze)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw f}let i=Array.from(s.observationTypes),c=i.map(()=>"?").join(","),l=Array.from(s.observationConcepts),p=l.map(()=>"?").join(","),u=o.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${c})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${p})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,...i,...l,s.totalObservationCount);if(u.length>0){let f=u.map(C=>C.id);o.logObservationAccessBatch(f,"context_injection",d?.session_id)}let b=o.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,s.sessionCount+ss),A="",R="";if(s.showLastMessage&&u.length>0){let f=d?.session_id,C=u.find(M=>M.sdk_session_id!==f);if(C){let M=C.sdk_session_id,v=ts(t),N=se.default.join((0,te.homedir)(),".claude","projects",v,`${M}.jsonl`),y=rs(N);A=y.userMessage,R=y.assistantMessage}}if(u.length===0&&b.length===0)return o?.close(),e?`
${a.bright}${a.cyan}[${r}] recent context${a.reset}
${a.gray}${"\u2500".repeat(60)}${a.reset}

${a.dim}No previous sessions found for this project yet.${a.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let O=b.slice(0,s.sessionCount),m=u,n=[];if(e?(n.push(""),n.push(`${a.bright}${a.cyan}[${r}] recent context${a.reset}`),n.push(`${a.gray}${"\u2500".repeat(60)}${a.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),m.length>0){let C=X.getInstance().getActiveMode().observation_types.map(_=>`${_.emoji} ${_.id}`).join(" | ");e?n.push(`${a.dim}Legend: \u{1F3AF} session-request | ${C}${a.reset}`):n.push(`**Legend:** \u{1F3AF} session-request | ${C}`),n.push(""),e?(n.push(`${a.bright}\u{1F4A1} Column Key${a.reset}`),n.push(`${a.dim}  Read: Tokens to read this observation (cost to learn it now)${a.reset}`),n.push(`${a.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${a.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${a.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${a.reset}`),n.push(""),n.push(`${a.dim}When you need implementation details, rationale, or debugging context:${a.reset}`),n.push(`${a.dim}  - Use the mem-search skill to fetch full observations on-demand${a.reset}`),n.push(`${a.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${a.reset}`),n.push(`${a.dim}  - Trust this index over re-reading code for past decisions and learnings${a.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let M=u.length,v=u.reduce((_,g)=>{let S=(g.title?.length||0)+(g.subtitle?.length||0)+(g.narrative?.length||0)+JSON.stringify(g.facts||[]).length;return _+Math.ceil(S/$e)},0),N=u.reduce((_,g)=>_+(g.discovery_tokens||0),0),y=N-v,j=N>0?Math.round(y/N*100):0,_e=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(_e)if(e){if(n.push(`${a.bright}${a.cyan}\u{1F4CA} Context Economics${a.reset}`),n.push(`${a.dim}  Loading: ${M} observations (${v.toLocaleString()} tokens to read)${a.reset}`),n.push(`${a.dim}  Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions${a.reset}`),N>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${y.toLocaleString()} tokens (${j}% reduction from reuse)`:s.showSavingsAmount?_+=`${y.toLocaleString()} tokens`:_+=`${j}% reduction from reuse`,n.push(`${a.green}${_}${a.reset}`)}n.push("")}else{if(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${M} observations (${v.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions`),N>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${y.toLocaleString()} tokens (${j}% reduction from reuse)`:s.showSavingsAmount?_+=`${y.toLocaleString()} tokens`:_+=`${j}% reduction from reuse`,n.push(_)}n.push("")}let Fe=b[0]?.id,Xe=O.map((_,g)=>{let S=g===0?null:b[g+1];return{..._,displayEpoch:S?S.created_at_epoch:_.created_at_epoch,displayTime:S?S.created_at:_.created_at,shouldShowLink:_.id!==Fe}}),We=new Set(u.slice(0,s.fullObservationCount).map(_=>_.id)),pe=[...m.map(_=>({type:"observation",data:_})),...Xe.map(_=>({type:"summary",data:_}))];pe.sort((_,g)=>{let S=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch,U=g.type==="observation"?g.data.created_at_epoch:g.data.displayEpoch;return S-U});let Y=new Map;for(let _ of pe){let g=_.type==="observation"?_.data.created_at:_.data.displayTime,S=Ue(g);Y.has(S)||Y.set(S,[]),Y.get(S).push(_)}let Pe=Array.from(Y.entries()).sort((_,g)=>{let S=new Date(_[0]).getTime(),U=new Date(g[0]).getTime();return S-U});for(let[_,g]of Pe){e?(n.push(`${a.bright}${a.cyan}${_}${a.reset}`),n.push("")):(n.push(`### ${_}`),n.push(""));let S=null,U="",x=!1;for(let re of g)if(re.type==="summary"){x&&(n.push(""),x=!1,S=null,U="");let E=re.data,$=`${E.request||"Session started"} (${De(E.displayTime)})`;e?n.push(`\u{1F3AF} ${a.yellow}#S${E.id}${a.reset} ${$}`):n.push(`**\u{1F3AF} #S${E.id}** ${$}`),n.push("")}else{let E=re.data,$=ke(E.files_modified,t);$!==S&&(x&&n.push(""),e?n.push(`${a.dim}${$}${a.reset}`):n.push(`**${$}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),S=$,x=!0,U="");let F=Me(E.created_at),K=E.title||"Untitled",V=X.getInstance().getTypeIcon(E.type),He=(E.title?.length||0)+(E.subtitle?.length||0)+(E.narrative?.length||0)+JSON.stringify(E.facts||[]).length,W=Math.ceil(He/$e),P=E.discovery_tokens||0,ne=X.getInstance().getWorkEmoji(E.type),Ee=P>0?`${ne} ${P.toLocaleString()}`:"-",oe=F!==U,me=oe?F:"";if(U=F,We.has(E.id)){let k=s.fullObservationField==="narrative"?E.narrative:E.facts?le(E.facts).join(`
`):null;if(e){let I=oe?`${a.dim}${F}${a.reset}`:" ".repeat(F.length),J=s.showReadTokens&&W>0?`${a.dim}(~${W}t)${a.reset}`:"",Te=s.showWorkTokens&&P>0?`${a.dim}(${ne} ${P.toLocaleString()}t)${a.reset}`:"";n.push(`  ${a.dim}#${E.id}${a.reset}  ${I}  ${V}  ${a.bright}${K}${a.reset}`),k&&n.push(`    ${a.dim}${k}${a.reset}`),(J||Te)&&n.push(`    ${J} ${Te}`),n.push("")}else{x&&(n.push(""),x=!1),n.push(`**#${E.id}** ${me||"\u2033"} ${V} **${K}**`),k&&(n.push(""),n.push(k),n.push(""));let I=[];s.showReadTokens&&I.push(`Read: ~${W}`),s.showWorkTokens&&I.push(`Work: ${Ee}`),I.length>0&&n.push(I.join(", ")),n.push(""),S=null}}else if(e){let k=oe?`${a.dim}${F}${a.reset}`:" ".repeat(F.length),I=s.showReadTokens&&W>0?`${a.dim}(~${W}t)${a.reset}`:"",J=s.showWorkTokens&&P>0?`${a.dim}(${ne} ${P.toLocaleString()}t)${a.reset}`:"";n.push(`  ${a.dim}#${E.id}${a.reset}  ${k}  ${V}  ${K} ${I} ${J}`)}else{let k=s.showReadTokens?`~${W}`:"",I=s.showWorkTokens?Ee:"";n.push(`| #${E.id} | ${me||"\u2033"} | ${V} | ${K} | ${k} | ${I} |`)}}x&&n.push("")}let L=b[0],ue=u[0];if(s.showLastSummary&&L&&(L.investigated||L.learned||L.completed||L.next_steps)&&(!ue||L.created_at_epoch>ue.created_at_epoch)&&(n.push(...ee("Investigated",L.investigated,a.blue,e)),n.push(...ee("Learned",L.learned,a.yellow,e)),n.push(...ee("Completed",L.completed,a.green,e)),n.push(...ee("Next Steps",L.next_steps,a.magenta,e))),R&&(n.push(""),n.push("---"),n.push(""),e?(n.push(`${a.bright}${a.magenta}\u{1F4CB} Previously${a.reset}`),n.push(""),n.push(`${a.dim}A: ${R}${a.reset}`)):(n.push("**\u{1F4CB} Previously**"),n.push(""),n.push(`A: ${R}`)),n.push("")),_e&&N>0&&y>0){let _=Math.round(N/1e3);n.push(""),e?n.push(`${a.dim}\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${v.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${a.reset}`):n.push(`\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${v.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return o?.close(),n.join(`
`).trimEnd()}0&&(module.exports={generateContext});
