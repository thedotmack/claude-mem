#!/usr/bin/env node
import J from"path";import Te from"better-sqlite3";import{join as S,dirname as ue,basename as Ce}from"path";import{homedir as te}from"os";import{existsSync as Me,mkdirSync as me}from"fs";import{fileURLToPath as _e}from"url";function Ee(){return typeof __dirname<"u"?__dirname:ue(_e(import.meta.url))}var he=Ee(),I=process.env.CLAUDE_MEM_DATA_DIR||S(te(),".claude-mem"),Xe=process.env.CLAUDE_CONFIG_DIR||S(te(),".claude"),Fe=S(I,"archives"),je=S(I,"logs"),We=S(I,"trash"),Ge=S(I,"backups"),Be=S(I,"settings.json"),se=S(I,"claude-mem.db");function re(a){me(a,{recursive:!0})}function ne(){return S(he,"..","..")}var j=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(j||{}),W=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=j[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,n){if(e<this.level)return;let c=new Date().toISOString().replace("T"," ").substring(0,23),l=j[e].padEnd(5),p=s.padEnd(6),f="";r?.correlationId?f=`[${r.correlationId}] `:r?.sessionId&&(f=`[session-${r.sessionId}] `);let R="";n!=null&&(this.level===0&&typeof n=="object"?R=`
`+JSON.stringify(n,null,2):R=" "+this.formatData(n));let M="";if(r){let{sessionId:o,sdkSessionId:v,correlationId:h,...L}=r;Object.keys(L).length>0&&(M=` {${Object.entries(L).map(([P,T])=>`${P}=${T}`).join(", ")}}`)}let y=`[${c}] [${l}] [${p}] ${f}${t}${M}${R}`;e===3?console.error(y):console.log(y)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},oe=new W;var w=class{db;constructor(){re(I),this.db=new Te(se),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(p=>p.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).all(e),r=new Set,n=new Set;for(let c of t){if(c.files_read)try{let l=JSON.parse(c.files_read);Array.isArray(l)&&l.forEach(p=>r.add(p))}catch{}if(c.files_modified)try{let l=JSON.parse(c.files_modified);Array.isArray(l)&&l.forEach(p=>n.add(p))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(n)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,n=r.getTime(),l=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),n);return l.lastInsertRowid===0||l.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:l.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(oe.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,t){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}storeObservation(e,s,t,r){let n=new Date,c=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`)),this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,n.toISOString(),c)}storeSummary(e,s,t,r){let n=new Date,c=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`)),this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,n.toISOString(),c)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};import Y from"path";import{existsSync as V}from"fs";import{spawn as Re}from"child_process";import{readFileSync as ge,writeFileSync as fe,existsSync as G,mkdirSync as be,renameSync as ie}from"fs";import{join as Se,dirname as Ne}from"path";import{homedir as Ie}from"os";var O={model:"claude-sonnet-4-5",workerPort:37777,enableMemoryStorage:!0,enableContextInjection:!0,contextDepth:5},C={model:"AI model to use for processing observations and generating summaries",workerPort:"Port for the background worker service HTTP API",enableMemoryStorage:"Enable/disable saving tool observations to the database",enableContextInjection:"Enable/disable context injection at session start",contextDepth:"Number of recent sessions to load when injecting context (higher = more history, more tokens)"},$=["claude-haiku-4-5","claude-sonnet-4-5","claude-opus-4","claude-3-7-sonnet"],H=class{settingsPath;cachedSettings=null;constructor(e){this.settingsPath=e||Se(Ie(),".claude-mem","settings.json")}loadSettings(){if(this.cachedSettings)return this.cachedSettings;let e={};if(G(this.settingsPath))try{let t=ge(this.settingsPath,"utf-8");e=JSON.parse(t)}catch(t){let r=this.settingsPath+".bak";try{ie(this.settingsPath,r),console.error(`[claude-mem] Failed to parse settings file: ${t.message}`),console.error(`[claude-mem] Backed up invalid settings to: ${r}`)}catch(n){console.error(`[claude-mem] Failed to parse settings file: ${t.message}`),console.error(`[claude-mem] Could not backup invalid file: ${n.message}`)}}let s={model:e.model??O.model,workerPort:e.workerPort??O.workerPort,enableMemoryStorage:e.enableMemoryStorage??O.enableMemoryStorage,enableContextInjection:e.enableContextInjection??O.enableContextInjection,contextDepth:e.contextDepth??O.contextDepth};return this.validateSettings(s),this.cachedSettings=s,s}validateSettings(e){if(!$.includes(e.model))throw new Error(`Invalid model: ${e.model}. Must be one of: ${$.join(", ")}`);if(typeof e.workerPort!="number"||e.workerPort<1||e.workerPort>65535)throw new Error(`Invalid workerPort: ${e.workerPort}. Must be between 1-65535`);if(typeof e.enableMemoryStorage!="boolean")throw new Error(`Invalid enableMemoryStorage: ${e.enableMemoryStorage}. Must be boolean`);if(typeof e.enableContextInjection!="boolean")throw new Error(`Invalid enableContextInjection: ${e.enableContextInjection}. Must be boolean`);if(typeof e.contextDepth!="number"||e.contextDepth<1||e.contextDepth>50)throw new Error(`Invalid contextDepth: ${e.contextDepth}. Must be between 1-50`)}get(){return this.loadSettings()}getWithDescriptions(){let e=this.get();return{model:{value:e.model,description:C.model,options:$},workerPort:{value:e.workerPort,description:C.workerPort},enableMemoryStorage:{value:e.enableMemoryStorage,description:C.enableMemoryStorage},enableContextInjection:{value:e.enableContextInjection,description:C.enableContextInjection},contextDepth:{value:e.contextDepth,description:C.contextDepth}}}set(e){let t={...this.get(),...e};this.validateSettings(t);let r=Ne(this.settingsPath);G(r)||be(r,{recursive:!0});try{let n=this.settingsPath+".tmp";fe(n,JSON.stringify(t,null,2),"utf-8"),ie(n,this.settingsPath),this.cachedSettings=t}catch(n){throw new Error(`Failed to save settings: ${n.message}`)}}reset(){this.set(O)}getDefaults(){return{...O}}getModelOptions(){return[...$]}exists(){return G(this.settingsPath)}getPath(){return this.settingsPath}},B=null;function U(){return B||(B=new H),B}var K;function Oe(){return K===void 0&&(K=U().get().workerPort),`http://127.0.0.1:${K}/health`}async function ae(){try{return(await fetch(Oe(),{signal:AbortSignal.timeout(500)})).ok}catch{return!1}}async function de(){try{if(await ae())return!0;console.error("[claude-mem] Worker not responding, starting...");let a=ne(),e=Y.join(a,"plugin","scripts","worker-service.cjs");if(!V(e))return console.error(`[claude-mem] Worker service not found at ${e}`),!1;let s=Y.join(a,"ecosystem.config.cjs"),t=Y.join(a,"node_modules",".bin","pm2");if(!V(t))throw new Error(`PM2 binary not found at ${t}. This is a bundled dependency - try running: npm install`);if(!V(s))throw new Error(`PM2 ecosystem config not found at ${s}. Plugin installation may be corrupted.`);let r=Re(t,["start",s],{detached:!0,stdio:"ignore",cwd:a});r.on("error",n=>{throw new Error(`Failed to spawn PM2: ${n.message}`)}),r.unref(),console.error("[claude-mem] Worker started with PM2");for(let n=0;n<3;n++)if(await new Promise(c=>setTimeout(c,500)),await ae())return console.error("[claude-mem] Worker is healthy"),!0;return console.error("[claude-mem] Worker failed to become healthy after startup"),!1}catch(a){return console.error(`[claude-mem] Failed to start worker: ${a.message}`),!1}}var i={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function q(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function ve(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ye(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Le(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ae(a){return a?Math.ceil(a.length/4):0}function xe(a,e){try{return J.isAbsolute(a)?J.relative(e,a):a}catch{return a}}function ke(a,e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return a.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified,
      created_at, created_at_epoch
    FROM observations
    WHERE sdk_session_id IN (${s})
    ORDER BY created_at_epoch DESC
  `).all(...e)}function Q(a,e=!1,s=!1){de();let t=U().get();if(!t.enableContextInjection)return"";let r=a?.cwd??process.cwd(),n=r?J.basename(r):"unknown-project",c=new w;try{let l=t.contextDepth,p=c.db.prepare(`
      SELECT id, sdk_session_id, request, completed, next_steps, created_at, created_at_epoch
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(n,l+1);if(p.length===0)return e?`
${i.bright}${i.cyan}\u{1F4DD} [${n}] recent context${i.reset}
${i.gray}${"\u2500".repeat(60)}${i.reset}

${i.dim}No previous sessions found for this project yet.${i.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let f=p.slice(0,l),R=[...new Set(f.map(v=>v.sdk_session_id))],y=ke(c,R).filter(v=>{let h=q(v.concepts);return h.includes("what-changed")||h.includes("how-it-works")||h.includes("problem-solution")||h.includes("gotcha")||h.includes("discovery")||h.includes("why-it-exists")||h.includes("decision")||h.includes("trade-off")}),o=[];if(e?(o.push(""),o.push(`${i.bright}${i.cyan}\u{1F4DD} [${n}] recent context${i.reset}`),o.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),o.push("")):(o.push(`# [${n}] recent context`),o.push("")),y.length>0){e?(o.push(`${i.dim}Legend: \u{1F3AF} session-request | \u{1F534} gotcha | \u{1F7E1} problem-solution | \u{1F535} how-it-works | \u{1F7E2} what-changed | \u{1F7E3} discovery | \u{1F7E0} why-it-exists | \u{1F7E4} decision | \u2696\uFE0F trade-off${i.reset}`),o.push("")):(o.push("**Legend:** \u{1F3AF} session-request | \u{1F534} gotcha | \u{1F7E1} problem-solution | \u{1F535} how-it-works | \u{1F7E2} what-changed | \u{1F7E3} discovery | \u{1F7E0} why-it-exists | \u{1F7E4} decision | \u2696\uFE0F trade-off"),o.push("")),e?(o.push(`${i.dim}\u{1F4A1} Progressive Disclosure: This index shows WHAT exists (titles) and retrieval COST (token counts).${i.reset}`),o.push(`${i.dim}   \u2192 Use MCP search tools to fetch full observation details on-demand (Layer 2)${i.reset}`),o.push(`${i.dim}   \u2192 Prefer searching observations over re-reading code for past decisions and learnings${i.reset}`),o.push(`${i.dim}   \u2192 Critical types (\u{1F534} gotcha, \u{1F7E4} decision, \u2696\uFE0F trade-off) often worth fetching immediately${i.reset}`),o.push("")):(o.push("\u{1F4A1} **Progressive Disclosure:** This index shows WHAT exists (titles) and retrieval COST (token counts)."),o.push("- Use MCP search tools to fetch full observation details on-demand (Layer 2)"),o.push("- Prefer searching observations over re-reading code for past decisions and learnings"),o.push("- Critical types (\u{1F534} gotcha, \u{1F7E4} decision, \u2696\uFE0F trade-off) often worth fetching immediately"),o.push(""));let v=p[0]?.id,h=f.map((d,_)=>{let u=_===0?null:p[_+1];return{...d,displayEpoch:u?u.created_at_epoch:d.created_at_epoch,displayTime:u?u.created_at:d.created_at,isMostRecent:d.id===v}}),L=[...y.map(d=>({type:"observation",data:d})),...h.map(d=>({type:"summary",data:d}))];L.sort((d,_)=>{let u=d.type==="observation"?d.data.created_at_epoch:d.data.displayEpoch,N=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch;return u-N});let A=new Map;for(let d of L){let _=d.type==="observation"?d.data.created_at:d.data.displayTime,u=Le(_);A.has(u)||A.set(u,[]),A.get(u).push(d)}let P=Array.from(A.entries()).sort((d,_)=>{let u=new Date(d[0]).getTime(),N=new Date(_[0]).getTime();return u-N});for(let[d,_]of P){e?(o.push(`${i.bright}${i.cyan}${d}${i.reset}`),o.push("")):(o.push(`### ${d}`),o.push(""));let u=null,N="",x=!1;for(let X of _)if(X.type==="summary"){x&&(o.push(""),x=!1,u=null,N="");let m=X.data,k=`${m.request||"Session started"} (${ve(m.displayTime)})`,b=m.isMostRecent?"":`claude-mem://session-summary/${m.id}`;if(e){let E=b?`${i.dim}[${b}]${i.reset}`:"";o.push(`\u{1F3AF} ${i.yellow}#S${m.id}${i.reset} ${k} ${E}`)}else{let E=b?` [\u2192](${b})`:"";o.push(`**\u{1F3AF} #S${m.id}** ${k}${E}`)}o.push("")}else{let m=X.data,k=q(m.files_modified),b=k.length>0?xe(k[0],r):"General";b!==u&&(x&&o.push(""),e?o.push(`${i.dim}${b}${i.reset}`):o.push(`**${b}**`),e||(o.push("| ID | Time | T | Title | Tokens |"),o.push("|----|------|---|-------|--------|")),u=b,x=!0,N="");let E=q(m.concepts),g="\u2022";E.includes("gotcha")?g="\u{1F534}":E.includes("decision")?g="\u{1F7E4}":E.includes("trade-off")?g="\u2696\uFE0F":E.includes("problem-solution")?g="\u{1F7E1}":E.includes("discovery")?g="\u{1F7E3}":E.includes("why-it-exists")?g="\u{1F7E0}":E.includes("how-it-works")?g="\u{1F535}":E.includes("what-changed")&&(g="\u{1F7E2}");let D=ye(m.created_at),Z=m.title||"Untitled",F=Ae(m.narrative),ee=D!==N,ce=ee?D:"";if(N=D,e){let pe=ee?`${i.dim}${D}${i.reset}`:" ".repeat(D.length),le=F>0?`${i.dim}(~${F}t)${i.reset}`:"";o.push(`  ${i.dim}#${m.id}${i.reset}  ${pe}  ${g}  ${Z} ${le}`)}else o.push(`| #${m.id} | ${ce||"\u2033"} | ${g} | ${Z} | ~${F} |`)}x&&o.push("")}let T=p[0];T&&(T.completed||T.next_steps)&&(T.completed&&(e?o.push(`${i.green}Completed:${i.reset} ${T.completed}`):o.push(`**Completed**: ${T.completed}`),o.push("")),T.next_steps&&(e?o.push(`${i.magenta}Next Steps:${i.reset} ${T.next_steps}`):o.push(`**Next Steps**: ${T.next_steps}`),o.push(""))),e?o.push(`${i.dim}Use claude-mem MCP search to access records with the given ID${i.reset}`):o.push("*Use claude-mem MCP search to access records with the given ID*"),o.push("")}return e&&(o.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),o.push("")),o.join(`
`)}finally{c.close()}}import{stdin as z}from"process";try{let a=process.argv.includes("--index");if(z.isTTY){let e=Q(void 0,!0,a);console.log(e),process.exit(0)}else{let e="";z.on("data",s=>e+=s),z.on("end",()=>{let s=e.trim()?JSON.parse(e):void 0,r={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:Q(s,!1,a)}};console.log(JSON.stringify(r)),process.exit(0)})}}catch(a){console.error(`[claude-mem context-hook error: ${a.message}]`),process.exit(0)}
