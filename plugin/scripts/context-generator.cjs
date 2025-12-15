"use strict";var we=Object.create;var K=Object.defineProperty;var Fe=Object.getOwnPropertyDescriptor;var Pe=Object.getOwnPropertyNames;var Xe=Object.getPrototypeOf,We=Object.prototype.hasOwnProperty;var je=(c,e)=>{for(var s in e)K(c,s,{get:e[s],enumerable:!0})},le=(c,e,s,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Pe(e))!We.call(c,n)&&n!==s&&K(c,n,{get:()=>e[n],enumerable:!(r=Fe(e,n))||r.enumerable});return c};var me=(c,e,s)=>(s=c!=null?we(Xe(c)):{},le(e||!c||!c.__esModule?K(s,"default",{value:c,enumerable:!0}):s,c)),Be=c=>le(K({},"__esModule",{value:!0}),c);var Ze={};je(Ze,{generateContext:()=>ze});module.exports=Be(Ze);var B=me(require("path"),1),Q=require("os"),W=require("fs");var Ie=require("bun:sqlite");var O=require("path"),fe=require("os"),Oe=require("fs");var Re=require("url");var X=require("fs"),Se=require("path"),be=require("os");var se=["bugfix","feature","refactor","discovery","decision","change"],te=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],Ee={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},Te={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},ge=se.join(","),he=te.join(",");var re=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(re||{}),ne=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let e=k.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=re[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let r=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&r.command){let n=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${e}(${n})`}if(e==="Read"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Edit"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Write"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}return e}catch{return e}}formatTimestamp(e){let s=e.getFullYear(),r=String(e.getMonth()+1).padStart(2,"0"),n=String(e.getDate()).padStart(2,"0"),i=String(e.getHours()).padStart(2,"0"),a=String(e.getMinutes()).padStart(2,"0"),d=String(e.getSeconds()).padStart(2,"0"),u=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${r}-${n} ${i}:${a}:${d}.${u}`}log(e,s,r,n,i){if(e<this.getLevel())return;let a=this.formatTimestamp(new Date),d=re[e].padEnd(5),u=s.padEnd(6),_="";n?.correlationId?_=`[${n.correlationId}] `:n?.sessionId&&(_=`[session-${n.sessionId}] `);let l="";i!=null&&(this.getLevel()===0&&typeof i=="object"?l=`
`+JSON.stringify(i,null,2):l=" "+this.formatData(i));let E="";if(n){let{sessionId:T,sdkSessionId:A,correlationId:g,...t}=n;Object.keys(t).length>0&&(E=` {${Object.entries(t).map(([R,f])=>`${R}=${f}`).join(", ")}}`)}let b=`[${a}] [${d}] [${u}] ${_}${r}${E}${l}`;e===3?console.error(b):console.log(b)}debug(e,s,r,n){this.log(0,e,s,r,n)}info(e,s,r,n){this.log(1,e,s,r,n)}warn(e,s,r,n){this.log(2,e,s,r,n)}error(e,s,r,n){this.log(3,e,s,r,n)}dataIn(e,s,r,n){this.info(e,`\u2192 ${s}`,r,n)}dataOut(e,s,r,n){this.info(e,`\u2190 ${s}`,r,n)}success(e,s,r,n){this.info(e,`\u2713 ${s}`,r,n)}failure(e,s,r,n){this.error(e,`\u2717 ${s}`,r,n)}timing(e,s,r,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${r}ms`})}happyPathError(e,s,r,n,i=""){let _=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),l=_?`${_[1].split("/").pop()}:${_[2]}`:"unknown",E={...r,location:l};return this.warn(e,`[HAPPY-PATH] ${s}`,E,n),i}},M=new ne;var k=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-sonnet-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:(0,Se.join)((0,be.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:ge,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:he,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){if(!(0,X.existsSync)(e))return this.getAllDefaults();let s=(0,X.readFileSync)(e,"utf-8"),r=JSON.parse(s),n=r;if(r.env&&typeof r.env=="object"){n=r.env;try{(0,X.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),M.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(a){M.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},a)}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))n[a]!==void 0&&(i[a]=n[a]);return i}};var Ge={};function He(){return typeof __dirname<"u"?__dirname:(0,O.dirname)((0,Re.fileURLToPath)(Ge.url))}var _s=He(),C=k.get("CLAUDE_MEM_DATA_DIR"),oe=process.env.CLAUDE_CONFIG_DIR||(0,O.join)((0,fe.homedir)(),".claude"),ls=(0,O.join)(C,"archives"),ms=(0,O.join)(C,"logs"),Es=(0,O.join)(C,"trash"),Ts=(0,O.join)(C,"backups"),gs=(0,O.join)(C,"settings.json"),Ne=(0,O.join)(C,"claude-mem.db"),hs=(0,O.join)(C,"vector-db"),Ss=(0,O.join)(oe,"settings.json"),bs=(0,O.join)(oe,"commands"),fs=(0,O.join)(oe,"CLAUDE.md");function Ae(c){(0,Oe.mkdirSync)(c,{recursive:!0})}var q=class{db;constructor(){Ae(C),this.db=new Ie.Database(Ne),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(r=>r.version)):0)===0&&(console.log("[SessionStore] Initializing fresh database with migration004..."),this.db.run(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.log("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.log("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(u=>u.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.log("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(u=>u.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(u=>u.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.log("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.log("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.log("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(n){throw this.db.run("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.log("[SessionStore] Adding hierarchical fields to observations table..."),this.db.run(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.log("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.log("[SessionStore] Making observations.text nullable..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.log("[SessionStore] Successfully made observations.text nullable")}catch(n){throw this.db.run("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.log("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.log("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(r){throw this.db.run("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.log("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).all().map(r=>r.project)}getLatestUserPrompt(e){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:i,type:a,concepts:d,files:u}=s,_=r==="date_asc"?"ASC":"DESC",l=n?`LIMIT ${n}`:"",E=e.map(()=>"?").join(","),b=[...e],T=[];if(i&&(T.push("project = ?"),b.push(i)),a)if(Array.isArray(a)){let t=a.map(()=>"?").join(",");T.push(`type IN (${t})`),b.push(...a)}else T.push("type = ?"),b.push(a);if(d){let t=Array.isArray(d)?d:[d],N=t.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");b.push(...t),T.push(`(${N.join(" OR ")})`)}if(u){let t=Array.isArray(u)?u:[u],N=t.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");t.forEach(R=>{b.push(`%${R}%`,`%${R}%`)}),T.push(`(${N.join(" OR ")})`)}let A=T.length>0?`WHERE id IN (${E}) AND ${T.join(" AND ")}`:`WHERE id IN (${E})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${A}
      ORDER BY created_at_epoch ${_}
      ${l}
    `).all(...b)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let r=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,i=new Set;for(let a of r){if(a.files_read)try{let d=JSON.parse(a.files_read);Array.isArray(d)&&d.forEach(u=>n.add(u))}catch{}if(a.files_modified)try{let d=JSON.parse(a.files_modified);Array.isArray(d)&&d.forEach(u=>i.add(u))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,r){let n=new Date,i=n.getTime(),d=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,r,n.toISOString(),i);return d.lastInsertRowid===0||d.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,r,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):d.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(M.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,r){let n=new Date,i=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,r,n.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,r,n,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.log(`[SessionStore] Auto-created session record for session_id: ${e}`));let E=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),n||null,i,a.toISOString(),d);return{id:Number(E.lastInsertRowid),createdAtEpoch:d}}storeSummary(e,s,r,n,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.log(`[SessionStore] Auto-created session record for session_id: ${e}`));let E=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,i,a.toISOString(),d);return{id:Number(E.lastInsertRowid),createdAtEpoch:d}}markSessionCompleted(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}markSessionFailed(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:i}=s,a=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),_=[...e],l=i?`WHERE id IN (${u}) AND project = ?`:`WHERE id IN (${u})`;return i&&_.push(i),this.db.prepare(`
      SELECT * FROM session_summaries
      ${l}
      ORDER BY created_at_epoch ${a}
      ${d}
    `).all(..._)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:i}=s,a=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),_=[...e],l=i?"AND s.project = ?":"";return i&&_.push(i),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${u}) ${l}
      ORDER BY up.created_at_epoch ${a}
      ${d}
    `).all(..._)}getTimelineAroundTimestamp(e,s=10,r=10,n){return this.getTimelineAroundObservation(null,e,s,r,n)}getTimelineAroundObservation(e,s,r=10,n=10,i){let a=i?"AND project = ?":"",d=i?[i]:[],u,_;if(e!==null){let T=`
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
      `;try{let g=this.db.prepare(T).all(e,...d,r+1),t=this.db.prepare(A).all(e,...d,n+1);if(g.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};u=g.length>0?g[g.length-1].created_at_epoch:s,_=t.length>0?t[t.length-1].created_at_epoch:s}catch(g){return console.error("[SessionStore] Error getting boundary observations:",g.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}else{let T=`
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
      `;try{let g=this.db.prepare(T).all(s,...d,r),t=this.db.prepare(A).all(s,...d,n+1);if(g.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};u=g.length>0?g[g.length-1].created_at_epoch:s,_=t.length>0?t[t.length-1].created_at_epoch:s}catch(g){return console.error("[SessionStore] Error getting boundary timestamps:",g.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,E=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let T=this.db.prepare(l).all(u,_,...d),A=this.db.prepare(E).all(u,_,...d),g=this.db.prepare(b).all(u,_,...d);return{observations:T,sessions:A.map(t=>({id:t.id,sdk_session_id:t.sdk_session_id,project:t.project,request:t.request,completed:t.completed,next_steps:t.next_steps,created_at:t.created_at,created_at_epoch:t.created_at_epoch})),prompts:g.map(t=>({id:t.id,claude_session_id:t.claude_session_id,prompt_number:t.prompt_number,prompt_text:t.prompt_text,project:t.project,created_at:t.created_at,created_at_epoch:t.created_at_epoch}))}}catch(T){return console.error("[SessionStore] Error querying timeline records:",T.message,i?`(project: ${i})`:"(all projects)"),{observations:[],sessions:[],prompts:[]}}}getPromptById(e){return this.db.prepare(`
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
    `).get(e)||null}close(){this.db.close()}};var ie=me(require("path"),1);function ae(c){if(!c)return[];try{let e=JSON.parse(c);return Array.isArray(e)?e:[]}catch{return[]}}function Le(c){return new Date(c).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Ce(c){return new Date(c).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ye(c){return new Date(c).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ye(c,e){return ie.default.isAbsolute(c)?ie.default.relative(e,c):c}function ve(c,e){let s=ae(c);return s.length>0?Ye(s[0],e):"General"}var Ve=B.default.join((0,Q.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ke(){let c=B.default.join((0,Q.homedir)(),".claude-mem","settings.json"),e=k.loadFromFile(c);try{return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(s=>s.trim()).filter(Boolean)),observationConcepts:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(s=>s.trim()).filter(Boolean)),fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(s){return M.warn("WORKER","Failed to load context settings, using defaults",{},s),{totalObservationCount:50,fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(se),observationConcepts:new Set(te),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1}}}var De=4,qe=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function J(c,e,s,r){return e?r?[`${s}${c}:${o.reset} ${e}`,""]:[`**${c}**: ${e}`,""]:[]}function Je(c){return c.replace(/\//g,"-")}function Qe(c){try{if(!(0,W.existsSync)(c))return{userMessage:"",assistantMessage:""};let e=(0,W.readFileSync)(c,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),r="";for(let n=s.length-1;n>=0;n--)try{let i=s[n];if(!i.includes('"type":"assistant"'))continue;let a=JSON.parse(i);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let d="";for(let u of a.message.content)u.type==="text"&&(d+=u.text);if(d=d.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),d){r=d;break}}}catch{continue}return{userMessage:"",assistantMessage:r}}catch(e){return M.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:c},e),{userMessage:"",assistantMessage:""}}}async function ze(c,e=!1){let s=Ke(),r=c?.cwd??process.cwd(),n=r?B.default.basename(r):"unknown-project",i=null;try{i=new q}catch(N){if(N.code==="ERR_DLOPEN_FAILED"){try{(0,W.unlinkSync)(Ve)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw N}let a=Array.from(s.observationTypes),d=a.map(()=>"?").join(","),u=Array.from(s.observationConcepts),_=u.map(()=>"?").join(","),l=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${d})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${_})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...a,...u,s.totalObservationCount),E=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+qe),b="",T="";if(s.showLastMessage&&l.length>0)try{let N=c?.session_id,R=l.find(f=>f.sdk_session_id!==N);if(R){let f=R.sdk_session_id,y=Je(r),w=B.default.join((0,Q.homedir)(),".claude","projects",y,`${f}.jsonl`),j=Qe(w);b=j.userMessage,T=j.assistantMessage}}catch{}if(l.length===0&&E.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let A=E.slice(0,s.sessionCount),g=l,t=[];if(e?(t.push(""),t.push(`${o.bright}${o.cyan}[${n}] recent context${o.reset}`),t.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),t.push("")):(t.push(`# [${n}] recent context`),t.push("")),g.length>0){e?t.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):t.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),t.push(""),e?(t.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),t.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),t.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(t.push("\u{1F4A1} **Column Key**:"),t.push("- **Read**: Tokens to read this observation (cost to learn it now)"),t.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),t.push(""),e?(t.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),t.push(""),t.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),t.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),t.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),t.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(t.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),t.push(""),t.push("When you need implementation details, rationale, or debugging context:"),t.push("- Use the mem-search skill to fetch full observations on-demand"),t.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),t.push("- Trust this index over re-reading code for past decisions and learnings")),t.push("");let N=l.length,R=l.reduce((p,h)=>{let S=(h.title?.length||0)+(h.subtitle?.length||0)+(h.narrative?.length||0)+JSON.stringify(h.facts||[]).length;return p+Math.ceil(S/De)},0),f=l.reduce((p,h)=>p+(h.discovery_tokens||0),0),y=f-R,w=f>0?Math.round(y/f*100):0,j=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(j)if(e){if(t.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),t.push(`${o.dim}  Loading: ${N} observations (${R.toLocaleString()} tokens to read)${o.reset}`),t.push(`${o.dim}  Work investment: ${f.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),f>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${y.toLocaleString()} tokens (${w}% reduction from reuse)`:s.showSavingsAmount?p+=`${y.toLocaleString()} tokens`:p+=`${w}% reduction from reuse`,t.push(`${o.green}${p}${o.reset}`)}t.push("")}else{if(t.push("\u{1F4CA} **Context Economics**:"),t.push(`- Loading: ${N} observations (${R.toLocaleString()} tokens to read)`),t.push(`- Work investment: ${f.toLocaleString()} tokens spent on research, building, and decisions`),f>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${y.toLocaleString()} tokens (${w}% reduction from reuse)`:s.showSavingsAmount?p+=`${y.toLocaleString()} tokens`:p+=`${w}% reduction from reuse`,t.push(p)}t.push("")}let Me=E[0]?.id,ke=A.map((p,h)=>{let S=h===0?null:E[h+1];return{...p,displayEpoch:S?S.created_at_epoch:p.created_at_epoch,displayTime:S?S.created_at:p.created_at,shouldShowLink:p.id!==Me}}),$e=new Set(l.slice(0,s.fullObservationCount).map(p=>p.id)),de=[...g.map(p=>({type:"observation",data:p})),...ke.map(p=>({type:"summary",data:p}))];de.sort((p,h)=>{let S=p.type==="observation"?p.data.created_at_epoch:p.data.displayEpoch,v=h.type==="observation"?h.data.created_at_epoch:h.data.displayEpoch;return S-v});let H=new Map;for(let p of de){let h=p.type==="observation"?p.data.created_at:p.data.displayTime,S=ye(h);H.has(S)||H.set(S,[]),H.get(S).push(p)}let Ue=Array.from(H.entries()).sort((p,h)=>{let S=new Date(p[0]).getTime(),v=new Date(h[0]).getTime();return S-v});for(let[p,h]of Ue){e?(t.push(`${o.bright}${o.cyan}${p}${o.reset}`),t.push("")):(t.push(`### ${p}`),t.push(""));let S=null,v="",$=!1;for(let z of h)if(z.type==="summary"){$&&(t.push(""),$=!1,S=null,v="");let m=z.data,U=`${m.request||"Session started"} (${Le(m.displayTime)})`;e?t.push(`\u{1F3AF} ${o.yellow}#S${m.id}${o.reset} ${U}`):t.push(`**\u{1F3AF} #S${m.id}** ${U}`),t.push("")}else{let m=z.data,U=ve(m.files_modified,r);U!==S&&($&&t.push(""),e?t.push(`${o.dim}${U}${o.reset}`):t.push(`**${U}**`),e||(t.push("| ID | Time | T | Title | Read | Work |"),t.push("|----|------|---|-------|------|------|")),S=U,$=!0,v="");let x=Ce(m.created_at),G=m.title||"Untitled",Y=Ee[m.type]||"\u2022",xe=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length,F=Math.ceil(xe/De),P=m.discovery_tokens||0,Z=Te[m.type]||"\u{1F50D}",pe=P>0?`${Z} ${P.toLocaleString()}`:"-",ee=x!==v,ue=ee?x:"";if(v=x,$e.has(m.id)){let D=s.fullObservationField==="narrative"?m.narrative:m.facts?ae(m.facts).join(`
`):null;if(e){let L=ee?`${o.dim}${x}${o.reset}`:" ".repeat(x.length),V=s.showReadTokens&&F>0?`${o.dim}(~${F}t)${o.reset}`:"",_e=s.showWorkTokens&&P>0?`${o.dim}(${Z} ${P.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${m.id}${o.reset}  ${L}  ${Y}  ${o.bright}${G}${o.reset}`),D&&t.push(`    ${o.dim}${D}${o.reset}`),(V||_e)&&t.push(`    ${V} ${_e}`),t.push("")}else{$&&(t.push(""),$=!1),t.push(`**#${m.id}** ${ue||"\u2033"} ${Y} **${G}**`),D&&(t.push(""),t.push(D),t.push(""));let L=[];s.showReadTokens&&L.push(`Read: ~${F}`),s.showWorkTokens&&L.push(`Work: ${pe}`),L.length>0&&t.push(L.join(", ")),t.push(""),S=null}}else if(e){let D=ee?`${o.dim}${x}${o.reset}`:" ".repeat(x.length),L=s.showReadTokens&&F>0?`${o.dim}(~${F}t)${o.reset}`:"",V=s.showWorkTokens&&P>0?`${o.dim}(${Z} ${P.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${m.id}${o.reset}  ${D}  ${Y}  ${G} ${L} ${V}`)}else{let D=s.showReadTokens?`~${F}`:"",L=s.showWorkTokens?pe:"";t.push(`| #${m.id} | ${ue||"\u2033"} | ${Y} | ${G} | ${D} | ${L} |`)}}$&&t.push("")}let I=E[0],ce=l[0];if(s.showLastSummary&&I&&(I.investigated||I.learned||I.completed||I.next_steps)&&(!ce||I.created_at_epoch>ce.created_at_epoch)&&(t.push(...J("Investigated",I.investigated,o.blue,e)),t.push(...J("Learned",I.learned,o.yellow,e)),t.push(...J("Completed",I.completed,o.green,e)),t.push(...J("Next Steps",I.next_steps,o.magenta,e))),T&&(t.push(""),t.push("---"),t.push(""),e?(t.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),t.push(""),t.push(`${o.dim}A: ${T}${o.reset}`)):(t.push("**\u{1F4CB} Previously**"),t.push(""),t.push(`A: ${T}`)),t.push("")),j&&f>0&&y>0){let p=Math.round(f/1e3);t.push(""),e?t.push(`${o.dim}\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):t.push(`\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),t.join(`
`).trimEnd()}0&&(module.exports={generateContext});
