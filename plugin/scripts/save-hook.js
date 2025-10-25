#!/usr/bin/env node
import q from"better-sqlite3";import{join as p,dirname as W,basename as ce}from"path";import{homedir as D}from"os";import{existsSync as Ee,mkdirSync as B}from"fs";import{fileURLToPath as K}from"url";function Y(){return typeof __dirname<"u"?__dirname:W(K(import.meta.url))}var V=Y(),u=process.env.CLAUDE_MEM_DATA_DIR||p(D(),".claude-mem"),Te=process.env.CLAUDE_CONFIG_DIR||p(D(),".claude"),ge=p(u,"archives"),Se=p(u,"logs"),be=p(u,"trash"),he=p(u,"backups"),fe=p(u,"settings.json"),w=p(u,"claude-mem.db");function U(n){B(n,{recursive:!0})}function P(){return p(V,"..","..")}var R=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(R||{}),I=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=R[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,o){if(e<this.level)return;let d=new Date().toISOString().replace("T"," ").substring(0,23),a=R[e].padEnd(5),i=s.padEnd(6),c="";r?.correlationId?c=`[${r.correlationId}] `:r?.sessionId&&(c=`[session-${r.sessionId}] `);let l="";o!=null&&(this.level===0&&typeof o=="object"?l=`
`+JSON.stringify(o,null,2):l=" "+this.formatData(o));let T="";if(r){let{sessionId:N,sdkSessionId:ie,correlationId:ae,...x}=r;Object.keys(x).length>0&&(T=` {${Object.entries(x).map(([G,$])=>`${G}=${$}`).join(", ")}}`)}let m=`[${d}] [${a}] [${i}] ${c}${t}${T}${l}`;e===3?console.error(m):console.log(m)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},E=new I;var S=class{db;constructor(){U(u),this.db=new q(w),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(i=>i.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(i=>i.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).all(e,s)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).all(e)}getSummaryForSession(e){return this.db.prepare(`
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
    `).all(e),r=new Set,o=new Set;for(let d of t){if(d.files_read)try{let a=JSON.parse(d.files_read);Array.isArray(a)&&a.forEach(i=>r.add(i))}catch{}if(d.files_modified)try{let a=JSON.parse(d.files_modified);Array.isArray(a)&&a.forEach(i=>o.add(i))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,o=r.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),o);return a.lastInsertRowid===0||a.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(E.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),o).lastInsertRowid}storeObservation(e,s,t,r){let o=new Date,d=o.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,o.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`)),this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,o.toISOString(),d)}storeSummary(e,s,t,r){let o=new Date,d=o.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,o.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`)),this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,o.toISOString(),d)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}cleanupOrphanedSessions(){let e=new Date,s=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};function J(n,e,s){return n==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:n==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:n==="UserPromptSubmit"||n==="PostToolUse"?{continue:!0,suppressOutput:!0}:n==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function b(n,e,s={}){let t=J(n,e,s);return JSON.stringify(t)}import A from"path";import{existsSync as k}from"fs";import{spawn as re}from"child_process";import{readFileSync as Q,writeFileSync as z,existsSync as O,mkdirSync as Z,renameSync as M}from"fs";import{join as ee,dirname as te}from"path";import{homedir as se}from"os";var _={model:"claude-sonnet-4-5",workerPort:37777,enableMemoryStorage:!0,enableContextInjection:!0,contextDepth:5},g={model:"AI model to use for processing observations and generating summaries",workerPort:"Port for the background worker service HTTP API",enableMemoryStorage:"Enable/disable saving tool observations to the database",enableContextInjection:"Enable/disable context injection at session start",contextDepth:"Number of recent sessions to load when injecting context (higher = more history, more tokens)"},h=["claude-haiku-4-5","claude-sonnet-4-5","claude-opus-4","claude-3-7-sonnet"],L=class{settingsPath;cachedSettings=null;constructor(e){this.settingsPath=e||ee(se(),".claude-mem","settings.json")}loadSettings(){if(this.cachedSettings)return this.cachedSettings;let e={};if(O(this.settingsPath))try{let t=Q(this.settingsPath,"utf-8");e=JSON.parse(t)}catch(t){let r=this.settingsPath+".bak";try{M(this.settingsPath,r),console.error(`[claude-mem] Failed to parse settings file: ${t.message}`),console.error(`[claude-mem] Backed up invalid settings to: ${r}`)}catch(o){console.error(`[claude-mem] Failed to parse settings file: ${t.message}`),console.error(`[claude-mem] Could not backup invalid file: ${o.message}`)}}let s={model:e.model??_.model,workerPort:e.workerPort??_.workerPort,enableMemoryStorage:e.enableMemoryStorage??_.enableMemoryStorage,enableContextInjection:e.enableContextInjection??_.enableContextInjection,contextDepth:e.contextDepth??_.contextDepth};return this.validateSettings(s),this.cachedSettings=s,s}validateSettings(e){if(!h.includes(e.model))throw new Error(`Invalid model: ${e.model}. Must be one of: ${h.join(", ")}`);if(typeof e.workerPort!="number"||e.workerPort<1||e.workerPort>65535)throw new Error(`Invalid workerPort: ${e.workerPort}. Must be between 1-65535`);if(typeof e.enableMemoryStorage!="boolean")throw new Error(`Invalid enableMemoryStorage: ${e.enableMemoryStorage}. Must be boolean`);if(typeof e.enableContextInjection!="boolean")throw new Error(`Invalid enableContextInjection: ${e.enableContextInjection}. Must be boolean`);if(typeof e.contextDepth!="number"||e.contextDepth<1||e.contextDepth>50)throw new Error(`Invalid contextDepth: ${e.contextDepth}. Must be between 1-50`)}get(){return this.loadSettings()}getWithDescriptions(){let e=this.get();return{model:{value:e.model,description:g.model,options:h},workerPort:{value:e.workerPort,description:g.workerPort},enableMemoryStorage:{value:e.enableMemoryStorage,description:g.enableMemoryStorage},enableContextInjection:{value:e.enableContextInjection,description:g.enableContextInjection},contextDepth:{value:e.contextDepth,description:g.contextDepth}}}set(e){let t={...this.get(),...e};this.validateSettings(t);let r=te(this.settingsPath);O(r)||Z(r,{recursive:!0});try{let o=this.settingsPath+".tmp";z(o,JSON.stringify(t,null,2),"utf-8"),M(o,this.settingsPath),this.cachedSettings=t}catch(o){throw new Error(`Failed to save settings: ${o.message}`)}}reset(){this.set(_)}getDefaults(){return{..._}}getModelOptions(){return[...h]}exists(){return O(this.settingsPath)}getPath(){return this.settingsPath}},v=null;function f(){return v||(v=new L),v}var C;function oe(){return C===void 0&&(C=f().get().workerPort),`http://127.0.0.1:${C}/health`}async function X(){try{return(await fetch(oe(),{signal:AbortSignal.timeout(500)})).ok}catch{return!1}}async function F(){try{if(await X())return!0;console.error("[claude-mem] Worker not responding, starting...");let n=P(),e=A.join(n,"plugin","scripts","worker-service.cjs");if(!k(e))return console.error(`[claude-mem] Worker service not found at ${e}`),!1;let s=A.join(n,"ecosystem.config.cjs"),t=A.join(n,"node_modules",".bin","pm2");if(!k(t))throw new Error(`PM2 binary not found at ${t}. This is a bundled dependency - try running: npm install`);if(!k(s))throw new Error(`PM2 ecosystem config not found at ${s}. Plugin installation may be corrupted.`);let r=re(t,["start",s],{detached:!0,stdio:"ignore",cwd:n});r.on("error",o=>{throw new Error(`Failed to spawn PM2: ${o.message}`)}),r.unref(),console.error("[claude-mem] Worker started with PM2");for(let o=0;o<3;o++)if(await new Promise(d=>setTimeout(d,500)),await X())return console.error("[claude-mem] Worker is healthy"),!0;return console.error("[claude-mem] Worker failed to become healthy after startup"),!1}catch(n){return console.error(`[claude-mem] Failed to start worker: ${n.message}`),!1}}var ne=new Set(["ListMcpResourcesTool"]);async function H(n){if(!n)throw new Error("saveHook requires input");let e=f().get();if(!e.enableMemoryStorage){console.log(b("PostToolUse",!0));return}let{session_id:s,tool_name:t,tool_input:r,tool_output:o}=n;if(ne.has(t)){console.log(b("PostToolUse",!0));return}if(!await F())throw new Error("Worker service failed to start or become healthy");let a=new S,i=a.createSDKSession(s,"",""),c=a.getPromptCounter(i);a.close();let l=E.formatTool(t,r),T=e.workerPort;E.dataIn("HOOK",`PostToolUse: ${l}`,{sessionId:i,workerPort:T});let m=await fetch(`http://127.0.0.1:${T}/sessions/${i}/observations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_output:o!==void 0?JSON.stringify(o):"{}",prompt_number:c}),signal:AbortSignal.timeout(2e3)});if(!m.ok){let N=await m.text();throw E.failure("HOOK","Failed to send observation",{sessionId:i,status:m.status},N),new Error(`Failed to send observation to worker: ${m.status} ${N}`)}E.debug("HOOK","Observation sent successfully",{sessionId:i,toolName:t}),console.log(b("PostToolUse",!0))}import{stdin as j}from"process";var y="";j.on("data",n=>y+=n);j.on("end",async()=>{let n=y.trim()?JSON.parse(y):void 0;await H(n),process.exit(0)});
