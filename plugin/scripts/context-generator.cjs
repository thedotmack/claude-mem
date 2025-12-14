"use strict";var Me=Object.create;var q=Object.defineProperty;var ke=Object.getOwnPropertyDescriptor;var Ue=Object.getOwnPropertyNames;var $e=Object.getPrototypeOf,xe=Object.prototype.hasOwnProperty;var we=(d,e)=>{for(var s in e)q(d,s,{get:e[s],enumerable:!0})},_e=(d,e,s,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Ue(e))!xe.call(d,n)&&n!==s&&q(d,n,{get:()=>e[n],enumerable:!(r=ke(e,n))||r.enumerable});return d};var Fe=(d,e,s)=>(s=d!=null?Me($e(d)):{},_e(e||!d||!d.__esModule?q(s,"default",{value:d,enumerable:!0}):s,d)),Pe=d=>_e(q({},"__esModule",{value:!0}),d);var ze={};we(ze,{generateContext:()=>Qe});module.exports=Pe(ze);var w=Fe(require("path"),1),z=require("os"),B=require("fs");var Ne=require("bun:sqlite");var O=require("path"),ge=require("os"),fe=require("fs");var be=require("url");var j=require("fs"),Se=require("path"),he=require("os");var te=["bugfix","feature","refactor","discovery","decision","change"],re=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],le={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},Ee={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},me=te.join(","),Te=re.join(",");var ne=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(ne||{}),oe=class{level=null;useColor;constructor(){this.useColor=process.stdout.isTTY??!1}getLevel(){if(this.level===null){let e=$.get("CLAUDE_MEM_LOG_LEVEL").toUpperCase();this.level=ne[e]??1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let r=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&r.command){let n=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${e}(${n})`}if(e==="Read"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Edit"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Write"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,s,r,n,i){if(e<this.getLevel())return;let a=new Date().toISOString().replace("T"," ").substring(0,23),c=ne[e].padEnd(5),u=s.padEnd(6),E="";n?.correlationId?E=`[${n.correlationId}] `:n?.sessionId&&(E=`[session-${n.sessionId}] `);let l="";i!=null&&(this.getLevel()===0&&typeof i=="object"?l=`
`+JSON.stringify(i,null,2):l=" "+this.formatData(i));let S="";if(n){let{sessionId:m,sdkSessionId:I,correlationId:T,...t}=n;Object.keys(t).length>0&&(S=` {${Object.entries(t).map(([R,b])=>`${R}=${b}`).join(", ")}}`)}let f=`[${a}] [${c}] [${u}] ${E}${r}${S}${l}`;e===3?console.error(f):console.log(f)}debug(e,s,r,n){this.log(0,e,s,r,n)}info(e,s,r,n){this.log(1,e,s,r,n)}warn(e,s,r,n){this.log(2,e,s,r,n)}error(e,s,r,n){this.log(3,e,s,r,n)}dataIn(e,s,r,n){this.info(e,`\u2192 ${s}`,r,n)}dataOut(e,s,r,n){this.info(e,`\u2190 ${s}`,r,n)}success(e,s,r,n){this.info(e,`\u2713 ${s}`,r,n)}failure(e,s,r,n){this.error(e,`\u2717 ${s}`,r,n)}timing(e,s,r,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${r}ms`})}},U=new oe;var $=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_WORKER_HOST:"127.0.0.1",CLAUDE_MEM_SKIP_TOOLS:"ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion",CLAUDE_MEM_DATA_DIR:(0,Se.join)((0,he.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_EMBEDDING_FUNCTION:"default",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:me,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:Te,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){if(!(0,j.existsSync)(e))return this.getAllDefaults();let s=(0,j.readFileSync)(e,"utf-8"),r=JSON.parse(s),n=r;if(r.env&&typeof r.env=="object"){n=r.env;try{(0,j.writeFileSync)(e,JSON.stringify(n,null,2),"utf-8"),U.info("SETTINGS","Migrated settings file from nested to flat schema",{settingsPath:e})}catch(a){U.warn("SETTINGS","Failed to auto-migrate settings file",{settingsPath:e},a)}}let i={...this.DEFAULTS};for(let a of Object.keys(this.DEFAULTS))n[a]!==void 0&&(i[a]=n[a]);return i}};var We={};function Xe(){return typeof __dirname<"u"?__dirname:(0,O.dirname)((0,be.fileURLToPath)(We.url))}var us=Xe(),y=$.get("CLAUDE_MEM_DATA_DIR"),ie=process.env.CLAUDE_CONFIG_DIR||(0,O.join)((0,ge.homedir)(),".claude"),_s=(0,O.join)(y,"archives"),ls=(0,O.join)(y,"logs"),Es=(0,O.join)(y,"trash"),ms=(0,O.join)(y,"backups"),Ts=(0,O.join)(y,"settings.json"),Oe=(0,O.join)(y,"claude-mem.db"),Ss=(0,O.join)(y,"vector-db"),hs=(0,O.join)(ie,"settings.json"),gs=(0,O.join)(ie,"commands"),fs=(0,O.join)(ie,"CLAUDE.md");function Re(d){(0,fe.mkdirSync)(d,{recursive:!0})}var J=class{db;constructor(){Re(y),this.db=new Ne.Database(Oe),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(r=>r.version)):0)===0&&(console.error("[SessionStore] Initializing fresh database with migration004..."),this.db.run(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(n=>n.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(u=>u.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(u=>u.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(u=>u.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(n){throw this.db.run("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.run(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.query("PRAGMA table_info(observations)").all().find(n=>n.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.error("[SessionStore] Successfully made observations.text nullable")}catch(n){throw this.db.run("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.error("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.run("BEGIN TRANSACTION");try{this.db.run(`
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
        `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(r){throw this.db.run("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(a=>a.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:i,type:a,concepts:c,files:u}=s,E=r==="date_asc"?"ASC":"DESC",l=n?`LIMIT ${n}`:"",S=e.map(()=>"?").join(","),f=[...e],m=[];if(i&&(m.push("project = ?"),f.push(i)),a)if(Array.isArray(a)){let t=a.map(()=>"?").join(",");m.push(`type IN (${t})`),f.push(...a)}else m.push("type = ?"),f.push(a);if(c){let t=Array.isArray(c)?c:[c],N=t.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");f.push(...t),m.push(`(${N.join(" OR ")})`)}if(u){let t=Array.isArray(u)?u:[u],N=t.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");t.forEach(R=>{f.push(`%${R}%`,`%${R}%`)}),m.push(`(${N.join(" OR ")})`)}let I=m.length>0?`WHERE id IN (${S}) AND ${m.join(" AND ")}`:`WHERE id IN (${S})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${I}
      ORDER BY created_at_epoch ${E}
      ${l}
    `).all(...f)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),n=new Set,i=new Set;for(let a of r){if(a.files_read)try{let c=JSON.parse(a.files_read);Array.isArray(c)&&c.forEach(u=>n.add(u))}catch{}if(a.files_modified)try{let c=JSON.parse(a.files_modified);Array.isArray(c)&&c.forEach(u=>i.add(u))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,r){let n=new Date,i=n.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,r,n.toISOString(),i);return c.lastInsertRowid===0||c.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,r,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):c.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(U.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,r,n,i=0){let a=new Date,c=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let S=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),n||null,i,a.toISOString(),c);return{id:Number(S.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,r,n,i=0){let a=new Date,c=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let S=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,i,a.toISOString(),c);return{id:Number(S.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}markSessionFailed(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:i}=s,a=r==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),E=[...e],l=i?`WHERE id IN (${u}) AND project = ?`:`WHERE id IN (${u})`;return i&&E.push(i),this.db.prepare(`
      SELECT * FROM session_summaries
      ${l}
      ORDER BY created_at_epoch ${a}
      ${c}
    `).all(...E)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n,project:i}=s,a=r==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",u=e.map(()=>"?").join(","),E=[...e],l=i?"AND s.project = ?":"";return i&&E.push(i),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${u}) ${l}
      ORDER BY up.created_at_epoch ${a}
      ${c}
    `).all(...E)}getTimelineAroundTimestamp(e,s=10,r=10,n){return this.getTimelineAroundObservation(null,e,s,r,n)}getTimelineAroundObservation(e,s,r=10,n=10,i){let a=i?"AND project = ?":"",c=i?[i]:[],u,E;if(e!==null){let m=`
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
      `;try{let T=this.db.prepare(m).all(e,...c,r+1),t=this.db.prepare(I).all(e,...c,n+1);if(T.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};u=T.length>0?T[T.length-1].created_at_epoch:s,E=t.length>0?t[t.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary observations:",T.message),{observations:[],sessions:[],prompts:[]}}}else{let m=`
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
      `;try{let T=this.db.prepare(m).all(s,...c,r),t=this.db.prepare(I).all(s,...c,n+1);if(T.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};u=T.length>0?T[T.length-1].created_at_epoch:s,E=t.length>0?t[t.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary timestamps:",T.message),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,S=`
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
    `;try{let m=this.db.prepare(l).all(u,E,...c),I=this.db.prepare(S).all(u,E,...c),T=this.db.prepare(f).all(u,E,...c);return{observations:m,sessions:I.map(t=>({id:t.id,sdk_session_id:t.sdk_session_id,project:t.project,request:t.request,completed:t.completed,next_steps:t.next_steps,created_at:t.created_at,created_at_epoch:t.created_at_epoch})),prompts:T.map(t=>({id:t.id,claude_session_id:t.claude_session_id,project:t.project,prompt:t.prompt_text,created_at:t.created_at,created_at_epoch:t.created_at_epoch}))}}catch(m){return console.error("[SessionStore] Error querying timeline records:",m.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var je=w.default.join((0,z.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Be(){let d=w.default.join((0,z.homedir)(),".claude-mem","settings.json"),e=$.loadFromFile(d);try{return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(s=>s.trim()).filter(Boolean)),observationConcepts:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(s=>s.trim()).filter(Boolean)),fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(s){return U.warn("WORKER","Failed to load context settings, using defaults",{},s),{totalObservationCount:50,fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(te),observationConcepts:new Set(re),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1}}}var Ae=4,He=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Ie(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function Ge(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Ye(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Ve(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ke(d,e){return w.default.isAbsolute(d)?w.default.relative(e,d):d}function Q(d,e,s,r){return e?r?[`${s}${d}:${o.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}function qe(d){return d.replace(/\//g,"-")}function Je(d){try{if(!(0,B.existsSync)(d))return{userMessage:"",assistantMessage:""};let e=(0,B.readFileSync)(d,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),r="";for(let n=s.length-1;n>=0;n--)try{let i=s[n];if(!i.includes('"type":"assistant"'))continue;let a=JSON.parse(i);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let c="";for(let u of a.message.content)u.type==="text"&&(c+=u.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){r=c;break}}}catch{continue}return{userMessage:"",assistantMessage:r}}catch(e){return U.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:d},e),{userMessage:"",assistantMessage:""}}}async function Qe(d,e=!1){let s=Be(),r=d?.cwd??process.cwd(),n=r?w.default.basename(r):"unknown-project",i=null;try{i=new J}catch(N){if(N.code==="ERR_DLOPEN_FAILED"){try{(0,B.unlinkSync)(je)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw N}let a=Array.from(s.observationTypes),c=a.map(()=>"?").join(","),u=Array.from(s.observationConcepts),E=u.map(()=>"?").join(","),l=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${c})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${E})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...a,...u,s.totalObservationCount),S=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+He),f="",m="";if(s.showLastMessage&&l.length>0)try{let N=d?.session_id,R=l.find(b=>b.sdk_session_id!==N);if(R){let b=R.sdk_session_id,D=qe(r),F=w.default.join((0,z.homedir)(),".claude","projects",D,`${b}.jsonl`),H=Je(F);f=H.userMessage,m=H.assistantMessage}}catch{}if(l.length===0&&S.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let I=S.slice(0,s.sessionCount),T=l,t=[];if(e?(t.push(""),t.push(`${o.bright}${o.cyan}[${n}] recent context${o.reset}`),t.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),t.push("")):(t.push(`# [${n}] recent context`),t.push("")),T.length>0){e?t.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):t.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),t.push(""),e?(t.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),t.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),t.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(t.push("\u{1F4A1} **Column Key**:"),t.push("- **Read**: Tokens to read this observation (cost to learn it now)"),t.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),t.push(""),e?(t.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),t.push(""),t.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),t.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),t.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),t.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(t.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),t.push(""),t.push("When you need implementation details, rationale, or debugging context:"),t.push("- Use the mem-search skill to fetch full observations on-demand"),t.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),t.push("- Trust this index over re-reading code for past decisions and learnings")),t.push("");let N=l.length,R=l.reduce((p,h)=>{let g=(h.title?.length||0)+(h.subtitle?.length||0)+(h.narrative?.length||0)+JSON.stringify(h.facts||[]).length;return p+Math.ceil(g/Ae)},0),b=l.reduce((p,h)=>p+(h.discovery_tokens||0),0),D=b-R,F=b>0?Math.round(D/b*100):0,H=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(H)if(e){if(t.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),t.push(`${o.dim}  Loading: ${N} observations (${R.toLocaleString()} tokens to read)${o.reset}`),t.push(`${o.dim}  Work investment: ${b.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),b>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${D.toLocaleString()} tokens (${F}% reduction from reuse)`:s.showSavingsAmount?p+=`${D.toLocaleString()} tokens`:p+=`${F}% reduction from reuse`,t.push(`${o.green}${p}${o.reset}`)}t.push("")}else{if(t.push("\u{1F4CA} **Context Economics**:"),t.push(`- Loading: ${N} observations (${R.toLocaleString()} tokens to read)`),t.push(`- Work investment: ${b.toLocaleString()} tokens spent on research, building, and decisions`),b>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${D.toLocaleString()} tokens (${F}% reduction from reuse)`:s.showSavingsAmount?p+=`${D.toLocaleString()} tokens`:p+=`${F}% reduction from reuse`,t.push(p)}t.push("")}let Le=S[0]?.id,Ce=I.map((p,h)=>{let g=h===0?null:S[h+1];return{...p,displayEpoch:g?g.created_at_epoch:p.created_at_epoch,displayTime:g?g.created_at:p.created_at,shouldShowLink:p.id!==Le}}),ve=new Set(l.slice(0,s.fullObservationCount).map(p=>p.id)),ae=[...T.map(p=>({type:"observation",data:p})),...Ce.map(p=>({type:"summary",data:p}))];ae.sort((p,h)=>{let g=p.type==="observation"?p.data.created_at_epoch:p.data.displayEpoch,M=h.type==="observation"?h.data.created_at_epoch:h.data.displayEpoch;return g-M});let G=new Map;for(let p of ae){let h=p.type==="observation"?p.data.created_at:p.data.displayTime,g=Ve(h);G.has(g)||G.set(g,[]),G.get(g).push(p)}let ye=Array.from(G.entries()).sort((p,h)=>{let g=new Date(p[0]).getTime(),M=new Date(h[0]).getTime();return g-M});for(let[p,h]of ye){e?(t.push(`${o.bright}${o.cyan}${p}${o.reset}`),t.push("")):(t.push(`### ${p}`),t.push(""));let g=null,M="",x=!1;for(let Z of h)if(Z.type==="summary"){x&&(t.push(""),x=!1,g=null,M="");let _=Z.data,P=`${_.request||"Session started"} (${Ge(_.displayTime)})`,v=_.shouldShowLink?`claude-mem://session-summary/${_.id}`:"";if(e){let A=v?`${o.dim}[${v}]${o.reset}`:"";t.push(`\u{1F3AF} ${o.yellow}#S${_.id}${o.reset} ${P} ${A}`)}else{let A=v?` [\u2192](${v})`:"";t.push(`**\u{1F3AF} #S${_.id}** ${P}${A}`)}t.push("")}else{let _=Z.data,P=Ie(_.files_modified),v=P.length>0&&P[0]?Ke(P[0],r):"General";v!==g&&(x&&t.push(""),e?t.push(`${o.dim}${v}${o.reset}`):t.push(`**${v}**`),e||(t.push("| ID | Time | T | Title | Read | Work |"),t.push("|----|------|---|-------|------|------|")),g=v,x=!0,M="");let A=Ye(_.created_at),Y=_.title||"Untitled",V=le[_.type]||"\u2022",De=(_.title?.length||0)+(_.subtitle?.length||0)+(_.narrative?.length||0)+JSON.stringify(_.facts||[]).length,X=Math.ceil(De/Ae),W=_.discovery_tokens||0,ee=Ee[_.type]||"\u{1F50D}",ce=W>0?`${ee} ${W.toLocaleString()}`:"-",se=A!==M,pe=se?A:"";if(M=A,ve.has(_.id)){let k=s.fullObservationField==="narrative"?_.narrative:_.facts?Ie(_.facts).join(`
`):null;if(e){let C=se?`${o.dim}${A}${o.reset}`:" ".repeat(A.length),K=s.showReadTokens&&X>0?`${o.dim}(~${X}t)${o.reset}`:"",ue=s.showWorkTokens&&W>0?`${o.dim}(${ee} ${W.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${_.id}${o.reset}  ${C}  ${V}  ${o.bright}${Y}${o.reset}`),k&&t.push(`    ${o.dim}${k}${o.reset}`),(K||ue)&&t.push(`    ${K} ${ue}`),t.push("")}else{x&&(t.push(""),x=!1),t.push(`**#${_.id}** ${pe||"\u2033"} ${V} **${Y}**`),k&&(t.push(""),t.push(k),t.push(""));let C=[];s.showReadTokens&&C.push(`Read: ~${X}`),s.showWorkTokens&&C.push(`Work: ${ce}`),C.length>0&&t.push(C.join(", ")),t.push(""),g=null}}else if(e){let k=se?`${o.dim}${A}${o.reset}`:" ".repeat(A.length),C=s.showReadTokens&&X>0?`${o.dim}(~${X}t)${o.reset}`:"",K=s.showWorkTokens&&W>0?`${o.dim}(${ee} ${W.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${_.id}${o.reset}  ${k}  ${V}  ${Y} ${C} ${K}`)}else{let k=s.showReadTokens?`~${X}`:"",C=s.showWorkTokens?ce:"";t.push(`| #${_.id} | ${pe||"\u2033"} | ${V} | ${Y} | ${k} | ${C} |`)}}x&&t.push("")}let L=S[0],de=l[0];if(s.showLastSummary&&L&&(L.investigated||L.learned||L.completed||L.next_steps)&&(!de||L.created_at_epoch>de.created_at_epoch)&&(t.push(...Q("Investigated",L.investigated,o.blue,e)),t.push(...Q("Learned",L.learned,o.yellow,e)),t.push(...Q("Completed",L.completed,o.green,e)),t.push(...Q("Next Steps",L.next_steps,o.magenta,e))),m&&(t.push(""),t.push("---"),t.push(""),e?(t.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),t.push(""),t.push(`${o.dim}A: ${m}${o.reset}`)):(t.push("**\u{1F4CB} Previously**"),t.push(""),t.push(`A: ${m}`)),t.push("")),H&&b>0&&D>0){let p=Math.round(b/1e3);t.push(""),e?t.push(`${o.dim}\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):t.push(`\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),t.join(`
`).trimEnd()}0&&(module.exports={generateContext});
