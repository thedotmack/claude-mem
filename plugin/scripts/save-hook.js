#!/usr/bin/env node
import{stdin as Z}from"process";import{readFileSync as X,writeFileSync as ke,renameSync as De,copyFileSync as Me}from"fs";import ae from"better-sqlite3";import{join as f,dirname as se,basename as te}from"path";import{homedir as $}from"os";import{existsSync as je,mkdirSync as re}from"fs";import{fileURLToPath as ne}from"url";function oe(){return typeof __dirname<"u"?__dirname:se(ne(import.meta.url))}var ie=oe(),h=process.env.CLAUDE_MEM_DATA_DIR||f($(),".claude-mem"),x=process.env.CLAUDE_CONFIG_DIR||f($(),".claude"),We=f(h,"archives"),Ge=f(h,"logs"),Ke=f(h,"trash"),I=f(h,"backups"),Ye=f(h,"settings.json"),W=f(h,"claude-mem.db"),Je=f(h,"vector-db"),qe=f(x,"settings.json"),Ve=f(x,"commands"),ze=f(x,"CLAUDE.md");function y(n){re(n,{recursive:!0})}function G(){return f(ie,"..","..")}function K(n){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=te(n);return f(I,`${s}.backup.${e}`)}var w=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(w||{}),F=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=w[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,i){if(e<this.level)return;let o=new Date().toISOString().replace("T"," ").substring(0,23),a=w[e].padEnd(5),l=s.padEnd(6),p="";r?.correlationId?p=`[${r.correlationId}] `:r?.sessionId&&(p=`[session-${r.sessionId}] `);let g="";i!=null&&(this.level===0&&typeof i=="object"?g=`
`+JSON.stringify(i,null,2):g=" "+this.formatData(i));let _="";if(r){let{sessionId:m,sdkSessionId:O,correlationId:c,...d}=r;Object.keys(d).length>0&&(_=` {${Object.entries(d).map(([R,T])=>`${R}=${T}`).join(", ")}}`)}let E=`[${o}] [${a}] [${l}] ${p}${t}${_}${g}`;e===3?console.error(E):console.log(E)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},u=new F;var v=class{db;constructor(){y(h),this.db=new ae(W),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(o=>o.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(o=>o.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(o=>o.name==="endless_original_tokens"),r=s.some(o=>o.name==="endless_compressed_tokens"),i=s.some(o=>o.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),i||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",o=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${i}
      ${o}
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
    `).all(e),r=new Set,i=new Set;for(let o of t){if(o.files_read)try{let a=JSON.parse(o.files_read);Array.isArray(a)&&a.forEach(l=>r.add(l))}catch{}if(o.files_modified)try{let a=JSON.parse(o.files_modified);Array.isArray(a)&&a.forEach(l=>i.add(l))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,i=r.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),i);return a.lastInsertRowid===0||a.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(u.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,t){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}storeObservation(e,s,t,r,i=0){let o=new Date,a=o.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,o.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let _=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,i,t.tool_use_id||null,o.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||null}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),i=new Map;for(let o of r)o.tool_use_id&&i.set(o.tool_use_id,o);return i}storeSummary(e,s,t,r,i=0){let o=new Date,a=o.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,o.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let _=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,i,o.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",o=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${i}
      ${o}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",o=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${i}
      ${o}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let o=i?"AND project = ?":"",a=i?[i]:[],l,p;if(e!==null){let m=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${o}
        ORDER BY id DESC
        LIMIT ?
      `,O=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${o}
        ORDER BY id ASC
        LIMIT ?
      `;try{let c=this.db.prepare(m).all(e,...a,t+1),d=this.db.prepare(O).all(e,...a,r+1);if(c.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};l=c.length>0?c[c.length-1].created_at_epoch:s,p=d.length>0?d[d.length-1].created_at_epoch:s}catch(c){return console.error("[SessionStore] Error getting boundary observations:",c.message),{observations:[],sessions:[],prompts:[]}}}else{let m=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${o}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,O=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${o}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let c=this.db.prepare(m).all(s,...a,t),d=this.db.prepare(O).all(s,...a,r+1);if(c.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};l=c.length>0?c[c.length-1].created_at_epoch:s,p=d.length>0?d[d.length-1].created_at_epoch:s}catch(c){return console.error("[SessionStore] Error getting boundary timestamps:",c.message),{observations:[],sessions:[],prompts:[]}}}let g=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${o}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${o}
      ORDER BY created_at_epoch ASC
    `,E=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${o.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let m=this.db.prepare(g).all(l,p,...a),O=this.db.prepare(_).all(l,p,...a),c=this.db.prepare(E).all(l,p,...a);return{observations:m,sessions:O.map(d=>({id:d.id,sdk_session_id:d.sdk_session_id,project:d.project,request:d.request,completed:d.completed,next_steps:d.next_steps,created_at:d.created_at,created_at_epoch:d.created_at_epoch})),prompts:c.map(d=>({id:d.id,claude_session_id:d.claude_session_id,project:d.project,prompt:d.prompt_text,created_at:d.created_at,created_at_epoch:d.created_at_epoch}))}}catch(m){return console.error("[SessionStore] Error querying timeline records:",m.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||0,compressedTokens:t.endless_compressed_tokens||0,tokensSaved:t.endless_tokens_saved||0}:null}close(){this.db.close()}};function de(n,e,s){return n==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:n==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:n==="UserPromptSubmit"||n==="PostToolUse"?{continue:!0,suppressOutput:!0}:n==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function N(n,e,s={}){let t=de(n,e,s);return JSON.stringify(t)}import Y from"path";import{homedir as ce}from"os";import{existsSync as J,readFileSync as pe}from"fs";import{execSync as le}from"child_process";var ue=100,_e=500,me=10;function D(){try{let n=Y.join(ce(),".claude-mem","settings.json");if(J(n)){let e=JSON.parse(pe(n,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function q(){try{let n=D();return(await fetch(`http://127.0.0.1:${n}/health`,{signal:AbortSignal.timeout(ue)})).ok}catch{return!1}}async function Ee(){try{let n=G(),e=Y.join(n,"ecosystem.config.cjs");if(!J(e))throw new Error(`Ecosystem config not found at ${e}`);le(`pm2 start "${e}"`,{cwd:n,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<me;s++)if(await new Promise(t=>setTimeout(t,_e)),await q())return!0;return!1}catch{return!1}}async function V(){if(await q())return;if(!await Ee()){let e=D();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{existsSync as Te,readFileSync as ge}from"fs";import{homedir as be}from"os";import fe from"path";function B(n,e,s){if(n!==void 0){if(typeof n=="boolean")return n;if(typeof n=="string")return n.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function H(n,e,s){if(n!==void 0){if(typeof n=="number")return n;if(typeof n=="string"){let t=parseInt(n,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function Se(){let n=fe.join(be(),".claude-mem","settings.json"),e={};if(Te(n))try{e=JSON.parse(ge(n,"utf-8"))}catch(p){u.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},p)}let s=B(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=B(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=H(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),i=H(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),o=H(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),a=B(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),l={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:i,maxToolHistoryMB:o,enableSynchronousMode:a};return s?u.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:i,maxToolHistoryMB:`${o}MB`,syncMode:a}):u.debug("CONFIG","Endless Mode disabled"),l}var A=class{static getConfig=Se;static clearCache(){}};import{appendFileSync as Oe}from"fs";import{homedir as Re}from"os";import{join as he}from"path";var Ne=he(Re(),".claude-mem","silent.log");function M(n,e,s=""){let t=new Date().toISOString(),a=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),l=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",p=`[${t}] [${l}] ${n}`;if(e!==void 0)try{p+=` ${JSON.stringify(e)}`}catch(g){p+=` [stringify error: ${g}]`}p+=`
`;try{Oe(Ne,p)}catch(g){console.error("[silent-debug] Failed to write to log:",g)}return s}import{existsSync as Ie,readFileSync as ye,writeFileSync as Le,appendFileSync as ve,statSync as Ae}from"fs";import{join as Ce}from"path";var C=Ce(I,"tool-outputs.jsonl");function z(n,e,s=Date.now()){y(I);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),o=JSON.stringify({tool_use_id:n,content:e,timestamp:s,size_bytes:r})+`
`;ve(C,o,"utf8")}function Q(n){if(!Ie(C)||Ae(C).size/(1024*1024)<=n)return;let r=ye(C,"utf8").trim().split(`
`).filter(_=>_.length>0),i=[];for(let _ of r)try{i.push(JSON.parse(_))}catch{continue}i.sort((_,E)=>_.timestamp-E.timestamp);let o=n*1024*1024,a=0,l=0;for(let _=i.length-1;_>=0;_--){let E=i[_].size_bytes+100;if(a+E>o){l=_+1;break}a+=E}let g=i.slice(l).map(_=>JSON.stringify(_)).join(`
`)+`
`;Le(C,g,"utf8")}var Ue=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function U(n,e){if(!n)return[];if(Array.isArray(n))return n;try{let s=JSON.parse(n);return Array.isArray(s)?s:[]}catch(s){return u.debug("HOOK",`Failed to parse ${e}`,{field:n,error:s}),[]}}function xe(n){let e=[];e.push(`# ${n.title}`),n.subtitle&&e.push(`**${n.subtitle}**`),e.push(""),n.narrative&&(e.push(n.narrative),e.push(""));let s=U(n.facts,"facts");s.length>0&&(e.push("**Key Facts:**"),s.forEach(o=>e.push(`- ${o}`)),e.push(""));let t=U(n.concepts,"concepts");t.length>0&&(e.push(`**Concepts**: ${t.join(", ")}`),e.push(""));let r=U(n.files_read,"files_read");r.length>0&&(e.push(`**Files Read**: ${r.join(", ")}`),e.push(""));let i=U(n.files_modified,"files_modified");return i.length>0&&(e.push(`**Files Modified**: ${i.join(", ")}`),e.push("")),e.push("---"),e.push("*[Compressed by Endless Mode]*"),e.join(`
`)}async function we(n,e,s){try{y(I);let c=K(n);Me(n,c),u.info("HOOK","Created transcript backup",{original:n,backup:c})}catch(c){throw u.error("HOOK","Failed to create transcript backup",{transcriptPath:n},c),new Error("Backup creation failed - aborting transformation for safety")}let r=X(n,"utf-8").trim().split(`
`),i=!1,o=0,a=0,l=r.map((c,d)=>{if(!c.trim())return c;try{let S=JSON.parse(c);if(S.type==="user"){let T=S.message.content;if(Array.isArray(T))for(let b=0;b<T.length;b++){let L=T[b];if(L.type==="tool_result"){let k=L;if(k.tool_use_id===e){i=!0;try{z(e,k.content,Date.now()),u.debug("HOOK","Backed up original tool output",{toolUseId:e})}catch(ee){u.warn("HOOK","Failed to backup original tool output",{toolUseId:e},ee)}o=JSON.stringify(k.content).length;let j=xe(s);a=j.length,k.content=j,u.success("HOOK","Transformed tool result",{toolUseId:e,originalSize:o,compressedSize:a,savings:`${Math.round((1-a/o)*100)}%`})}}}}return JSON.stringify(S)}catch(S){throw u.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:d,error:S}),new Error(`Malformed JSONL line at index ${d}: ${S.message}`)}});if(!i)return u.warn("HOOK","Tool result not found in transcript",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let p=`${n}.tmp`;ke(p,l.join(`
`)+`
`,"utf-8");let _=X(p,"utf-8").trim().split(`
`);for(let c of _)c.trim()&&JSON.parse(c);De(p,n);let E=4,m=Math.ceil(o/E),O=Math.ceil(a/E);u.success("HOOK","Transcript transformation complete",{toolUseId:e,originalSize:o,compressedSize:a,savings:`${Math.round((1-a/o)*100)}%`});try{let c=A.getConfig();c.maxToolHistoryMB>0&&(Q(c.maxToolHistoryMB),u.debug("HOOK","Trimmed tool output backup",{maxSizeMB:c.maxToolHistoryMB}))}catch(c){u.warn("HOOK","Failed to trim tool output backup",{},c)}return{originalTokens:m,compressedTokens:O}}async function Fe(n){if(!n){u.warn("HOOK","PostToolUse called with no input"),console.log(N("PostToolUse",!0));return}let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:i,transcript_path:o,tool_use_id:a}=n;if(Ue.has(t)){console.log(N("PostToolUse",!0));return}await V();let l=new v,p=l.createSDKSession(e,"",""),g=l.getPromptCounter(p);l.close();let _=u.formatTool(t,r),E=D(),m=a;if(!m&&o)try{let S=X(o,"utf-8").trim().split(`
`);for(let R=S.length-1;R>=0;R--){let T=JSON.parse(S[R]);if(T.type==="user"&&Array.isArray(T.message.content)){for(let b of T.message.content)if(b.type==="tool_result"&&b.tool_use_id){m=b.tool_use_id;break}if(m)break}}}catch(d){M("Failed to extract tool_use_id from transcript",{error:d})}u.dataIn("HOOK",`PostToolUse: ${_}`,{sessionId:p,workerPort:E,toolUseId:m||M("tool_use_id not found in transcript",{toolName:t},"(none)")});let O=A.getConfig(),c=O.enabled&&m&&o;M("Endless Mode Check",{configEnabled:O.enabled,hasToolUseId:!!m,hasTranscriptPath:!!o,isEndlessModeEnabled:c,toolName:t,toolUseId:m,allInputKeys:Object.keys(n).join(", ")});try{let d=c?`http://127.0.0.1:${E}/sessions/${p}/observations?wait_until_obs_is_saved=true`:`http://127.0.0.1:${E}/sessions/${p}/observations`,S=c?9e4:2e3,R=await fetch(d,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_response:i!==void 0?JSON.stringify(i):"{}",prompt_number:g,cwd:s||"",tool_use_id:m}),signal:AbortSignal.timeout(S)});if(!R.ok){let b=await R.text();u.failure("HOOK","Failed to send observation",{sessionId:p,status:R.status},b),console.log(N("PostToolUse",!0));return}let T=await R.json();if(c)if(T.status==="completed"&&T.observation){u.success("HOOK","Observation ready, transforming transcript",{sessionId:p,toolUseId:m,processingTimeMs:T.processing_time_ms});try{let b=await we(o,m,T.observation);if(b.originalTokens>0){let L=new v;L.incrementEndlessModeStats(e,b.originalTokens,b.compressedTokens),L.close()}}catch(b){u.failure("HOOK","Transcript transformation failed",{sessionId:p,toolUseId:m},b)}}else T.status==="timeout"?u.warn("HOOK","Endless Mode timeout - using full output",{sessionId:p,toolUseId:m,processingTimeMs:T.processing_time_ms,message:T.message}):u.debug("HOOK","Endless Mode received non-standard response - continuing",{sessionId:p,toolUseId:m,status:T.status||"unknown"});else u.debug("HOOK","Observation sent successfully (async mode)",{sessionId:p,toolName:t})}catch(d){if(d.cause?.code==="ECONNREFUSED"){u.failure("HOOK","Worker connection refused",{sessionId:p},d),console.log(N("PostToolUse",!0,"Worker connection failed. Try: pm2 restart claude-mem-worker"));return}if(d.name==="TimeoutError"||d.message?.includes("timed out")){u.warn("HOOK","Observation request timed out - continuing",{sessionId:p,toolName:t}),console.log(N("PostToolUse",!0));return}u.warn("HOOK","Observation request failed - continuing anyway",{sessionId:p,toolName:t,error:d.message}),console.log(N("PostToolUse",!0));return}console.log(N("PostToolUse",!0))}var P="";Z.on("data",n=>P+=n);Z.on("end",async()=>{let n=P?JSON.parse(P):void 0;await Fe(n)});
