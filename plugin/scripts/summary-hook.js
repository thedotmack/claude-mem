#!/usr/bin/env node
import{stdin as J}from"process";import{readFileSync as q,existsSync as w}from"fs";import se from"better-sqlite3";import{join as T,dirname as V,basename as ke}from"path";import{homedir as F}from"os";import{existsSync as Ue,mkdirSync as z}from"fs";import{fileURLToPath as Q}from"url";function Z(){return typeof __dirname<"u"?__dirname:V(Q(import.meta.url))}var ee=Z(),S=process.env.CLAUDE_MEM_DATA_DIR||T(F(),".claude-mem"),v=process.env.CLAUDE_CONFIG_DIR||T(F(),".claude"),Fe=T(S,"archives"),Be=T(S,"logs"),He=T(S,"trash"),C=T(S,"backups"),Xe=T(S,"settings.json"),B=T(S,"claude-mem.db"),$e=T(S,"vector-db"),je=T(v,"settings.json"),Pe=T(v,"commands"),Ge=T(v,"CLAUDE.md");function h(n){z(n,{recursive:!0})}function H(){return T(ee,"..","..")}var k=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(k||{}),D=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=k[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,o){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),a=k[e].padEnd(5),c=s.padEnd(6),d="";r?.correlationId?d=`[${r.correlationId}] `:r?.sessionId&&(d=`[session-${r.sessionId}] `);let u="";o!=null&&(this.level===0&&typeof o=="object"?u=`
`+JSON.stringify(o,null,2):u=" "+this.formatData(o));let _="";if(r){let{sessionId:g,sdkSessionId:f,correlationId:E,...p}=r;Object.keys(p).length>0&&(_=` {${Object.entries(p).map(([O,A])=>`${O}=${A}`).join(", ")}}`)}let m=`[${i}] [${a}] [${c}] ${d}${t}${_}${u}`;e===3?console.error(m):console.log(m)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},l=new D;var b=class{db;constructor(){h(S),this.db=new se(B),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn()}initializeSchema(){try{this.db.exec(`
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
            status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active',
            endless_original_tokens INTEGER DEFAULT 0,
            endless_compressed_tokens INTEGER DEFAULT 0,
            endless_tokens_saved INTEGER DEFAULT 0
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(c=>c.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created unique index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(i=>i.name==="endless_original_tokens"),r=s.some(i=>i.name==="endless_compressed_tokens"),o=s.some(i=>i.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),o||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).all().map(t=>t.project)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
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
    `).all(e),r=new Set,o=new Set;for(let i of t){if(i.files_read)try{let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(c=>r.add(c))}catch{}if(i.files_modified)try{let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(c=>o.add(c))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).run(s,e).changes===0?(l.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),o).lastInsertRowid}storeObservation(e,s,t,r,o=0){let i=new Date,a=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let _=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,o,t.tool_use_id||null,i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||null}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),o=new Map;for(let i of r)i.tool_use_id&&o.set(i.tool_use_id,i);return o}storeSummary(e,s,t,r,o=0){let i=new Date,a=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let _=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,o,i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${o}
      ${i}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${o}
      ${i}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,o){let i=o?"AND project = ?":"",a=o?[o]:[],c,d;if(e!==null){let g=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let E=this.db.prepare(g).all(e,...a,t+1),p=this.db.prepare(f).all(e,...a,r+1);if(E.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};c=E.length>0?E[E.length-1].created_at_epoch:s,d=p.length>0?p[p.length-1].created_at_epoch:s}catch(E){return console.error("[SessionStore] Error getting boundary observations:",E.message),{observations:[],sessions:[],prompts:[]}}}else{let g=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let E=this.db.prepare(g).all(s,...a,t),p=this.db.prepare(f).all(s,...a,r+1);if(E.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};c=E.length>0?E[E.length-1].created_at_epoch:s,d=p.length>0?p[p.length-1].created_at_epoch:s}catch(E){return console.error("[SessionStore] Error getting boundary timestamps:",E.message),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,m=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let g=this.db.prepare(u).all(c,d,...a),f=this.db.prepare(_).all(c,d,...a),E=this.db.prepare(m).all(c,d,...a);return{observations:g,sessions:f.map(p=>({id:p.id,sdk_session_id:p.sdk_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:E.map(p=>({id:p.id,claude_session_id:p.claude_session_id,project:p.project,prompt:p.prompt_text,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}catch(g){return console.error("[SessionStore] Error querying timeline records:",g.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
      UPDATE sdk_sessions
      SET
        endless_original_tokens = COALESCE(endless_original_tokens, 0) + ?,
        endless_compressed_tokens = COALESCE(endless_compressed_tokens, 0) + ?,
        endless_tokens_saved = COALESCE(endless_tokens_saved, 0) + ?
      WHERE claude_session_id = ?
    `).run(s,t,r,e)}getEndlessModeStats(e){let t=this.db.prepare(`
      SELECT
        endless_original_tokens,
        endless_compressed_tokens,
        endless_tokens_saved
      FROM sdk_sessions
      WHERE claude_session_id = ?
    `).get(e);return t?{originalTokens:t.endless_original_tokens||0,compressedTokens:t.endless_compressed_tokens||0,tokensSaved:t.endless_tokens_saved||0}:null}close(){this.db.close()}};function te(n,e,s){return n==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:n==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:n==="UserPromptSubmit"||n==="PostToolUse"?{continue:!0,suppressOutput:!0}:n==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function X(n,e,s={}){let t=te(n,e,s);return JSON.stringify(t)}import $ from"path";import{homedir as re}from"os";import{existsSync as j,readFileSync as ne}from"fs";import{execSync as oe}from"child_process";var ie=100,ae=500,ce=10;function y(){try{let n=$.join(re(),".claude-mem","settings.json");if(j(n)){let e=JSON.parse(ne(n,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function P(){try{let n=y();return(await fetch(`http://127.0.0.1:${n}/health`,{signal:AbortSignal.timeout(ie)})).ok}catch{return!1}}async function de(){try{let n=H(),e=$.join(n,"ecosystem.config.cjs");if(!j(e))throw new Error(`Ecosystem config not found at ${e}`);oe(`pm2 start "${e}"`,{cwd:n,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<ce;s++)if(await new Promise(t=>setTimeout(t,ae)),await P())return!0;return!1}catch{return!1}}async function G(){if(await P())return;if(!await de()){let e=y();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{appendFileSync as pe}from"fs";import{homedir as ue}from"os";import{join as le}from"path";var _e=le(ue(),".claude-mem","silent.log");function M(n,e,s=""){let t=new Date().toISOString(),a=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),c=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",d=`[${t}] [${c}] ${n}`;if(e!==void 0)try{d+=` ${JSON.stringify(e)}`}catch(u){d+=` [stringify error: ${u}]`}d+=`
`;try{pe(_e,d)}catch(u){console.error("[silent-debug] Failed to write to log:",u)}return s}import{existsSync as me,readFileSync as Ee}from"fs";import{homedir as Te}from"os";import ge from"path";function N(n,e,s){if(n!==void 0){if(typeof n=="boolean")return n;if(typeof n=="string")return n.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function x(n,e,s){if(n!==void 0){if(typeof n=="number")return n;if(typeof n=="string"){let t=parseInt(n,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function fe(){let n=ge.join(Te(),".claude-mem","settings.json"),e={};if(me(n))try{e=JSON.parse(Ee(n,"utf-8"))}catch(u){l.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},u)}let s=N(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=N(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=x(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),o=x(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),i=N(e.env?.CLAUDE_MEM_OBSERVE_EVERYTHING,process.env.CLAUDE_MEM_OBSERVE_EVERYTHING,s),a=x(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),c=N(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),d={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:o,observeEverything:i,maxToolHistoryMB:a,enableSynchronousMode:c};return s?l.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:o,observeEverything:i,maxToolHistoryMB:`${a}MB`}):l.debug("CONFIG","Endless Mode disabled"),d}var I=class{static getConfig=fe;static clearCache(){}};import{readFileSync as K,writeFileSync as Oe,renameSync as he}from"fs";import{existsSync as ms,readFileSync as Es,writeFileSync as Ts,appendFileSync as Se,statSync as gs}from"fs";import{join as be}from"path";var Re=be(C,"tool-outputs.jsonl");function W(n,e,s=Date.now()){h(C);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),i=JSON.stringify({tool_use_id:n,content:e,timestamp:s,size_bytes:r})+`
`;Se(Re,i,"utf8")}function L(n,e){if(!n)return[];if(Array.isArray(n))return n;try{let s=JSON.parse(n);return Array.isArray(s)?s:[]}catch(s){return l.debug("HOOK",`Failed to parse ${e}`,{field:n,error:s}),[]}}function ye(n){try{let s=K(n,"utf-8").trim().split(`
`),t=[];for(let r of s)if(r.trim())try{let o=JSON.parse(r);if(o.type==="user"){let a=o.message.content;if(Array.isArray(a)){for(let c of a)if(c.type==="tool_result"){let d=c;!(typeof d.content=="string"?d.content:JSON.stringify(d.content)).trim().startsWith("# ")&&d.tool_use_id&&t.push(d.tool_use_id)}}}}catch{continue}return t}catch(e){return l.warn("HOOK","Failed to extract pending tool_use_ids",{transcriptPath:n},e),[]}}function Ne(n){let e=L(n.facts,"facts"),s=L(n.concepts,"concepts"),t=L(n.files_read,"files_read"),r=L(n.files_modified,"files_modified");return`# ${n.title}
${n.subtitle?`**${n.subtitle}**
`:""}
${n.narrative?`${n.narrative}
`:""}
${e.length>0?`**Key Facts:**
${e.map(o=>`- ${o}`).join(`
`)}
`:""}
${s.length>0?`**Concepts**: ${s.join(", ")}
`:""}
${t.length>0?`**Files Read**: ${t.join(", ")}
`:""}
${r.length>0?`**Files Modified**: ${r.join(", ")}
`:""}
---
*[Compressed by Endless Mode]*`}async function Ie(n,e,s){let r=K(n,"utf-8").trim().split(`
`),o=!1,i=0,a=0,c=r.map((u,_)=>{if(!u.trim())return u;try{let m=JSON.parse(u);if(m.type==="user"){let f=m.message.content;if(Array.isArray(f))for(let E=0;E<f.length;E++){let p=f[E];if(p.type==="tool_result"){let R=p;if(R.tool_use_id===e){o=!0;try{W(e,R.content,Date.now()),l.debug("HOOK","Backed up original tool output",{toolUseId:e})}catch(A){l.warn("HOOK","Failed to backup original tool output",{toolUseId:e},A)}i=JSON.stringify(R.content).length;let O=Ne(s);a=O.length,R.content=O,l.success("HOOK","Transformed tool result",{toolUseId:e,originalSize:i,compressedSize:a,savings:`${Math.round((1-a/i)*100)}%`})}}}}return JSON.stringify(m)}catch(m){throw l.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:_,error:m}),new Error(`Malformed JSONL line at index ${_}: ${m.message}`)}});if(!o)return l.warn("HOOK","Tool result not found in transcript",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let d=`${n}.tmp`;return Oe(d,c.join(`
`)+`
`,"utf-8"),he(d,n),{originalTokens:i,compressedTokens:a}}async function Y(n,e,s){let t=0;try{let r=ye(n);if(r.length===0)return 0;l.debug(s,"Found pending tool_use_ids",{count:r.length,ids:r});let o=new b,i=o.getObservationsByToolUseIds(r);if(o.close(),i.size===0)return 0;l.info(s,"Ready observations for transformation",{pending:r.length,ready:i.size});for(let[a,c]of i)try{let d={id:c.id,type:c.type,title:c.title,subtitle:c.subtitle,narrative:c.narrative,facts:JSON.parse(c.facts),concepts:JSON.parse(c.concepts),files_read:JSON.parse(c.files_read),files_modified:JSON.parse(c.files_modified),created_at_epoch:c.created_at_epoch},u=await Ie(n,a,d);if(u.originalTokens>0)try{let _=new b;_.incrementEndlessModeStats(e,u.originalTokens,u.compressedTokens),_.close()}catch(_){l.debug(s,"Stats update skipped",{error:_})}l.success(s,"Deferred transformation complete",{toolUseId:a,observationId:c.id,savings:`${Math.round((1-u.compressedTokens/u.originalTokens)*100)}%`}),t++}catch(d){l.warn(s,"Deferred transformation failed",{toolUseId:a},d)}}catch(r){l.warn(s,"Deferred transformation check failed",{},r)}return t}function Le(n){if(!n||!w(n))return"";try{let e=q(n,"utf-8").trim();if(!e)return"";let s=e.split(`
`);for(let t=s.length-1;t>=0;t--)try{let r=JSON.parse(s[t]);if(r.type==="user"&&r.message?.content){let o=r.message.content;if(typeof o=="string")return o;if(Array.isArray(o))return o.filter(a=>a.type==="text").map(a=>a.text).join(`
`)}}catch{continue}}catch(e){l.error("HOOK","Failed to read transcript",{transcriptPath:n},e)}return""}function Ae(n){if(!n||!w(n))return"";try{let e=q(n,"utf-8").trim();if(!e)return"";let s=e.split(`
`);for(let t=s.length-1;t>=0;t--)try{let r=JSON.parse(s[t]);if(r.type==="assistant"&&r.message?.content){let o="",i=r.message.content;return typeof i=="string"?o=i:Array.isArray(i)&&(o=i.filter(c=>c.type==="text").map(c=>c.text).join(`
`)),o=o.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,""),o=o.replace(/\n{3,}/g,`

`).trim(),o}}catch{continue}}catch(e){l.error("HOOK","Failed to read transcript",{transcriptPath:n},e)}return""}async function ve(n){if(!n)throw new Error("summaryHook requires input");let{session_id:e,transcript_path:s}=n;await G(),I.getConfig().enabled&&s&&w(s)&&await Y(s,e,"STOP_HOOK");let r=new b,o=r.createSDKSession(e,"",""),i=r.getPromptCounter(o),a=r.db.prepare(`
    SELECT id, claude_session_id, sdk_session_id, project
    FROM sdk_sessions WHERE id = ?
  `).get(o),c=r.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations
    WHERE sdk_session_id = ?
  `).get(a?.sdk_session_id);M("[summary-hook] Session diagnostics",{claudeSessionId:e,sessionDbId:o,sdkSessionId:a?.sdk_session_id,project:a?.project,promptNumber:i,observationCount:c?.count||0,transcriptPath:n.transcript_path}),r.close();let d=y(),u=Le(n.transcript_path||""),_=Ae(n.transcript_path||"");M("[summary-hook] Extracted messages",{hasLastUserMessage:!!u,hasLastAssistantMessage:!!_,lastAssistantPreview:_.substring(0,200),lastAssistantLength:_.length}),l.dataIn("HOOK","Stop: Requesting summary",{sessionId:o,workerPort:d,promptNumber:i,hasLastUserMessage:!!u,hasLastAssistantMessage:!!_});try{let m=await fetch(`http://127.0.0.1:${d}/sessions/${o}/summarize`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt_number:i,last_user_message:u,last_assistant_message:_}),signal:AbortSignal.timeout(2e3)});if(!m.ok){let g=await m.text();throw l.failure("HOOK","Failed to generate summary",{sessionId:o,status:m.status},g),new Error(`Failed to request summary from worker: ${m.status} ${g}`)}l.debug("HOOK","Summary request sent successfully",{sessionId:o})}catch(m){throw m.cause?.code==="ECONNREFUSED"||m.name==="TimeoutError"||m.message.includes("fetch failed")?new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"):m}finally{await fetch(`http://127.0.0.1:${d}/api/processing`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({isProcessing:!1})})}console.log(X("Stop",!0))}var U="";J.on("data",n=>U+=n);J.on("end",async()=>{let n=U?JSON.parse(U):void 0;await ve(n)});
