#!/usr/bin/env node
import{stdin as Q}from"process";import{readFileSync as A,existsSync as B,writeFileSync as ve,renameSync as Ce,copyFileSync as ke}from"fs";import ie from"better-sqlite3";import{join as g,dirname as ee,basename as se}from"path";import{homedir as j}from"os";import{existsSync as $e,mkdirSync as te}from"fs";import{fileURLToPath as re}from"url";function ne(){return typeof __dirname<"u"?__dirname:ee(re(import.meta.url))}var oe=ne(),b=process.env.CLAUDE_MEM_DATA_DIR||g(j(),".claude-mem"),M=process.env.CLAUDE_CONFIG_DIR||g(j(),".claude"),Ge=g(b,"archives"),We=g(b,"logs"),Ke=g(b,"trash"),R=g(b,"backups"),Ye=g(b,"settings.json"),$=g(b,"claude-mem.db"),Je=g(b,"vector-db"),qe=g(M,"settings.json"),Ve=g(M,"commands"),ze=g(M,"CLAUDE.md");function N(o){te(o,{recursive:!0})}function P(){return g(oe,"..","..")}function G(o){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=se(o);return g(R,`${s}.backup.${e}`)}var x=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(x||{}),U=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=x[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,n){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),a=x[e].padEnd(5),d=s.padEnd(6),u="";r?.correlationId?u=`[${r.correlationId}] `:r?.sessionId&&(u=`[session-${r.sessionId}] `);let E="";n!=null&&(this.level===0&&typeof n=="object"?E=`
`+JSON.stringify(n,null,2):E=" "+this.formatData(n));let _="";if(r){let{sessionId:T,sdkSessionId:f,correlationId:p,...c}=r;Object.keys(c).length>0&&(_=` {${Object.entries(c).map(([h,O])=>`${h}=${O}`).join(", ")}}`)}let l=`[${i}] [${a}] [${d}] ${u}${t}${_}${E}`;e===3?console.error(l):console.log(l)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},m=new U;var y=class{db;constructor(){N(b),this.db=new ie($),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(d=>d.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(d=>d.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(d=>d.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created unique index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(i=>i.name==="endless_original_tokens"),r=s.some(i=>i.name==="endless_compressed_tokens"),n=s.some(i=>i.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),n||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,n=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${n}
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
    `).all(e),r=new Set,n=new Set;for(let i of t){if(i.files_read)try{let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(d=>r.add(d))}catch{}if(i.files_modified)try{let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(d=>n.add(d))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(n)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,n=r.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),n);return a.lastInsertRowid===0||a.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(m.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}storeObservation(e,s,t,r,n=0){let i=new Date,a=i.getTime();this.db.prepare(`
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
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,n,t.tool_use_id||null,i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||null}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),n=new Map;for(let i of r)i.tool_use_id&&n.set(i.tool_use_id,i);return n}storeSummary(e,s,t,r,n=0){let i=new Date,a=i.getTime();this.db.prepare(`
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
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,n,i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,n=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${n}
      ${i}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,n=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${n}
      ${i}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,n){let i=n?"AND project = ?":"",a=n?[n]:[],d,u;if(e!==null){let T=`
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
      `;try{let p=this.db.prepare(T).all(e,...a,t+1),c=this.db.prepare(f).all(e,...a,r+1);if(p.length===0&&c.length===0)return{observations:[],sessions:[],prompts:[]};d=p.length>0?p[p.length-1].created_at_epoch:s,u=c.length>0?c[c.length-1].created_at_epoch:s}catch(p){return console.error("[SessionStore] Error getting boundary observations:",p.message),{observations:[],sessions:[],prompts:[]}}}else{let T=`
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
      `;try{let p=this.db.prepare(T).all(s,...a,t),c=this.db.prepare(f).all(s,...a,r+1);if(p.length===0&&c.length===0)return{observations:[],sessions:[],prompts:[]};d=p.length>0?p[p.length-1].created_at_epoch:s,u=c.length>0?c[c.length-1].created_at_epoch:s}catch(p){return console.error("[SessionStore] Error getting boundary timestamps:",p.message),{observations:[],sessions:[],prompts:[]}}}let E=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,l=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let T=this.db.prepare(E).all(d,u,...a),f=this.db.prepare(_).all(d,u,...a),p=this.db.prepare(l).all(d,u,...a);return{observations:T,sessions:f.map(c=>({id:c.id,sdk_session_id:c.sdk_session_id,project:c.project,request:c.request,completed:c.completed,next_steps:c.next_steps,created_at:c.created_at,created_at_epoch:c.created_at_epoch})),prompts:p.map(c=>({id:c.id,claude_session_id:c.claude_session_id,project:c.project,prompt:c.prompt_text,created_at:c.created_at,created_at_epoch:c.created_at_epoch}))}}catch(T){return console.error("[SessionStore] Error querying timeline records:",T.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||0,compressedTokens:t.endless_compressed_tokens||0,tokensSaved:t.endless_tokens_saved||0}:null}close(){this.db.close()}};function ae(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function W(o,e,s={}){let t=ae(o,e,s);return JSON.stringify(t)}import K from"path";import{homedir as ce}from"os";import{existsSync as Y,readFileSync as de}from"fs";import{execSync as pe}from"child_process";var ue=100,le=500,_e=10;function C(){try{let o=K.join(ce(),".claude-mem","settings.json");if(Y(o)){let e=JSON.parse(de(o,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function J(){try{let o=C();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(ue)})).ok}catch{return!1}}async function me(){try{let o=P(),e=K.join(o,"ecosystem.config.cjs");if(!Y(e))throw new Error(`Ecosystem config not found at ${e}`);pe(`pm2 start "${e}"`,{cwd:o,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<_e;s++)if(await new Promise(t=>setTimeout(t,le)),await J())return!0;return!1}catch{return!1}}async function q(){if(await J())return;if(!await me()){let e=C();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{appendFileSync as Ee}from"fs";import{homedir as Te}from"os";import{join as ge}from"path";var fe=ge(Te(),".claude-mem","silent.log");function w(o,e,s=""){let t=new Date().toISOString(),a=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),d=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",u=`[${t}] [${d}] ${o}`;if(e!==void 0)try{u+=` ${JSON.stringify(e)}`}catch(E){u+=` [stringify error: ${E}]`}u+=`
`;try{Ee(fe,u)}catch(E){console.error("[silent-debug] Failed to write to log:",E)}return s}import{existsSync as Se,readFileSync as be}from"fs";import{homedir as he}from"os";import Oe from"path";var I=class{static config=null;static getConfig(){if(this.config)return this.config;let e=Oe.join(he(),".claude-mem","settings.json"),s={};if(Se(e))try{s=JSON.parse(be(e,"utf-8"))}catch(u){m.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},u)}let t=this.getBooleanSetting(s.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),r=this.getBooleanSetting(s.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),n=this.getNumberSetting(s.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),i=this.getNumberSetting(s.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),a=this.getBooleanSetting(s.env?.CLAUDE_MEM_OBSERVE_EVERYTHING,process.env.CLAUDE_MEM_OBSERVE_EVERYTHING,t),d=this.getNumberSetting(s.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50);return this.config={enabled:t,fallbackToOriginal:r,maxLookupTime:n,keepRecentToolUses:i,observeEverything:a,maxToolHistoryMB:d},t?m.info("CONFIG","Endless Mode enabled",{fallback:r,maxLookupTime:`${n}ms`,keepRecent:i,observeEverything:a,maxToolHistoryMB:`${d}MB`}):m.debug("CONFIG","Endless Mode disabled"),this.config}static clearCache(){this.config=null}static getBooleanSetting(e,s,t){if(e!==void 0){if(typeof e=="boolean")return e;if(typeof e=="string")return e.toLowerCase()==="true"}return s!==void 0?s.toLowerCase()==="true":t}static getNumberSetting(e,s,t){if(e!==void 0){if(typeof e=="number")return e;if(typeof e=="string"){let r=parseInt(e,10);if(!isNaN(r))return r}}if(s!==void 0){let r=parseInt(s,10);if(!isNaN(r))return r}return t}};import{existsSync as Re,readFileSync as Ne,writeFileSync as ye,appendFileSync as Ie,statSync as Le}from"fs";import{join as Ae}from"path";var L=Ae(R,"tool-outputs.jsonl");function V(o,e,s=Date.now()){N(R);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),i=JSON.stringify({tool_use_id:o,content:e,timestamp:s,size_bytes:r})+`
`;Ie(L,i,"utf8")}function z(o){if(!Re(L)||Le(L).size/(1024*1024)<=o)return;let r=Ne(L,"utf8").trim().split(`
`).filter(_=>_.length>0),n=[];for(let _ of r)try{n.push(JSON.parse(_))}catch{continue}n.sort((_,l)=>_.timestamp-l.timestamp);let i=o*1024*1024,a=0,d=0;for(let _=n.length-1;_>=0;_--){let l=n[_].size_bytes+100;if(a+l>i){d=_+1;break}a+=l}let E=n.slice(d).map(_=>JSON.stringify(_)).join(`
`)+`
`;ye(L,E,"utf8")}function De(o){try{let s=A(o,"utf-8").trim().split(`
`),t=[];for(let r of s)if(r.trim())try{let n=JSON.parse(r);if(n.type==="user"){let a=n.message.content;if(Array.isArray(a)){for(let d of a)if(d.type==="tool_result"){let u=d;!(typeof u.content=="string"?u.content:JSON.stringify(u.content)).trim().startsWith("# ")&&u.tool_use_id&&t.push(u.tool_use_id)}}}}catch{continue}return t}catch(e){return m.warn("HOOK","Failed to extract pending tool_use_ids",{transcriptPath:o},e),[]}}function k(o,e){if(!o)return[];if(Array.isArray(o))return o;try{let s=JSON.parse(o);return Array.isArray(s)?s:[]}catch{return[]}}function Me(o){let e=[];e.push(`# ${o.title}`),o.subtitle&&e.push(`**${o.subtitle}**`),e.push(""),o.narrative&&(e.push(o.narrative),e.push(""));let s=k(o.facts,"facts");s.length>0&&(e.push("**Key Facts:**"),s.forEach(i=>e.push(`- ${i}`)),e.push(""));let t=k(o.concepts,"concepts");t.length>0&&(e.push(`**Concepts**: ${t.join(", ")}`),e.push(""));let r=k(o.files_read,"files_read");r.length>0&&(e.push(`**Files Read**: ${r.join(", ")}`),e.push(""));let n=k(o.files_modified,"files_modified");return n.length>0&&(e.push(`**Files Modified**: ${n.join(", ")}`),e.push("")),e.push("---"),e.push("*[Compressed by Endless Mode]*"),e.join(`
`)}async function xe(o,e,s){try{N(R);let p=G(o);ke(o,p),m.info("HOOK","Created transcript backup",{original:o,backup:p})}catch(p){throw m.error("HOOK","Failed to create transcript backup",{transcriptPath:o},p),new Error("Backup creation failed - aborting transformation for safety")}let r=A(o,"utf-8").trim().split(`
`),n=!1,i=0,a=0,d=r.map((p,c)=>{if(!p.trim())return p;try{let S=JSON.parse(p);if(S.type==="user"){let O=S.message.content;if(Array.isArray(O))for(let D=0;D<O.length;D++){let H=O[D];if(H.type==="tool_result"){let v=H;if(v.tool_use_id===e){n=!0;try{V(e,v.content,Date.now())}catch(Z){m.warn("HOOK","Failed to backup original tool output",{toolUseId:e},Z)}i=JSON.stringify(v.content).length;let X=Me(s);a=X.length,v.content=X,m.success("HOOK","Transformed tool result",{toolUseId:e,originalSize:i,compressedSize:a,savings:`${Math.round((1-a/i)*100)}%`})}}}}return JSON.stringify(S)}catch(S){throw m.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:c,error:S}),new Error(`Malformed JSONL line at index ${c}: ${S.message}`)}});if(!n)return m.warn("HOOK","Tool result not found in transcript",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let u=`${o}.tmp`;ve(u,d.join(`
`)+`
`,"utf-8");let _=A(u,"utf-8").trim().split(`
`);for(let p of _)p.trim()&&JSON.parse(p);Ce(u,o);let l=4,T=Math.ceil(i/l),f=Math.ceil(a/l);try{let p=I.getConfig();p.maxToolHistoryMB>0&&z(p.maxToolHistoryMB)}catch(p){m.warn("HOOK","Failed to trim tool output backup",{},p)}return{originalTokens:T,compressedTokens:f}}function Ue(o){if(!o||!B(o))return"";try{let e=A(o,"utf-8").trim();if(!e)return"";let s=e.split(`
`);for(let t=s.length-1;t>=0;t--)try{let r=JSON.parse(s[t]);if(r.type==="user"&&r.message?.content){let n=r.message.content;if(typeof n=="string")return n;if(Array.isArray(n))return n.filter(a=>a.type==="text").map(a=>a.text).join(`
`)}}catch{continue}}catch(e){m.error("HOOK","Failed to read transcript",{transcriptPath:o},e)}return""}function we(o){if(!o||!B(o))return"";try{let e=A(o,"utf-8").trim();if(!e)return"";let s=e.split(`
`);for(let t=s.length-1;t>=0;t--)try{let r=JSON.parse(s[t]);if(r.type==="assistant"&&r.message?.content){let n="",i=r.message.content;return typeof i=="string"?n=i:Array.isArray(i)&&(n=i.filter(d=>d.type==="text").map(d=>d.text).join(`
`)),n=n.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,""),n=n.replace(/\n{3,}/g,`

`).trim(),n}}catch{continue}}catch(e){m.error("HOOK","Failed to read transcript",{transcriptPath:o},e)}return""}async function Fe(o){if(!o)throw new Error("summaryHook requires input");let{session_id:e,transcript_path:s}=o;if(await q(),I.getConfig().enabled&&s&&B(s))try{let l=De(s);if(l.length>0){m.info("HOOK","Stop hook: Found pending transformations",{count:l.length,ids:l});let T=new y,f=T.getObservationsByToolUseIds(l);T.close(),m.info("HOOK","Stop hook: Ready observations for final transformation",{pending:l.length,ready:f.size});for(let[p,c]of f)try{let S={id:c.id,type:c.type,title:c.title,subtitle:c.subtitle,narrative:c.narrative,facts:JSON.parse(c.facts),concepts:JSON.parse(c.concepts),files_read:JSON.parse(c.files_read),files_modified:JSON.parse(c.files_modified),created_at_epoch:c.created_at_epoch},h=await xe(s,p,S);if(h.originalTokens>0){let O=new y;O.incrementEndlessModeStats(e,h.originalTokens,h.compressedTokens),O.close()}m.success("HOOK","Stop hook: Final transformation complete",{toolUseId:p,observationId:c.id,savings:`${Math.round((1-h.compressedTokens/h.originalTokens)*100)}%`})}catch(S){m.warn("HOOK","Stop hook: Final transformation failed",{toolUseId:p},S)}}else m.debug("HOOK","Stop hook: No pending transformations found")}catch(l){m.warn("HOOK","Stop hook: Transformation check failed",{},l)}let r=new y,n=r.createSDKSession(e,"",""),i=r.getPromptCounter(n),a=r.db.prepare(`
    SELECT id, claude_session_id, sdk_session_id, project
    FROM sdk_sessions WHERE id = ?
  `).get(n),d=r.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations
    WHERE sdk_session_id = ?
  `).get(a?.sdk_session_id);w("[summary-hook] Session diagnostics",{claudeSessionId:e,sessionDbId:n,sdkSessionId:a?.sdk_session_id,project:a?.project,promptNumber:i,observationCount:d?.count||0,transcriptPath:o.transcript_path}),r.close();let u=C(),E=Ue(o.transcript_path||""),_=we(o.transcript_path||"");w("[summary-hook] Extracted messages",{hasLastUserMessage:!!E,hasLastAssistantMessage:!!_,lastAssistantPreview:_.substring(0,200),lastAssistantLength:_.length}),m.dataIn("HOOK","Stop: Requesting summary",{sessionId:n,workerPort:u,promptNumber:i,hasLastUserMessage:!!E,hasLastAssistantMessage:!!_});try{let l=await fetch(`http://127.0.0.1:${u}/sessions/${n}/summarize`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt_number:i,last_user_message:E,last_assistant_message:_}),signal:AbortSignal.timeout(2e3)});if(!l.ok){let T=await l.text();throw m.failure("HOOK","Failed to generate summary",{sessionId:n,status:l.status},T),new Error(`Failed to request summary from worker: ${l.status} ${T}`)}m.debug("HOOK","Summary request sent successfully",{sessionId:n})}catch(l){throw l.cause?.code==="ECONNREFUSED"||l.name==="TimeoutError"||l.message.includes("fetch failed")?new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"):l}finally{await fetch(`http://127.0.0.1:${u}/api/processing`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({isProcessing:!1})})}console.log(W("Stop",!0))}var F="";Q.on("data",o=>F+=o);Q.on("end",async()=>{let o=F?JSON.parse(F):void 0;await Fe(o)});
