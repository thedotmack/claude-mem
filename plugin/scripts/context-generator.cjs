"use strict";var Ce=Object.create;var V=Object.defineProperty;var ye=Object.getOwnPropertyDescriptor;var ke=Object.getOwnPropertyNames;var De=Object.getPrototypeOf,$e=Object.prototype.hasOwnProperty;var xe=(a,e)=>{for(var s in e)V(a,s,{get:e[s],enumerable:!0})},le=(a,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of ke(e))!$e.call(a,n)&&n!==s&&V(a,n,{get:()=>e[n],enumerable:!(t=ye(e,n))||t.enumerable});return a};var me=(a,e,s)=>(s=a!=null?Ce(De(a)):{},le(e||!a||!a.__esModule?V(s,"default",{value:a,enumerable:!0}):s,a)),Me=a=>le(V({},"__esModule",{value:!0}),a);var Ke={};xe(Ke,{generateContext:()=>Ve});module.exports=Me(Ke);var w=me(require("path"),1),J=require("os"),x=require("fs");var he=me(require("better-sqlite3"),1);var h=require("path"),ee=require("os"),se=require("fs");var _e=require("url"),Ue={};function we(){return typeof __dirname<"u"?__dirname:(0,h.dirname)((0,_e.fileURLToPath)(Ue.url))}var Ze=we(),L=process.env.CLAUDE_MEM_DATA_DIR||(0,h.join)((0,ee.homedir)(),".claude-mem"),te=process.env.CLAUDE_CONFIG_DIR||(0,h.join)((0,ee.homedir)(),".claude"),es=(0,h.join)(L,"archives"),ss=(0,h.join)(L,"logs"),ts=(0,h.join)(L,"trash"),rs=(0,h.join)(L,"backups"),ns=(0,h.join)(L,"settings.json"),Ee=(0,h.join)(L,"claude-mem.db"),os=(0,h.join)(L,"vector-db"),is=(0,h.join)(te,"settings.json"),as=(0,h.join)(te,"commands"),ds=(0,h.join)(te,"CLAUDE.md");function Te(a){(0,se.mkdirSync)(a,{recursive:!0})}var re=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(re||{}),ne=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=re[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let n=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${n})`}if(e==="Read"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Edit"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Write"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,s,t,n,i){if(e<this.level)return;let d=new Date().toISOString().replace("T"," ").substring(0,23),c=re[e].padEnd(5),u=s.padEnd(6),S="";n?.correlationId?S=`[${n.correlationId}] `:n?.sessionId&&(S=`[session-${n.sessionId}] `);let T="";i!=null&&(this.level===0&&typeof i=="object"?T=`
`+JSON.stringify(i,null,2):T=" "+this.formatData(i));let b="";if(n){let{sessionId:f,sdkSessionId:y,correlationId:m,...r}=n;Object.keys(r).length>0&&(b=` {${Object.entries(r).map(([R,g])=>`${R}=${g}`).join(", ")}}`)}let C=`[${d}] [${c}] [${u}] ${S}${t}${b}${T}`;e===3?console.error(C):console.log(C)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}error(e,s,t,n){this.log(3,e,s,t,n)}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}timing(e,s,t,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${t}ms`})}},W=new ne;var K=class{db;constructor(){Te(L),this.db=new he.default(Ee),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(d=>d.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(d=>d.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).all().map(t=>t.project)}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.sdk_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.claude_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${c})
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
    `).get(e)||null}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,i=new Set;for(let d of t){if(d.files_read)try{let c=JSON.parse(d.files_read);Array.isArray(c)&&c.forEach(u=>n.add(u))}catch{}if(d.files_modified)try{let c=JSON.parse(d.files_modified);Array.isArray(c)&&c.forEach(u=>i.add(u))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let n=new Date,i=n.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,n.toISOString(),i);return c.lastInsertRowid===0||c.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):c.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(W.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,i=0){let d=new Date,c=d.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,d.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),n||null,i,d.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,t,n,i=0){let d=new Date,c=d.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,d.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,i,d.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${i}
      ${d}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${c})
      ORDER BY up.created_at_epoch ${i}
      ${d}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,n){return this.getTimelineAroundObservation(null,e,s,t,n)}getTimelineAroundObservation(e,s,t=10,n=10,i){let d=i?"AND project = ?":"",c=i?[i]:[],u,S;if(e!==null){let f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${d}
        ORDER BY id DESC
        LIMIT ?
      `,y=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${d}
        ORDER BY id ASC
        LIMIT ?
      `;try{let m=this.db.prepare(f).all(e,...c,t+1),r=this.db.prepare(y).all(e,...c,n+1);if(m.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};u=m.length>0?m[m.length-1].created_at_epoch:s,S=r.length>0?r[r.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary observations:",m.message),{observations:[],sessions:[],prompts:[]}}}else{let f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${d}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,y=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${d}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let m=this.db.prepare(f).all(s,...c,t),r=this.db.prepare(y).all(s,...c,n+1);if(m.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};u=m.length>0?m[m.length-1].created_at_epoch:s,S=r.length>0?r[r.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary timestamps:",m.message),{observations:[],sessions:[],prompts:[]}}}let T=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,C=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${d.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let f=this.db.prepare(T).all(u,S,...c),y=this.db.prepare(b).all(u,S,...c),m=this.db.prepare(C).all(u,S,...c);return{observations:f,sessions:y.map(r=>({id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,request:r.request,completed:r.completed,next_steps:r.next_steps,created_at:r.created_at,created_at_epoch:r.created_at_epoch})),prompts:m.map(r=>({id:r.id,claude_session_id:r.claude_session_id,project:r.project,prompt:r.prompt_text,created_at:r.created_at,created_at_epoch:r.created_at_epoch}))}}catch(f){return console.error("[SessionStore] Error querying timeline records:",f.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var oe=["bugfix","feature","refactor","discovery","decision","change"],ie=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],ge={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},Se={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},be=oe.join(","),fe=ie.join(",");var Fe=w.default.join((0,J.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Pe(){let a={totalObservationCount:parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(oe),observationConcepts:new Set(ie),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1};try{let e=w.default.join((0,J.homedir)(),".claude-mem","settings.json");if(!(0,x.existsSync)(e))return a;let t=JSON.parse((0,x.readFileSync)(e,"utf-8")).env||{};return{totalObservationCount:parseInt(t.CLAUDE_MEM_CONTEXT_OBSERVATIONS||"50",10),fullObservationCount:parseInt(t.CLAUDE_MEM_CONTEXT_FULL_COUNT||"5",10),sessionCount:parseInt(t.CLAUDE_MEM_CONTEXT_SESSION_COUNT||"10",10),showReadTokens:t.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS!=="false",showWorkTokens:t.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS!=="false",showSavingsAmount:t.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT!=="false",showSavingsPercent:t.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT!=="false",observationTypes:new Set((t.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES||be).split(",").map(n=>n.trim()).filter(Boolean)),observationConcepts:new Set((t.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS||fe).split(",").map(n=>n.trim()).filter(Boolean)),fullObservationField:t.CLAUDE_MEM_CONTEXT_FULL_FIELD||"narrative",showLastSummary:t.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY!=="false",showLastMessage:t.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(e){return W.warn("WORKER","Failed to load context settings, using defaults",{},e),a}}var Re=4,Xe=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Oe(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function Be(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function We(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function je(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function He(a,e){return w.default.isAbsolute(a)?w.default.relative(e,a):a}function q(a,e,s,t){return e?t?[`${s}${a}:${o.reset} ${e}`,""]:[`**${a}**: ${e}`,""]:[]}function Ge(a){return a.replace(/\//g,"-")}function Ye(a){try{if(!(0,x.existsSync)(a))return{userMessage:"",assistantMessage:""};let e=(0,x.readFileSync)(a,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),t="";for(let n=s.length-1;n>=0;n--)try{let i=s[n];if(!i.includes('"type":"assistant"'))continue;let d=JSON.parse(i);if(d.type==="assistant"&&d.message?.content&&Array.isArray(d.message.content)){let c="";for(let u of d.message.content)u.type==="text"&&(c+=u.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){t=c;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return W.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:a},e),{userMessage:"",assistantMessage:""}}}async function Ve(a,e=!1){let s=Pe(),t=a?.cwd??process.cwd(),n=t?w.default.basename(t):"unknown-project",i=null;try{i=new K}catch(v){if(v.code==="ERR_DLOPEN_FAILED"){try{(0,x.unlinkSync)(Fe)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw v}let d=Array.from(s.observationTypes),c=d.map(()=>"?").join(","),u=Array.from(s.observationConcepts),S=u.map(()=>"?").join(","),T=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${c})
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
  `).all(n,s.sessionCount+Xe),C="",f="";if(s.showLastMessage&&T.length>0)try{let v=a?.session_id,R=T.find(g=>g.sdk_session_id!==v);if(R){let g=R.sdk_session_id,k=Ge(t),U=w.default.join((0,J.homedir)(),".claude","projects",k,`${g}.jsonl`),B=Ye(U);C=B.userMessage,f=B.assistantMessage}}catch{}if(T.length===0&&b.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let y=b.slice(0,s.sessionCount),m=T,r=[];if(e?(r.push(""),r.push(`${o.bright}${o.cyan}[${n}] recent context${o.reset}`),r.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),r.push("")):(r.push(`# [${n}] recent context`),r.push("")),m.length>0){e?r.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):r.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),r.push(""),e?(r.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),r.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),r.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(r.push("\u{1F4A1} **Column Key**:"),r.push("- **Read**: Tokens to read this observation (cost to learn it now)"),r.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),r.push(""),e?(r.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),r.push(""),r.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),r.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),r.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),r.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(r.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),r.push(""),r.push("When you need implementation details, rationale, or debugging context:"),r.push("- Use the mem-search skill to fetch full observations on-demand"),r.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),r.push("- Trust this index over re-reading code for past decisions and learnings")),r.push("");let v=T.length,R=T.reduce((p,_)=>{let E=(_.title?.length||0)+(_.subtitle?.length||0)+(_.narrative?.length||0)+JSON.stringify(_.facts||[]).length;return p+Math.ceil(E/Re)},0),g=T.reduce((p,_)=>p+(_.discovery_tokens||0),0),k=g-R,U=g>0?Math.round(k/g*100):0,B=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(B)if(e){if(r.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),r.push(`${o.dim}  Loading: ${v} observations (${R.toLocaleString()} tokens to read)${o.reset}`),r.push(`${o.dim}  Work investment: ${g.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),g>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${k.toLocaleString()} tokens (${U}% reduction from reuse)`:s.showSavingsAmount?p+=`${k.toLocaleString()} tokens`:p+=`${U}% reduction from reuse`,r.push(`${o.green}${p}${o.reset}`)}r.push("")}else{if(r.push("\u{1F4CA} **Context Economics**:"),r.push(`- Loading: ${v} observations (${R.toLocaleString()} tokens to read)`),r.push(`- Work investment: ${g.toLocaleString()} tokens spent on research, building, and decisions`),g>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${k.toLocaleString()} tokens (${U}% reduction from reuse)`:s.showSavingsAmount?p+=`${k.toLocaleString()} tokens`:p+=`${U}% reduction from reuse`,r.push(p)}r.push("")}let Ne=b[0]?.id,Ie=y.map((p,_)=>{let E=_===0?null:b[_+1];return{...p,displayEpoch:E?E.created_at_epoch:p.created_at_epoch,displayTime:E?E.created_at:p.created_at,shouldShowLink:p.id!==Ne}}),ve=new Set(T.slice(0,s.fullObservationCount).map(p=>p.id)),ae=[...m.map(p=>({type:"observation",data:p})),...Ie.map(p=>({type:"summary",data:p}))];ae.sort((p,_)=>{let E=p.type==="observation"?p.data.created_at_epoch:p.data.displayEpoch,D=_.type==="observation"?_.data.created_at_epoch:_.data.displayEpoch;return E-D});let j=new Map;for(let p of ae){let _=p.type==="observation"?p.data.created_at:p.data.displayTime,E=je(_);j.has(E)||j.set(E,[]),j.get(E).push(p)}let Ae=Array.from(j.entries()).sort((p,_)=>{let E=new Date(p[0]).getTime(),D=new Date(_[0]).getTime();return E-D});for(let[p,_]of Ae){e?(r.push(`${o.bright}${o.cyan}${p}${o.reset}`),r.push("")):(r.push(`### ${p}`),r.push(""));let E=null,D="",M=!1;for(let Q of _)if(Q.type==="summary"){M&&(r.push(""),M=!1,E=null,D="");let l=Q.data,F=`${l.request||"Session started"} (${Be(l.displayTime)})`,A=l.shouldShowLink?`claude-mem://session-summary/${l.id}`:"";if(e){let O=A?`${o.dim}[${A}]${o.reset}`:"";r.push(`\u{1F3AF} ${o.yellow}#S${l.id}${o.reset} ${F} ${O}`)}else{let O=A?` [\u2192](${A})`:"";r.push(`**\u{1F3AF} #S${l.id}** ${F}${O}`)}r.push("")}else{let l=Q.data,F=Oe(l.files_modified),A=F.length>0&&F[0]?He(F[0],t):"General";A!==E&&(M&&r.push(""),e?r.push(`${o.dim}${A}${o.reset}`):r.push(`**${A}**`),e||(r.push("| ID | Time | T | Title | Read | Work |"),r.push("|----|------|---|-------|------|------|")),E=A,M=!0,D="");let O=We(l.created_at),H=l.title||"Untitled",G=ge[l.type]||"\u2022",Le=(l.title?.length||0)+(l.subtitle?.length||0)+(l.narrative?.length||0)+JSON.stringify(l.facts||[]).length,P=Math.ceil(Le/Re),X=l.discovery_tokens||0,z=Se[l.type]||"\u{1F50D}",ce=X>0?`${z} ${X.toLocaleString()}`:"-",Z=O!==D,pe=Z?O:"";if(D=O,ve.has(l.id)){let $=s.fullObservationField==="narrative"?l.narrative:l.facts?Oe(l.facts).join(`
`):null;if(e){let I=Z?`${o.dim}${O}${o.reset}`:" ".repeat(O.length),Y=s.showReadTokens&&P>0?`${o.dim}(~${P}t)${o.reset}`:"",ue=s.showWorkTokens&&X>0?`${o.dim}(${z} ${X.toLocaleString()}t)${o.reset}`:"";r.push(`  ${o.dim}#${l.id}${o.reset}  ${I}  ${G}  ${o.bright}${H}${o.reset}`),$&&r.push(`    ${o.dim}${$}${o.reset}`),(Y||ue)&&r.push(`    ${Y} ${ue}`),r.push("")}else{M&&(r.push(""),M=!1),r.push(`**#${l.id}** ${pe||"\u2033"} ${G} **${H}**`),$&&(r.push(""),r.push($),r.push(""));let I=[];s.showReadTokens&&I.push(`Read: ~${P}`),s.showWorkTokens&&I.push(`Work: ${ce}`),I.length>0&&r.push(I.join(", ")),r.push(""),E=null}}else if(e){let $=Z?`${o.dim}${O}${o.reset}`:" ".repeat(O.length),I=s.showReadTokens&&P>0?`${o.dim}(~${P}t)${o.reset}`:"",Y=s.showWorkTokens&&X>0?`${o.dim}(${z} ${X.toLocaleString()}t)${o.reset}`:"";r.push(`  ${o.dim}#${l.id}${o.reset}  ${$}  ${G}  ${H} ${I} ${Y}`)}else{let $=s.showReadTokens?`~${P}`:"",I=s.showWorkTokens?ce:"";r.push(`| #${l.id} | ${pe||"\u2033"} | ${G} | ${H} | ${$} | ${I} |`)}}M&&r.push("")}let N=b[0],de=T[0];if(s.showLastSummary&&N&&(N.investigated||N.learned||N.completed||N.next_steps)&&(!de||N.created_at_epoch>de.created_at_epoch)&&(r.push(...q("Investigated",N.investigated,o.blue,e)),r.push(...q("Learned",N.learned,o.yellow,e)),r.push(...q("Completed",N.completed,o.green,e)),r.push(...q("Next Steps",N.next_steps,o.magenta,e))),f&&(r.push(""),r.push("---"),r.push(""),e?(r.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),r.push(""),r.push(`${o.dim}A: ${f}${o.reset}`)):(r.push("**\u{1F4CB} Previously**"),r.push(""),r.push(`A: ${f}`)),r.push("")),B&&g>0&&k>0){let p=Math.round(g/1e3);r.push(""),e?r.push(`${o.dim}\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):r.push(`\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${R.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),r.join(`
`).trimEnd()}0&&(module.exports={generateContext});
