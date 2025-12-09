"use strict";var Fe=Object.create;var V=Object.defineProperty;var Xe=Object.getOwnPropertyDescriptor;var Pe=Object.getOwnPropertyNames;var We=Object.getPrototypeOf,Be=Object.prototype.hasOwnProperty;var He=(a,e)=>{for(var s in e)V(a,s,{get:e[s],enumerable:!0})},Te=(a,e,s,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of Pe(e))!Be.call(a,n)&&n!==s&&V(a,n,{get:()=>e[n],enumerable:!(r=Xe(e,n))||r.enumerable});return a};var ge=(a,e,s)=>(s=a!=null?Fe(We(a)):{},Te(e||!a||!a.__esModule?V(s,"default",{value:a,enumerable:!0}):s,a)),je=a=>Te(V({},"__esModule",{value:!0}),a);var rs={};He(rs,{generateContext:()=>ts});module.exports=je(rs);var x=ge(require("path"),1),ee=require("os"),P=require("fs");var Ne=ge(require("better-sqlite3"),1);var g=require("path"),ne=require("os"),oe=require("fs");var fe=require("url");var he=require("path"),be=require("os"),K=require("fs"),Se=(0,he.join)((0,be.homedir)(),".claude-mem","settings.json");function q(a,e){try{if((0,K.existsSync)(Se)){let r=JSON.parse((0,K.readFileSync)(Se,"utf-8")).env?.[a];if(r!==void 0)return r}}catch{}return process.env[a]||e}var Ye={};function Ge(){return typeof __dirname<"u"?__dirname:(0,g.dirname)((0,fe.fileURLToPath)(Ye.url))}var ps=Ge(),C=q("CLAUDE_MEM_DATA_DIR",(0,g.join)((0,ne.homedir)(),".claude-mem")),ie=process.env.CLAUDE_CONFIG_DIR||(0,g.join)((0,ne.homedir)(),".claude"),_s=(0,g.join)(C,"archives"),us=(0,g.join)(C,"logs"),ls=(0,g.join)(C,"trash"),Es=(0,g.join)(C,"backups"),ms=(0,g.join)(C,"settings.json"),Oe=(0,g.join)(C,"claude-mem.db"),Ts=(0,g.join)(C,"vector-db"),gs=(0,g.join)(ie,"settings.json"),Ss=(0,g.join)(ie,"commands"),hs=(0,g.join)(ie,"CLAUDE.md");function Re(a){(0,oe.mkdirSync)(a,{recursive:!0})}var ae=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(ae||{}),de=class{level;useColor;constructor(){let e=q("CLAUDE_MEM_LOG_LEVEL","INFO").toUpperCase();this.level=ae[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let r=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&r.command){let n=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${e}(${n})`}if(e==="Read"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Edit"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}if(e==="Write"&&r.file_path){let n=r.file_path.split("/").pop()||r.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,s,r,n,i){if(e<this.level)return;let d=new Date().toISOString().replace("T"," ").substring(0,23),c=ae[e].padEnd(5),_=s.padEnd(6),h="";n?.correlationId?h=`[${n.correlationId}] `:n?.sessionId&&(h=`[session-${n.sessionId}] `);let T="";i!=null&&(this.level===0&&typeof i=="object"?T=`
`+JSON.stringify(i,null,2):T=" "+this.formatData(i));let b="";if(n){let{sessionId:f,sdkSessionId:D,correlationId:l,...t}=n;Object.keys(t).length>0&&(b=` {${Object.entries(t).map(([O,S])=>`${O}=${S}`).join(", ")}}`)}let v=`[${d}] [${c}] [${_}] ${h}${r}${b}${T}`;e===3?console.error(v):console.log(v)}debug(e,s,r,n){this.log(0,e,s,r,n)}info(e,s,r,n){this.log(1,e,s,r,n)}warn(e,s,r,n){this.log(2,e,s,r,n)}error(e,s,r,n){this.log(3,e,s,r,n)}dataIn(e,s,r,n){this.info(e,`\u2192 ${s}`,r,n)}dataOut(e,s,r,n){this.info(e,`\u2190 ${s}`,r,n)}success(e,s,r,n){this.info(e,`\u2713 ${s}`,r,n)}failure(e,s,r,n){this.error(e,`\u2717 ${s}`,r,n)}timing(e,s,r,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${r}ms`})}},B=new de;var J=class{db;constructor(){Re(C),this.db=new Ne.default(Oe),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(n=>n.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(_=>_.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(_=>_.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(_=>_.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).all().map(r=>r.project)}getLatestUserPrompt(e){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n}=s,i=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).get(e)||null}getFilesForSession(e){let r=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,i=new Set;for(let d of r){if(d.files_read)try{let c=JSON.parse(d.files_read);Array.isArray(c)&&c.forEach(_=>n.add(_))}catch{}if(d.files_modified)try{let c=JSON.parse(d.files_modified);Array.isArray(c)&&c.forEach(_=>i.add(_))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,r){let n=new Date,i=n.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,r,n.toISOString(),i);return c.lastInsertRowid===0||c.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,r,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):c.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
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
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,r){let n=new Date,i=n.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,r,n.toISOString(),i).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,r,n,i=0){let d=new Date,c=d.getTime();this.db.prepare(`
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
    `).run(e,s,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),n||null,i,d.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}storeSummary(e,s,r,n,i=0){let d=new Date,c=d.getTime();this.db.prepare(`
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
    `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,i,d.toISOString(),c);return{id:Number(b.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}markSessionFailed(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n}=s,i=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${i}
      ${d}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:n}=s,i=r==="date_asc"?"ASC":"DESC",d=n?`LIMIT ${n}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${c})
      ORDER BY up.created_at_epoch ${i}
      ${d}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,r=10,n){return this.getTimelineAroundObservation(null,e,s,r,n)}getTimelineAroundObservation(e,s,r=10,n=10,i){let d=i?"AND project = ?":"",c=i?[i]:[],_,h;if(e!==null){let f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${d}
        ORDER BY id DESC
        LIMIT ?
      `,D=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${d}
        ORDER BY id ASC
        LIMIT ?
      `;try{let l=this.db.prepare(f).all(e,...c,r+1),t=this.db.prepare(D).all(e,...c,n+1);if(l.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};_=l.length>0?l[l.length-1].created_at_epoch:s,h=t.length>0?t[t.length-1].created_at_epoch:s}catch(l){return console.error("[SessionStore] Error getting boundary observations:",l.message),{observations:[],sessions:[],prompts:[]}}}else{let f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${d}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,D=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${d}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let l=this.db.prepare(f).all(s,...c,r),t=this.db.prepare(D).all(s,...c,n+1);if(l.length===0&&t.length===0)return{observations:[],sessions:[],prompts:[]};_=l.length>0?l[l.length-1].created_at_epoch:s,h=t.length>0?t[t.length-1].created_at_epoch:s}catch(l){return console.error("[SessionStore] Error getting boundary timestamps:",l.message),{observations:[],sessions:[],prompts:[]}}}let T=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${d}
      ORDER BY created_at_epoch ASC
    `,v=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${d.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let f=this.db.prepare(T).all(_,h,...c),D=this.db.prepare(b).all(_,h,...c),l=this.db.prepare(v).all(_,h,...c);return{observations:f,sessions:D.map(t=>({id:t.id,sdk_session_id:t.sdk_session_id,project:t.project,request:t.request,completed:t.completed,next_steps:t.next_steps,created_at:t.created_at,created_at_epoch:t.created_at_epoch})),prompts:l.map(t=>({id:t.id,claude_session_id:t.claude_session_id,project:t.project,prompt:t.prompt_text,created_at:t.created_at,created_at_epoch:t.created_at_epoch}))}}catch(f){return console.error("[SessionStore] Error querying timeline records:",f.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var ce=["bugfix","feature","refactor","discovery","decision","change"],pe=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],Ae={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},Ie={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},Le=ce.join(","),Ce=pe.join(",");var z=require("fs"),ve=require("path"),De=require("os");var Q=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_DATA_DIR:(0,ve.join)((0,De.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:Le,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:Ce,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]||this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){if(!(0,z.existsSync)(e))return this.getAllDefaults();let s=(0,z.readFileSync)(e,"utf-8"),n=JSON.parse(s).env||{},i={...this.DEFAULTS};for(let d of Object.keys(this.DEFAULTS))n[d]!==void 0&&(i[d]=n[d]);return i}};var Ve=x.default.join((0,ee.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ke(){let a=x.default.join((0,ee.homedir)(),".claude-mem","settings.json"),e=Q.loadFromFile(a);try{return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(s=>s.trim()).filter(Boolean)),observationConcepts:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(s=>s.trim()).filter(Boolean)),fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(s){return B.warn("WORKER","Failed to load context settings, using defaults",{},s),{totalObservationCount:50,fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(ce),observationConcepts:new Set(pe),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1}}}var ye=4,qe=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function Me(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function Je(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function Qe(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function ze(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function Ze(a,e){return x.default.isAbsolute(a)?x.default.relative(e,a):a}function Z(a,e,s,r){return e?r?[`${s}${a}:${o.reset} ${e}`,""]:[`**${a}**: ${e}`,""]:[]}function es(a){return a.replace(/\//g,"-")}function ss(a){try{if(!(0,P.existsSync)(a))return{userMessage:"",assistantMessage:""};let e=(0,P.readFileSync)(a,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),r="";for(let n=s.length-1;n>=0;n--)try{let i=s[n];if(!i.includes('"type":"assistant"'))continue;let d=JSON.parse(i);if(d.type==="assistant"&&d.message?.content&&Array.isArray(d.message.content)){let c="";for(let _ of d.message.content)_.type==="text"&&(c+=_.text);if(c=c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),c){r=c;break}}}catch{continue}return{userMessage:"",assistantMessage:r}}catch(e){return B.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:a},e),{userMessage:"",assistantMessage:""}}}async function ts(a,e=!1){let s=Ke(),r=a?.cwd??process.cwd(),n=r?x.default.basename(r):"unknown-project",i=null;try{i=new J}catch(I){if(I.code==="ERR_DLOPEN_FAILED"){try{(0,P.unlinkSync)(Ve)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw I}let d=Array.from(s.observationTypes),c=d.map(()=>"?").join(","),_=Array.from(s.observationConcepts),h=_.map(()=>"?").join(","),T=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${c})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${h})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...d,..._,s.totalObservationCount),b=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+qe),v="",f="";if(s.showLastMessage&&T.length>0)try{let I=a?.session_id,O=T.find(S=>S.sdk_session_id!==I);if(O){let S=O.sdk_session_id,y=es(r),$=x.default.join((0,ee.homedir)(),".claude","projects",y,`${S}.jsonl`),W=ss($);v=W.userMessage,f=W.assistantMessage}}catch{}if(T.length===0&&b.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let D=b.slice(0,s.sessionCount),l=T,t=[];if(e?(t.push(""),t.push(`${o.bright}${o.cyan}[${n}] recent context${o.reset}`),t.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),t.push("")):(t.push(`# [${n}] recent context`),t.push("")),l.length>0){e?t.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):t.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),t.push(""),e?(t.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),t.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),t.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(t.push("\u{1F4A1} **Column Key**:"),t.push("- **Read**: Tokens to read this observation (cost to learn it now)"),t.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),t.push(""),e?(t.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),t.push(""),t.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),t.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),t.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),t.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(t.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),t.push(""),t.push("When you need implementation details, rationale, or debugging context:"),t.push("- Use the mem-search skill to fetch full observations on-demand"),t.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),t.push("- Trust this index over re-reading code for past decisions and learnings")),t.push("");let I=T.length,O=T.reduce((p,E)=>{let m=(E.title?.length||0)+(E.subtitle?.length||0)+(E.narrative?.length||0)+JSON.stringify(E.facts||[]).length;return p+Math.ceil(m/ye)},0),S=T.reduce((p,E)=>p+(E.discovery_tokens||0),0),y=S-O,$=S>0?Math.round(y/S*100):0,W=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(W)if(e){if(t.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),t.push(`${o.dim}  Loading: ${I} observations (${O.toLocaleString()} tokens to read)${o.reset}`),t.push(`${o.dim}  Work investment: ${S.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),S>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${y.toLocaleString()} tokens (${$}% reduction from reuse)`:s.showSavingsAmount?p+=`${y.toLocaleString()} tokens`:p+=`${$}% reduction from reuse`,t.push(`${o.green}${p}${o.reset}`)}t.push("")}else{if(t.push("\u{1F4CA} **Context Economics**:"),t.push(`- Loading: ${I} observations (${O.toLocaleString()} tokens to read)`),t.push(`- Work investment: ${S.toLocaleString()} tokens spent on research, building, and decisions`),S>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${y.toLocaleString()} tokens (${$}% reduction from reuse)`:s.showSavingsAmount?p+=`${y.toLocaleString()} tokens`:p+=`${$}% reduction from reuse`,t.push(p)}t.push("")}let ke=b[0]?.id,Ue=D.map((p,E)=>{let m=E===0?null:b[E+1];return{...p,displayEpoch:m?m.created_at_epoch:p.created_at_epoch,displayTime:m?m.created_at:p.created_at,shouldShowLink:p.id!==ke}}),xe=new Set(T.slice(0,s.fullObservationCount).map(p=>p.id)),_e=[...l.map(p=>({type:"observation",data:p})),...Ue.map(p=>({type:"summary",data:p}))];_e.sort((p,E)=>{let m=p.type==="observation"?p.data.created_at_epoch:p.data.displayEpoch,M=E.type==="observation"?E.data.created_at_epoch:E.data.displayEpoch;return m-M});let H=new Map;for(let p of _e){let E=p.type==="observation"?p.data.created_at:p.data.displayTime,m=ze(E);H.has(m)||H.set(m,[]),H.get(m).push(p)}let $e=Array.from(H.entries()).sort((p,E)=>{let m=new Date(p[0]).getTime(),M=new Date(E[0]).getTime();return m-M});for(let[p,E]of $e){e?(t.push(`${o.bright}${o.cyan}${p}${o.reset}`),t.push("")):(t.push(`### ${p}`),t.push(""));let m=null,M="",U=!1;for(let se of E)if(se.type==="summary"){U&&(t.push(""),U=!1,m=null,M="");let u=se.data,w=`${u.request||"Session started"} (${Je(u.displayTime)})`,L=u.shouldShowLink?`claude-mem://session-summary/${u.id}`:"";if(e){let R=L?`${o.dim}[${L}]${o.reset}`:"";t.push(`\u{1F3AF} ${o.yellow}#S${u.id}${o.reset} ${w} ${R}`)}else{let R=L?` [\u2192](${L})`:"";t.push(`**\u{1F3AF} #S${u.id}** ${w}${R}`)}t.push("")}else{let u=se.data,w=Me(u.files_modified),L=w.length>0&&w[0]?Ze(w[0],r):"General";L!==m&&(U&&t.push(""),e?t.push(`${o.dim}${L}${o.reset}`):t.push(`**${L}**`),e||(t.push("| ID | Time | T | Title | Read | Work |"),t.push("|----|------|---|-------|------|------|")),m=L,U=!0,M="");let R=Qe(u.created_at),j=u.title||"Untitled",G=Ae[u.type]||"\u2022",we=(u.title?.length||0)+(u.subtitle?.length||0)+(u.narrative?.length||0)+JSON.stringify(u.facts||[]).length,F=Math.ceil(we/ye),X=u.discovery_tokens||0,te=Ie[u.type]||"\u{1F50D}",le=X>0?`${te} ${X.toLocaleString()}`:"-",re=R!==M,Ee=re?R:"";if(M=R,xe.has(u.id)){let k=s.fullObservationField==="narrative"?u.narrative:u.facts?Me(u.facts).join(`
`):null;if(e){let A=re?`${o.dim}${R}${o.reset}`:" ".repeat(R.length),Y=s.showReadTokens&&F>0?`${o.dim}(~${F}t)${o.reset}`:"",me=s.showWorkTokens&&X>0?`${o.dim}(${te} ${X.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${u.id}${o.reset}  ${A}  ${G}  ${o.bright}${j}${o.reset}`),k&&t.push(`    ${o.dim}${k}${o.reset}`),(Y||me)&&t.push(`    ${Y} ${me}`),t.push("")}else{U&&(t.push(""),U=!1),t.push(`**#${u.id}** ${Ee||"\u2033"} ${G} **${j}**`),k&&(t.push(""),t.push(k),t.push(""));let A=[];s.showReadTokens&&A.push(`Read: ~${F}`),s.showWorkTokens&&A.push(`Work: ${le}`),A.length>0&&t.push(A.join(", ")),t.push(""),m=null}}else if(e){let k=re?`${o.dim}${R}${o.reset}`:" ".repeat(R.length),A=s.showReadTokens&&F>0?`${o.dim}(~${F}t)${o.reset}`:"",Y=s.showWorkTokens&&X>0?`${o.dim}(${te} ${X.toLocaleString()}t)${o.reset}`:"";t.push(`  ${o.dim}#${u.id}${o.reset}  ${k}  ${G}  ${j} ${A} ${Y}`)}else{let k=s.showReadTokens?`~${F}`:"",A=s.showWorkTokens?le:"";t.push(`| #${u.id} | ${Ee||"\u2033"} | ${G} | ${j} | ${k} | ${A} |`)}}U&&t.push("")}let N=b[0],ue=T[0];if(s.showLastSummary&&N&&(N.investigated||N.learned||N.completed||N.next_steps)&&(!ue||N.created_at_epoch>ue.created_at_epoch)&&(t.push(...Z("Investigated",N.investigated,o.blue,e)),t.push(...Z("Learned",N.learned,o.yellow,e)),t.push(...Z("Completed",N.completed,o.green,e)),t.push(...Z("Next Steps",N.next_steps,o.magenta,e))),f&&(t.push(""),t.push("---"),t.push(""),e?(t.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),t.push(""),t.push(`${o.dim}A: ${f}${o.reset}`)):(t.push("**\u{1F4CB} Previously**"),t.push(""),t.push(`A: ${f}`)),t.push("")),W&&S>0&&y>0){let p=Math.round(S/1e3);t.push(""),e?t.push(`${o.dim}\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${O.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):t.push(`\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${O.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),t.join(`
`).trimEnd()}0&&(module.exports={generateContext});
