#!/usr/bin/env node
import V from"path";import Ee from"better-sqlite3";import{join as T,dirname as pe,basename as Ae}from"path";import{homedir as Z}from"os";import{existsSync as Ce,mkdirSync as le}from"fs";import{fileURLToPath as ue}from"url";function me(){return typeof __dirname<"u"?__dirname:pe(ue(import.meta.url))}var _e=me(),I=process.env.CLAUDE_MEM_DATA_DIR||T(Z(),".claude-mem"),X=process.env.CLAUDE_CONFIG_DIR||T(Z(),".claude"),$e=T(I,"archives"),Ue=T(I,"logs"),Me=T(I,"trash"),Pe=T(I,"backups"),Xe=T(I,"settings.json"),ee=T(I,"claude-mem.db"),Fe=T(X,"settings.json"),je=T(X,"commands"),Ge=T(X,"CLAUDE.md");function te(a){le(a,{recursive:!0})}function se(){return T(_e,"..","..")}var F=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(F||{}),j=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=F[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;try{let s=typeof t=="string"?JSON.parse(t):t;if(e==="Bash"&&s.command){let r=s.command.length>50?s.command.substring(0,50)+"...":s.command;return`${e}(${r})`}if(e==="Read"&&s.file_path){let r=s.file_path.split("/").pop()||s.file_path;return`${e}(${r})`}if(e==="Edit"&&s.file_path){let r=s.file_path.split("/").pop()||s.file_path;return`${e}(${r})`}if(e==="Write"&&s.file_path){let r=s.file_path.split("/").pop()||s.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,t,s,r,i){if(e<this.level)return;let c=new Date().toISOString().replace("T"," ").substring(0,23),p=F[e].padEnd(5),l=t.padEnd(6),S="";r?.correlationId?S=`[${r.correlationId}] `:r?.sessionId&&(S=`[session-${r.sessionId}] `);let v="";i!=null&&(this.level===0&&typeof i=="object"?v=`
`+JSON.stringify(i,null,2):v=" "+this.formatData(i));let L="";if(r){let{sessionId:y,sdkSessionId:h,correlationId:U,...R}=r;Object.keys(R).length>0&&(L=` {${Object.entries(R).map(([g,d])=>`${g}=${d}`).join(", ")}}`)}let n=`[${c}] [${p}] [${l}] ${S}${s}${L}${v}`;e===3?console.error(n):console.log(n)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}error(e,t,s,r){this.log(3,e,t,s,r)}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}timing(e,t,s,r){this.info(e,`\u23F1 ${t}`,r,{duration:`${s}ms`})}},re=new j;var C=class{db;constructor(){te(I),this.db=new Ee(ee),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(s=>s.version)):0)===0&&(console.error("[SessionStore] Initializing fresh database with migration004..."),this.db.exec(`
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
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.pragma("table_info(observations)").find(r=>r.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(s){throw this.db.exec("ROLLBACK"),s}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentSummariesWithSessionInfo(e,t=3){return this.db.prepare(`
      SELECT
        sdk_session_id, request, learned, completed, next_steps,
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
    `).all(e,t)}getRecentSessionsWithStatus(e,t=3){return this.db.prepare(`
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
    `).all(e,t)}getObservationsForSession(e){return this.db.prepare(`
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
    `).get(e)||null}getFilesForSession(e){let s=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),r=new Set,i=new Set;for(let c of s){if(c.files_read)try{let p=JSON.parse(c.files_read);Array.isArray(p)&&p.forEach(l=>r.add(l))}catch{}if(c.files_modified)try{let p=JSON.parse(c.files_modified);Array.isArray(p)&&p.forEach(l=>i.add(l))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)||null}reactivateSession(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(t,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||1}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||0}createSDKSession(e,t,s){let r=new Date,i=r.getTime(),p=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,t,s,r.toISOString(),i);return p.lastInsertRowid===0||p.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:p.lastInsertRowid}updateSDKSessionId(e,t){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(t,e).changes===0?(re.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:t}),!1):!0}setWorkerPort(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(t,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,t,s){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,t,s,r.toISOString(),i).lastInsertRowid}storeObservation(e,t,s,r){let i=new Date,c=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,t,i.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`)),this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),r||null,i.toISOString(),c)}storeSummary(e,t,s,r){let i=new Date,c=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,t,i.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`)),this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,r||null,i.toISOString(),c)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t.toISOString(),s,e)}markSessionFailed(e){let t=new Date,s=t.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t.toISOString(),s,e)}cleanupOrphanedSessions(){let e=new Date,t=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};import H from"path";import{existsSync as B}from"fs";import{spawn as be}from"child_process";import{readFileSync as Te,writeFileSync as he,existsSync as ne}from"fs";import{join as ge}from"path";import{homedir as fe}from"os";var O={model:"claude-sonnet-4-5",workerPort:37777,enableMemoryStorage:!0,enableContextInjection:!0,contextDepth:5},D={model:"AI model to use for processing observations and generating summaries",workerPort:"Port for the background worker service HTTP API",enableMemoryStorage:"Enable/disable saving tool observations to the database",enableContextInjection:"Enable/disable context injection at session start",contextDepth:"Number of recent sessions to load when injecting context (higher = more history, more tokens)"},w=["claude-haiku-4-5","claude-sonnet-4-5","claude-opus-4","claude-3-7-sonnet"],W=class{settingsPath;cachedSettings=null;constructor(e){this.settingsPath=e||ge(fe(),".claude-mem","settings.json")}loadSettings(){if(this.cachedSettings)return this.cachedSettings;let e={};if(ne(this.settingsPath))try{let s=Te(this.settingsPath,"utf-8");e=JSON.parse(s)}catch(s){console.error(`[claude-mem] Failed to parse settings file: ${s.message}`)}let t={model:e.model||O.model,workerPort:e.workerPort||O.workerPort,enableMemoryStorage:e.enableMemoryStorage??O.enableMemoryStorage,enableContextInjection:e.enableContextInjection??O.enableContextInjection,contextDepth:e.contextDepth||O.contextDepth};return this.validateSettings(t),this.cachedSettings=t,t}validateSettings(e){if(!w.includes(e.model))throw new Error(`Invalid model: ${e.model}. Must be one of: ${w.join(", ")}`);if(typeof e.workerPort!="number"||e.workerPort<1||e.workerPort>65535)throw new Error(`Invalid workerPort: ${e.workerPort}. Must be between 1-65535`);if(typeof e.enableMemoryStorage!="boolean")throw new Error(`Invalid enableMemoryStorage: ${e.enableMemoryStorage}. Must be boolean`);if(typeof e.enableContextInjection!="boolean")throw new Error(`Invalid enableContextInjection: ${e.enableContextInjection}. Must be boolean`);if(typeof e.contextDepth!="number"||e.contextDepth<1||e.contextDepth>50)throw new Error(`Invalid contextDepth: ${e.contextDepth}. Must be between 1-50`)}get(){return this.loadSettings()}getWithDescriptions(){let e=this.get();return{model:{value:e.model,description:D.model,options:w},workerPort:{value:e.workerPort,description:D.workerPort},enableMemoryStorage:{value:e.enableMemoryStorage,description:D.enableMemoryStorage},enableContextInjection:{value:e.enableContextInjection,description:D.enableContextInjection},contextDepth:{value:e.contextDepth,description:D.contextDepth}}}set(e){let s={...this.get(),...e};this.validateSettings(s);try{he(this.settingsPath,JSON.stringify(s,null,2),"utf-8"),this.cachedSettings=s}catch(r){throw new Error(`Failed to save settings: ${r.message}`)}}reset(){this.set(O)}getDefaults(){return{...O}}getModelOptions(){return[...w]}exists(){return ne(this.settingsPath)}getPath(){return this.settingsPath}},G=null;function $(){return G||(G=new W),G}function Se(){return`http://127.0.0.1:${$().get().workerPort}/health`}async function oe(){try{return(await fetch(Se(),{signal:AbortSignal.timeout(500)})).ok}catch{return!1}}async function ie(){try{if(await oe())return!0;console.error("[claude-mem] Worker not responding, starting...");let a=se(),e=H.join(a,"plugin","scripts","worker-service.cjs");if(!B(e))return console.error(`[claude-mem] Worker service not found at ${e}`),!1;let t=H.join(a,"ecosystem.config.cjs"),s=H.join(a,"node_modules",".bin","pm2");if(!B(s))throw new Error(`PM2 binary not found at ${s}. This is a bundled dependency - try running: npm install`);if(!B(t))throw new Error(`PM2 ecosystem config not found at ${t}. Plugin installation may be corrupted.`);let r=be(s,["start",t],{detached:!0,stdio:"ignore",cwd:a});r.on("error",i=>{throw new Error(`Failed to spawn PM2: ${i.message}`)}),r.unref(),console.error("[claude-mem] Worker started with PM2");for(let i=0;i<3;i++)if(await new Promise(c=>setTimeout(c,500)),await oe())return console.error("[claude-mem] Worker is healthy"),!0;return console.error("[claude-mem] Worker failed to become healthy after startup"),!1}catch(a){return console.error(`[claude-mem] Failed to start worker: ${a.message}`),!1}}var o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Y(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function Ne(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Ie(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Re(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Oe(a){return a?Math.ceil(a.length/4):0}function ve(a,e){try{return V.isAbsolute(a)?V.relative(e,a):a}catch{return a}}function ye(a,e){if(e.length===0)return[];let t=e.map(()=>"?").join(",");return a.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified,
      created_at, created_at_epoch
    FROM observations
    WHERE sdk_session_id IN (${t})
    ORDER BY created_at_epoch DESC
  `).all(...e)}function K(a,e=!1,t=!1){if(ie(),!$().get().enableContextInjection)return"";let r=a?.cwd??process.cwd(),i=r?V.basename(r):"unknown-project",c=new C;try{let p=c.db.prepare(`
      SELECT id, sdk_session_id, request, completed, next_steps, created_at, created_at_epoch
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 4
    `).all(i);if(p.length===0)return e?`
${o.bright}${o.cyan}\u{1F4DD} [${i}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${i}] recent context

No previous sessions found for this project yet.`;let l=p.slice(0,3),S=[...new Set(l.map(y=>y.sdk_session_id))],L=ye(c,S).filter(y=>{let h=Y(y.concepts);return h.includes("what-changed")||h.includes("how-it-works")||h.includes("problem-solution")||h.includes("gotcha")||h.includes("discovery")||h.includes("why-it-exists")||h.includes("decision")||h.includes("trade-off")}),n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}\u{1F4DD} [${i}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${i}] recent context`),n.push("")),L.length>0){e?(n.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} gotcha | \u{1F7E1} problem-solution | \u{1F535} how-it-works | \u{1F7E2} what-changed | \u{1F7E3} discovery | \u{1F7E0} why-it-exists | \u{1F7E4} decision | \u2696\uFE0F trade-off${o.reset}`),n.push("")):(n.push("**Legend:** \u{1F3AF} session-request | \u{1F534} gotcha | \u{1F7E1} problem-solution | \u{1F535} how-it-works | \u{1F7E2} what-changed | \u{1F7E3} discovery | \u{1F7E0} why-it-exists | \u{1F7E4} decision | \u2696\uFE0F trade-off"),n.push("")),e?(n.push(`${o.dim}\u{1F4A1} Progressive Disclosure: This index shows WHAT exists (titles) and retrieval COST (token counts).${o.reset}`),n.push(`${o.dim}   \u2192 Use MCP search tools to fetch full observation details on-demand (Layer 2)${o.reset}`),n.push(`${o.dim}   \u2192 Prefer searching observations over re-reading code for past decisions and learnings${o.reset}`),n.push(`${o.dim}   \u2192 Critical types (\u{1F534} gotcha, \u{1F7E4} decision, \u2696\uFE0F trade-off) often worth fetching immediately${o.reset}`),n.push("")):(n.push("\u{1F4A1} **Progressive Disclosure:** This index shows WHAT exists (titles) and retrieval COST (token counts)."),n.push("- Use MCP search tools to fetch full observation details on-demand (Layer 2)"),n.push("- Prefer searching observations over re-reading code for past decisions and learnings"),n.push("- Critical types (\u{1F534} gotcha, \u{1F7E4} decision, \u2696\uFE0F trade-off) often worth fetching immediately"),n.push(""));let y=p[0]?.id,h=l.map((d,_)=>{let u=_===0?null:p[_+1];return{...d,displayEpoch:u?u.created_at_epoch:d.created_at_epoch,displayTime:u?u.created_at:d.created_at,isMostRecent:d.id===y}}),U=[...L.map(d=>({type:"observation",data:d})),...h.map(d=>({type:"summary",data:d}))];U.sort((d,_)=>{let u=d.type==="observation"?d.data.created_at_epoch:d.data.displayEpoch,N=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch;return u-N});let R=new Map;for(let d of U){let _=d.type==="observation"?d.data.created_at:d.data.displayTime,u=Re(_);R.has(u)||R.set(u,[]),R.get(u).push(d)}let J=Array.from(R.entries()).sort((d,_)=>{let u=new Date(d[0]).getTime(),N=new Date(_[0]).getTime();return u-N});for(let[d,_]of J){e?(n.push(`${o.bright}${o.cyan}${d}${o.reset}`),n.push("")):(n.push(`### ${d}`),n.push(""));let u=null,N="",A=!1;for(let M of _)if(M.type==="summary"){A&&(n.push(""),A=!1,u=null,N="");let m=M.data,x=`${m.request||"Session started"} (${Ne(m.displayTime)})`,b=m.isMostRecent?"":`claude-mem://session-summary/${m.id}`;if(e){let E=b?`${o.dim}[${b}]${o.reset}`:"";n.push(`\u{1F3AF} ${o.yellow}#S${m.id}${o.reset} ${x} ${E}`)}else{let E=b?` [\u2192](${b})`:"";n.push(`**\u{1F3AF} #S${m.id}** ${x}${E}`)}n.push("")}else{let m=M.data,x=Y(m.files_modified),b=x.length>0?ve(x[0],r):"General";b!==u&&(A&&n.push(""),e?n.push(`${o.dim}${b}${o.reset}`):n.push(`**${b}**`),e||(n.push("| ID | Time | T | Title | Tokens |"),n.push("|----|------|---|-------|--------|")),u=b,A=!0,N="");let E=Y(m.concepts),f="\u2022";E.includes("gotcha")?f="\u{1F534}":E.includes("decision")?f="\u{1F7E4}":E.includes("trade-off")?f="\u2696\uFE0F":E.includes("problem-solution")?f="\u{1F7E1}":E.includes("discovery")?f="\u{1F7E3}":E.includes("why-it-exists")?f="\u{1F7E0}":E.includes("how-it-works")?f="\u{1F535}":E.includes("what-changed")&&(f="\u{1F7E2}");let k=Ie(m.created_at),Q=m.title||"Untitled",P=Oe(m.narrative),z=k!==N,ae=z?k:"";if(N=k,e){let de=z?`${o.dim}${k}${o.reset}`:" ".repeat(k.length),ce=P>0?`${o.dim}(~${P}t)${o.reset}`:"";n.push(`  ${o.dim}#${m.id}${o.reset}  ${de}  ${f}  ${Q} ${ce}`)}else n.push(`| #${m.id} | ${ae||"\u2033"} | ${f} | ${Q} | ~${P} |`)}A&&n.push("")}let g=p[0];g&&(g.completed||g.next_steps)&&(g.completed&&(e?n.push(`${o.green}Completed:${o.reset} ${g.completed}`):n.push(`**Completed**: ${g.completed}`),n.push("")),g.next_steps&&(e?n.push(`${o.magenta}Next Steps:${o.reset} ${g.next_steps}`):n.push(`**Next Steps**: ${g.next_steps}`),n.push(""))),e?n.push(`${o.dim}Use claude-mem MCP search to access records with the given ID${o.reset}`):n.push("*Use claude-mem MCP search to access records with the given ID*"),n.push("")}return e&&(n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")),n.join(`
`)}finally{c.close()}}import{stdin as q}from"process";try{let a=process.argv.includes("--index");if(q.isTTY){let e=K(void 0,!0,a);console.log(e),process.exit(0)}else{let e="";q.on("data",t=>e+=t),q.on("end",()=>{let t=e.trim()?JSON.parse(e):void 0,r={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:K(t,!1,a)}};console.log(JSON.stringify(r)),process.exit(0)})}}catch(a){console.error(`[claude-mem context-hook error: ${a.message}]`),process.exit(0)}
