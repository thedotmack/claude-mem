"use strict";var Be=Object.create;var V=Object.defineProperty;var He=Object.getOwnPropertyDescriptor;var je=Object.getOwnPropertyNames;var Ge=Object.getPrototypeOf,Ye=Object.prototype.hasOwnProperty;var Ve=(a,e)=>{for(var s in e)V(a,s,{get:e[s],enumerable:!0})},Te=(a,e,s,t)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of je(e))!Ye.call(a,n)&&n!==s&&V(a,n,{get:()=>e[n],enumerable:!(t=He(e,n))||t.enumerable});return a};var ge=(a,e,s)=>(s=a!=null?Be(Ge(a)):{},Te(e||!a||!a.__esModule?V(s,"default",{value:a,enumerable:!0}):s,a)),Ke=a=>Te(V({},"__esModule",{value:!0}),a);var cs={};Ve(cs,{generateContext:()=>as});module.exports=Ke(cs);var U=ge(require("path"),1),ee=require("os"),P=require("fs");var Ce=ge(require("better-sqlite3"),1);var S=require("path"),oe=require("os"),Ne=require("fs");var Ae=require("url");var Oe=require("path"),Re=require("os"),K=require("fs");var Se=require("fs"),he=require("os"),be=require("path"),qe=(0,be.join)((0,he.homedir)(),".claude-mem","silent.log");function fe(a,e,s=""){let t=new Date().toISOString(),d=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),_=d?`${d[1].split("/").pop()}:${d[2]}`:"unknown",m=`[${t}] [${_}] ${a}`;if(e!==void 0)try{m+=` ${JSON.stringify(e)}`}catch(l){m+=` [stringify error: ${l}]`}m+=`
`;try{(0,Se.appendFileSync)(qe,m)}catch(l){console.error("[silent-debug] Failed to write to log:",l)}return s}var ne=(0,Oe.join)((0,Re.homedir)(),".claude-mem","settings.json");function q(a,e){try{if((0,K.existsSync)(ne)){let t=JSON.parse((0,K.readFileSync)(ne,"utf-8")).env?.[a];if(t!==void 0)return t}}catch(s){fe("Failed to load settings file",{error:s,settingsPath:ne,key:a})}return process.env[a]||e}var Qe={};function Je(){return typeof __dirname<"u"?__dirname:(0,S.dirname)((0,Ae.fileURLToPath)(Qe.url))}var Ss=Je(),C=q("CLAUDE_MEM_DATA_DIR",(0,S.join)((0,oe.homedir)(),".claude-mem")),ie=process.env.CLAUDE_CONFIG_DIR||(0,S.join)((0,oe.homedir)(),".claude"),hs=(0,S.join)(C,"archives"),bs=(0,S.join)(C,"logs"),fs=(0,S.join)(C,"trash"),Os=(0,S.join)(C,"backups"),Rs=(0,S.join)(C,"settings.json"),Ie=(0,S.join)(C,"claude-mem.db"),Ns=(0,S.join)(C,"vector-db"),As=(0,S.join)(ie,"settings.json"),Is=(0,S.join)(ie,"commands"),Ls=(0,S.join)(ie,"CLAUDE.md");function Le(a){(0,Ne.mkdirSync)(a,{recursive:!0})}var ae=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(ae||{}),ce=class{level;useColor;constructor(){let e=q("CLAUDE_MEM_LOG_LEVEL","INFO").toUpperCase();this.level=ae[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let n=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${n})`}if(e==="Read"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Edit"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Write"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,s,t,n,i){if(e<this.level)return;let c=new Date().toISOString().replace("T"," ").substring(0,23),d=ae[e].padEnd(5),_=s.padEnd(6),m="";n?.correlationId?m=`[${n.correlationId}] `:n?.sessionId&&(m=`[session-${n.sessionId}] `);let l="";i!=null&&(this.level===0&&typeof i=="object"?l=`
`+JSON.stringify(i,null,2):l=" "+this.formatData(i));let b="";if(n){let{sessionId:f,sdkSessionId:y,correlationId:E,...r}=n;Object.keys(r).length>0&&(b=` {${Object.entries(r).map(([O,h])=>`${O}=${h}`).join(", ")}}`)}let v=`[${c}] [${d}] [${_}] ${m}${t}${b}${l}`;e===3?console.error(v):console.log(v)}debug(e,s,t,n){this.log(0,e,s,t,n)}info(e,s,t,n){this.log(1,e,s,t,n)}warn(e,s,t,n){this.log(2,e,s,t,n)}error(e,s,t,n){this.log(3,e,s,t,n)}dataIn(e,s,t,n){this.info(e,`\u2192 ${s}`,t,n)}dataOut(e,s,t,n){this.info(e,`\u2190 ${s}`,t,n)}success(e,s,t,n){this.info(e,`\u2713 ${s}`,t,n)}failure(e,s,t,n){this.error(e,`\u2717 ${s}`,t,n)}timing(e,s,t,n){this.info(e,`\u23F1 ${s}`,n,{duration:`${t}ms`})}},B=new ce;var J=class{db;constructor(){Le(C),this.db=new Ce.default(Ie),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(c=>c.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(c=>c.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${d})
      ORDER BY created_at_epoch ${i}
      ${c}
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
    `).all(e),n=new Set,i=new Set;for(let c of t){if(c.files_read)try{let d=JSON.parse(c.files_read);Array.isArray(d)&&d.forEach(_=>n.add(_))}catch{}if(c.files_modified)try{let d=JSON.parse(c.files_modified);Array.isArray(d)&&d.forEach(_=>i.add(_))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,n,i=0){let c=new Date,d=c.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,c.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),n||null,i,c.toISOString(),d);return{id:Number(b.lastInsertRowid),createdAtEpoch:d}}storeSummary(e,s,t,n,i=0){let c=new Date,d=c.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,c.toISOString(),d),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let b=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,i,c.toISOString(),d);return{id:Number(b.lastInsertRowid),createdAtEpoch:d}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${d})
      ORDER BY created_at_epoch ${i}
      ${c}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:n}=s,i=t==="date_asc"?"ASC":"DESC",c=n?`LIMIT ${n}`:"",d=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${d})
      ORDER BY up.created_at_epoch ${i}
      ${c}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,n){return this.getTimelineAroundObservation(null,e,s,t,n)}getTimelineAroundObservation(e,s,t=10,n=10,i){let c=i?"AND project = ?":"",d=i?[i]:[],_,m;if(e!==null){let f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${c}
        ORDER BY id DESC
        LIMIT ?
      `,y=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${c}
        ORDER BY id ASC
        LIMIT ?
      `;try{let E=this.db.prepare(f).all(e,...d,t+1),r=this.db.prepare(y).all(e,...d,n+1);if(E.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};_=E.length>0?E[E.length-1].created_at_epoch:s,m=r.length>0?r[r.length-1].created_at_epoch:s}catch(E){return console.error("[SessionStore] Error getting boundary observations:",E.message),{observations:[],sessions:[],prompts:[]}}}else{let f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${c}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,y=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${c}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let E=this.db.prepare(f).all(s,...d,t),r=this.db.prepare(y).all(s,...d,n+1);if(E.length===0&&r.length===0)return{observations:[],sessions:[],prompts:[]};_=E.length>0?E[E.length-1].created_at_epoch:s,m=r.length>0?r[r.length-1].created_at_epoch:s}catch(E){return console.error("[SessionStore] Error getting boundary timestamps:",E.message),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${c}
      ORDER BY created_at_epoch ASC
    `,b=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${c}
      ORDER BY created_at_epoch ASC
    `,v=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${c.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let f=this.db.prepare(l).all(_,m,...d),y=this.db.prepare(b).all(_,m,...d),E=this.db.prepare(v).all(_,m,...d);return{observations:f,sessions:y.map(r=>({id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,request:r.request,completed:r.completed,next_steps:r.next_steps,created_at:r.created_at,created_at_epoch:r.created_at_epoch})),prompts:E.map(r=>({id:r.id,claude_session_id:r.claude_session_id,project:r.project,prompt:r.prompt_text,created_at:r.created_at,created_at_epoch:r.created_at_epoch}))}}catch(f){return console.error("[SessionStore] Error querying timeline records:",f.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var de=["bugfix","feature","refactor","discovery","decision","change"],pe=["how-it-works","why-it-exists","what-changed","problem-solution","gotcha","pattern","trade-off"],ve={bugfix:"\u{1F534}",feature:"\u{1F7E3}",refactor:"\u{1F504}",change:"\u2705",discovery:"\u{1F535}",decision:"\u2696\uFE0F","session-request":"\u{1F3AF}"},ye={discovery:"\u{1F50D}",change:"\u{1F6E0}\uFE0F",feature:"\u{1F6E0}\uFE0F",bugfix:"\u{1F6E0}\uFE0F",refactor:"\u{1F6E0}\uFE0F",decision:"\u2696\uFE0F"},De=de.join(","),Me=pe.join(",");var z=require("fs"),ke=require("path"),$e=require("os");var Q=class{static DEFAULTS={CLAUDE_MEM_MODEL:"claude-haiku-4-5",CLAUDE_MEM_CONTEXT_OBSERVATIONS:"50",CLAUDE_MEM_WORKER_PORT:"37777",CLAUDE_MEM_DATA_DIR:(0,ke.join)((0,$e.homedir)(),".claude-mem"),CLAUDE_MEM_LOG_LEVEL:"INFO",CLAUDE_MEM_PYTHON_VERSION:"3.13",CLAUDE_CODE_PATH:"",CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT:"true",CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT:"true",CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES:De,CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS:Me,CLAUDE_MEM_CONTEXT_FULL_COUNT:"5",CLAUDE_MEM_CONTEXT_FULL_FIELD:"narrative",CLAUDE_MEM_CONTEXT_SESSION_COUNT:"10",CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY:"true",CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE:"false"};static getAllDefaults(){return{...this.DEFAULTS}}static get(e){return process.env[e]||this.DEFAULTS[e]}static getInt(e){let s=this.get(e);return parseInt(s,10)}static getBool(e){return this.get(e)==="true"}static loadFromFile(e){if(!(0,z.existsSync)(e))return this.getAllDefaults();let s=(0,z.readFileSync)(e,"utf-8"),n=JSON.parse(s).env||{},i={...this.DEFAULTS};for(let c of Object.keys(this.DEFAULTS))n[c]!==void 0&&(i[c]=n[c]);return i}};var ze=U.default.join((0,ee.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version");function Ze(){let a=U.default.join((0,ee.homedir)(),".claude-mem","settings.json"),e=Q.loadFromFile(a);try{return{totalObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10),fullObservationCount:parseInt(e.CLAUDE_MEM_CONTEXT_FULL_COUNT,10),sessionCount:parseInt(e.CLAUDE_MEM_CONTEXT_SESSION_COUNT,10),showReadTokens:e.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS==="true",showWorkTokens:e.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS==="true",showSavingsAmount:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT==="true",showSavingsPercent:e.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT==="true",observationTypes:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES.split(",").map(s=>s.trim()).filter(Boolean)),observationConcepts:new Set(e.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS.split(",").map(s=>s.trim()).filter(Boolean)),fullObservationField:e.CLAUDE_MEM_CONTEXT_FULL_FIELD,showLastSummary:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY==="true",showLastMessage:e.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE==="true"}}catch(s){return B.warn("WORKER","Failed to load context settings, using defaults",{},s),{totalObservationCount:50,fullObservationCount:5,sessionCount:10,showReadTokens:!0,showWorkTokens:!0,showSavingsAmount:!0,showSavingsPercent:!0,observationTypes:new Set(de),observationConcepts:new Set(pe),fullObservationField:"narrative",showLastSummary:!0,showLastMessage:!1}}}var Ue=4,es=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function xe(a){if(!a)return[];try{let e=JSON.parse(a);return Array.isArray(e)?e:[]}catch{return[]}}function ss(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function ts(a){return new Date(a).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function rs(a){return new Date(a).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function ns(a,e){return U.default.isAbsolute(a)?U.default.relative(e,a):a}function Z(a,e,s,t){return e?t?[`${s}${a}:${o.reset} ${e}`,""]:[`**${a}**: ${e}`,""]:[]}function os(a){return a.replace(/\//g,"-")}function is(a){try{if(!(0,P.existsSync)(a))return{userMessage:"",assistantMessage:""};let e=(0,P.readFileSync)(a,"utf-8").trim();if(!e)return{userMessage:"",assistantMessage:""};let s=e.split(`
`).filter(n=>n.trim()),t="";for(let n=s.length-1;n>=0;n--)try{let i=s[n];if(!i.includes('"type":"assistant"'))continue;let c=JSON.parse(i);if(c.type==="assistant"&&c.message?.content&&Array.isArray(c.message.content)){let d="";for(let _ of c.message.content)_.type==="text"&&(d+=_.text);if(d=d.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,"").trim(),d){t=d;break}}}catch{continue}return{userMessage:"",assistantMessage:t}}catch(e){return B.failure("WORKER","Failed to extract prior messages from transcript",{transcriptPath:a},e),{userMessage:"",assistantMessage:""}}}async function as(a,e=!1){let s=Ze(),t=a?.cwd??process.cwd(),n=t?U.default.basename(t):"unknown-project",i=null;try{i=new J}catch(I){if(I.code==="ERR_DLOPEN_FAILED"){try{(0,P.unlinkSync)(ze)}catch{}return console.error("Native module rebuild needed - restart Claude Code to auto-fix"),""}throw I}let c=Array.from(s.observationTypes),d=c.map(()=>"?").join(","),_=Array.from(s.observationConcepts),m=_.map(()=>"?").join(","),l=i.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${d})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${m})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,...c,..._,s.totalObservationCount),b=i.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(n,s.sessionCount+es),v="",f="";if(s.showLastMessage&&l.length>0)try{let I=a?.session_id,O=l.find(h=>h.sdk_session_id!==I);if(O){let h=O.sdk_session_id,D=os(t),x=U.default.join((0,ee.homedir)(),".claude","projects",D,`${h}.jsonl`),W=is(x);v=W.userMessage,f=W.assistantMessage}}catch{}if(l.length===0&&b.length===0)return i?.close(),e?`
${o.bright}${o.cyan}[${n}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${n}] recent context

No previous sessions found for this project yet.`;let y=b.slice(0,s.sessionCount),E=l,r=[];if(e?(r.push(""),r.push(`${o.bright}${o.cyan}[${n}] recent context${o.reset}`),r.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),r.push("")):(r.push(`# [${n}] recent context`),r.push("")),E.length>0){e?r.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):r.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),r.push(""),e?(r.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),r.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),r.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(r.push("\u{1F4A1} **Column Key**:"),r.push("- **Read**: Tokens to read this observation (cost to learn it now)"),r.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),r.push(""),e?(r.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),r.push(""),r.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),r.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),r.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),r.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(r.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),r.push(""),r.push("When you need implementation details, rationale, or debugging context:"),r.push("- Use the mem-search skill to fetch full observations on-demand"),r.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),r.push("- Trust this index over re-reading code for past decisions and learnings")),r.push("");let I=l.length,O=l.reduce((p,T)=>{let g=(T.title?.length||0)+(T.subtitle?.length||0)+(T.narrative?.length||0)+JSON.stringify(T.facts||[]).length;return p+Math.ceil(g/Ue)},0),h=l.reduce((p,T)=>p+(T.discovery_tokens||0),0),D=h-O,x=h>0?Math.round(D/h*100):0,W=s.showReadTokens||s.showWorkTokens||s.showSavingsAmount||s.showSavingsPercent;if(W)if(e){if(r.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),r.push(`${o.dim}  Loading: ${I} observations (${O.toLocaleString()} tokens to read)${o.reset}`),r.push(`${o.dim}  Work investment: ${h.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),h>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="  Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${D.toLocaleString()} tokens (${x}% reduction from reuse)`:s.showSavingsAmount?p+=`${D.toLocaleString()} tokens`:p+=`${x}% reduction from reuse`,r.push(`${o.green}${p}${o.reset}`)}r.push("")}else{if(r.push("\u{1F4CA} **Context Economics**:"),r.push(`- Loading: ${I} observations (${O.toLocaleString()} tokens to read)`),r.push(`- Work investment: ${h.toLocaleString()} tokens spent on research, building, and decisions`),h>0&&(s.showSavingsAmount||s.showSavingsPercent)){let p="- Your savings: ";s.showSavingsAmount&&s.showSavingsPercent?p+=`${D.toLocaleString()} tokens (${x}% reduction from reuse)`:s.showSavingsAmount?p+=`${D.toLocaleString()} tokens`:p+=`${x}% reduction from reuse`,r.push(p)}r.push("")}let we=b[0]?.id,Fe=y.map((p,T)=>{let g=T===0?null:b[T+1];return{...p,displayEpoch:g?g.created_at_epoch:p.created_at_epoch,displayTime:g?g.created_at:p.created_at,shouldShowLink:p.id!==we}}),Xe=new Set(l.slice(0,s.fullObservationCount).map(p=>p.id)),_e=[...E.map(p=>({type:"observation",data:p})),...Fe.map(p=>({type:"summary",data:p}))];_e.sort((p,T)=>{let g=p.type==="observation"?p.data.created_at_epoch:p.data.displayEpoch,M=T.type==="observation"?T.data.created_at_epoch:T.data.displayEpoch;return g-M});let H=new Map;for(let p of _e){let T=p.type==="observation"?p.data.created_at:p.data.displayTime,g=rs(T);H.has(g)||H.set(g,[]),H.get(g).push(p)}let Pe=Array.from(H.entries()).sort((p,T)=>{let g=new Date(p[0]).getTime(),M=new Date(T[0]).getTime();return g-M});for(let[p,T]of Pe){e?(r.push(`${o.bright}${o.cyan}${p}${o.reset}`),r.push("")):(r.push(`### ${p}`),r.push(""));let g=null,M="",$=!1;for(let se of T)if(se.type==="summary"){$&&(r.push(""),$=!1,g=null,M="");let u=se.data,w=`${u.request||"Session started"} (${ss(u.displayTime)})`,L=u.shouldShowLink?`claude-mem://session-summary/${u.id}`:"";if(e){let R=L?`${o.dim}[${L}]${o.reset}`:"";r.push(`\u{1F3AF} ${o.yellow}#S${u.id}${o.reset} ${w} ${R}`)}else{let R=L?` [\u2192](${L})`:"";r.push(`**\u{1F3AF} #S${u.id}** ${w}${R}`)}r.push("")}else{let u=se.data,w=xe(u.files_modified),L=w.length>0&&w[0]?ns(w[0],t):"General";L!==g&&($&&r.push(""),e?r.push(`${o.dim}${L}${o.reset}`):r.push(`**${L}**`),e||(r.push("| ID | Time | T | Title | Read | Work |"),r.push("|----|------|---|-------|------|------|")),g=L,$=!0,M="");let R=ts(u.created_at),j=u.title||"Untitled",G=ve[u.type]||"\u2022",We=(u.title?.length||0)+(u.subtitle?.length||0)+(u.narrative?.length||0)+JSON.stringify(u.facts||[]).length,F=Math.ceil(We/Ue),X=u.discovery_tokens||0,te=ye[u.type]||"\u{1F50D}",le=X>0?`${te} ${X.toLocaleString()}`:"-",re=R!==M,me=re?R:"";if(M=R,Xe.has(u.id)){let k=s.fullObservationField==="narrative"?u.narrative:u.facts?xe(u.facts).join(`
`):null;if(e){let A=re?`${o.dim}${R}${o.reset}`:" ".repeat(R.length),Y=s.showReadTokens&&F>0?`${o.dim}(~${F}t)${o.reset}`:"",Ee=s.showWorkTokens&&X>0?`${o.dim}(${te} ${X.toLocaleString()}t)${o.reset}`:"";r.push(`  ${o.dim}#${u.id}${o.reset}  ${A}  ${G}  ${o.bright}${j}${o.reset}`),k&&r.push(`    ${o.dim}${k}${o.reset}`),(Y||Ee)&&r.push(`    ${Y} ${Ee}`),r.push("")}else{$&&(r.push(""),$=!1),r.push(`**#${u.id}** ${me||"\u2033"} ${G} **${j}**`),k&&(r.push(""),r.push(k),r.push(""));let A=[];s.showReadTokens&&A.push(`Read: ~${F}`),s.showWorkTokens&&A.push(`Work: ${le}`),A.length>0&&r.push(A.join(", ")),r.push(""),g=null}}else if(e){let k=re?`${o.dim}${R}${o.reset}`:" ".repeat(R.length),A=s.showReadTokens&&F>0?`${o.dim}(~${F}t)${o.reset}`:"",Y=s.showWorkTokens&&X>0?`${o.dim}(${te} ${X.toLocaleString()}t)${o.reset}`:"";r.push(`  ${o.dim}#${u.id}${o.reset}  ${k}  ${G}  ${j} ${A} ${Y}`)}else{let k=s.showReadTokens?`~${F}`:"",A=s.showWorkTokens?le:"";r.push(`| #${u.id} | ${me||"\u2033"} | ${G} | ${j} | ${k} | ${A} |`)}}$&&r.push("")}let N=b[0],ue=l[0];if(s.showLastSummary&&N&&(N.investigated||N.learned||N.completed||N.next_steps)&&(!ue||N.created_at_epoch>ue.created_at_epoch)&&(r.push(...Z("Investigated",N.investigated,o.blue,e)),r.push(...Z("Learned",N.learned,o.yellow,e)),r.push(...Z("Completed",N.completed,o.green,e)),r.push(...Z("Next Steps",N.next_steps,o.magenta,e))),f&&(r.push(""),r.push("---"),r.push(""),e?(r.push(`${o.bright}${o.magenta}\u{1F4CB} Previously${o.reset}`),r.push(""),r.push(`${o.dim}A: ${f}${o.reset}`)):(r.push("**\u{1F4CB} Previously**"),r.push(""),r.push(`A: ${f}`)),r.push("")),W&&h>0&&D>0){let p=Math.round(h/1e3);r.push(""),e?r.push(`${o.dim}\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${O.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${o.reset}`):r.push(`\u{1F4B0} Access ${p}k tokens of past research & decisions for just ${O.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`)}}return i?.close(),r.join(`
`).trimEnd()}0&&(module.exports={generateContext});
