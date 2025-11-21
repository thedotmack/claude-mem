#!/usr/bin/env node
import{stdin as Y}from"process";import{readFileSync as Le}from"fs";import se from"better-sqlite3";import{join as g,dirname as q,basename as V}from"path";import{homedir as F}from"os";import{existsSync as Ue,mkdirSync as z}from"fs";import{fileURLToPath as Q}from"url";function Z(){return typeof __dirname<"u"?__dirname:q(Q(import.meta.url))}var ee=Z(),O=process.env.CLAUDE_MEM_DATA_DIR||g(F(),".claude-mem"),D=process.env.CLAUDE_CONFIG_DIR||g(F(),".claude"),we=g(O,"archives"),Fe=g(O,"logs"),Be=g(O,"trash"),I=g(O,"backups"),He=g(O,"settings.json"),B=g(O,"claude-mem.db"),Xe=g(O,"vector-db"),Pe=g(D,"settings.json"),je=g(D,"commands"),$e=g(D,"CLAUDE.md");function L(o){z(o,{recursive:!0})}function H(){return g(ee,"..","..")}function X(o){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=V(o);return g(I,`${s}.backup.${e}`)}var M=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(M||{}),U=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=M[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,i){if(e<this.level)return;let n=new Date().toISOString().replace("T"," ").substring(0,23),a=M[e].padEnd(5),c=s.padEnd(6),p="";r?.correlationId?p=`[${r.correlationId}] `:r?.sessionId&&(p=`[session-${r.sessionId}] `);let u="";i!=null&&(this.level===0&&typeof i=="object"?u=`
`+JSON.stringify(i,null,2):u=" "+this.formatData(i));let T="";if(r){let{sessionId:m,sdkSessionId:f,correlationId:E,...d}=r;Object.keys(d).length>0&&(T=` {${Object.entries(d).map(([S,b])=>`${S}=${b}`).join(", ")}}`)}let _=`[${n}] [${a}] [${c}] ${p}${t}${T}${u}`;e===3?console.error(_):console.log(_)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},l=new U;var N=class{db;constructor(){L(O),this.db=new se(B),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(n=>n.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(n=>n.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created unique index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(n=>n.name==="endless_original_tokens"),r=s.some(n=>n.name==="endless_compressed_tokens"),i=s.some(n=>n.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),i||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${i}
      ${n}
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
    `).all(e),r=new Set,i=new Set;for(let n of t){if(n.files_read)try{let a=JSON.parse(n.files_read);Array.isArray(a)&&a.forEach(c=>r.add(c))}catch{}if(n.files_modified)try{let a=JSON.parse(n.files_modified);Array.isArray(a)&&a.forEach(c=>i.add(c))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).run(s,e).changes===0?(l.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}storeObservation(e,s,t,r,i=0){let n=new Date,a=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let T=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,i,t.tool_use_id||null,n.toISOString(),a);return{id:Number(T.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||null}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),i=new Map;for(let n of r)n.tool_use_id&&i.set(n.tool_use_id,n);return i}storeSummary(e,s,t,r,i=0){let n=new Date,a=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let T=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,i,n.toISOString(),a);return{id:Number(T.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${i}
      ${n}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${i}
      ${n}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let n=i?"AND project = ?":"",a=i?[i]:[],c,p;if(e!==null){let m=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${n}
        ORDER BY id DESC
        LIMIT ?
      `,f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${n}
        ORDER BY id ASC
        LIMIT ?
      `;try{let E=this.db.prepare(m).all(e,...a,t+1),d=this.db.prepare(f).all(e,...a,r+1);if(E.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};c=E.length>0?E[E.length-1].created_at_epoch:s,p=d.length>0?d[d.length-1].created_at_epoch:s}catch(E){return console.error("[SessionStore] Error getting boundary observations:",E.message),{observations:[],sessions:[],prompts:[]}}}else{let m=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${n}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${n}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let E=this.db.prepare(m).all(s,...a,t),d=this.db.prepare(f).all(s,...a,r+1);if(E.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};c=E.length>0?E[E.length-1].created_at_epoch:s,p=d.length>0?d[d.length-1].created_at_epoch:s}catch(E){return console.error("[SessionStore] Error getting boundary timestamps:",E.message),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,T=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${n.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let m=this.db.prepare(u).all(c,p,...a),f=this.db.prepare(T).all(c,p,...a),E=this.db.prepare(_).all(c,p,...a);return{observations:m,sessions:f.map(d=>({id:d.id,sdk_session_id:d.sdk_session_id,project:d.project,request:d.request,completed:d.completed,next_steps:d.next_steps,created_at:d.created_at,created_at_epoch:d.created_at_epoch})),prompts:E.map(d=>({id:d.id,claude_session_id:d.claude_session_id,project:d.project,prompt:d.prompt_text,created_at:d.created_at,created_at_epoch:d.created_at_epoch}))}}catch(m){return console.error("[SessionStore] Error querying timeline records:",m.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||0,compressedTokens:t.endless_compressed_tokens||0,tokensSaved:t.endless_tokens_saved||0}:null}close(){this.db.close()}};function te(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function h(o,e,s={}){let t=te(o,e,s);return JSON.stringify(t)}import P from"path";import{homedir as re}from"os";import{existsSync as j,readFileSync as ne}from"fs";import{execSync as oe}from"child_process";var ie=100,ae=500,ce=10;function v(){try{let o=P.join(re(),".claude-mem","settings.json");if(j(o)){let e=JSON.parse(ne(o,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function $(){try{let o=v();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(ie)})).ok}catch{return!1}}async function de(){try{let o=H(),e=P.join(o,"ecosystem.config.cjs");if(!j(e))throw new Error(`Ecosystem config not found at ${e}`);oe(`pm2 start "${e}"`,{cwd:o,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<ce;s++)if(await new Promise(t=>setTimeout(t,ae)),await $())return!0;return!1}catch{return!1}}async function G(){if(await $())return;if(!await de()){let e=v();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{existsSync as pe,readFileSync as le}from"fs";import{homedir as ue}from"os";import _e from"path";var A=class{static config=null;static getConfig(){if(this.config)return this.config;let e=_e.join(ue(),".claude-mem","settings.json"),s={};if(pe(e))try{s=JSON.parse(le(e,"utf-8"))}catch(p){l.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},p)}let t=this.getBooleanSetting(s.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),r=this.getBooleanSetting(s.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),i=this.getNumberSetting(s.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),n=this.getNumberSetting(s.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),a=this.getBooleanSetting(s.env?.CLAUDE_MEM_OBSERVE_EVERYTHING,process.env.CLAUDE_MEM_OBSERVE_EVERYTHING,t),c=this.getNumberSetting(s.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50);return this.config={enabled:t,fallbackToOriginal:r,maxLookupTime:i,keepRecentToolUses:n,observeEverything:a,maxToolHistoryMB:c},t?l.info("CONFIG","Endless Mode enabled",{fallback:r,maxLookupTime:`${i}ms`,keepRecent:n,observeEverything:a,maxToolHistoryMB:`${c}MB`}):l.debug("CONFIG","Endless Mode disabled"),this.config}static clearCache(){this.config=null}static getBooleanSetting(e,s,t){if(e!==void 0){if(typeof e=="boolean")return e;if(typeof e=="string")return e.toLowerCase()==="true"}return s!==void 0?s.toLowerCase()==="true":t}static getNumberSetting(e,s,t){if(e!==void 0){if(typeof e=="number")return e;if(typeof e=="string"){let r=parseInt(e,10);if(!isNaN(r))return r}}if(s!==void 0){let r=parseInt(s,10);if(!isNaN(r))return r}return t}};import{appendFileSync as me}from"fs";import{homedir as Ee}from"os";import{join as Te}from"path";var fe=Te(Ee(),".claude-mem","silent.log");function C(o,e,s=""){let t=new Date().toISOString(),a=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),c=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",p=`[${t}] [${c}] ${o}`;if(e!==void 0)try{p+=` ${JSON.stringify(e)}`}catch(u){p+=` [stringify error: ${u}]`}p+=`
`;try{me(fe,p)}catch(u){console.error("[silent-debug] Failed to write to log:",u)}return s}import{readFileSync as x,writeFileSync as Oe,renameSync as Re,copyFileSync as he}from"fs";import{existsSync as _s,readFileSync as ms,writeFileSync as Es,appendFileSync as ge,statSync as Ts}from"fs";import{join as Se}from"path";var be=Se(I,"tool-outputs.jsonl");function W(o,e,s=Date.now()){L(I);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),n=JSON.stringify({tool_use_id:o,content:e,timestamp:s,size_bytes:r})+`
`;ge(be,n,"utf8")}function k(o,e){if(!o)return[];if(Array.isArray(o))return o;try{let s=JSON.parse(o);return Array.isArray(s)?s:[]}catch(s){return l.debug("HOOK",`Failed to parse ${e}`,{field:o,error:s}),[]}}function Ne(o){try{let s=x(o,"utf-8").trim().split(`
`),t=[];for(let r of s)if(r.trim())try{let i=JSON.parse(r);if(i.type==="user"){let a=i.message.content;if(Array.isArray(a)){for(let c of a)if(c.type==="tool_result"){let p=c;!(typeof p.content=="string"?p.content:JSON.stringify(p.content)).trim().startsWith("# ")&&p.tool_use_id&&t.push(p.tool_use_id)}}}}catch{continue}return t}catch(e){return l.warn("HOOK","Failed to extract pending tool_use_ids",{transcriptPath:o},e),[]}}function ye(o){let e=[];e.push(`# ${o.title}`),o.subtitle&&e.push(`**${o.subtitle}**`),e.push(""),o.narrative&&(e.push(o.narrative),e.push(""));let s=k(o.facts,"facts");s.length>0&&(e.push("**Key Facts:**"),s.forEach(n=>e.push(`- ${n}`)),e.push(""));let t=k(o.concepts,"concepts");t.length>0&&(e.push(`**Concepts**: ${t.join(", ")}`),e.push(""));let r=k(o.files_read,"files_read");r.length>0&&(e.push(`**Files Read**: ${r.join(", ")}`),e.push(""));let i=k(o.files_modified,"files_modified");return i.length>0&&(e.push(`**Files Modified**: ${i.join(", ")}`),e.push("")),e.push("---"),e.push("*[Compressed by Endless Mode]*"),e.join(`
`)}async function Ie(o,e,s){try{L(I);let _=X(o);he(o,_),l.info("HOOK","Created transcript backup",{original:o,backup:_})}catch(_){throw l.error("HOOK","Failed to create transcript backup",{transcriptPath:o},_),new Error("Backup creation failed - aborting transformation for safety")}let r=x(o,"utf-8").trim().split(`
`),i=!1,n=0,a=0,c=r.map((_,m)=>{if(!_.trim())return _;try{let f=JSON.parse(_);if(f.type==="user"){let d=f.message.content;if(Array.isArray(d))for(let R=0;R<d.length;R++){let S=d[R];if(S.type==="tool_result"){let b=S;if(b.tool_use_id===e){i=!0;try{W(e,b.content,Date.now()),l.debug("HOOK","Backed up original tool output",{toolUseId:e})}catch(J){l.warn("HOOK","Failed to backup original tool output",{toolUseId:e},J)}n=JSON.stringify(b.content).length;let y=ye(s);a=y.length,b.content=y,l.success("HOOK","Transformed tool result",{toolUseId:e,originalSize:n,compressedSize:a,savings:`${Math.round((1-a/n)*100)}%`})}}}}return JSON.stringify(f)}catch(f){throw l.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:m,error:f}),new Error(`Malformed JSONL line at index ${m}: ${f.message}`)}});if(!i)return l.warn("HOOK","Tool result not found in transcript",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let p=`${o}.tmp`;Oe(p,c.join(`
`)+`
`,"utf-8");let T=x(p,"utf-8").trim().split(`
`);for(let _ of T)_.trim()&&JSON.parse(_);return Re(p,o),{originalTokens:n,compressedTokens:a}}async function K(o,e,s){let t=0;try{let r=Ne(o);if(r.length===0)return 0;l.debug(s,"Found pending tool_use_ids",{count:r.length,ids:r});let i=new N,n=i.getObservationsByToolUseIds(r);if(i.close(),n.size===0)return 0;l.info(s,"Ready observations for transformation",{pending:r.length,ready:n.size});for(let[a,c]of n)try{let p={id:c.id,type:c.type,title:c.title,subtitle:c.subtitle,narrative:c.narrative,facts:JSON.parse(c.facts),concepts:JSON.parse(c.concepts),files_read:JSON.parse(c.files_read),files_modified:JSON.parse(c.files_modified),created_at_epoch:c.created_at_epoch},u=await Ie(o,a,p);if(u.originalTokens>0)try{let T=new N;T.incrementEndlessModeStats(e,u.originalTokens,u.compressedTokens),T.close()}catch(T){l.debug(s,"Stats update skipped",{error:T})}l.success(s,"Deferred transformation complete",{toolUseId:a,observationId:c.id,savings:`${Math.round((1-u.compressedTokens/u.originalTokens)*100)}%`}),t++}catch(p){l.warn(s,"Deferred transformation failed",{toolUseId:a},p)}}catch(r){l.warn(s,"Deferred transformation check failed",{},r)}return t}var ve=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);async function Ae(o){if(!o){l.warn("HOOK","PostToolUse called with no input"),console.log(h("PostToolUse",!0));return}let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:i,transcript_path:n,tool_use_id:a}=o;if(ve.has(t)){console.log(h("PostToolUse",!0));return}await G();let c=new N,p=c.createSDKSession(e,"",""),u=c.getPromptCounter(p);c.close();let T=l.formatTool(t,r),_=v(),m=a;if(!m&&n)try{let R=Le(n,"utf-8").trim().split(`
`);for(let S=R.length-1;S>=0;S--){let b=JSON.parse(R[S]);if(b.type==="user"&&Array.isArray(b.message.content)){for(let y of b.message.content)if(y.type==="tool_result"&&y.tool_use_id){m=y.tool_use_id;break}if(m)break}}}catch(d){C("Failed to extract tool_use_id from transcript",{error:d})}l.dataIn("HOOK",`PostToolUse: ${T}`,{sessionId:p,workerPort:_,toolUseId:m||C("tool_use_id not found in transcript",{toolName:t},"(none)")});let f=A.getConfig(),E=f.enabled&&m&&n;C("Endless Mode Check",{configEnabled:f.enabled,hasToolUseId:!!m,hasTranscriptPath:!!n,isEndlessModeEnabled:E,toolName:t,toolUseId:m,allInputKeys:Object.keys(o).join(", ")}),E&&n&&await K(n,e,"HOOK");try{let d=`http://127.0.0.1:${_}/sessions/${p}/observations`,S=await fetch(d,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_response:i!==void 0?JSON.stringify(i):"{}",prompt_number:u,cwd:s||"",tool_use_id:m}),signal:AbortSignal.timeout(2e3)});if(!S.ok){let b=await S.text();l.failure("HOOK","Failed to send observation",{sessionId:p,status:S.status},b),console.log(h("PostToolUse",!0));return}l.debug("HOOK","Observation queued (async mode)",{sessionId:p,toolName:t,toolUseId:m,endlessMode:E})}catch(d){if(d.cause?.code==="ECONNREFUSED"){l.failure("HOOK","Worker connection refused",{sessionId:p},d),console.log(h("PostToolUse",!0,"Worker connection failed. Try: pm2 restart claude-mem-worker"));return}if(d.name==="TimeoutError"||d.message?.includes("timed out")){l.warn("HOOK","Observation request timed out - continuing",{sessionId:p,toolName:t}),console.log(h("PostToolUse",!0));return}l.warn("HOOK","Observation request failed - continuing anyway",{sessionId:p,toolName:t,error:d.message}),console.log(h("PostToolUse",!0));return}console.log(h("PostToolUse",!0))}var w="";Y.on("data",o=>w+=o);Y.on("end",async()=>{let o=w?JSON.parse(w):void 0;await Ae(o)});
