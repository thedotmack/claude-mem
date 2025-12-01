#!/usr/bin/env node
import P from"path";import{homedir as ge}from"os";import{existsSync as Se,readFileSync as be,unlinkSync as ke}from"fs";import{stdin as te}from"process";import{fileURLToPath as De}from"url";import{dirname as $e}from"path";import Ce from"better-sqlite3";import{join as O,dirname as ve,basename as qe}from"path";import{homedir as de}from"os";import{existsSync as Ze,mkdirSync as ye}from"fs";import{fileURLToPath as Ae}from"url";function Le(){return typeof __dirname<"u"?__dirname:ve(Ae(import.meta.url))}var ss=Le(),L=process.env.CLAUDE_MEM_DATA_DIR||O(de(),".claude-mem"),Q=process.env.CLAUDE_CONFIG_DIR||O(de(),".claude"),ts=O(L,"archives"),rs=O(L,"logs"),ns=O(L,"trash"),os=O(L,"backups"),is=O(L,"settings.json"),ce=O(L,"claude-mem.db"),as=O(L,"vector-db"),ds=O(Q,"settings.json"),cs=O(Q,"commands"),ps=O(Q,"CLAUDE.md");function pe(p){ye(p,{recursive:!0})}var z=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(z||{}),Z=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=z[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let r=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&r.command){let n=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${e}(${n})`}if(e==="Read"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Edit"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Write"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,s,r,n,i){if(e<this.level)return;let d=new Date().toISOString().replace("T"," ").substring(0,23),a=z[e].padEnd(5),u=s.padEnd(6),S="";n?.correlationId?S=`[${n.correlationId}] `:n?.sessionId&&(S=`[session-${n.sessionId}] `);let T="";i!=null&&(this.level===0&&typeof i=="object"?T=`
`+JSON.stringify(i,null,2):T=" "+this.formatData(i));let b="";if(n){let{sessionId:h,sdkSessionId:C,correlationId:_,...t}=n;Object.keys(t).length>0&&(b=` {${Object.entries(t).map(([N,g])=>`${N}=${g}`).join(", ")}}`)}let f=`[${d}] [${a}] [${u}] ${S}${r}${b}${T}`;e===3?console.error(f):console.log(f)}debug(e,s,r,n){this.log(0,e,s,r,n)}info(e,s,r,n){this.log(1,e,s,r,n)}warn(e,s,r,n){this.log(2,e,s,r,n)}error(e,s,r,n){this.log(3,e,s,r,n)}dataIn(e,s,r,n){this.info(e,`\u2192 ${s}`,r,n)}dataOut(e,s,r,n){this.info(e,`\u2190 ${s}`,r,n)}success(e,s,r,n){this.info(e,`\u2713 ${s}`,r,n)}failure(e,s,r,n){this.error(e,`\u2717 ${s}`,r,n)}timing(e,s,r,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${r}ms`})}},F=new Z;var Y=class{db;constructor(){pe(L),this.db=new Ce(ce),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(r=>r.version)):0)===0&&(console.error("[SessionStore] Initializing fresh database with migration004..."),this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(n=>n.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(u=>u.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(u=>u.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(u=>u.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(n){throw this.db.exec("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.pragma("table_info(observations)").some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.pragma("table_info(observations)").find(n=>n.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.error("[SessionStore] Successfully made observations.text nullable")}catch(n){throw this.db.exec("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.pragma("table_info(user_prompts)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.error("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(r){throw this.db.exec("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(d=>d.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(d=>d.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).all().map(r=>r.project)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n}=s,i=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${i}
      ${d}
    `).all(...e)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let r=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,i=new Set;for(let d of r){if(d.files_read)try{let a=JSON.parse(d.files_read);Array.isArray(a)&&a.forEach(u=>n.add(u))}catch{}if(d.files_modified)try{let a=JSON.parse(d.files_modified);Array.isArray(a)&&a.forEach(u=>i.add(u))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,r){let n=new Date,i=n.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,r,n.toISOString(),i);return a.lastInsertRowid===0||a.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,r,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(F.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,r){let n=new Date,i=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,r,n.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,r,n,i=0){let d=new Date,a=d.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,d.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),n||null,i,d.toISOString(),a);return{id:Number(b.lastInsertRowid),createdAtEpoch:a}}storeSummary(e,s,r,n,i=0){let d=new Date,a=d.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,d.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,i,d.toISOString(),a);return{id:Number(b.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}markSessionFailed(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n}=s,i=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${i}
      ${d}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n}=s,i=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${i}
      ${d}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,r=10,n){return this.getTimelineAroundObservation(null,e,s,r,n)}getTimelineAroundObservation(e,s,r=10,n=10,i){let d=i?"AND project = ?":"",a=i?[i]:[],u,S;if(e!==null){let h=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${d}
        ORDER BY id DESC
        LIMIT ?
      `,C=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${d}
        ORDER BY id ASC
        LIMIT ?
      `;try{let _=this.db.prepare(h).all(e,...a,r+1),t=this.db.prepare(C).all(e,...a,n+1);if(_.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};u=_.length>0?_[_.length-1].created_at_epoch:s,S=t.length>0?t[t.length-1].created_at_epoch:s}catch(_){return console.error("[SessionStore] Error getting boundary observations:",_.message),{observations:[],sessions:[],prompts:[]}}}else{let h=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${d}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,C=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${d}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let _=this.db.prepare(h).all(s,...a,r),t=this.db.prepare(C).all(s,...a,n+1);if(_.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};u=_.length>0?_[_.length-1].created_at_epoch:s,S=t.length>0?t[t.length-1].created_at_epoch:s}catch(_){return console.error("[SessionStore] Error getting boundary timestamps:",_.message),{observations:[],sessions:[],prompts:[]}}}let T=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,f=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${d.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let h=this.db.prepare(T).all(u,S,...a),C=this.db.prepare(b).all(u,S,...a),_=this.db.prepare(f).all(u,S,...a);return{observations:h,sessions:C.map(t=>({id:t.id,sdk_session_id:t.sdk_session_id,project:t.project,request:t.request,completed:t.completed,next_steps:t.next_steps,created_at:t.created_at,created_at_epoch:t.created_at_epoch})),prompts:_.map(t=>({id:t.id,claude_session_id:t.claude_session_id,project:t.project,prompt:t.prompt_text,created_at:t.created_at,created_at_epoch:t.created_at_epoch}))}}catch(h){return console.error("[SessionStore] Error querying timeline records:",h.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var ee=["bugfix","feature","refactor","discovery","decision","change"],se=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],ue={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},le={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},_e=ee.join(","),me=se.join(",");var xe=De(import.meta.url),Me=$e(xe),we=P.join(Me,"../../.install-version");function Ue(){let p={totalObservationCount:parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(ee),observationConcepts:new Set(se),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1};try{let e=P.join(ge(),".claude","settings.json");if(!Se(e))return p;let r=JSON.parse(be(e,"utf-8")).env||{};return{totalObservationCount:parseInt(r.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:parseInt(r.CLAUDE_MEM_CONTEXT_FULL_COUNT||"5",10),sessionCount:parseInt(r.CLAUDE_MEM_CONTEXT_SESSION_COUNT||"10",10),showReadTokens:r.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS!=="false",showWorkTokens:r.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS!=="false",showSavingsAmount:r.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT!=="false",showSavingsPercent:r.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT!=="false",observationTypes:new Set((r.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES||_e).split(",").map(n=>n.trim()).filter(Boolean)),observationConcepts:new Set((r.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS||me).split(",").map(n=>n.trim()).filter(Boolean)),fullObservationField:r.CLAUDE_MEM_CONTEXT_FULL_FIELD||"narrative",showLastSummary:r.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY!=="false",showLastMessage:r.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(e){return F.warn("HOOK","Failed to load context settings, using defaults",{},e),p}}var Ee=4,Fe=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Te(p){if(!p)return[];try{let e=JSON.parse(p);return Array.isArray(e)?e:[]}catch{return[]}}function Pe(p){return new Date(p).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Xe(p){return new Date(p).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Be(p){return new Date(p).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function je(p,e){return P.isAbsolute(p)?P.relative(e,p):p}function V(p,e,s,r){return e?r?[`${s}${p}:${o.reset} ${e}`,""]:[`**${p}**: ${e}`,""]:[]}function We(p){return p.replace(/^\//,"").replace(/\//g,"-")}function He(p){try{if(!Se(p))return{userMessage:"",assistantMessage:""};let e=be(p,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(i=>i.trim()),r="",n="";for(let i=s.length-1;i>=0;i--)try{let d=JSON.parse(s[i]);if(!n&&d.type==="assistant"&&d.message?.content){let a="";for(let u of d.message.content)u.type==="text"&&(a+=u.text);a=a.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),a&&(n=a)}if(!r&&d.type==="user"&&d.message?.content){let a="";for(let u of d.message.content)u.type==="text"&&(a+=u.text);a&&(r=a)}if(r&&n)break}catch{continue}return{userMessage:r,assistantMessage:n}}catch(e){return F.debug("HOOK",`Failed to extract prior messages from ${p}:`,{},e),{userMessage:"",assistantMessage:""}}}async function he(p,e=!1){let s=Ue(),r=p?.cwd??process.cwd(),n=r?P.basename(r):"unknown-project",i;try{i=new Y}catch(v){if(v.code==="ERR_DLOPEN_FAILED"){try{ke(we)}catch{}console.error("\u26A0\uFE0F  Native module rebuild needed - restart Claude Code to auto-fix"),console.error("   (This happens after Node.js version upgrades)"),process.exit(0)}throw v}let d=Array.from(s.observationTypes),a=d.map(()=>"?").join(","),u=Array.from(s.observationConcepts),S=u.map(()=>"?").join(","),T=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${a})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${S})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...d,...u,s.totalObservationCount),b=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+Fe),f="",h="";if(s.showLastMessage&&T.length>0)try{let v=p?.session_id,N=T.find(g=>g.sdk_session_id!==v);if(N){let g=N.sdk_session_id,k=We(r),M=P.join(ge(),".claude","projects",k,`${g}.jsonl`),X=He(M);f=X.userMessage,h=X.assistantMessage}}catch(v){F.debug("HOOK","Failed to retrieve prior session messages:",{},v)}if(T.length===0&&b.length===0)return i.close(),e?`
${o.bright}${o.cyan}\u{1F4DD} [${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let C=b.slice(0,s.sessionCount),_=T,t=[];if(e?(t.push(""),t.push(`${o.bright}${o.cyan}\u{1F4DD} [${n}] recent context${o.reset}`),t.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),t.push("")):(t.push(`# [${n}] recent context`),t.push("")),(f||h)&&(e?(t.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),t.push(""),f&&(t.push(`${o.dim}User: ${f}${o.reset}`),t.push("")),h&&(t.push(`${o.dim}Assistant: ${h}${o.reset}`),t.push("")),t.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),t.push("")):(t.push("**\u{1F4CB} Previously**"),t.push(""),f&&(t.push(`User: ${f}`),t.push("")),h&&(t.push(`Assistant: ${h}`),t.push("")),t.push("---"),t.push(""))),_.length>0){e?t.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):t.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),t.push(""),e?(t.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),t.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),t.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(t.push("\u{1F4A1} **Column Key**:"),t.push("- **Read**: Tokens to read this observation (cost to learn it now)"),t.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),t.push(""),e?(t.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),t.push(""),t.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),t.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),t.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),t.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(t.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),t.push(""),t.push("When you need implementation details, rationale, or debugging context:"),t.push("- Use the mem-search skill to fetch full observations on-demand"),t.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),t.push("- Trust this index over re-reading code for past decisions and learnings")),t.push("");let v=T.length,N=T.reduce((c,m)=>{let E=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length;return c+Math.ceil(E/Ee)},0),g=T.reduce((c,m)=>c+(m.discovery_tokens||0),0),k=g-N,M=g>0?Math.round(k/g*100):0,X=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(X)if(e){if(t.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),t.push(`${o.dim}  Loading: ${v} observations (${N.toLocaleString()} tokens to read)${o.reset}`),t.push(`${o.dim}  Work investment: ${g.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),g>0&&(s.showSavingsAmount||s.showSavingsPercent)){let c="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?c+=`${k.toLocaleString()} tokens (${M}% reduction from reuse)`:s.showSavingsAmount?c+=`${k.toLocaleString()} tokens`:c+=`${M}% reduction from reuse`,t.push(`${o.green}${c}${o.reset}`)}t.push("")}else{if(t.push("\u{1F4CA} **Context Economics**:"),t.push(`- Loading: ${v} observations (${N.toLocaleString()} tokens to read)`),t.push(`- Work investment: ${g.toLocaleString()} tokens spent on research, building, and decisions`),g>0&&(s.showSavingsAmount||s.showSavingsPercent)){let c="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?c+=`${k.toLocaleString()} tokens (${M}% reduction from reuse)`:s.showSavingsAmount?c+=`${k.toLocaleString()} tokens`:c+=`${M}% reduction from reuse`,t.push(c)}t.push("")}let fe=b[0]?.id,Re=C.map((c,m)=>{let E=m===0?null:b[m+1];return{...c,displayEpoch:E?E.created_at_epoch:c.created_at_epoch,displayTime:E?E.created_at:c.created_at,shouldShowLink:c.id!==fe}}),Oe=new Set(T.slice(0,s.fullObservationCount).map(c=>c.id)),re=[..._.map(c=>({type:"observation",data:c})),...Re.map(c=>({type:"summary",data:c}))];re.sort((c,m)=>{let E=c.type==="observation"?c.data.created_at_epoch:c.data.displayEpoch,D=m.type==="observation"?m.data.created_at_epoch:m.data.displayEpoch;return E-D});let j=new Map;for(let c of re){let m=c.type==="observation"?c.data.created_at:c.data.displayTime,E=Be(m);j.has(E)||j.set(E,[]),j.get(E).push(c)}let Ne=Array.from(j.entries()).sort((c,m)=>{let E=new Date(c[0]).getTime(),D=new Date(m[0]).getTime();return E-D});for(let[c,m]of Ne){e?(t.push(`${o.bright}${o.cyan}${c}${o.reset}`),t.push("")):(t.push(`### ${c}`),t.push(""));let E=null,D="",x=!1;for(let K of m)if(K.type==="summary"){x&&(t.push(""),x=!1,E=null,D="");let l=K.data,B=`${l.request||"Session started"} (${Pe(l.displayTime)})`,A=l.shouldShowLink?`claude-mem://session-summary/${l.id}`:"";if(e){let I=A?`${o.dim}[${A}]${o.reset}`:"";t.push(`\u{1F3AF} ${o.yellow}#S${l.id}${o.reset} ${B} ${I}`)}else{let I=A?` [\u2192](${A})`:"";t.push(`**\u{1F3AF} #S${l.id}** ${B}${I}`)}t.push("")}else{let l=K.data,B=Te(l.files_modified),A=B.length>0?je(B[0],r):"General";A!==E&&(x&&t.push(""),e?t.push(`${o.dim}${A}${o.reset}`):t.push(`**${A}**`),e||(t.push("| ID | Time | T | Title | Read | Work |"),t.push("|----|------|---|-------|------|------|")),E=A,x=!0,D="");let I=Xe(l.created_at),W=l.title||"Untitled",H=ue[l.type]||"\u2022",Ie=(l.title?.length||0)+(l.subtitle?.length||0)+(l.narrative?.length||0)+JSON.stringify(l.facts||[]).length,w=Math.ceil(Ie/Ee),U=l.discovery_tokens||0,q=le[l.type]||"\u{1F50D}",oe=U>0?`${q} ${U.toLocaleString()}`:"-",J=I!==D,ie=J?I:"";if(D=I,Oe.has(l.id)){let $=s.fullObservationField==="narrative"?l.narrative:l.facts?Te(l.facts).join(`
`):null;if(e){let y=J?`${o.dim}${I}${o.reset}`:" ".repeat(I.length),G=s.showReadTokens&&w>0?`${o.dim}(~${w}t)${o.reset}`:"",ae=s.showWorkTokens&&U>0?`${o.dim}(${q} ${U.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${l.id}${o.reset}  ${y}  ${H}  ${o.bright}${W}${o.reset}`),$&&t.push(`    ${o.dim}${$}${o.reset}`),(G||ae)&&t.push(`    ${G} ${ae}`),t.push("")}else{x&&(t.push(""),x=!1),t.push(`**#${l.id}** ${ie||"\u2033"} ${H} **${W}**`),$&&(t.push(""),t.push($),t.push(""));let y=[];s.showReadTokens&&y.push(`Read: ~${w}`),s.showWorkTokens&&y.push(`Work: ${oe}`),y.length>0&&t.push(y.join(", ")),t.push(""),E=null}}else if(e){let $=J?`${o.dim}${I}${o.reset}`:" ".repeat(I.length),y=s.showReadTokens&&w>0?`${o.dim}(~${w}t)${o.reset}`:"",G=s.showWorkTokens&&U>0?`${o.dim}(${q} ${U.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${l.id}${o.reset}  ${$}  ${H}  ${W} ${y} ${G}`)}else{let $=s.showReadTokens?`~${w}`:"",y=s.showWorkTokens?oe:"";t.push(`| #${l.id} | ${ie||"\u2033"} | ${H} | ${W} | ${$} | ${y} |`)}}x&&t.push("")}let R=b[0],ne=T[0];if(s.showLastSummary&&R&&(R.investigated||R.learned||R.completed||R.next_steps)&&(!ne||R.created_at_epoch>ne.created_at_epoch)&&(t.push(...V("Investigated",R.investigated,o.blue,e)),t.push(...V("Learned",R.learned,o.yellow,e)),t.push(...V("Completed",R.completed,o.green,e)),t.push(...V("Next Steps",R.next_steps,o.magenta,e))),s.showLastMessage&&R){let c=R.last_assistant_message;c&&(t.push(""),e?(t.push(`${o.bright}${o.magenta}\u{1F4AC} Last Message from Previous Session${o.reset}`),t.push(`${o.dim}${c}${o.reset}`)):(t.push("**\u{1F4AC} Last Message from Previous Session**"),t.push(""),t.push(c)),t.push(""))}if(X&&g>0&&k>0){let c=Math.round(g/1e3);t.push(""),e?t.push(`${o.dim}\u{1F4B0} Access ${c}k tokens of past research & decisions for just ${N.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):t.push(`\u{1F4B0} Access ${c}k tokens of past research & decisions for just ${N.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i.close(),t.join(`
`).trimEnd()}var Ge=process.argv.includes("--colors");if(te.isTTY||Ge)he(void 0,!0).then(p=>{console.log(p),process.exit(0)});else{let p="";te.on("data",e=>p+=e),te.on("end",async()=>{let e=p.trim()?JSON.parse(p):void 0,r={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:await he(e,!1)}};console.log(JSON.stringify(r)),process.exit(0)})}
