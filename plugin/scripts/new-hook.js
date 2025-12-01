#!/usr/bin/env node
import cs from"path";import{stdin as Ee}from"process";import Le from"better-sqlite3";import{join as y,dirname as Se,basename as be}from"path";import{homedir as ne}from"os";import{existsSync as _s,mkdirSync as he}from"fs";import{fileURLToPath as Oe}from"url";function Re(){return typeof __dirname<"u"?__dirname:Se(Oe(import.meta.url))}var ye=Re(),k=process.env.CLAUDE_MEM_DATA_DIR||y(ne(),".claude-mem"),W=process.env.CLAUDE_CONFIG_DIR||y(ne(),".claude"),Ts=y(k,"archives"),gs=y(k,"logs"),fs=y(k,"trash"),w=y(k,"backups"),Ss=y(k,"settings.json"),ie=y(k,"claude-mem.db"),bs=y(k,"vector-db"),hs=y(W,"settings.json"),Os=y(W,"commands"),Rs=y(W,"CLAUDE.md");function F(o){he(o,{recursive:!0})}function G(){return y(ye,"..","..")}function ae(o){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=be(o);return y(w,`${s}.backup.${e}`)}var K=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(K||{}),Y=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=K[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,n){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),a=K[e].padEnd(5),c=s.padEnd(6),d="";r?.correlationId?d=`[${r.correlationId}] `:r?.sessionId&&(d=`[session-${r.sessionId}] `);let S="";n!=null&&(this.level===0&&typeof n=="object"?S=`
`+JSON.stringify(n,null,2):S=" "+this.formatData(n));let _="";if(r){let{sessionId:m,sdkSessionId:f,correlationId:T,...p}=r;Object.keys(p).length>0&&(_=` {${Object.entries(p).map(([b,R])=>`${b}=${R}`).join(", ")}}`)}let g=`[${i}] [${a}] [${c}] ${d}${t}${_}${S}`;e===3?console.error(g):console.log(g)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},l=new Y;import{appendFileSync as Ne}from"fs";import{homedir as Ie}from"os";import{join as ve}from"path";var Ae=ve(Ie(),".pm2","logs","claude-mem-worker-error.log");function E(o,e,s=""){let t=new Date().toISOString(),a=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),c=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",d=`[${t}] [HAPPY-PATH-ERROR] [${c}] ${o}`;if(e!==void 0)try{d+=` ${JSON.stringify(e)}`}catch(S){d+=` [stringify error: ${S}]`}d+=`
`;try{Ne(Ae,d)}catch{}return s}var C=E;var x=class{db;constructor(){F(k),this.db=new Le(ie),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(i=>i.name==="endless_original_tokens"),r=s.some(i=>i.name==="endless_compressed_tokens"),n=s.some(i=>i.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),n||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||E("SessionStore.getObservationById: No observation found",{id:e},null)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,n=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).get(e)||E("SessionStore.getSummaryForSession: No summary found",{sdkSessionId:e},null)}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),r=new Set,n=new Set;for(let i of t){if(i.files_read)try{let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(c=>r.add(c))}catch{}if(i.files_modified)try{let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(c=>n.add(c))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(n)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||E("SessionStore.getSessionById: No session found",{id:e},null)}findActiveSDKSession(e){return this.db.prepare(`
      SELECT id, sdk_session_id, project, worker_port
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(e)||E("SessionStore.findActiveSDKSession: No active session found",{claudeSessionId:e},null)}findAnySDKSession(e){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE claude_session_id = ?
      LIMIT 1
    `).get(e)||E("SessionStore.findAnySDKSession: No session found",{claudeSessionId:e},null)}reactivateSession(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(s,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||E("SessionStore.incrementPromptCounter: result or prompt_counter is null",{id:e},1)}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||E("SessionStore.getPromptCounter: prompt_counter is null",{id:e},0)}createSDKSession(e,s,t){let r=new Date,n=r.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),n);return a.lastInsertRowid===0||a.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
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
    `).get(e)?.worker_port||E("SessionStore.getWorkerPort: worker_port is null",{id:e},null)}saveUserPrompt(e,s,t){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,r,n=0){let i=new Date,a=i.getTime();this.db.prepare(`
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
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||E("SessionStore.storeObservation: promptNumber is null",{sdkSessionId:e},null),n,t.tool_use_id||E("SessionStore.storeObservation: tool_use_id is null",{sdkSessionId:e},null),i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||E("SessionStore.getObservationByToolUseId: No observation found",{toolUseId:e},null)}getAllObservationsForToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
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
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||E("SessionStore.storeSummary: promptNumber is null",{sdkSessionId:e},null),n,i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,n){let i=n?"AND project = ?":"",a=n?[n]:[],c,d;if(e!==null){let m=`
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
      `;try{let T=this.db.prepare(m).all(e,...a,t+1),p=this.db.prepare(f).all(e,...a,r+1);if(T.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};c=T.length>0?T[T.length-1].created_at_epoch:s,d=p.length>0?p[p.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary observations:",T.message),{observations:[],sessions:[],prompts:[]}}}else{let m=`
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
      `;try{let T=this.db.prepare(m).all(s,...a,t),p=this.db.prepare(f).all(s,...a,r+1);if(T.length===0&&p.length===0)return{observations:[],sessions:[],prompts:[]};c=T.length>0?T[T.length-1].created_at_epoch:s,d=p.length>0?p[p.length-1].created_at_epoch:s}catch(T){return console.error("[SessionStore] Error getting boundary timestamps:",T.message),{observations:[],sessions:[],prompts:[]}}}let S=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,g=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let m=this.db.prepare(S).all(c,d,...a),f=this.db.prepare(_).all(c,d,...a),T=this.db.prepare(g).all(c,d,...a);return{observations:m,sessions:f.map(p=>({id:p.id,sdk_session_id:p.sdk_session_id,project:p.project,request:p.request,completed:p.completed,next_steps:p.next_steps,created_at:p.created_at,created_at_epoch:p.created_at_epoch})),prompts:T.map(p=>({id:p.id,claude_session_id:p.claude_session_id,project:p.project,prompt:p.prompt_text,created_at:p.created_at,created_at_epoch:p.created_at_epoch}))}}catch(m){return console.error("[SessionStore] Error querying timeline records:",m.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||E("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||E("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||E("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};function Ce(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||E("hook-response: options.reason is null",{},"Pre-compact operation failed"),suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function A(o,e,s={}){let t=Ce(o,e,s);return JSON.stringify(t)}import z from"path";import{homedir as ke}from"os";import{existsSync as J,readFileSync as De}from"fs";import{spawnSync as Me}from"child_process";var xe=100,Ue=500,we=10;function H(){try{let o=z.join(ke(),".claude-mem","settings.json");if(J(o)){let e=JSON.parse(De(o,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function ce(){try{let o=H();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(xe)})).ok}catch{return!1}}async function Fe(){try{let o=G(),e=z.join(o,"ecosystem.config.cjs");if(!J(e))throw new Error(`Ecosystem config not found at ${e}`);let s=z.join(o,"node_modules",".bin","pm2"),t=process.platform==="win32"?s+".cmd":s,r=J(t)?t:"pm2",n=Me(r,["start",e],{cwd:o,stdio:"pipe",encoding:"utf-8"});if(n.status!==0)throw new Error(n.stderr||"PM2 start failed");for(let i=0;i<we;i++)if(await new Promise(a=>setTimeout(a,Ue)),await ce())return!0;return!1}catch{return!1}}async function X(){if(await ce())return;if(!await Fe()){let e=H(),s=G();throw new Error(`Worker service failed to start on port ${e}.

To start manually, run:
  cd ${s}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}import{stdin as me}from"process";import{readFileSync as ee,writeFileSync as Je,renameSync as qe,copyFileSync as Ve,existsSync as Qe,createReadStream as Ze}from"fs";import{dirname as es,join as ss,basename as ts}from"path";import{createInterface as rs}from"readline";import{existsSync as He,readFileSync as Be}from"fs";import{homedir as Pe}from"os";import Xe from"path";function q(o,e,s){if(o!==void 0){if(typeof o=="boolean")return o;if(typeof o=="string")return o.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function V(o,e,s){if(o!==void 0){if(typeof o=="number")return o;if(typeof o=="string"){let t=parseInt(o,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function $e(){let o=Xe.join(Pe(),".claude-mem","settings.json"),e={};if(He(o))try{e=JSON.parse(Be(o,"utf-8"))}catch(d){l.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},d)}let s=q(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=q(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=V(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),n=V(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),i=V(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),a=q(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),c={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:n,maxToolHistoryMB:i,enableSynchronousMode:a};return s?l.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:n,maxToolHistoryMB:`${i}MB`,syncMode:a}):l.debug("CONFIG","Endless Mode disabled"),c}var U=class{static getConfig=$e;static clearCache(){}};import{existsSync as je,readFileSync as We,writeFileSync as Ge,appendFileSync as Ke,statSync as Ye}from"fs";import{join as ze}from"path";var P=ze(w,"tool-outputs.jsonl");function Q(o,e,s=Date.now()){F(w);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),i=JSON.stringify({tool_use_id:o,content:e,timestamp:s,size_bytes:r})+`
`;Ke(P,i,"utf8")}function pe(o){if(!je(P)||Ye(P).size/(1024*1024)<=o)return;let r=We(P,"utf8").trim().split(`
`).filter(_=>_.length>0),n=[];for(let _ of r)try{n.push(JSON.parse(_))}catch{continue}n.sort((_,g)=>_.timestamp-g.timestamp);let i=o*1024*1024,a=0,c=0;for(let _=n.length-1;_>=0;_--){let g=n[_].size_bytes+100;if(a+g>i){c=_+1;break}a+=g}let S=n.slice(c).map(_=>JSON.stringify(_)).join(`
`)+`
`;Ge(P,S,"utf8")}var $=100;function de(o){let e=(o.match(/<private>/g)||[]).length,s=(o.match(/<claude-mem-context>/g)||[]).length;return e+s}function Z(o){if(typeof o!="string")return C("[tag-stripping] received non-string for JSON context:",{type:typeof o}),"{}";let e=de(o);return e>$&&C("[tag-stripping] tag count exceeds limit, truncating:",{tagCount:e,maxAllowed:$,contentLength:o.length}),o.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim()}function le(o){if(typeof o!="string")return C("[tag-stripping] received non-string for prompt context:",{type:typeof o}),"";let e=de(o);return e>$&&C("[tag-stripping] tag count exceeds limit, truncating:",{tagCount:e,maxAllowed:$,contentLength:o.length}),o.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim()}var os=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function j(o,e){if(!o)return[];if(Array.isArray(o))return o;try{let s=JSON.parse(o);return Array.isArray(s)?s:[]}catch(s){return l.debug("HOOK",`Failed to parse ${e}`,{field:o,error:s}),[]}}function ns(o){let e=[];e.push(`## ${o.title}`),o.subtitle&&e.push(o.subtitle),o.narrative&&e.push(o.narrative);let s=j(o.facts,"facts");s.length>0&&e.push(`Facts: ${s.join("; ")}`);let t=j(o.concepts,"concepts");t.length>0&&e.push(`Concepts: ${t.join(", ")}`);let r=j(o.files_read,"files_read");r.length>0&&e.push(`Files read: ${r.join(", ")}`);let n=j(o.files_modified,"files_modified");return n.length>0&&e.push(`Files modified: ${n.join(", ")}`),e.join(`

`)}async function is(o){let e=new Set;try{let s=Ze(o),t=rs({input:s,crlfDelay:1/0});for await(let i of t)if(i.includes("agentId"))try{let a=JSON.parse(i);a.toolUseResult?.agentId&&e.add(a.toolUseResult.agentId)}catch{}let r=es(o),n=Array.from(e).map(i=>ss(r,`agent-${i}.jsonl`)).filter(i=>Qe(i));return l.debug("HOOK","Discovered agent transcripts",{agentCount:e.size,filesFound:n.length,agentFiles:n.map(i=>ts(i))}),n}catch(s){return l.warn("HOOK","Failed to discover agent files",{mainTranscriptPath:o},s),[]}}async function _e(o,e,s=[]){let t=await is(o),r=await ue(o,e,s),n=0,i=0;for(let a of t)try{let c=await ue(a,e,[]);n+=c.originalTokens,i+=c.compressedTokens}catch(c){l.warn("HOOK","Failed to transform agent transcript",{agentFile:a},c)}return{originalTokens:r.originalTokens+n,compressedTokens:r.compressedTokens+i}}async function ue(o,e,s=[]){try{F(w);let u=ae(o);Ve(o,u),l.info("HOOK","Created transcript backup",{original:o,backup:u})}catch(u){throw l.error("HOOK","Failed to create transcript backup",{transcriptPath:o},u),new Error("Backup creation failed - aborting transformation for safety")}let r=ee(o,"utf-8").trim().split(`
`),n={totalOriginalSize:0,totalCompressedSize:0,transformCount:0},i=new x,a=i.getAllObservationsForToolUseId(e);if(a.length===0)return i.close(),l.debug("HOOK","No observations found for rolling replacement",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let c=new Set(s);c.add(e),l.info("HOOK","Rolling replacement scope",{toolUseId:e,cycleSize:c.size,observationCount:a.length});let d=a.map(u=>ns(u)).join(`

`),S={type:"assistant",message:{role:"assistant",content:[{type:"text",text:d}]}},_=d.length,g=new Set,m=new Set,f=new Set;for(let u of r)if(u.trim())try{let N=JSON.parse(u);if(N.type==="assistant"&&Array.isArray(N.message?.content)){for(let O of N.message.content)if(O.type==="tool_use"){let L=O;L.id&&c.has(L.id)&&m.add(L.id)}}if(N.type==="user"&&Array.isArray(N.message?.content)){for(let O of N.message.content)if(O.type==="tool_result"){let L=O;L.tool_use_id&&c.has(L.tool_use_id)&&f.add(L.tool_use_id)}}}catch{continue}for(let u of c)m.has(u)&&f.has(u)&&g.add(u);if(l.info("HOOK","Validated tool pairs for replacement",{requestedIds:c.size,validatedIds:g.size,toolUseOnly:Array.from(m).filter(u=>!f.has(u)),toolResultOnly:Array.from(f).filter(u=>!m.has(u))}),g.size===0)return i.close(),l.debug("HOOK","No complete tool_use/tool_result pairs found for replacement",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let T=[],p=!1,h=-1,b=0,R=!1;for(let u=0;u<r.length;u++){let N=r[u];if(!N.trim()){T.push(N);continue}try{let O=JSON.parse(N);if(O.type==="assistant"&&Array.isArray(O.message?.content)){let L=O;for(let B of L.message.content)if(B.type==="tool_use"){let I=B;if(I.id&&g.has(I.id)){p||(p=!0,h=u,l.debug("HOOK","Replacement zone start",{toolUseId:I.id,lineIndex:u}));try{Q(I.id,JSON.stringify(I.input),Date.now())}catch(oe){l.warn("HOOK","Failed to backup original tool input",{toolUseId:I.id},oe)}b+=N.length,R=!0;break}}if(p&&R)continue}if(O.type==="user"&&Array.isArray(O.message?.content)&&R){let L=O;for(let B of L.message.content)if(B.type==="tool_result"){let I=B;if(I.tool_use_id&&g.has(I.tool_use_id)){try{Q(I.tool_use_id,JSON.stringify(I.content),Date.now())}catch(fe){l.warn("HOOK","Failed to backup original tool output",{toolUseId:I.tool_use_id},fe)}b+=N.length,I.tool_use_id===e&&(T.push(JSON.stringify(S)),p=!1,R=!1,n.totalOriginalSize+=b,n.totalCompressedSize+=_,n.transformCount++,l.success("HOOK","Rolling replacement complete",{zoneStart:h,zoneEnd:u,toolsReplaced:g.size,originalSize:b,compressedSize:_,savings:`${Math.round((1-_/b)*100)}%`}));continue}}}(!p||!R)&&T.push(N)}catch(O){throw l.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:u,error:O}),new Error(`Malformed JSONL line at index ${u}: ${O.message}`)}}i.close();let v=`${o}.tmp`;Je(v,T.join(`
`)+`
`,"utf-8");let M=ee(v,"utf-8").trim().split(`
`);for(let u of M)u.trim()&&JSON.parse(u);qe(v,o);let re=4,Te=Math.ceil(n.totalOriginalSize/re),ge=Math.ceil(n.totalCompressedSize/re);l.success("HOOK","Transcript transformation complete",{toolUseId:e,transformCount:n.transformCount,totalOriginalSize:n.totalOriginalSize,totalCompressedSize:n.totalCompressedSize,savings:n.totalOriginalSize>0?`${Math.round((1-n.totalCompressedSize/n.totalOriginalSize)*100)}%`:"0%"});try{let u=U.getConfig();u.maxToolHistoryMB>0&&(pe(u.maxToolHistoryMB),l.debug("HOOK","Trimmed tool output backup",{maxSizeMB:u.maxToolHistoryMB}))}catch(u){l.warn("HOOK","Failed to trim tool output backup",{},u)}return{originalTokens:Te,compressedTokens:ge}}async function as(o){o||(l.warn("HOOK","PostToolUse called with no input"),console.log(A("PostToolUse",!0)),process.exit(0));let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:n,transcript_path:i,tool_use_id:a}=o;os.has(t)&&(console.log(A("PostToolUse",!0)),process.exit(0)),await X();let c=new x,d=c.createSDKSession(e,"",""),S=c.getPromptCounter(d),_=c.getUserPrompt(e,S);if(!_||_.trim()===""){C("[save-hook] Skipping observation - user prompt was entirely private",{session_id:e,promptNumber:S,tool_name:t}),c.close(),console.log(A("PostToolUse",!0));return}c.close();let g=l.formatTool(t,r),m=H(),f=a;if(!f&&i)try{let b=ee(i,"utf-8").trim().split(`
`);for(let R=b.length-1;R>=0;R--){let v=JSON.parse(b[R]);if(v.type==="user"&&Array.isArray(v.message.content)){for(let D of v.message.content)if(D.type==="tool_result"&&D.tool_use_id){f=D.tool_use_id;break}if(f)break}}}catch(h){E("Failed to extract tool_use_id from transcript",{error:h})}l.dataIn("HOOK",`PostToolUse: ${g}`,{sessionDbId:d,claudeSessionId:e,workerPort:m,toolUseId:f||E("tool_use_id not found in transcript",{toolName:t},"(none)")});let T=U.getConfig(),p=!!(T.enabled&&f&&i);E("Endless Mode Check",{configEnabled:T.enabled,hasToolUseId:!!f,hasTranscriptPath:!!i,isEndlessModeEnabled:p,toolName:t,toolUseId:f,allInputKeys:Object.keys(o).join(", ")});try{let h="{}",b="{}";try{h=r!==void 0?Z(JSON.stringify(r)):"{}"}catch(M){C("[save-hook] Failed to stringify tool_input:",{error:M,tool_name:t}),h='{"error": "Failed to serialize tool_input"}'}try{b=n!==void 0?Z(JSON.stringify(n)):"{}"}catch(M){C("[save-hook] Failed to stringify tool_response:",{error:M,tool_name:t}),b='{"error": "Failed to serialize tool_response"}'}let R=p?parseInt(process.env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS||(E("CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS not set, using default 90000ms"),"90000"),10):2e3,v=await fetch(`http://127.0.0.1:${m}/sessions/${d}/observations?wait_until_obs_is_saved=${p}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:h,tool_response:b,prompt_number:S,cwd:s||E("save-hook: cwd missing",{sessionDbId:d,tool_name:t}),tool_use_id:f,transcript_path:i||E("save-hook: transcript_path missing",{sessionDbId:d,tool_name:t})}),signal:AbortSignal.timeout(R)});if(!v.ok){let M=await v.text();l.failure("HOOK","Failed to send observation",{sessionDbId:d,status:v.status},M),console.log(A("PostToolUse",!0)),process.exit(0)}let D=await v.json();D.status==="completed"?console.log("[save-hook] \u2705 Observation created, transcript transformed"):D.status==="skipped"?console.log("[save-hook] \u23ED\uFE0F  No observation needed, continuing"):D.status==="timeout"&&console.warn(`[save-hook] \u23F1\uFE0F  Timeout after ${R}ms - processing async`),l.debug("HOOK","Observation sent successfully",{sessionDbId:d,toolName:t,mode:p?"synchronous (Endless Mode)":"async"})}catch(h){if(h.cause?.code==="ECONNREFUSED"){let b="Worker connection failed. Try: pm2 restart claude-mem-worker";l.failure("HOOK","Worker connection refused",{sessionDbId:d},h),console.error(`[save-hook] ${b}`),console.log(A("PostToolUse",!1,{reason:b})),process.exit(2)}console.warn("[save-hook] \u274C Failed to send observation:",h.message),l.warn("HOOK","Observation request failed - continuing anyway",{sessionDbId:d,toolName:t,error:h.message}),console.log(A("PostToolUse",!0)),process.exit(0)}console.log(A("PostToolUse",!0)),process.exit(0)}var se="";me.on("data",o=>se+=o);me.on("end",async()=>{try{let o=se?JSON.parse(se):void 0;await as(o)}catch(o){console.error(`[save-hook] Unhandled error: ${o.message}`),console.log(A("PostToolUse",!1,{reason:o.message})),process.exit(1)}});async function ps(o){if(!o)throw new Error("newHook requires input");let{session_id:e,cwd:s,prompt:t,transcript_path:r}=o;E("[new-hook] Input received",{session_id:e,cwd:s,cwd_type:typeof s,cwd_length:s?.length,has_cwd:!!s,prompt_length:t?.length});let n=cs.basename(s);E("[new-hook] Project extracted",{project:n,project_type:typeof n,project_length:n?.length,is_empty:n==="",cwd_was:s}),await X();let i=new x,a=i.createSDKSession(e,n,t),c=i.incrementPromptCounter(a),d=le(t);if(!d||d.trim()===""){C("[new-hook] Prompt entirely private, skipping memory operations",{session_id:e,promptNumber:c,originalLength:t.length}),i.close(),console.error(`[new-hook] Session ${a}, prompt #${c} (fully private - skipped)`),console.log(A("UserPromptSubmit",!0));return}if(i.saveUserPrompt(e,c,d),console.error(`[new-hook] Session ${a}, prompt #${c}`),i.close(),U.getConfig().enabled&&r)try{l.info("HOOK","\u{1F504} Batch transforming transcript at UserPromptSubmit",{transcriptPath:r});let m=await _e(r,`user-prompt-${c}`);l.success("HOOK","\u2705 Batch transformation complete",{originalTokens:m.originalTokens,compressedTokens:m.compressedTokens,savings:`${Math.round((1-m.compressedTokens/m.originalTokens)*100)}%`})}catch(m){l.warn("HOOK","Batch transformation failed - continuing anyway",{transcriptPath:r},m)}let _=H(),g=t.startsWith("/")?t.substring(1):t;try{let m=await fetch(`http://127.0.0.1:${_}/sessions/${a}/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:n,userPrompt:g,promptNumber:c}),signal:AbortSignal.timeout(5e3)});if(!m.ok){let f=await m.text();throw new Error(`Failed to initialize session: ${m.status} ${f}`)}}catch(m){throw m.cause?.code==="ECONNREFUSED"||m.name==="TimeoutError"||m.message.includes("fetch failed")?new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"):m}console.log(A("UserPromptSubmit",!0))}var te="";Ee.on("data",o=>te+=o);Ee.on("end",async()=>{let o=te?JSON.parse(te):void 0;await ps(o)});
