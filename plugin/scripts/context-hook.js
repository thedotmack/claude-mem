#!/usr/bin/env node
import M from"path";import{homedir as Ee}from"os";import{existsSync as he,readFileSync as ge,unlinkSync as Ie}from"fs";import{stdin as Z}from"process";import{fileURLToPath as Ae}from"url";import{dirname as Le}from"path";import ye from"better-sqlite3";import{join as b,dirname as Oe,basename as Ve}from"path";import{homedir as ie}from"os";import{existsSync as Qe,mkdirSync as Re}from"fs";import{fileURLToPath as Ne}from"url";function ve(){return typeof __dirname<"u"?__dirname:Oe(Ne(import.meta.url))}var Ze=ve(),A=process.env.CLAUDE_MEM_DATA_DIR||b(ie(),".claude-mem"),J=process.env.CLAUDE_CONFIG_DIR||b(ie(),".claude"),es=b(A,"archives"),ss=b(A,"logs"),ts=b(A,"trash"),rs=b(A,"backups"),ns=b(A,"settings.json"),ae=b(A,"claude-mem.db"),os=b(A,"vector-db"),is=b(J,"settings.json"),as=b(J,"commands"),ds=b(J,"CLAUDE.md");function de(l){Re(l,{recursive:!0})}var K=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(K||{}),q=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=K[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,i){if(e<this.level)return;let a=new Date().toISOString().replace("T"," ").substring(0,23),d=K[e].padEnd(5),m=s.padEnd(6),S="";r?.correlationId?S=`[${r.correlationId}] `:r?.sessionId&&(S=`[session-${r.sessionId}] `);let y="";i!=null&&(this.level===0&&typeof i=="object"?y=`
`+JSON.stringify(i,null,2):y=" "+this.formatData(i));let O="";if(r){let{sessionId:E,sdkSessionId:h,correlationId:u,...p}=r;Object.keys(p).length>0&&(O=` {${Object.entries(p).map(([L,H])=>`${L}=${H}`).join(", ")}}`)}let n=`[${a}] [${d}] [${m}] ${S}${t}${O}${y}`;e===3?console.error(n):console.log(n)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},U=new q;var j=class{db;constructor(){de(A),this.db=new ye(ae),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
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
    `).run(s,e).changes===0?(U.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
      `).run(e,e,s,a.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let O=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,i,a.toISOString(),d);return{id:Number(O.lastInsertRowid),createdAtEpoch:d}}storeSummary(e,s,t,r,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let O=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,i,a.toISOString(),d);return{id:Number(O.lastInsertRowid),createdAtEpoch:d}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let a=i?"AND project = ?":"",d=i?[i]:[],m,S;if(e!==null){let E=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${a}
        ORDER BY id DESC
        LIMIT ?
      `,h=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${a}
        ORDER BY id ASC
        LIMIT ?
      `;try{let u=this.db.prepare(E).all(e,...d,t+1),p=this.db.prepare(h).all(e,...d,r+1);if(u.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};m=u.length>0?u[u.length-1].created_at_epoch:s,S=p.length>0?p[p.length-1].created_at_epoch:s}catch(u){return console.error("[SessionStore] Error getting boundary observations:",u.message),{observations:[],sessions:[],prompts:[]}}}else{let E=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${a}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${a}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let u=this.db.prepare(E).all(s,...d,t),p=this.db.prepare(h).all(s,...d,r+1);if(u.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};m=u.length>0?u[u.length-1].created_at_epoch:s,S=p.length>0?p[p.length-1].created_at_epoch:s}catch(u){return console.error("[SessionStore] Error getting boundary timestamps:",u.message),{observations:[],sessions:[],prompts:[]}}}let y=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,O=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,n=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let E=this.db.prepare(y).all(m,S,...d),h=this.db.prepare(O).all(m,S,...d),u=this.db.prepare(n).all(m,S,...d);return{observations:E,sessions:h.map(p=>({id:p.id,sdk_session_id:p.sdk_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:u.map(p=>({id:p.id,claude_session_id:p.claude_session_id,project:p.project,prompt:p.prompt_text,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}catch(E){return console.error("[SessionStore] Error querying timeline records:",E.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var Q=["bugfix","feature","refactor","discovery","decision","change"],z=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],ce={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},pe={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},le=Q.join(","),ue=z.join(",");var Ce=Ae(import.meta.url),ke=Le(Ce),De=M.join(ke,"../../.install-version");function we(){let l={totalObservationCount:parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(Q),observationConcepts:new Set(z),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1};try{let e=M.join(Ee(),".claude-mem","settings.json");if(!he(e))return l;let t=JSON.parse(ge(e,"utf-8")).env||{};return{totalObservationCount:parseInt(t.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:parseInt(t.CLAUDE_MEM_CONTEXT_FULL_COUNT||"5",10),sessionCount:parseInt(t.CLAUDE_MEM_CONTEXT_SESSION_COUNT||"10",10),showReadTokens:t.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS!=="false",showWorkTokens:t.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS!=="false",showSavingsAmount:t.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT!=="false",showSavingsPercent:t.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT!=="false",observationTypes:new Set((t.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES||le).split(",").map(r=>r.trim()).filter(Boolean)),observationConcepts:new Set((t.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS||ue).split(",").map(r=>r.trim()).filter(Boolean)),fullObservationField:t.CLAUDE_MEM_CONTEXT_FULL_FIELD||"narrative",showLastSummary:t.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY!=="false",showLastMessage:t.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(e){return U.warn("HOOK","Failed to load context settings, using defaults",{},e),l}}var me=4,xe=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"},$e=[{id:1001,sdk_session_id:"demo-session-1",type:"bugfix",title:"Fixed context preview API endpoint path error",subtitle:"toRelativePath receiving undefined from files_modified array",narrative:"Found bug where toRelativePath was called with undefined when files[0] existed but was null. Added truthy check before calling toRelativePath.",facts:JSON.stringify(["Added null check: (files.length > 0 && files[0])",'Error was "path argument must be string, received undefined"',"Bug occurred in preview mode when using fake cwd"]),concepts:JSON.stringify(["debugging","error-handling","type-safety"]),files_read:JSON.stringify(["src/hooks/context-hook.ts"]),files_modified:JSON.stringify(["src/hooks/context-hook.ts"]),discovery_tokens:1247,created_at:new Date(Date.now()-36e5).toISOString(),created_at_epoch:Date.now()-36e5},{id:1002,sdk_session_id:"demo-session-1",type:"feature",title:"Implemented Context Injection Settings modal",subtitle:"Added modal with settings form and live terminal preview",narrative:"Created ContextSettingsModal component with settings form that auto-saves to backend. Integrated TerminalPreview component to show live preview of how observations appear.",facts:JSON.stringify(["Modal triggered by gear icon in viewer header","Settings auto-save with 300ms debounce","Preview fetches from /api/context/preview endpoint","Built three new React components"]),concepts:JSON.stringify(["react","ui-components","settings","preview"]),files_read:null,files_modified:JSON.stringify(["src/ui/viewer/components/ContextSettingsModal.tsx","src/ui/viewer/components/TerminalPreview.tsx","src/ui/viewer/hooks/useContextPreview.ts"]),discovery_tokens:2891,created_at:new Date(Date.now()-72e5).toISOString(),created_at_epoch:Date.now()-72e5},{id:1003,sdk_session_id:"demo-session-1",type:"refactor",title:"Replaced preview endpoint with mock data",subtitle:"Removed real context-hook call to avoid path errors",narrative:"Changed /api/context/preview to return static mock markdown instead of calling context-hook with fake cwd. This avoided path errors but was too lazy - needed real formatted preview.",facts:JSON.stringify(["Initially tried calling real context-hook with fake cwd","Got path errors from non-existent directories","Switched to static mock but lost settings integration"]),concepts:JSON.stringify(["api-design","mocking","prototyping"]),files_read:JSON.stringify(["src/services/worker-service.ts"]),files_modified:JSON.stringify(["src/services/worker-service.ts"]),discovery_tokens:1653,created_at:new Date(Date.now()-54e5).toISOString(),created_at_epoch:Date.now()-54e5},{id:1004,sdk_session_id:"demo-session-2",type:"decision",title:"Chose demo content approach over static mocks",subtitle:"cm_demo_content project bypasses DB, uses baked-in observations",narrative:'Decided to add demo data directly in context-hook. When project="cm_demo_content", skip DB queries and use pre-baked observations but still run through real formatting logic with current settings.',facts:JSON.stringify(["Demo content shows real ANSI-formatted output","Settings changes trigger preview refresh with new formatting","Avoids fake cwd and missing data issues","Tests actual formatting code paths"]),concepts:JSON.stringify(["architecture","testing","ux-design"]),files_read:null,files_modified:null,discovery_tokens:2134,created_at:new Date(Date.now()-18e5).toISOString(),created_at_epoch:Date.now()-18e5},{id:1005,sdk_session_id:"demo-session-2",type:"discovery",title:"Terminal preview needs ANSI rendering, not raw markdown",subtitle:"Preview should show formatted output as it appears in terminal",narrative:"Realized preview should display ANSI-colored terminal output matching what users see at session start, not raw markdown text. Purpose is to show what context injection looks like with current settings.",facts:JSON.stringify(["Preview shows visual formatting with colors and spacing","Users configure settings and see immediate visual feedback","ANSI codes need browser rendering for preview"]),concepts:JSON.stringify(["ui-design","user-feedback","terminal-rendering"]),files_read:JSON.stringify(["src/ui/viewer/components/TerminalPreview.tsx"]),files_modified:null,discovery_tokens:1876,created_at:new Date(Date.now()-9e5).toISOString(),created_at_epoch:Date.now()-9e5}],Me=[{id:501,sdk_session_id:"demo-session-1",request:"Debug and fix Context Injection Settings modal functionality",investigated:"Found API endpoint path errors, modal rendering issues, and missing preview data handling",learned:"Preview endpoint needs real formatted output, not static mocks. Path validation critical when working with dynamic cwds.",completed:"Fixed toRelativePath bug, replaced static mock with proper endpoint structure",next_steps:"Implement demo content system for preview, add ANSI rendering to TerminalPreview component",created_at:new Date(Date.now()-36e5).toISOString(),created_at_epoch:Date.now()-36e5}];function ee(l){if(!l)return[];try{let e=JSON.parse(l);return Array.isArray(e)?e:[]}catch{return[]}}function Ue(l){return new Date(l).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Pe(l){return new Date(l).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Fe(l){return new Date(l).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Xe(l,e){return M.isAbsolute(l)?M.relative(e,l):l}function W(l,e,s,t){return e?t?[`${s}${l}:${o.reset} ${e}`,""]:[`**${l}**: ${e}`,""]:[]}function Be(l){return l.replace(/\//g,"-")}function je(l){try{if(!he(l))return{userMessage:"",assistantMessage:""};let e=ge(l,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(r=>r.trim()),t="";for(let r=s.length-1;r>=0;r--)try{let i=s[r];if(!i.includes('"type":"assistant"'))continue;let a=JSON.parse(i);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let d="";for(let m of a.message.content)m.type==="text"&&(d+=m.text);if(d=d.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),d){t=d;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return U.failure("HOOK","Failed to extract prior messages from transcript",{transcriptPath:l},e),{userMessage:"",assistantMessage:""}}}async function _e(l,e=!1){let s=we(),t=l?.cwd??process.cwd(),r=t?M.basename(t):"unknown-project",i,a,d=null;if(r==="cm_demo_content"){let E=Array.from(s.observationTypes),h=Array.from(s.observationConcepts);i=$e.filter(u=>E.includes(u.type)).filter(u=>ee(u.concepts).some(f=>h.includes(f))).slice(0,s.totalObservationCount),a=Me.slice(0,s.sessionCount+1)}else{try{d=new j}catch(f){if(f.code==="ERR_DLOPEN_FAILED"){try{Ie(De)}catch{}console.error("\u26A0\uFE0F  Native module rebuild needed - restart Claude Code to auto-fix"),console.error("   (This happens after Node.js version upgrades)"),process.exit(0)}throw f}let E=Array.from(s.observationTypes),h=E.map(()=>"?").join(","),u=Array.from(s.observationConcepts),p=u.map(()=>"?").join(",");i=d.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${h})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${p})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(r,...E,...u,s.totalObservationCount),a=d.db.prepare(`
      SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(r,s.sessionCount+xe)}let m="",S="";if(s.showLastMessage&&i.length>0&&r!=="cm_demo_content")try{let E=l?.session_id,h=i.find(u=>u.sdk_session_id!==E);if(h){let u=h.sdk_session_id,p=Be(t),f=M.join(Ee(),".claude","projects",p,`${u}.jsonl`),L=je(f);m=L.userMessage,S=L.assistantMessage}}catch{}if(i.length===0&&a.length===0)return d?.close(),e?`
${o.bright}${o.cyan}\u{1F4DD} [${r}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${r}] recent context

No previous sessions found for this project yet.`;let y=a.slice(0,s.sessionCount),O=i,n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}\u{1F4DD} [${r}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${r}] recent context`),n.push("")),O.length>0){e?n.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):n.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),n.push(""),e?(n.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),n.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),n.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),n.push(""),n.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),n.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),n.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),n.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let E=i.length,h=i.reduce((c,g)=>{let T=(g.title?.length||0)+(g.subtitle?.length||0)+(g.narrative?.length||0)+JSON.stringify(g.facts||[]).length;return c+Math.ceil(T/me)},0),u=i.reduce((c,g)=>c+(g.discovery_tokens||0),0),p=u-h,f=u>0?Math.round(p/u*100):0,L=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(L)if(e){if(n.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),n.push(`${o.dim}  Loading: ${E} observations (${h.toLocaleString()} tokens to read)${o.reset}`),n.push(`${o.dim}  Work investment: ${u.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),u>0&&(s.showSavingsAmount||s.showSavingsPercent)){let c="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?c+=`${p.toLocaleString()} tokens (${f}% reduction from reuse)`:s.showSavingsAmount?c+=`${p.toLocaleString()} tokens`:c+=`${f}% reduction from reuse`,n.push(`${o.green}${c}${o.reset}`)}n.push("")}else{if(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${E} observations (${h.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${u.toLocaleString()} tokens spent on research, building, and decisions`),u>0&&(s.showSavingsAmount||s.showSavingsPercent)){let c="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?c+=`${p.toLocaleString()} tokens (${f}% reduction from reuse)`:s.showSavingsAmount?c+=`${p.toLocaleString()} tokens`:c+=`${f}% reduction from reuse`,n.push(c)}n.push("")}let H=a[0]?.id,Te=y.map((c,g)=>{let T=g===0?null:a[g+1];return{...c,displayEpoch:T?T.created_at_epoch:c.created_at_epoch,displayTime:T?T.created_at:c.created_at,shouldShowLink:c.id!==H}}),Se=new Set(i.slice(0,s.fullObservationCount).map(c=>c.id)),se=[...O.map(c=>({type:"observation",data:c})),...Te.map(c=>({type:"summary",data:c}))];se.sort((c,g)=>{let T=c.type==="observation"?c.data.created_at_epoch:c.data.displayEpoch,C=g.type==="observation"?g.data.created_at_epoch:g.data.displayEpoch;return T-C});let P=new Map;for(let c of se){let g=c.type==="observation"?c.data.created_at:c.data.displayTime,T=Fe(g);P.has(T)||P.set(T,[]),P.get(T).push(c)}let fe=Array.from(P.entries()).sort((c,g)=>{let T=new Date(c[0]).getTime(),C=new Date(g[0]).getTime();return T-C});for(let[c,g]of fe){e?(n.push(`${o.bright}${o.cyan}${c}${o.reset}`),n.push("")):(n.push(`### ${c}`),n.push(""));let T=null,C="",D=!1;for(let G of g)if(G.type==="summary"){D&&(n.push(""),D=!1,T=null,C="");let _=G.data,w=`${_.request||"Session started"} (${Ue(_.displayTime)})`,I=_.shouldShowLink?`claude-mem://session-summary/${_.id}`:"";if(e){let R=I?`${o.dim}[${I}]${o.reset}`:"";n.push(`\u{1F3AF} ${o.yellow}#S${_.id}${o.reset} ${w} ${R}`)}else{let R=I?` [\u2192](${I})`:"";n.push(`**\u{1F3AF} #S${_.id}** ${w}${R}`)}n.push("")}else{let _=G.data,w=ee(_.files_modified),I=w.length>0&&w[0]?Xe(w[0],t):"General";I!==T&&(D&&n.push(""),e?n.push(`${o.dim}${I}${o.reset}`):n.push(`**${I}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),T=I,D=!0,C="");let R=Pe(_.created_at),F=_.title||"Untitled",X=ce[_.type]||"\u2022",be=(_.title?.length||0)+(_.subtitle?.length||0)+(_.narrative?.length||0)+JSON.stringify(_.facts||[]).length,x=Math.ceil(be/me),$=_.discovery_tokens||0,Y=pe[_.type]||"\u{1F50D}",re=$>0?`${Y} ${$.toLocaleString()}`:"-",V=R!==C,ne=V?R:"";if(C=R,Se.has(_.id)){let k=s.fullObservationField==="narrative"?_.narrative:_.facts?ee(_.facts).join(`
`):null;if(e){let v=V?`${o.dim}${R}${o.reset}`:" ".repeat(R.length),B=s.showReadTokens&&x>0?`${o.dim}(~${x}t)${o.reset}`:"",oe=s.showWorkTokens&&$>0?`${o.dim}(${Y} ${$.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${_.id}${o.reset}  ${v}  ${X}  ${o.bright}${F}${o.reset}`),k&&n.push(`    ${o.dim}${k}${o.reset}`),(B||oe)&&n.push(`    ${B} ${oe}`),n.push("")}else{D&&(n.push(""),D=!1),n.push(`**#${_.id}** ${ne||"\u2033"} ${X} **${F}**`),k&&(n.push(""),n.push(k),n.push(""));let v=[];s.showReadTokens&&v.push(`Read: ~${x}`),s.showWorkTokens&&v.push(`Work: ${re}`),v.length>0&&n.push(v.join(", ")),n.push(""),T=null}}else if(e){let k=V?`${o.dim}${R}${o.reset}`:" ".repeat(R.length),v=s.showReadTokens&&x>0?`${o.dim}(~${x}t)${o.reset}`:"",B=s.showWorkTokens&&$>0?`${o.dim}(${Y} ${$.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${_.id}${o.reset}  ${k}  ${X}  ${F} ${v} ${B}`)}else{let k=s.showReadTokens?`~${x}`:"",v=s.showWorkTokens?re:"";n.push(`| #${_.id} | ${ne||"\u2033"} | ${X} | ${F} | ${k} | ${v} |`)}}D&&n.push("")}let N=a[0],te=i[0];if(s.showLastSummary&&N&&(N.investigated||N.learned||N.completed||N.next_steps)&&(!te||N.created_at_epoch>te.created_at_epoch)&&(n.push(...W("Investigated",N.investigated,o.blue,e)),n.push(...W("Learned",N.learned,o.yellow,e)),n.push(...W("Completed",N.completed,o.green,e)),n.push(...W("Next Steps",N.next_steps,o.magenta,e))),S&&(n.push(""),n.push("---"),n.push(""),e?(n.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),n.push(""),n.push(`${o.dim}A: ${S}${o.reset}`)):(n.push("**\u{1F4CB} Previously**"),n.push(""),n.push(`A: ${S}`)),n.push("")),L&&u>0&&p>0){let c=Math.round(u/1e3);n.push(""),e?n.push(`${o.dim}\u{1F4B0} Access ${c}k tokens of past research & decisions for just ${h.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):n.push(`\u{1F4B0} Access ${c}k tokens of past research & decisions for just ${h.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return d?.close(),n.join(`
`).trimEnd()}var We=process.argv.includes("--colors");if(Z.isTTY||We)_e(void 0,!0).then(l=>{console.log(l),process.exit(0)});else{let l="";Z.on("data",e=>l+=e),Z.on("end",async()=>{let e=l.trim()?JSON.parse(l):void 0,t={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:await _e(e,!1)}};console.log(JSON.stringify(t)),process.exit(0)})}export{_e as contextHook};
