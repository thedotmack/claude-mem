#!/usr/bin/env node
import X from"path";import{homedir as ge}from"os";import{existsSync as Se,readFileSync as be,unlinkSync as ke}from"fs";import{stdin as te}from"process";import{fileURLToPath as De}from"url";import{dirname as $e}from"path";import Ce from"better-sqlite3";import{join as f,dirname as ye,basename as qe}from"path";import{homedir as de}from"os";import{existsSync as Ze,mkdirSync as ve}from"fs";import{fileURLToPath as Ae}from"url";function Le(){return typeof __dirname<"u"?__dirname:ye(Ae(import.meta.url))}var ss=Le(),A=process.env.CLAUDE_MEM_DATA_DIR||f(de(),".claude-mem"),Q=process.env.CLAUDE_CONFIG_DIR||f(de(),".claude"),ts=f(A,"archives"),rs=f(A,"logs"),ns=f(A,"trash"),os=f(A,"backups"),is=f(A,"settings.json"),ce=f(A,"claude-mem.db"),as=f(A,"vector-db"),ds=f(Q,"settings.json"),cs=f(Q,"commands"),ps=f(Q,"CLAUDE.md");function pe(p){ve(p,{recursive:!0})}var z=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(z||{}),Z=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=z[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let n=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${n})`}if(e==="Read"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Edit"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Write"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,s,t,n,i){if(e<this.level)return;let a=new Date().toISOString().replace("T"," ").substring(0,23),d=z[e].padEnd(5),u=s.padEnd(6),g="";n?.correlationId?g=`[${n.correlationId}] `:n?.sessionId&&(g=`[session-${n.sessionId}] `);let T="";i!=null&&(this.level===0&&typeof i=="object"?T=`
`+JSON.stringify(i,null,2):T=" "+this.formatData(i));let S="";if(n){let{sessionId:b,sdkSessionId:C,correlationId:_,...r}=n;Object.keys(r).length>0&&(S=` {${Object.entries(r).map(([R,h])=>`${R}=${h}`).join(", ")}}`)}let L=`[${a}] [${d}] [${u}] ${g}${t}${S}${T}`;e===3?console.error(L):console.log(L)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}error(e,s,t,n){this.log(3,e,s,t,n)}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}timing(e,s,t,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${t}ms`})}},B=new Z;var Y=class{db;constructor(){pe(A),this.db=new Ce(ce),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
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
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.pragma("table_info(observations)").find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${n}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).all(e),n=new Set,i=new Set;for(let a of t){if(a.files_read)try{let d=JSON.parse(a.files_read);Array.isArray(d)&&d.forEach(u=>n.add(u))}catch{}if(a.files_modified)try{let d=JSON.parse(a.files_modified);Array.isArray(d)&&d.forEach(u=>i.add(u))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let n=new Date,i=n.getTime(),d=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,n.toISOString(),i);return d.lastInsertRowid===0||d.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):d.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(B.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,t){let n=new Date,i=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,n.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let S=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),n||null,i,a.toISOString(),d);return{id:Number(S.lastInsertRowid),createdAtEpoch:d}}storeSummary(e,s,t,n,i=0){let a=new Date,d=a.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,a.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let S=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,i,a.toISOString(),d);return{id:Number(S.lastInsertRowid),createdAtEpoch:d}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${n}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${d})
      ORDER BY created_at_epoch ${i}
      ${a}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",a=n?`LIMIT ${n}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${d})
      ORDER BY up.created_at_epoch ${i}
      ${a}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,n){return this.getTimelineAroundObservation(null,e,s,t,n)}getTimelineAroundObservation(e,s,t=10,n=10,i){let a=i?"AND project = ?":"",d=i?[i]:[],u,g;if(e!==null){let b=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${a}
        ORDER BY id DESC
        LIMIT ?
      `,C=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${a}
        ORDER BY id ASC
        LIMIT ?
      `;try{let _=this.db.prepare(b).all(e,...d,t+1),r=this.db.prepare(C).all(e,...d,n+1);if(_.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};u=_.length>0?_[_.length-1].created_at_epoch:s,g=r.length>0?r[r.length-1].created_at_epoch:s}catch(_){return console.error("[SessionStore] Error getting boundary observations:",_.message),{observations:[],sessions:[],prompts:[]}}}else{let b=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${a}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,C=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${a}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let _=this.db.prepare(b).all(s,...d,t),r=this.db.prepare(C).all(s,...d,n+1);if(_.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};u=_.length>0?_[_.length-1].created_at_epoch:s,g=r.length>0?r[r.length-1].created_at_epoch:s}catch(_){return console.error("[SessionStore] Error getting boundary timestamps:",_.message),{observations:[],sessions:[],prompts:[]}}}let T=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,S=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${a}
      ORDER BY created_at_epoch ASC
    `,L=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${a.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let b=this.db.prepare(T).all(u,g,...d),C=this.db.prepare(S).all(u,g,...d),_=this.db.prepare(L).all(u,g,...d);return{observations:b,sessions:C.map(r=>({id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,request:r.request,completed:r.completed,next_steps:r.next_steps,created_at:r.created_at,created_at_epoch:r.created_at_epoch})),prompts:_.map(r=>({id:r.id,claude_session_id:r.claude_session_id,project:r.project,prompt:r.prompt_text,created_at:r.created_at,created_at_epoch:r.created_at_epoch}))}}catch(b){return console.error("[SessionStore] Error querying timeline records:",b.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var ee=["bugfix","feature","refactor","discovery","decision","change"],se=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],ue={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},le={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},_e=ee.join(","),me=se.join(",");var xe=De(import.meta.url),Me=$e(xe),we=X.join(Me,"../../.install-version");function Ue(){let p={totalObservationCount:parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(ee),observationConcepts:new Set(se),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1};try{let e=X.join(ge(),".claude-mem","settings.json");if(!Se(e))return p;let t=JSON.parse(be(e,"utf-8")).env||{};return{totalObservationCount:parseInt(t.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:parseInt(t.CLAUDE_MEM_CONTEXT_FULL_COUNT||"5",10),sessionCount:parseInt(t.CLAUDE_MEM_CONTEXT_SESSION_COUNT||"10",10),showReadTokens:t.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS!=="false",showWorkTokens:t.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS!=="false",showSavingsAmount:t.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT!=="false",showSavingsPercent:t.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT!=="false",observationTypes:new Set((t.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES||_e).split(",").map(n=>n.trim()).filter(Boolean)),observationConcepts:new Set((t.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS||me).split(",").map(n=>n.trim()).filter(Boolean)),fullObservationField:t.CLAUDE_MEM_CONTEXT_FULL_FIELD||"narrative",showLastSummary:t.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY!=="false",showLastMessage:t.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(e){return B.warn("HOOK","Failed to load context settings, using defaults",{},e),p}}var Ee=4,Fe=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Te(p){if(!p)return[];try{let e=JSON.parse(p);return Array.isArray(e)?e:[]}catch{return[]}}function Xe(p){return new Date(p).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Pe(p){return new Date(p).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Be(p){return new Date(p).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function je(p,e){return X.isAbsolute(p)?X.relative(e,p):p}function V(p,e,s,t){return e?t?[`${s}${p}:${o.reset} ${e}`,""]:[`**${p}**: ${e}`,""]:[]}function We(p){return p.replace(/\//g,"-")}function He(p){try{if(!Se(p))return{userMessage:"",assistantMessage:""};let e=be(p,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),t="";for(let n=s.length-1;n>=0;n--)try{let i=s[n];if(!i.includes('"type":"assistant"'))continue;let a=JSON.parse(i);if(a.type==="assistant"&&a.message?.content&&Array.isArray(a.message.content)){let d="";for(let u of a.message.content)u.type==="text"&&(d+=u.text);if(d=d.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),d){t=d;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return B.failure("HOOK","Failed to extract prior messages from transcript",{transcriptPath:p},e),{userMessage:"",assistantMessage:""}}}async function he(p,e=!1){let s=Ue(),t=p?.cwd??process.cwd(),n=t?X.basename(t):"unknown-project",i=null;try{i=new Y}catch(y){if(y.code==="ERR_DLOPEN_FAILED"){try{ke(we)}catch{}console.error("\u26A0\uFE0F  Native module rebuild needed - restart Claude Code to auto-fix"),console.error("   (This happens after Node.js version upgrades)"),process.exit(0)}throw y}let a=Array.from(s.observationTypes),d=a.map(()=>"?").join(","),u=Array.from(s.observationConcepts),g=u.map(()=>"?").join(","),T=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${d})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${g})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...a,...u,s.totalObservationCount),S=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+Fe),L="",b="";if(s.showLastMessage&&T.length>0)try{let y=p?.session_id,R=T.find(h=>h.sdk_session_id!==y);if(R){let h=R.sdk_session_id,k=We(t),M=X.join(ge(),".claude","projects",k,`${h}.jsonl`),P=He(M);L=P.userMessage,b=P.assistantMessage}}catch{}if(T.length===0&&S.length===0)return i?.close(),e?`
${o.bright}${o.cyan}\u{1F4DD} [${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let C=S.slice(0,s.sessionCount),_=T,r=[];if(e?(r.push(""),r.push(`${o.bright}${o.cyan}\u{1F4DD} [${n}] recent context${o.reset}`),r.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),r.push("")):(r.push(`# [${n}] recent context`),r.push("")),_.length>0){e?r.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):r.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),r.push(""),e?(r.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),r.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),r.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(r.push("\u{1F4A1} **Column Key**:"),r.push("- **Read**: Tokens to read this observation (cost to learn it now)"),r.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),r.push(""),e?(r.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),r.push(""),r.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),r.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),r.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),r.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(r.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),r.push(""),r.push("When you need implementation details, rationale, or debugging context:"),r.push("- Use the mem-search skill to fetch full observations on-demand"),r.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),r.push("- Trust this index over re-reading code for past decisions and learnings")),r.push("");let y=T.length,R=T.reduce((c,m)=>{let E=(m.title?.length||0)+(m.subtitle?.length||0)+(m.narrative?.length||0)+JSON.stringify(m.facts||[]).length;return c+Math.ceil(E/Ee)},0),h=T.reduce((c,m)=>c+(m.discovery_tokens||0),0),k=h-R,M=h>0?Math.round(k/h*100):0,P=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(P)if(e){if(r.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),r.push(`${o.dim}  Loading: ${y} observations (${R.toLocaleString()} tokens to read)${o.reset}`),r.push(`${o.dim}  Work investment: ${h.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),h>0&&(s.showSavingsAmount||s.showSavingsPercent)){let c="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?c+=`${k.toLocaleString()} tokens (${M}% reduction from reuse)`:s.showSavingsAmount?c+=`${k.toLocaleString()} tokens`:c+=`${M}% reduction from reuse`,r.push(`${o.green}${c}${o.reset}`)}r.push("")}else{if(r.push("\u{1F4CA} **Context Economics**:"),r.push(`- Loading: ${y} observations (${R.toLocaleString()} tokens to read)`),r.push(`- Work investment: ${h.toLocaleString()} tokens spent on research, building, and decisions`),h>0&&(s.showSavingsAmount||s.showSavingsPercent)){let c="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?c+=`${k.toLocaleString()} tokens (${M}% reduction from reuse)`:s.showSavingsAmount?c+=`${k.toLocaleString()} tokens`:c+=`${M}% reduction from reuse`,r.push(c)}r.push("")}let fe=S[0]?.id,Re=C.map((c,m)=>{let E=m===0?null:S[m+1];return{...c,displayEpoch:E?E.created_at_epoch:c.created_at_epoch,displayTime:E?E.created_at:c.created_at,shouldShowLink:c.id!==fe}}),Oe=new Set(T.slice(0,s.fullObservationCount).map(c=>c.id)),re=[..._.map(c=>({type:"observation",data:c})),...Re.map(c=>({type:"summary",data:c}))];re.sort((c,m)=>{let E=c.type==="observation"?c.data.created_at_epoch:c.data.displayEpoch,D=m.type==="observation"?m.data.created_at_epoch:m.data.displayEpoch;return E-D});let j=new Map;for(let c of re){let m=c.type==="observation"?c.data.created_at:c.data.displayTime,E=Be(m);j.has(E)||j.set(E,[]),j.get(E).push(c)}let Ne=Array.from(j.entries()).sort((c,m)=>{let E=new Date(c[0]).getTime(),D=new Date(m[0]).getTime();return E-D});for(let[c,m]of Ne){e?(r.push(`${o.bright}${o.cyan}${c}${o.reset}`),r.push("")):(r.push(`### ${c}`),r.push(""));let E=null,D="",x=!1;for(let K of m)if(K.type==="summary"){x&&(r.push(""),x=!1,E=null,D="");let l=K.data,w=`${l.request||"Session started"} (${Xe(l.displayTime)})`,v=l.shouldShowLink?`claude-mem://session-summary/${l.id}`:"";if(e){let O=v?`${o.dim}[${v}]${o.reset}`:"";r.push(`\u{1F3AF} ${o.yellow}#S${l.id}${o.reset} ${w} ${O}`)}else{let O=v?` [\u2192](${v})`:"";r.push(`**\u{1F3AF} #S${l.id}** ${w}${O}`)}r.push("")}else{let l=K.data,w=Te(l.files_modified),v=w.length>0&&w[0]?je(w[0],t):"General";v!==E&&(x&&r.push(""),e?r.push(`${o.dim}${v}${o.reset}`):r.push(`**${v}**`),e||(r.push("| ID | Time | T | Title | Read | Work |"),r.push("|----|------|---|-------|------|------|")),E=v,x=!0,D="");let O=Pe(l.created_at),W=l.title||"Untitled",H=ue[l.type]||"\u2022",Ie=(l.title?.length||0)+(l.subtitle?.length||0)+(l.narrative?.length||0)+JSON.stringify(l.facts||[]).length,U=Math.ceil(Ie/Ee),F=l.discovery_tokens||0,q=le[l.type]||"\u{1F50D}",oe=F>0?`${q} ${F.toLocaleString()}`:"-",J=O!==D,ie=J?O:"";if(D=O,Oe.has(l.id)){let $=s.fullObservationField==="narrative"?l.narrative:l.facts?Te(l.facts).join(`
`):null;if(e){let I=J?`${o.dim}${O}${o.reset}`:" ".repeat(O.length),G=s.showReadTokens&&U>0?`${o.dim}(~${U}t)${o.reset}`:"",ae=s.showWorkTokens&&F>0?`${o.dim}(${q} ${F.toLocaleString()}t)${o.reset}`:"";r.push(`  ${o.dim}#${l.id}${o.reset}  ${I}  ${H}  ${o.bright}${W}${o.reset}`),$&&r.push(`    ${o.dim}${$}${o.reset}`),(G||ae)&&r.push(`    ${G} ${ae}`),r.push("")}else{x&&(r.push(""),x=!1),r.push(`**#${l.id}** ${ie||"\u2033"} ${H} **${W}**`),$&&(r.push(""),r.push($),r.push(""));let I=[];s.showReadTokens&&I.push(`Read: ~${U}`),s.showWorkTokens&&I.push(`Work: ${oe}`),I.length>0&&r.push(I.join(", ")),r.push(""),E=null}}else if(e){let $=J?`${o.dim}${O}${o.reset}`:" ".repeat(O.length),I=s.showReadTokens&&U>0?`${o.dim}(~${U}t)${o.reset}`:"",G=s.showWorkTokens&&F>0?`${o.dim}(${q} ${F.toLocaleString()}t)${o.reset}`:"";r.push(`  ${o.dim}#${l.id}${o.reset}  ${$}  ${H}  ${W} ${I} ${G}`)}else{let $=s.showReadTokens?`~${U}`:"",I=s.showWorkTokens?oe:"";r.push(`| #${l.id} | ${ie||"\u2033"} | ${H} | ${W} | ${$} | ${I} |`)}}x&&r.push("")}let N=S[0],ne=T[0];if(s.showLastSummary&&N&&(N.investigated||N.learned||N.completed||N.next_steps)&&(!ne||N.created_at_epoch>ne.created_at_epoch)&&(r.push(...V("Investigated",N.investigated,o.blue,e)),r.push(...V("Learned",N.learned,o.yellow,e)),r.push(...V("Completed",N.completed,o.green,e)),r.push(...V("Next Steps",N.next_steps,o.magenta,e))),b&&(r.push(""),r.push("---"),r.push(""),e?(r.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),r.push(""),r.push(`${o.dim}A: ${b}${o.reset}`)):(r.push("**\u{1F4CB} Previously**"),r.push(""),r.push(`A: ${b}`)),r.push("")),P&&h>0&&k>0){let c=Math.round(h/1e3);r.push(""),e?r.push(`${o.dim}\u{1F4B0} Access ${c}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):r.push(`\u{1F4B0} Access ${c}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),r.join(`
`).trimEnd()}var Ge=process.argv.includes("--colors");if(te.isTTY||Ge)he(void 0,!0).then(p=>{console.log(p),process.exit(0)});else{let p="";te.on("data",e=>p+=e),te.on("end",async()=>{let e=p.trim()?JSON.parse(p):void 0,t={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:await he(e,!1)}};console.log(JSON.stringify(t)),process.exit(0)})}export{he as contextHook};
