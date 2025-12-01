#!/usr/bin/env node
import x from"path";import{homedir as le}from"os";import{existsSync as _e,readFileSync as Ee,unlinkSync as Te}from"fs";import{stdin as P}from"process";import{fileURLToPath as he}from"url";import{dirname as ge}from"path";import me from"better-sqlite3";import{join as f,dirname as de,basename as xe}from"path";import{homedir as V}from"os";import{existsSync as we,mkdirSync as ce}from"fs";import{fileURLToPath as pe}from"url";function ue(){return typeof __dirname<"u"?__dirname:de(pe(import.meta.url))}var Xe=ue(),L=process.env.CLAUDE_MEM_DATA_DIR||f(V(),".claude-mem"),B=process.env.CLAUDE_CONFIG_DIR||f(V(),".claude"),Be=f(L,"archives"),je=f(L,"logs"),He=f(L,"trash"),Pe=f(L,"backups"),We=f(L,"settings.json"),q=f(L,"claude-mem.db"),Ge=f(L,"vector-db"),Ye=f(B,"settings.json"),Ke=f(B,"commands"),Ve=f(B,"CLAUDE.md");function J(c){ce(c,{recursive:!0})}var j=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(j||{}),H=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=j[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,i){if(e<this.level)return;let a=new Date().toISOString().replace("T"," ").substring(0,23),d=j[e].padEnd(5),m=s.padEnd(6),g="";r?.correlationId?g=`[${r.correlationId}] `:r?.sessionId&&(g=`[session-${r.sessionId}] `);let n="";i!=null&&(this.level===0&&typeof i=="object"?n=`
`+JSON.stringify(i,null,2):n=" "+this.formatData(i));let b="";if(r){let{sessionId:T,sdkSessionId:R,correlationId:l,...p}=r;Object.keys(p).length>0&&(b=` {${Object.entries(p).map(([$,A])=>`${$}=${A}`).join(", ")}}`)}let S=`[${a}] [${d}] [${m}] ${g}${t}${b}${n}`;e===3?console.error(S):console.log(S)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},Q=new H;var M=class{db;constructor(){J(L),this.db=new me(q),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(m=>m.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(m=>m.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(m=>m.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
          CREATE INDEX idx_user_prompts_lookup ON user_prompts(claude_session_id, prompt_number);
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(a=>a.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(a=>a.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${d})
      ORDER BY created_at_epoch ${i}
      ${a}
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
    `).all(e),r=new Set,i=new Set;for(let a of t){if(a.files_read)try{let d=JSON.parse(a.files_read);Array.isArray(d)&&d.forEach(m=>r.add(m))}catch{}if(a.files_modified)try{let d=JSON.parse(a.files_modified);Array.isArray(d)&&d.forEach(m=>i.add(m))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,i=r.getTime(),d=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),i);return d.lastInsertRowid===0||d.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):d.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(Q.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,i,a.toISOString(),d);return{id:Number(b.lastInsertRowid),createdAtEpoch:d}}storeSummary(e,s,t,r,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,i,a.toISOString(),d);return{id:Number(b.lastInsertRowid),createdAtEpoch:d}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${d})
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",a=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${d})
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let a=i?"AND project = ?":"",d=i?[i]:[],m,g;if(e!==null){let T=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${a}
        ORDER BY id DESC
        LIMIT ?
      `,R=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${a}
        ORDER BY id ASC
        LIMIT ?
      `;try{let l=this.db.prepare(T).all(e,...d,t+1),p=this.db.prepare(R).all(e,...d,r+1);if(l.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};m=l.length>0?l[l.length-1].created_at_epoch:s,g=p.length>0?p[p.length-1].created_at_epoch:s}catch(l){return console.error("[SessionStore] Error getting boundary observations:",l.message),{observations:[],sessions:[],prompts:[]}}}else{let T=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${a}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,R=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${a}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let l=this.db.prepare(T).all(s,...d,t),p=this.db.prepare(R).all(s,...d,r+1);if(l.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};m=l.length>0?l[l.length-1].created_at_epoch:s,g=p.length>0?p[p.length-1].created_at_epoch:s}catch(l){return console.error("[SessionStore] Error getting boundary timestamps:",l.message),{observations:[],sessions:[],prompts:[]}}}let n=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,S=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let T=this.db.prepare(n).all(m,g,...d),R=this.db.prepare(b).all(m,g,...d),l=this.db.prepare(S).all(m,g,...d);return{observations:T,sessions:R.map(p=>({id:p.id,sdk_session_id:p.sdk_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:l.map(p=>({id:p.id,claude_session_id:p.claude_session_id,project:p.project,prompt:p.prompt_text,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}catch(T){return console.error("[SessionStore] Error querying timeline records:",T.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var be=he(import.meta.url),Se=ge(be),fe=x.join(Se,"../../.install-version");function Re(){try{let c=x.join(le(),".claude","settings.json");if(_e(c)){let e=JSON.parse(Ee(c,"utf-8"));if(e.env?.CLAUDE_MEM_CONTEXT_OBSERVATIONS){let s=parseInt(e.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10);if(!isNaN(s)&&s>0)return s}}}catch{}return parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10)}var Ne=Re(),z=10,Z=4,Ie=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Oe(c){if(!c)return[];try{let e=JSON.parse(c);return Array.isArray(e)?e:[]}catch{return[]}}function ye(c){return new Date(c).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Le(c){return new Date(c).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ve(c){return new Date(c).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ae(c,e){return x.isAbsolute(c)?x.relative(e,c):c}function w(c,e,s,t){return e?t?[`${s}${c}:${o.reset} ${e}`,""]:[`**${c}**: ${e}`,""]:[]}async function ee(c,e=!1){let s=c?.cwd??process.cwd(),t=s?x.basename(s):"unknown-project",r;try{r=new M}catch(b){if(b.code==="ERR_DLOPEN_FAILED"){try{Te(fe)}catch{}console.error("\u26A0\uFE0F  Native module rebuild needed - restart Claude Code to auto-fix"),console.error("   (This happens after Node.js version upgrades)"),process.exit(0)}throw b}let i=r.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(t,Ne),a=r.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(t,z+Ie);if(i.length===0&&a.length===0)return r.close(),e?`
${o.bright}${o.cyan}\u{1F4DD} [${t}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${t}] recent context

No previous sessions found for this project yet.`;let d=i,m=a.slice(0,z),g=d,n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}\u{1F4DD} [${t}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${t}] recent context`),n.push("")),g.length>0){e?n.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):n.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),n.push(""),e?(n.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),n.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),n.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),n.push(""),n.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),n.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),n.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),n.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let b=d.length,S=d.reduce((u,_)=>{let h=(_.title?.length||0)+(_.subtitle?.length||0)+(_.narrative?.length||0)+JSON.stringify(_.facts||[]).length;return u+Math.ceil(h/Z)},0),T=d.reduce((u,_)=>u+(_.discovery_tokens||0),0),R=T-S,l=T>0?Math.round(R/T*100):0;e?(n.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),n.push(`${o.dim}  Loading: ${b} observations (${S.toLocaleString()} tokens to read)${o.reset}`),n.push(`${o.dim}  Work investment: ${T.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),T>0&&n.push(`${o.green}  Your savings: ${R.toLocaleString()} tokens (${l}% reduction from reuse)${o.reset}`),n.push("")):(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${b} observations (${S.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${T.toLocaleString()} tokens spent on research, building, and decisions`),T>0&&n.push(`- Your savings: ${R.toLocaleString()} tokens (${l}% reduction from reuse)`),n.push(""));let p=a[0]?.id,W=m.map((u,_)=>{let h=_===0?null:a[_+1];return{...u,displayEpoch:h?h.created_at_epoch:u.created_at_epoch,displayTime:h?h.created_at:u.created_at,shouldShowLink:u.id!==p}}),$=[...g.map(u=>({type:"observation",data:u})),...W.map(u=>({type:"summary",data:u}))];$.sort((u,_)=>{let h=u.type==="observation"?u.data.created_at_epoch:u.data.displayEpoch,v=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch;return h-v});let A=new Map;for(let u of $){let _=u.type==="observation"?u.data.created_at:u.data.displayTime,h=ve(_);A.has(h)||A.set(h,[]),A.get(h).push(u)}let se=Array.from(A.entries()).sort((u,_)=>{let h=new Date(u[0]).getTime(),v=new Date(_[0]).getTime();return h-v});for(let[u,_]of se){e?(n.push(`${o.bright}${o.cyan}${u}${o.reset}`),n.push("")):(n.push(`### ${u}`),n.push(""));let h=null,v="",D=!1;for(let F of _)if(F.type==="summary"){D&&(n.push(""),D=!1,h=null,v="");let E=F.data,C=`${E.request||"Session started"} (${ye(E.displayTime)})`,I=E.shouldShowLink?`claude-mem://session-summary/${E.id}`:"";if(e){let O=I?`${o.dim}[${I}]${o.reset}`:"";n.push(`\u{1F3AF} ${o.yellow}#S${E.id}${o.reset} ${C} ${O}`)}else{let O=I?` [\u2192](${I})`:"";n.push(`**\u{1F3AF} #S${E.id}** ${C}${O}`)}n.push("")}else{let E=F.data,C=Oe(E.files_modified),I=C.length>0?Ae(C[0],s):"General";I!==h&&(D&&n.push(""),e?n.push(`${o.dim}${I}${o.reset}`):n.push(`**${I}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),h=I,D=!0,v="");let O=Le(E.created_at),Y=E.title||"Untitled",y="\u2022";switch(E.type){case"bugfix":y="\u{1F534}";break;case"feature":y="\u{1F7E3}";break;case"refactor":y="\u{1F504}";break;case"change":y="\u2705";break;case"discovery":y="\u{1F535}";break;case"decision":y="\u2696\uFE0F";break;default:y="\u2022"}let te=(E.title?.length||0)+(E.subtitle?.length||0)+(E.narrative?.length||0)+JSON.stringify(E.facts||[]).length,X=Math.ceil(te/Z),U=E.discovery_tokens||0,k="\u{1F50D}";switch(E.type){case"discovery":k="\u{1F50D}";break;case"change":case"feature":case"bugfix":case"refactor":k="\u{1F6E0}\uFE0F";break;case"decision":k="\u2696\uFE0F";break}let re=U>0?`${k} ${U.toLocaleString()}`:"-",K=O!==v,ne=K?O:"";if(v=O,e){let oe=K?`${o.dim}${O}${o.reset}`:" ".repeat(O.length),ie=X>0?`${o.dim}(~${X}t)${o.reset}`:"",ae=U>0?`${o.dim}(${k} ${U.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${E.id}${o.reset}  ${oe}  ${y}  ${Y} ${ie} ${ae}`)}else n.push(`| #${E.id} | ${ne||"\u2033"} | ${y} | ${Y} | ~${X} | ${re} |`)}D&&n.push("")}let N=a[0],G=d[0];if(N&&(N.investigated||N.learned||N.completed||N.next_steps)&&(!G||N.created_at_epoch>G.created_at_epoch)&&(n.push(...w("Investigated",N.investigated,o.blue,e)),n.push(...w("Learned",N.learned,o.yellow,e)),n.push(...w("Completed",N.completed,o.green,e)),n.push(...w("Next Steps",N.next_steps,o.magenta,e))),T>0&&R>0){let u=Math.round(T/1e3);n.push(""),e?n.push(`${o.dim}\u{1F4B0} Access ${u}k tokens of past research & decisions for just ${S.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):n.push(`\u{1F4B0} Access ${u}k tokens of past research & decisions for just ${S.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return r.close(),n.join(`
`).trimEnd()}var De=process.argv.includes("--colors");if(P.isTTY||De)ee(void 0,!0).then(c=>{console.log(c),process.exit(0)});else{let c="";P.on("data",e=>c+=e),P.on("end",async()=>{let e=c.trim()?JSON.parse(c):void 0,t={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:await ee(e,!1)}};console.log(JSON.stringify(t)),process.exit(0)})}
