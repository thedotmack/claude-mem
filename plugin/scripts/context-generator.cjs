"use strict";var rs=Object.create;var Z=Object.defineProperty;var ns=Object.getOwnPropertyDescriptor;var os=Object.getOwnPropertyNames;var is=Object.getPrototypeOf,as=Object.prototype.hasOwnProperty;var K=(d,e)=>()=>(d&&(e=d(d=0)),e);var Le=(d,e)=>{for(var s in e)Z(d,s,{get:e[s],enumerable:!0})},Ce=(d,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of os(e))!as.call(d,r)&&r!==s&&Z(d,r,{get:()=>e[r],enumerable:!(t=ns(e,r))||t.enumerable});return d};var ce=(d,e,s)=>(s=d!=null?rs(is(d)):{},Ce(e||!d||!d.__esModule?Z(s,"default",{value:d,enumerable:!0}):s,d)),ds=d=>Ce(Z({},"__esModule",{value:!0}),d);var pe,_e,ve,ye,Me,De,ue=K(()=>{"use strict";pe=["bugfix","feature","refactor","discovery","decision","change"],_e=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],ve={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},ye={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},Me=pe.join(","),De=_e.join(",")});var le,me,R,B=K(()=>{"use strict";ee();le=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(le||{}),me=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let e=$.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=le[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),a=String(e.getMinutes()).padStart(2,"0"),c=String(e.getSeconds()).padStart(2,"0"),u=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${r} ${i}:${a}:${c}.${u}`}log(e,s,t,r,i){if(e<this.getLevel())return;let a=this.formatTimestamp(new Date),c=le[e].padEnd(5),u=s.padEnd(6),l="";r?.correlationId?l=`[${r.correlationId}] `:r?.sessionId&&(l=`[session-${r.sessionId}] `);let S="";i!=null&&(this.getLevel()===0&&typeof i=="object"?S=`
`+JSON.stringify(i,null,2):S=" "+this.formatData(i));let b="";if(r){let{sessionId:E,sdkSessionId:I,correlationId:T,...p}=r;Object.keys(p).length>0&&(b=` {${Object.entries(p).map(([P,j])=>`${P}=${j}`).join(", ")}}`)}let f=`[${a}] [${c}] [${u}] ${l}${t}${b}${S}`;e===3?console.error(f):console.log(f)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}happyPathError(e,s,t,r,i=""){let l=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),S=l?`${l[1].split("/").pop()}:${l[2]}`:"unknown",b={...t,location:S};return this.warn(e,`[HAPPY-PATH] ${s}`,b,r),i}},R=new me});var G,ke,Ue,$,ee=K(()=>{"use strict";G=require("fs"),ke=require("path"),Ue=require("os");ue();B();$=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:(0,ke.join)((0,Ue.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:Me,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:De,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){if(!(0,G.existsSync)(e))return this.getAllDefaults();let s=(0,G.readFileSync)(e,"utf-8"),t=JSON.parse(s),r=t;if(t.env&&typeof t.env=="object"){r=t.env;try{(0,G.writeFileSync)(e,JSON.stringify(r,null,2),"utf-8"),R.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(a){R.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},a)}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))r[a]!==void 0&&(i[a]=r[a]);return i}}});function cs(){return typeof __dirname<"u"?__dirname:(0,O.dirname)((0,we.fileURLToPath)(_s.url))}function Pe(d){(0,xe.mkdirSync)(d,{recursive:!0})}function je(){return(0,O.join)(ps,"..","..")}var O,$e,xe,we,_s,ps,y,Ee,Ds,ks,Us,$s,xs,ws,Fe,Fs,Ps,js,Xs,Te=K(()=>{"use strict";O=require("path"),$e=require("os"),xe=require("fs"),we=require("url");ee();_s={};ps=cs(),y=$.get("CLAUDE_MEM_DATA_DIR"),Ee=process.env.CLAUDE_CONFIG_DIR||(0,O.join)((0,$e.homedir)(),".claude"),Ds=(0,O.join)(y,"archives"),ks=(0,O.join)(y,"logs"),Us=(0,O.join)(y,"trash"),$s=(0,O.join)(y,"backups"),xs=(0,O.join)(y,"modes"),ws=(0,O.join)(y,"settings.json"),Fe=(0,O.join)(y,"claude-mem.db"),Fs=(0,O.join)(y,"vector-db"),Ps=(0,O.join)(Ee,"settings.json"),js=(0,O.join)(Ee,"commands"),Xs=(0,O.join)(Ee,"CLAUDE.md")});var Ke={};Le(Ke,{ModeManager:()=>be});var te,Se,be,qe=K(()=>{"use strict";te=require("fs"),Se=require("path");B();Te();be=class d{static instance=null;modeCache=new Map;modesDir;constructor(){this.modesDir=(0,Se.join)(je(),"modes")}static getInstance(){return d.instance||(d.instance=new d),d.instance}loadMode(e){let s=this.modeCache.get(e);if(s)return s;let t=(0,Se.join)(this.modesDir,`${e}.json`);if(!(0,te.existsSync)(t)){if(R.warn("SYSTEM",`Mode file not found: ${t}, falling back to 'code'`),e==="code")throw new Error("Critical: code.json mode file missing");return this.loadMode("code")}try{let r=(0,te.readFileSync)(t,"utf-8"),i=JSON.parse(r);return this.modeCache.set(e,i),R.debug("SYSTEM",`Loaded mode: ${i.name} (${e})`,void 0,{types:i.observation_types.map(a=>a.id),concepts:i.observation_concepts.map(a=>a.id)}),i}catch(r){if(R.error("SYSTEM",`Failed to load mode: ${t}`,void 0,r),e==="code")throw r;return this.loadMode("code")}}getObservationTypes(e){return this.loadMode(e).observation_types}getObservationConcepts(e){return this.loadMode(e).observation_concepts}getTypeIcon(e,s){return this.getObservationTypes(e).find(r=>r.id===s)?.emoji||"\u{1F4DD}"}getWorkEmoji(e,s){return this.getObservationTypes(e).find(r=>r.id===s)?.work_emoji||"\u{1F4DD}"}validateType(e,s){return this.getObservationTypes(e).some(t=>t.id===s)}getTypeLabel(e,s){return this.getObservationTypes(e).find(r=>r.id===s)?.label||s}}});var Ss={};Le(Ss,{generateContext:()=>hs});module.exports=ds(Ss);var ne=ce(require("path"),1),oe=require("os"),Y=require("fs");var Xe=require("bun:sqlite");Te();B();var se=class{db;constructor(){Pe(y),this.db=new Xe.Database(Fe),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.ensureMetadataJsonColumn(),this.removeObservationsTypeCheckConstraint()}initializeSchema(){try{this.db.run(`
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
            type TEXT NOT NULL,
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.log("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.log("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(u=>u.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.log("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(u=>u.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(u=>u.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.log("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.log("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(r){throw this.db.run("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.log("[SessionStore] Adding hierarchical fields to observations table..."),this.db.run(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.log("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.log("[SessionStore] Making observations.text nullable..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
          CREATE TABLE observations_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sdk_session_id TEXT NOT NULL,
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.log("[SessionStore] Successfully made observations.text nullable")}catch(r){throw this.db.run("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.log("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.log("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.run("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}createPendingMessagesTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}console.log("[SessionStore] Creating pending_messages table..."),this.db.run(`
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
      `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(claude_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),console.log("[SessionStore] pending_messages table created successfully")}catch(e){throw console.error("[SessionStore] Pending messages table migration error:",e.message),e}}ensureMetadataJsonColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="metadata_json")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN metadata_json TEXT"),console.log("[SessionStore] Added metadata_json column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString())}catch(e){console.error("[SessionStore] Metadata JSON migration error:",e.message)}}removeObservationsTypeCheckConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(18))return;let t=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations'").get()?.sql;if(!t){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(18,new Date().toISOString());return}if(!/CHECK\s*\(\s*type\s+IN\s*\(/i.test(t)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(18,new Date().toISOString());return}console.log("[SessionStore] Removing CHECK constraint from observations.type...");let i=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='observations' AND sql IS NOT NULL").all().map(c=>c.sql).filter(Boolean),a=t.replace(/type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*type\s+IN\s*\([^)]+\)\s*\)/i,"type TEXT NOT NULL").replace(/CHECK\s*\(\s*type\s+IN\s*\([^)]+\)\s*\)/i,"");if(/CHECK\s*\(\s*type\s+IN\s*\(/i.test(a)){console.error("[SessionStore] Failed to rewrite observations schema; CHECK constraint still present.");return}this.db.run("BEGIN TRANSACTION");try{this.db.run("ALTER TABLE observations RENAME TO observations_old"),this.db.run(a);let u=this.db.prepare("PRAGMA table_info(observations_old)").all().map(l=>l.name).map(l=>`"${l}"`).join(", ");this.db.run(`
          INSERT INTO observations (${u})
          SELECT ${u}
          FROM observations_old
          WHERE sdk_session_id IN (SELECT sdk_session_id FROM sdk_sessions)
        `),this.db.run("DROP TABLE observations_old");for(let l of i)this.db.run(l);this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(18,new Date().toISOString()),console.log("[SessionStore] observations.type CHECK constraint removed")}catch(c){throw this.db.run("ROLLBACK"),c}}catch(e){console.error("[SessionStore] Migration error (remove type CHECK constraint):",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:i,type:a,concepts:c,files:u}=s,l=t==="date_asc"?"ASC":"DESC",S=r?`LIMIT ${r}`:"",b=e.map(()=>"?").join(","),f=[...e],E=[];if(i&&(E.push("project = ?"),f.push(i)),a)if(Array.isArray(a)){let p=a.map(()=>"?").join(",");E.push(`type IN (${p})`),f.push(...a)}else E.push("type = ?"),f.push(a);if(c){let p=Array.isArray(c)?c:[c],L=p.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");f.push(...p),E.push(`(${L.join(" OR ")})`)}if(u){let p=Array.isArray(u)?u:[u],L=p.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");p.forEach(P=>{f.push(`%${P}%`,`%${P}%`)}),E.push(`(${L.join(" OR ")})`)}let I=E.length>0?`WHERE id IN (${b}) AND ${E.join(" AND ")}`:`WHERE id IN (${b})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${I}
      ORDER BY created_at_epoch ${l}
      ${S}
    `).all(...f)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),r=new Set,i=new Set;for(let a of t){if(a.files_read)try{let c=JSON.parse(a.files_read);Array.isArray(c)&&c.forEach(u=>r.add(u))}catch{}if(a.files_modified)try{let c=JSON.parse(a.files_modified);Array.isArray(c)&&c.forEach(u=>i.add(u))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)||null}getSessionDbIdByClaudeId(e){return this.findAnySDKSession(e)?.id??null}reactivateSession(e,s){this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t,r){let i=new Date,a=i.getTime(),c=r?JSON.stringify({mode:r}):null,l=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(e,e,s,t,i.toISOString(),a,c);if(l.lastInsertRowid===0||l.changes===0){if(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),r){let E=this.db.prepare("SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1").get(e);E&&this.setSessionMode(E.id,r)}return this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id}return l.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(R.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}setSessionMode(e,s){let r=this.db.prepare("SELECT metadata_json FROM sdk_sessions WHERE id = ?").get(e),i={};if(r?.metadata_json)try{i=JSON.parse(r.metadata_json)}catch{}i.mode=s,this.db.prepare("UPDATE sdk_sessions SET metadata_json = ? WHERE id = ?").run(JSON.stringify(i),e)}getSessionMode(e){let t=this.db.prepare("SELECT metadata_json FROM sdk_sessions WHERE id = ?").get(e);if(t?.metadata_json)try{return JSON.parse(t.metadata_json).mode}catch{return}}getSessionModeByClaudeSessionId(e){let t=this.db.prepare("SELECT metadata_json FROM sdk_sessions WHERE claude_session_id = ?").get(e);if(t?.metadata_json)try{return JSON.parse(t.metadata_json).mode}catch{return}}saveUserPrompt(e,s,t){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,i=0){let a=new Date,c=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),c),console.log(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,i,a.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,t,r,i=0){let a=new Date,c=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),c),console.log(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,i,a.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:i}=s,a=t==="date_asc"?"ASC":"DESC",c=r?`LIMIT ${r}`:"",u=e.map(()=>"?").join(","),l=[...e],S=i?`WHERE id IN (${u}) AND project = ?`:`WHERE id IN (${u})`;return i&&l.push(i),this.db.prepare(`
      SELECT * FROM session_summaries
      ${S}
      ORDER BY created_at_epoch ${a}
      ${c}
    `).all(...l)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:i}=s,a=t==="date_asc"?"ASC":"DESC",c=r?`LIMIT ${r}`:"",u=e.map(()=>"?").join(","),l=[...e],S=i?"AND s.project = ?":"";return i&&l.push(i),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${u}) ${S}
      ORDER BY up.created_at_epoch ${a}
      ${c}
    `).all(...l)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let a=i?"AND project = ?":"",c=i?[i]:[],u,l;if(e!==null){let E=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${a}
        ORDER BY id DESC
        LIMIT ?
      `,I=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${a}
        ORDER BY id ASC
        LIMIT ?
      `;try{let T=this.db.prepare(E).all(e,...c,t+1),p=this.db.prepare(I).all(e,...c,r+1);if(T.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};u=T.length>0?T[T.length-1].created_at_epoch:s,l=p.length>0?p[p.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary observations:",T.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}else{let E=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${a}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,I=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${a}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let T=this.db.prepare(E).all(s,...c,t),p=this.db.prepare(I).all(s,...c,r+1);if(T.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};u=T.length>0?T[T.length-1].created_at_epoch:s,l=p.length>0?p[p.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary timestamps:",T.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}let S=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,f=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let E=this.db.prepare(S).all(u,l,...c),I=this.db.prepare(b).all(u,l,...c),T=this.db.prepare(f).all(u,l,...c);return{observations:E,sessions:I.map(p=>({id:p.id,sdk_session_id:p.sdk_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:T.map(p=>({id:p.id,claude_session_id:p.claude_session_id,prompt_number:p.prompt_number,prompt_text:p.prompt_text,project:p.project,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}catch(E){return console.error("[SessionStore] Error querying timeline records:",E.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
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
    `).run(e.claude_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};ue();B();ee();var ge=ce(require("path"),1);function he(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function He(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function We(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Be(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function us(d,e){return ge.default.isAbsolute(d)?ge.default.relative(e,d):d}function Ge(d,e){let s=he(d);return s.length>0?us(s[0],e):"General"}var Ye=ce(require("path"),1);B();function Ve(d){if(process.env.CLAUDE_MEM_PROJECT)return process.env.CLAUDE_MEM_PROJECT;if(!d||d.trim()==="")return R.warn("PROJECT_NAME","Empty cwd provided, using fallback",{cwd:d}),"unknown-project";let e=Ye.default.basename(d);if(e==="")if(process.platform==="win32"&&d.match(/^[A-Z]:\\/i)){let r=`drive-${d[0].toUpperCase()}`;return R.info("PROJECT_NAME","Drive root detected",{cwd:d,projectName:r}),r}else return R.warn("PROJECT_NAME","Root directory detected, using fallback",{cwd:d}),"unknown-project";return e}var ls=ne.default.join((0,oe.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function ms(){let d=ne.default.join((0,oe.homedir)(),".claude-mem","settings.json"),e=$.loadFromFile(d);try{return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(s=>s.trim()).filter(Boolean)),observationConcepts:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(s=>s.trim()).filter(Boolean)),fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(s){return R.warn("WORKER","Failed to load context settings, using defaults",{},s),{totalObservationCount:50,fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(pe),observationConcepts:new Set(_e),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1}}}var Je=4,Es=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function re(d,e,s,t){return e?t?[`${s}${d}:${o.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}function Ts(d){return d.replace(/\//g,"-")}function gs(d){try{if(!(0,Y.existsSync)(d))return{userMessage:"",assistantMessage:""};let e=(0,Y.readFileSync)(d,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim()),t="";for(let r=s.length-1;r>=0;r--)try{let i=s[r];if(!i.includes('"type":"assistant"'))continue;let a=JSON.parse(i);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let c="";for(let u of a.message.content)u.type==="text"&&(c+=u.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){t=c;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return R.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:d},e),{userMessage:"",assistantMessage:""}}}async function hs(d,e=!1){let s=ms(),t=d?.cwd??process.cwd(),r=Ve(t),i=d?.mode||"code",a=null;try{a=new se}catch(A){if(A.code==="ERR_DLOPEN_FAILED"){try{(0,Y.unlinkSync)(ls)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw A}let{ModeManager:c}=await Promise.resolve().then(()=>(qe(),Ke)),l=c.getInstance().loadMode(i),S=l.observation_types.map(A=>A.id),b=l.observation_concepts.map(A=>A.id),f=S,E=f.map(()=>"?").join(","),I=b,T=I.map(()=>"?").join(","),p=a.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${E})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${T})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,...f,...I,s.totalObservationCount),L=a.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,s.sessionCount+Es),P="",j="";if(s.showLastMessage&&p.length>0)try{let A=d?.session_id,M=p.find(N=>N.sdk_session_id!==A);if(M){let N=M.sdk_session_id,D=Ts(t),X=ne.default.join((0,oe.homedir)(),".claude","projects",D,`${N}.jsonl`),V=gs(X);P=V.userMessage,j=V.assistantMessage}}catch{}if(p.length===0&&L.length===0)return a?.close(),e?`
${o.bright}${o.cyan}[${r}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let Qe=L.slice(0,s.sessionCount),fe=p,n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}[${r}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),fe.length>0){e?n.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):n.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),n.push(""),e?(n.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),n.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),n.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),n.push(""),n.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),n.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),n.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),n.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let A=p.length,M=p.reduce((_,g)=>{let h=(g.title?.length||0)+(g.subtitle?.length||0)+(g.narrative?.length||0)+JSON.stringify(g.facts||[]).length;return _+Math.ceil(h/Je)},0),N=p.reduce((_,g)=>_+(g.discovery_tokens||0),0),D=N-M,X=N>0?Math.round(D/N*100):0,V=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(V)if(e){if(n.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),n.push(`${o.dim}  Loading: ${A} observations (${M.toLocaleString()} tokens to read)${o.reset}`),n.push(`${o.dim}  Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),N>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${D.toLocaleString()} tokens (${X}% reduction from reuse)`:s.showSavingsAmount?_+=`${D.toLocaleString()} tokens`:_+=`${X}% reduction from reuse`,n.push(`${o.green}${_}${o.reset}`)}n.push("")}else{if(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${A} observations (${M.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${N.toLocaleString()} tokens spent on research, building, and decisions`),N>0&&(s.showSavingsAmount||s.showSavingsPercent)){let _="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?_+=`${D.toLocaleString()} tokens (${X}% reduction from reuse)`:s.showSavingsAmount?_+=`${D.toLocaleString()} tokens`:_+=`${X}% reduction from reuse`,n.push(_)}n.push("")}let ze=L[0]?.id,Ze=Qe.map((_,g)=>{let h=g===0?null:L[g+1];return{..._,displayEpoch:h?h.created_at_epoch:_.created_at_epoch,displayTime:h?h.created_at:_.created_at,shouldShowLink:_.id!==ze}}),es=new Set(p.slice(0,s.fullObservationCount).map(_=>_.id)),Oe=[...fe.map(_=>({type:"observation",data:_})),...Ze.map(_=>({type:"summary",data:_}))];Oe.sort((_,g)=>{let h=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch,k=g.type==="observation"?g.data.created_at_epoch:g.data.displayEpoch;return h-k});let q=new Map;for(let _ of Oe){let g=_.type==="observation"?_.data.created_at:_.data.displayTime,h=Be(g);q.has(h)||q.set(h,[]),q.get(h).push(_)}let ss=Array.from(q.entries()).sort((_,g)=>{let h=new Date(_[0]).getTime(),k=new Date(g[0]).getTime();return h-k});for(let[_,g]of ss){e?(n.push(`${o.bright}${o.cyan}${_}${o.reset}`),n.push("")):(n.push(`### ${_}`),n.push(""));let h=null,k="",x=!1;for(let ie of g)if(ie.type==="summary"){x&&(n.push(""),x=!1,h=null,k="");let m=ie.data,w=`${m.request||"Session started"} (${He(m.displayTime)})`;e?n.push(`\u{1F3AF} ${o.yellow}#S${m.id}${o.reset} ${w}`):n.push(`**\u{1F3AF} #S${m.id}** ${w}`),n.push("")}else{let m=ie.data,w=Ge(m.files_modified,t);w!==h&&(x&&n.push(""),e?n.push(`${o.dim}${w}${o.reset}`):n.push(`**${w}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),h=w,x=!0,k="");let F=We(m.created_at),J=m.title||"Untitled",Q=ve[m.type]||"\u2022",ts=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length,H=Math.ceil(ts/Je),W=m.discovery_tokens||0,ae=ye[m.type]||"\u{1F50D}",Ne=W>0?`${ae} ${W.toLocaleString()}`:"-",de=F!==k,Ae=de?F:"";if(k=F,es.has(m.id)){let U=s.fullObservationField==="narrative"?m.narrative:m.facts?he(m.facts).join(`
`):null;if(e){let v=de?`${o.dim}${F}${o.reset}`:" ".repeat(F.length),z=s.showReadTokens&&H>0?`${o.dim}(~${H}t)${o.reset}`:"",Ie=s.showWorkTokens&&W>0?`${o.dim}(${ae} ${W.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${m.id}${o.reset}  ${v}  ${Q}  ${o.bright}${J}${o.reset}`),U&&n.push(`    ${o.dim}${U}${o.reset}`),(z||Ie)&&n.push(`    ${z} ${Ie}`),n.push("")}else{x&&(n.push(""),x=!1),n.push(`**#${m.id}** ${Ae||"\u2033"} ${Q} **${J}**`),U&&(n.push(""),n.push(U),n.push(""));let v=[];s.showReadTokens&&v.push(`Read: ~${H}`),s.showWorkTokens&&v.push(`Work: ${Ne}`),v.length>0&&n.push(v.join(", ")),n.push(""),h=null}}else if(e){let U=de?`${o.dim}${F}${o.reset}`:" ".repeat(F.length),v=s.showReadTokens&&H>0?`${o.dim}(~${H}t)${o.reset}`:"",z=s.showWorkTokens&&W>0?`${o.dim}(${ae} ${W.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${m.id}${o.reset}  ${U}  ${Q}  ${J} ${v} ${z}`)}else{let U=s.showReadTokens?`~${H}`:"",v=s.showWorkTokens?Ne:"";n.push(`| #${m.id} | ${Ae||"\u2033"} | ${Q} | ${J} | ${U} | ${v} |`)}}x&&n.push("")}let C=L[0],Re=p[0];if(s.showLastSummary&&C&&(C.investigated||C.learned||C.completed||C.next_steps)&&(!Re||C.created_at_epoch>Re.created_at_epoch)&&(n.push(...re("Investigated",C.investigated,o.blue,e)),n.push(...re("Learned",C.learned,o.yellow,e)),n.push(...re("Completed",C.completed,o.green,e)),n.push(...re("Next Steps",C.next_steps,o.magenta,e))),j&&(n.push(""),n.push("---"),n.push(""),e?(n.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),n.push(""),n.push(`${o.dim}A: ${j}${o.reset}`)):(n.push("**\u{1F4CB} Previously**"),n.push(""),n.push(`A: ${j}`)),n.push("")),V&&N>0&&D>0){let _=Math.round(N/1e3);n.push(""),e?n.push(`${o.dim}\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${M.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):n.push(`\u{1F4B0} Access ${_}k tokens of past research & decisions for just ${M.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return a?.close(),n.join(`
`).trimEnd()}0&&(module.exports={generateContext});
