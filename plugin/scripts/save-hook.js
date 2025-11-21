#!/usr/bin/env node
import{stdin as ee}from"process";import{readFileSync as P,writeFileSync as ke,renameSync as De,copyFileSync as Me}from"fs";import ae from"better-sqlite3";import{join as S,dirname as se,basename as te}from"path";import{homedir as W}from"os";import{existsSync as $e,mkdirSync as re}from"fs";import{fileURLToPath as ne}from"url";function oe(){return typeof __dirname<"u"?__dirname:se(ne(import.meta.url))}var ie=oe(),R=process.env.CLAUDE_MEM_DATA_DIR||S(W(),".claude-mem"),w=process.env.CLAUDE_CONFIG_DIR||S(W(),".claude"),Ge=S(R,"archives"),Ke=S(R,"logs"),Ye=S(R,"trash"),y=S(R,"backups"),Je=S(R,"settings.json"),G=S(R,"claude-mem.db"),qe=S(R,"vector-db"),Ve=S(w,"settings.json"),ze=S(w,"commands"),Qe=S(w,"CLAUDE.md");function v(n){re(n,{recursive:!0})}function K(){return S(ie,"..","..")}function Y(n){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=te(n);return S(y,`${s}.backup.${e}`)}var F=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(F||{}),B=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=F[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,o){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),d=F[e].padEnd(5),c=s.padEnd(6),p="";r?.correlationId?p=`[${r.correlationId}] `:r?.sessionId&&(p=`[session-${r.sessionId}] `);let E="";o!=null&&(this.level===0&&typeof o=="object"?E=`
`+JSON.stringify(o,null,2):E=" "+this.formatData(o));let _="";if(r){let{sessionId:u,sdkSessionId:O,correlationId:m,...a}=r;Object.keys(a).length>0&&(_=` {${Object.entries(a).map(([g,f])=>`${g}=${f}`).join(", ")}}`)}let T=`[${i}] [${d}] [${c}] ${p}${t}${_}${E}`;e===3?console.error(T):console.log(T)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},l=new B;var L=class{db;constructor(){v(R),this.db=new ae(G),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(i=>i.name==="endless_original_tokens"),r=s.some(i=>i.name==="endless_compressed_tokens"),o=s.some(i=>i.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),o||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${d})
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
    `).all(e),r=new Set,o=new Set;for(let i of t){if(i.files_read)try{let d=JSON.parse(i.files_read);Array.isArray(d)&&d.forEach(c=>r.add(c))}catch{}if(i.files_modified)try{let d=JSON.parse(i.files_modified);Array.isArray(d)&&d.forEach(c=>o.add(c))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,o=r.getTime(),d=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),o);return d.lastInsertRowid===0||d.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:d.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),o).lastInsertRowid}storeObservation(e,s,t,r,o=0){let i=new Date,d=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let _=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,o,t.tool_use_id||null,i.toISOString(),d);return{id:Number(_.lastInsertRowid),createdAtEpoch:d}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||null}getAllObservationsForToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),o=new Map;for(let i of r)i.tool_use_id&&o.set(i.tool_use_id,i);return o}storeSummary(e,s,t,r,o=0){let i=new Date,d=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let _=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,o,i.toISOString(),d);return{id:Number(_.lastInsertRowid),createdAtEpoch:d}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${d})
      ORDER BY created_at_epoch ${o}
      ${i}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${d})
      ORDER BY up.created_at_epoch ${o}
      ${i}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,o){let i=o?"AND project = ?":"",d=o?[o]:[],c,p;if(e!==null){let u=`
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
      `;try{let m=this.db.prepare(u).all(e,...d,t+1),a=this.db.prepare(O).all(e,...d,r+1);if(m.length===0&&a.length===0)return{observations:[],sessions:[],prompts:[]};c=m.length>0?m[m.length-1].created_at_epoch:s,p=a.length>0?a[a.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary observations:",m.message),{observations:[],sessions:[],prompts:[]}}}else{let u=`
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
      `;try{let m=this.db.prepare(u).all(s,...d,t),a=this.db.prepare(O).all(s,...d,r+1);if(m.length===0&&a.length===0)return{observations:[],sessions:[],prompts:[]};c=m.length>0?m[m.length-1].created_at_epoch:s,p=a.length>0?a[a.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary timestamps:",m.message),{observations:[],sessions:[],prompts:[]}}}let E=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,T=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let u=this.db.prepare(E).all(c,p,...d),O=this.db.prepare(_).all(c,p,...d),m=this.db.prepare(T).all(c,p,...d);return{observations:u,sessions:O.map(a=>({id:a.id,sdk_session_id:a.sdk_session_id,project:a.project,request:a.request,completed:a.completed,next_steps:a.next_steps,created_at:a.created_at,created_at_epoch:a.created_at_epoch})),prompts:m.map(a=>({id:a.id,claude_session_id:a.claude_session_id,project:a.project,prompt:a.prompt_text,created_at:a.created_at,created_at_epoch:a.created_at_epoch}))}}catch(u){return console.error("[SessionStore] Error querying timeline records:",u.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||0,compressedTokens:t.endless_compressed_tokens||0,tokensSaved:t.endless_tokens_saved||0}:null}close(){this.db.close()}};function de(n,e,s){return n==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:n==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:n==="UserPromptSubmit"||n==="PostToolUse"?{continue:!0,suppressOutput:!0}:n==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function N(n,e,s={}){let t=de(n,e,s);return JSON.stringify(t)}import J from"path";import{homedir as ce}from"os";import{existsSync as q,readFileSync as pe}from"fs";import{execSync as le}from"child_process";var ue=100,_e=500,me=10;function M(){try{let n=J.join(ce(),".claude-mem","settings.json");if(q(n)){let e=JSON.parse(pe(n,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function V(){try{let n=M();return(await fetch(`http://127.0.0.1:${n}/health`,{signal:AbortSignal.timeout(ue)})).ok}catch{return!1}}async function Ee(){try{let n=K(),e=J.join(n,"ecosystem.config.cjs");if(!q(e))throw new Error(`Ecosystem config not found at ${e}`);le(`pm2 start "${e}"`,{cwd:n,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<me;s++)if(await new Promise(t=>setTimeout(t,_e)),await V())return!0;return!1}catch{return!1}}async function z(){if(await V())return;if(!await Ee()){let e=M();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{existsSync as Te,readFileSync as ge}from"fs";import{homedir as be}from"os";import fe from"path";function H(n,e,s){if(n!==void 0){if(typeof n=="boolean")return n;if(typeof n=="string")return n.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function X(n,e,s){if(n!==void 0){if(typeof n=="number")return n;if(typeof n=="string"){let t=parseInt(n,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function Se(){let n=fe.join(be(),".claude-mem","settings.json"),e={};if(Te(n))try{e=JSON.parse(ge(n,"utf-8"))}catch(p){l.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},p)}let s=H(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=H(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=X(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),o=X(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),i=X(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),d=H(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),c={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:o,maxToolHistoryMB:i,enableSynchronousMode:d};return s?l.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:o,maxToolHistoryMB:`${i}MB`,syncMode:d}):l.debug("CONFIG","Endless Mode disabled"),c}var C=class{static getConfig=Se;static clearCache(){}};import{appendFileSync as Oe}from"fs";import{homedir as Re}from"os";import{join as he}from"path";var Ne=he(Re(),".claude-mem","silent.log");function x(n,e,s=""){let t=new Date().toISOString(),d=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),c=d?`${d[1].split("/").pop()}:${d[2]}`:"unknown",p=`[${t}] [${c}] ${n}`;if(e!==void 0)try{p+=` ${JSON.stringify(e)}`}catch(E){p+=` [stringify error: ${E}]`}p+=`
`;try{Oe(Ne,p)}catch(E){console.error("[silent-debug] Failed to write to log:",E)}return s}import{existsSync as Ie,readFileSync as ye,writeFileSync as ve,appendFileSync as Le,statSync as Ae}from"fs";import{join as Ce}from"path";var k=Ce(y,"tool-outputs.jsonl");function Q(n,e,s=Date.now()){v(y);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),i=JSON.stringify({tool_use_id:n,content:e,timestamp:s,size_bytes:r})+`
`;Le(k,i,"utf8")}function Z(n){if(!Ie(k)||Ae(k).size/(1024*1024)<=n)return;let r=ye(k,"utf8").trim().split(`
`).filter(_=>_.length>0),o=[];for(let _ of r)try{o.push(JSON.parse(_))}catch{continue}o.sort((_,T)=>_.timestamp-T.timestamp);let i=n*1024*1024,d=0,c=0;for(let _=o.length-1;_>=0;_--){let T=o[_].size_bytes+100;if(d+T>i){c=_+1;break}d+=T}let E=o.slice(c).map(_=>JSON.stringify(_)).join(`
`)+`
`;ve(k,E,"utf8")}var xe=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function U(n,e){if(!n)return[];if(Array.isArray(n))return n;try{let s=JSON.parse(n);return Array.isArray(s)?s:[]}catch(s){return l.debug("HOOK",`Failed to parse ${e}`,{field:n,error:s}),[]}}function Ue(n){let e=[];e.push(`# ${n.title}`),n.subtitle&&e.push(`**${n.subtitle}**`),e.push(""),n.narrative&&(e.push(n.narrative),e.push(""));let s=U(n.facts,"facts");s.length>0&&(e.push("**Key Facts:**"),s.forEach(i=>e.push(`- ${i}`)),e.push(""));let t=U(n.concepts,"concepts");t.length>0&&(e.push(`**Concepts**: ${t.join(", ")}`),e.push(""));let r=U(n.files_read,"files_read");r.length>0&&(e.push(`**Files Read**: ${r.join(", ")}`),e.push(""));let o=U(n.files_modified,"files_modified");return o.length>0&&(e.push(`**Files Modified**: ${o.join(", ")}`),e.push("")),e.push("---"),e.push("*[Compressed by Endless Mode]*"),e.join(`
`)}async function we(n,e){let s=new L,t=s.getAllObservationsForToolUseId(e);if(s.close(),t.length===0)return l.warn("HOOK","No observations found for tool_use_id",{toolUseId:e}),{originalTokens:0,compressedTokens:0};l.debug("HOOK","Found observations for concatenation",{toolUseId:e,count:t.length});try{v(y);let a=Y(n);Me(n,a),l.info("HOOK","Created transcript backup",{original:n,backup:a})}catch(a){throw l.error("HOOK","Failed to create transcript backup",{transcriptPath:n},a),new Error("Backup creation failed - aborting transformation for safety")}let o=P(n,"utf-8").trim().split(`
`),i=!1,d=0,c=0,p=o.map((a,h)=>{if(!a.trim())return a;try{let g=JSON.parse(a);if(g.type==="assistant"){let b=g.message.content;if(Array.isArray(b))for(let I=0;I<b.length;I++){let $=b[I];if($.type==="tool_use"){let D=$;if(D.id===e){i=!0;try{Q(e,JSON.stringify(D.input),Date.now()),l.debug("HOOK","Backed up original tool input",{toolUseId:e})}catch(A){l.warn("HOOK","Failed to backup original tool input",{toolUseId:e},A)}d=JSON.stringify(D.input).length,c=t.map(A=>Ue(A)).join(`

---

`).length,D.input={_observation_refs:t.map(A=>A.id),_observation_count:t.length,_note:`Original input compressed - ${t.length} observation(s) for details`},l.success("HOOK","Transformed tool_use input",{toolUseId:e,originalSize:d,compressedSize:c,savings:`${Math.round((1-c/d)*100)}%`})}}}}return JSON.stringify(g)}catch(g){throw l.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:h,error:g}),new Error(`Malformed JSONL line at index ${h}: ${g.message}`)}});if(!i)return l.warn("HOOK","Tool result not found in transcript",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let E=`${n}.tmp`;ke(E,p.join(`
`)+`
`,"utf-8");let T=P(E,"utf-8").trim().split(`
`);for(let a of T)a.trim()&&JSON.parse(a);De(E,n);let u=4,O=Math.ceil(d/u),m=Math.ceil(c/u);l.success("HOOK","Transcript transformation complete",{toolUseId:e,originalSize:d,compressedSize:c,savings:`${Math.round((1-c/d)*100)}%`});try{let a=C.getConfig();a.maxToolHistoryMB>0&&(Z(a.maxToolHistoryMB),l.debug("HOOK","Trimmed tool output backup",{maxSizeMB:a.maxToolHistoryMB}))}catch(a){l.warn("HOOK","Failed to trim tool output backup",{},a)}return{originalTokens:O,compressedTokens:m}}async function Fe(n){if(!n){l.warn("HOOK","PostToolUse called with no input"),console.log(N("PostToolUse",!0));return}let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:o,transcript_path:i,tool_use_id:d}=n;if(xe.has(t)){console.log(N("PostToolUse",!0));return}await z();let c=new L,p=c.createSDKSession(e,"",""),E=c.getPromptCounter(p);c.close();let _=l.formatTool(t,r),T=M(),u=d;if(!u&&i)try{let h=P(i,"utf-8").trim().split(`
`);for(let g=h.length-1;g>=0;g--){let f=JSON.parse(h[g]);if(f.type==="user"&&Array.isArray(f.message.content)){for(let b of f.message.content)if(b.type==="tool_result"&&b.tool_use_id){u=b.tool_use_id;break}if(u)break}}}catch(a){x("Failed to extract tool_use_id from transcript",{error:a})}l.dataIn("HOOK",`PostToolUse: ${_}`,{sessionId:p,workerPort:T,toolUseId:u||x("tool_use_id not found in transcript",{toolName:t},"(none)")});let O=C.getConfig(),m=O.enabled&&u&&i;x("Endless Mode Check",{configEnabled:O.enabled,hasToolUseId:!!u,hasTranscriptPath:!!i,isEndlessModeEnabled:m,toolName:t,toolUseId:u,allInputKeys:Object.keys(n).join(", ")});try{let a=m?`http://127.0.0.1:${T}/sessions/${p}/observations?wait_until_obs_is_saved=true`:`http://127.0.0.1:${T}/sessions/${p}/observations`,h=m?3e4:2e3,g=await fetch(a,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_response:o!==void 0?JSON.stringify(o):"{}",prompt_number:E,cwd:s||"",tool_use_id:u}),signal:AbortSignal.timeout(h)});if(!g.ok){let b=await g.text();l.failure("HOOK","Failed to send observation",{sessionId:p,status:g.status},b),console.log(N("PostToolUse",!0));return}let f=await g.json();if(m)if(f.status==="completed"&&f.observation){l.success("HOOK","Observation ready, transforming transcript",{sessionId:p,toolUseId:u,processingTimeMs:f.processing_time_ms});try{let b=await we(i,u);if(b.originalTokens>0){let I=new L;I.incrementEndlessModeStats(e,b.originalTokens,b.compressedTokens),I.close()}}catch(b){l.failure("HOOK","Transcript transformation failed",{sessionId:p,toolUseId:u},b)}}else f.status==="timeout"?l.warn("HOOK","Endless Mode timeout - using full output",{sessionId:p,toolUseId:u,processingTimeMs:f.processing_time_ms,message:f.message}):l.debug("HOOK","Endless Mode received non-standard response - continuing",{sessionId:p,toolUseId:u,status:f.status||"unknown"});else l.debug("HOOK","Observation sent successfully (async mode)",{sessionId:p,toolName:t})}catch(a){if(a.cause?.code==="ECONNREFUSED"){l.failure("HOOK","Worker connection refused",{sessionId:p},a),console.log(N("PostToolUse",!0,"Worker connection failed. Try: pm2 restart claude-mem-worker"));return}if(a.name==="TimeoutError"||a.message?.includes("timed out")){l.warn("HOOK","Observation request timed out - continuing",{sessionId:p,toolName:t}),console.log(N("PostToolUse",!0));return}l.warn("HOOK","Observation request failed - continuing anyway",{sessionId:p,toolName:t,error:a.message}),console.log(N("PostToolUse",!0));return}console.log(N("PostToolUse",!0))}var j="";ee.on("data",n=>j+=n);ee.on("end",async()=>{let n=j?JSON.parse(j):void 0;await Fe(n)});export{Ue as formatObservationAsMarkdown,we as transformTranscript};
