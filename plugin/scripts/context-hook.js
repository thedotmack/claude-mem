#!/usr/bin/env node
import X from"path";import ae from"better-sqlite3";import{join as _,dirname as te,basename as Te}from"path";import{homedir as H}from"os";import{existsSync as Se,mkdirSync as re}from"fs";import{fileURLToPath as ne}from"url";function ie(){return typeof __dirname<"u"?__dirname:te(ne(import.meta.url))}var oe=ie(),L=process.env.CLAUDE_MEM_DATA_DIR||_(H(),".claude-mem"),C=process.env.CLAUDE_CONFIG_DIR||_(H(),".claude"),Re=_(L,"archives"),Ne=_(L,"logs"),Ie=_(L,"trash"),Oe=_(L,"backups"),Le=_(L,"settings.json"),B=_(L,"claude-mem.db"),Ae=_(C,"settings.json"),ve=_(C,"commands"),ye=_(C,"CLAUDE.md");function j(a){re(a,{recursive:!0})}function Y(){return _(oe,"..","..")}var x=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(x||{}),$=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=x[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,o){if(e<this.level)return;let d=new Date().toISOString().replace("T"," ").substring(0,23),u=x[e].padEnd(5),p=s.padEnd(6),c="";r?.correlationId?c=`[${r.correlationId}] `:r?.sessionId&&(c=`[session-${r.sessionId}] `);let R="";o!=null&&(this.level===0&&typeof o=="object"?R=`
`+JSON.stringify(o,null,2):R=" "+this.formatData(o));let n="";if(r){let{sessionId:E,sdkSessionId:h,correlationId:N,...g}=r;Object.keys(g).length>0&&(n=` {${Object.entries(g).map(([O,f])=>`${O}=${f}`).join(", ")}}`)}let b=`[${d}] [${u}] [${p}] ${c}${t}${n}${R}`;e===3?console.error(b):console.log(b)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},q=new $;var D=class{db;constructor(){j(L),this.db=new ae(B),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
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
    `).all(e),r=new Set,o=new Set;for(let d of t){if(d.files_read)try{let u=JSON.parse(d.files_read);Array.isArray(u)&&u.forEach(p=>r.add(p))}catch{}if(d.files_modified)try{let u=JSON.parse(d.files_modified);Array.isArray(u)&&u.forEach(p=>o.add(p))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,o=r.getTime(),u=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),o);return u.lastInsertRowid===0||u.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:u.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(q.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};import w from"path";import{existsSync as U}from"fs";import{spawn as de}from"child_process";var ce=parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10),pe=`http://127.0.0.1:${ce}/health`;async function K(){try{return(await fetch(pe,{signal:AbortSignal.timeout(500)})).ok}catch{return!1}}async function V(){try{if(await K())return!0;console.error("[claude-mem] Worker not responding, starting...");let a=Y(),e=w.join(a,"plugin","scripts","worker-service.cjs");if(!U(e))return console.error(`[claude-mem] Worker service not found at ${e}`),!1;let s=w.join(a,"ecosystem.config.cjs"),t=w.join(a,"node_modules",".bin","pm2");if(!U(t))throw new Error(`PM2 binary not found at ${t}. This is a bundled dependency - try running: npm install`);if(!U(s))throw new Error(`PM2 ecosystem config not found at ${s}. Plugin installation may be corrupted.`);let r=de(t,["start",s],{detached:!0,stdio:"ignore",cwd:a});r.on("error",o=>{throw new Error(`Failed to spawn PM2: ${o.message}`)}),r.unref(),console.error("[claude-mem] Worker started with PM2");for(let o=0;o<3;o++)if(await new Promise(d=>setTimeout(d,500)),await K())return console.error("[claude-mem] Worker is healthy"),!0;return console.error("[claude-mem] Worker failed to become healthy after startup"),!1}catch(a){return console.error(`[claude-mem] Failed to start worker: ${a.message}`),!1}}var i={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function M(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function J(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Q(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function z(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function ue(a){return a?Math.ceil(a.length/4):0}function me(a,e){try{return X.isAbsolute(a)?X.relative(e,a):a}catch{return a}}function le(a,e,s=3){return a.db.prepare(`
    SELECT sdk_session_id
    FROM sdk_sessions
    WHERE project = ? AND sdk_session_id IS NOT NULL
    ORDER BY started_at_epoch DESC
    LIMIT ?
  `).all(e,s).map(r=>r.sdk_session_id)}function _e(a,e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return a.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified,
      created_at, created_at_epoch
    FROM observations
    WHERE sdk_session_id IN (${s})
    ORDER BY created_at_epoch DESC
  `).all(...e)}function F(a,e=!1,s=!1){V();let t=a?.cwd??process.cwd(),r=t?X.basename(t):"unknown-project",o=new D;try{let d=le(o,r,3);if(d.length===0)return e?`
${i.bright}${i.cyan}\u{1F4DD} [${r}] recent context${i.reset}
${i.gray}${"\u2500".repeat(60)}${i.reset}

${i.dim}No previous sessions found for this project yet.${i.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let p=_e(o,d).filter(b=>{let E=M(b.concepts);return E.includes("what-changed")||E.includes("how-it-works")||E.includes("problem-solution")||E.includes("gotcha")||E.includes("discovery")||E.includes("why-it-exists")||E.includes("decision")||E.includes("trade-off")}),c=o.db.prepare(`
      SELECT request, completed, next_steps, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(r),R=o.db.prepare(`
      SELECT id, request, created_at, created_at_epoch
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 3
    `).all(r),n=[];if(e?(n.push(""),n.push(`${i.bright}${i.cyan}\u{1F4DD} [${r}] recent context${i.reset}`),n.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),p.length>0){e?(n.push(`${i.bright}${i.blue}\u{1F4CB} RECENT ACTIVITY TIMELINE${i.reset}`),n.push("")):(n.push("## Recent Activity Timeline"),n.push("")),e?(n.push(`${i.dim}Legend: \u{1F3AF} session-request | \u{1F534} gotcha | \u{1F7E1} problem-solution | \u{1F535} how-it-works | \u{1F7E2} what-changed | \u{1F7E3} discovery | \u{1F7E0} why-it-exists | \u{1F7E4} decision | \u2696\uFE0F trade-off${i.reset}`),n.push("")):(n.push("**Legend:** \u{1F3AF} session-request | \u{1F534} gotcha | \u{1F7E1} problem-solution | \u{1F535} how-it-works | \u{1F7E2} what-changed | \u{1F7E3} discovery | \u{1F7E0} why-it-exists | \u{1F7E4} decision | \u2696\uFE0F trade-off"),n.push(""));let b=new Map;for(let h of p){let N=z(h.created_at),g=M(h.files_modified),I=g.length>0?me(g[0],t):"General";b.has(N)||b.set(N,new Map);let O=b.get(N);O.has(I)||O.set(I,[]),O.get(I).push(h)}let E=Array.from(b.entries()).sort((h,N)=>{let g=new Date(h[0]).getTime(),I=new Date(N[0]).getTime();return g-I});for(let[h,N]of E){e?(n.push(`${i.bright}${i.cyan}${h}${i.reset}`),n.push("")):(n.push(`### ${h}`),n.push(""));let g=R.filter(f=>z(f.created_at)===h);if(g.length>0){e?n.push(`${i.dim}Session Requests${i.reset}`):n.push("**Session Requests**"),e||(n.push("| ID | Time | Title | Link |"),n.push("|----|------|-------|------|"));let f=R[0]?.id;for(let S of g.slice().reverse()){let A=Q(S.created_at),v=S.request||"Session started",l=S.id===f?"":`claude-mem://session-summary/${S.id}`;if(e){let m=l?`${i.dim}[${l}]${i.reset}`:"";n.push(`  ${i.dim}#S${S.id}${i.reset}  ${i.dim}${A}${i.reset}  \u{1F3AF}  ${v} ${m}`)}else{let m=l?`[\u2192](${l})`:"-";n.push(`| #S${S.id} | ${A} | \u{1F3AF} ${v} | ${m} |`)}}n.push("")}let I=Array.from(N.entries()).sort((f,S)=>{let A=Math.min(...f[1].map(T=>T.created_at_epoch)),v=Math.min(...S[1].map(T=>T.created_at_epoch));return A-v}),O=0;for(let[f,S]of I){if(O>=10)break;e?n.push(`${i.dim}${f}${i.reset}`):n.push(`**${f}**`),e||(n.push("| ID | Time | T | Title | Tokens |"),n.push("|----|------|---|-------|--------|"));let A="",v=S.slice(0,5).reverse();for(let T of v){let l=M(T.concepts),m="\u2022";l.includes("gotcha")?m="\u{1F534}":l.includes("decision")?m="\u{1F7E4}":l.includes("trade-off")?m="\u2696\uFE0F":l.includes("problem-solution")?m="\u{1F7E1}":l.includes("discovery")?m="\u{1F7E3}":l.includes("why-it-exists")?m="\u{1F7E0}":l.includes("how-it-works")?m="\u{1F535}":l.includes("what-changed")&&(m="\u{1F7E2}");let y=Q(T.created_at),G=T.title||"Untitled",k=ue(T.narrative),W=y!==A,Z=W?y:"";if(A=y,e){let ee=W?`${i.dim}${y}${i.reset}`:" ".repeat(y.length),se=k>0?`${i.dim}(~${k}t)${i.reset}`:"";n.push(`  ${i.dim}#${T.id}${i.reset}  ${ee}  ${m}  ${G} ${se}`)}else n.push(`| #${T.id} | ${Z||"\u2033"} | ${m} | ${G} | ~${k} |`)}n.push(""),O++}}e?n.push(`${i.dim}Use claude-mem MCP search to access records with the given ID${i.reset}`):n.push("*Use claude-mem MCP search to access records with the given ID*"),n.push("")}return c&&(e?(n.push(`${i.bright}${i.cyan}\u{1F4CB} RECENT SESSION SUMMARY${i.reset} ${i.dim}(${J(c.created_at)})${i.reset}`),n.push("")):(n.push(`## Recent Session Summary *(${J(c.created_at)})*`),n.push("")),c.request&&(e?n.push(`${i.yellow}Request:${i.reset} ${c.request}`):n.push(`**Request**: ${c.request}`),n.push("")),c.completed&&(e?n.push(`${i.green}Completed:${i.reset} ${c.completed}`):n.push(`**Completed**: ${c.completed}`),n.push("")),c.next_steps&&(e?n.push(`${i.magenta}Next Steps:${i.reset} ${c.next_steps}`):n.push(`**Next Steps**: ${c.next_steps}`),n.push(""))),e&&(n.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),n.push("")),n.join(`
`)}finally{o.close()}}import{stdin as P}from"process";try{let a=process.argv.includes("--index");if(P.isTTY){let e=F(void 0,!0,a);console.log(e),process.exit(0)}else{let e="";P.on("data",s=>e+=s),P.on("end",()=>{let s=e.trim()?JSON.parse(e):void 0,r={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:F(s,!1,a)}};console.log(JSON.stringify(r)),process.exit(0)})}}catch(a){console.error(`[claude-mem context-hook error: ${a.message}]`),process.exit(0)}
