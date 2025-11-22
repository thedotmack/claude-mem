#!/usr/bin/env node
import ze from"path";import{stdin as ie}from"process";import ge from"better-sqlite3";import{join as f,dirname as ae,basename as ce}from"path";import{homedir as J}from"os";import{existsSync as ss,mkdirSync as de}from"fs";import{fileURLToPath as pe}from"url";function le(){return typeof __dirname<"u"?__dirname:ae(pe(import.meta.url))}var ue=le(),I=process.env.CLAUDE_MEM_DATA_DIR||f(J(),".claude-mem"),H=process.env.CLAUDE_CONFIG_DIR||f(J(),".claude"),rs=f(I,"archives"),os=f(I,"logs"),ns=f(I,"trash"),D=f(I,"backups"),is=f(I,"settings.json"),z=f(I,"claude-mem.db"),as=f(I,"vector-db"),cs=f(H,"settings.json"),ds=f(H,"commands"),ps=f(H,"CLAUDE.md");function U(o){de(o,{recursive:!0})}function q(){return f(ue,"..","..")}function V(o){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=ce(o);return f(D,`${s}.backup.${e}`)}var P=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(P||{}),X=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=P[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,i){if(e<this.level)return;let n=new Date().toISOString().replace("T"," ").substring(0,23),a=P[e].padEnd(5),d=s.padEnd(6),u="";r?.correlationId?u=`[${r.correlationId}] `:r?.sessionId&&(u=`[session-${r.sessionId}] `);let S="";i!=null&&(this.level===0&&typeof i=="object"?S=`
`+JSON.stringify(i,null,2):S=" "+this.formatData(i));let E="";if(r){let{sessionId:p,sdkSessionId:h,correlationId:_,...c}=r;Object.keys(c).length>0&&(E=` {${Object.entries(c).map(([b,g])=>`${b}=${g}`).join(", ")}}`)}let m=`[${n}] [${a}] [${d}] ${u}${t}${E}${S}`;e===3?console.error(m):console.log(m)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},l=new X;import{appendFileSync as me}from"fs";import{homedir as _e}from"os";import{join as Ee}from"path";var Te=Ee(_e(),".pm2","logs","claude-mem-worker-error.log");function T(o,e,s=""){let t=new Date().toISOString(),a=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),d=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",u=`[${t}] [SILENT-DEBUG] [${d}] ${o}`;if(e!==void 0)try{u+=` ${JSON.stringify(e)}`}catch(S){u+=` [stringify error: ${S}]`}u+=`
`;try{me(Te,u)}catch{}return s}var C=class{db;constructor(){U(I),this.db=new ge(z),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(n=>n.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(n=>n.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(n=>n.name==="endless_original_tokens"),r=s.some(n=>n.name==="endless_compressed_tokens"),i=s.some(n=>n.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),i||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||T("SessionStore.getObservationById: No observation found",{id:e},null)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).get(e)||T("SessionStore.getSummaryForSession: No summary found",{sdkSessionId:e},null)}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),r=new Set,i=new Set;for(let n of t){if(n.files_read)try{let a=JSON.parse(n.files_read);Array.isArray(a)&&a.forEach(d=>r.add(d))}catch{}if(n.files_modified)try{let a=JSON.parse(n.files_modified);Array.isArray(a)&&a.forEach(d=>i.add(d))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||T("SessionStore.getSessionById: No session found",{id:e},null)}findActiveSDKSession(e){return this.db.prepare(`
      SELECT id, sdk_session_id, project, worker_port
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(e)||T("SessionStore.findActiveSDKSession: No active session found",{claudeSessionId:e},null)}findAnySDKSession(e){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE claude_session_id = ?
      LIMIT 1
    `).get(e)||T("SessionStore.findAnySDKSession: No session found",{claudeSessionId:e},null)}reactivateSession(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(s,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||T("SessionStore.incrementPromptCounter: result or prompt_counter is null",{id:e},1)}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||T("SessionStore.getPromptCounter: prompt_counter is null",{id:e},0)}createSDKSession(e,s,t){let r=new Date,i=r.getTime(),a=this.db.prepare(`
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
    `).get(e)?.worker_port||T("SessionStore.getWorkerPort: worker_port is null",{id:e},null)}saveUserPrompt(e,s,t){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}storeObservation(e,s,t,r,i=0){let n=new Date,a=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let E=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||T("SessionStore.storeObservation: promptNumber is null",{sdkSessionId:e},null),i,t.tool_use_id||T("SessionStore.storeObservation: tool_use_id is null",{sdkSessionId:e},null),n.toISOString(),a);return{id:Number(E.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||T("SessionStore.getObservationByToolUseId: No observation found",{toolUseId:e},null)}getAllObservationsForToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),i=new Map;for(let n of r)n.tool_use_id&&i.set(n.tool_use_id,n);return i}storeSummary(e,s,t,r,i=0){let n=new Date,a=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let E=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||T("SessionStore.storeSummary: promptNumber is null",{sdkSessionId:e},null),i,n.toISOString(),a);return{id:Number(E.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let n=i?"AND project = ?":"",a=i?[i]:[],d,u;if(e!==null){let p=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${n}
        ORDER BY id DESC
        LIMIT ?
      `,h=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${n}
        ORDER BY id ASC
        LIMIT ?
      `;try{let _=this.db.prepare(p).all(e,...a,t+1),c=this.db.prepare(h).all(e,...a,r+1);if(_.length===0&&c.length===0)return{observations:[],sessions:[],prompts:[]};d=_.length>0?_[_.length-1].created_at_epoch:s,u=c.length>0?c[c.length-1].created_at_epoch:s}catch(_){return console.error("[SessionStore] Error getting boundary observations:",_.message),{observations:[],sessions:[],prompts:[]}}}else{let p=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${n}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${n}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let _=this.db.prepare(p).all(s,...a,t),c=this.db.prepare(h).all(s,...a,r+1);if(_.length===0&&c.length===0)return{observations:[],sessions:[],prompts:[]};d=_.length>0?_[_.length-1].created_at_epoch:s,u=c.length>0?c[c.length-1].created_at_epoch:s}catch(_){return console.error("[SessionStore] Error getting boundary timestamps:",_.message),{observations:[],sessions:[],prompts:[]}}}let S=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,E=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,m=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${n.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let p=this.db.prepare(S).all(d,u,...a),h=this.db.prepare(E).all(d,u,...a),_=this.db.prepare(m).all(d,u,...a);return{observations:p,sessions:h.map(c=>({id:c.id,sdk_session_id:c.sdk_session_id,project:c.project,request:c.request,completed:c.completed,next_steps:c.next_steps,created_at:c.created_at,created_at_epoch:c.created_at_epoch})),prompts:_.map(c=>({id:c.id,claude_session_id:c.claude_session_id,project:c.project,prompt:c.prompt_text,created_at:c.created_at,created_at_epoch:c.created_at_epoch}))}}catch(p){return console.error("[SessionStore] Error querying timeline records:",p.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||T("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||T("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||T("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};function Se(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||T("hook-response: options.reason is null",{},"Pre-compact operation failed"),suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function R(o,e,s={}){let t=Se(o,e,s);return JSON.stringify(t)}import Q from"path";import{homedir as fe}from"os";import{existsSync as Z,readFileSync as be}from"fs";import{execSync as Oe}from"child_process";var he=100,Re=500,Ne=10;function M(){try{let o=Q.join(fe(),".claude-mem","settings.json");if(Z(o)){let e=JSON.parse(be(o,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function ee(){try{let o=M();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(he)})).ok}catch{return!1}}async function ye(){try{let o=q(),e=Q.join(o,"ecosystem.config.cjs");if(!Z(e))throw new Error(`Ecosystem config not found at ${e}`);Oe(`pm2 start "${e}"`,{cwd:o,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<Ne;s++)if(await new Promise(t=>setTimeout(t,Re)),await ee())return!0;return!1}catch{return!1}}async function w(){if(await ee())return;if(!await ye()){let e=M();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{stdin as oe}from"process";import{readFileSync as G,writeFileSync as Fe,renameSync as Be,copyFileSync as He,existsSync as Pe,createReadStream as Xe}from"fs";import{dirname as je,join as $e,basename as We}from"path";import{createInterface as Ge}from"readline";import{existsSync as Ie,readFileSync as ve}from"fs";import{homedir as Ae}from"os";import Le from"path";function j(o,e,s){if(o!==void 0){if(typeof o=="boolean")return o;if(typeof o=="string")return o.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function $(o,e,s){if(o!==void 0){if(typeof o=="number")return o;if(typeof o=="string"){let t=parseInt(o,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function Ce(){let o=Le.join(Ae(),".claude-mem","settings.json"),e={};if(Ie(o))try{e=JSON.parse(ve(o,"utf-8"))}catch(u){l.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},u)}let s=j(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=j(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=$(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),i=$(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),n=$(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),a=j(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),d={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:i,maxToolHistoryMB:n,enableSynchronousMode:a};return s?l.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:i,maxToolHistoryMB:`${n}MB`,syncMode:a}):l.debug("CONFIG","Endless Mode disabled"),d}var k=class{static getConfig=Ce;static clearCache(){}};import{existsSync as ke,readFileSync as De,writeFileSync as Ue,appendFileSync as Me,statSync as xe}from"fs";import{join as we}from"path";var x=we(D,"tool-outputs.jsonl");function W(o,e,s=Date.now()){U(D);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),n=JSON.stringify({tool_use_id:o,content:e,timestamp:s,size_bytes:r})+`
`;Me(x,n,"utf8")}function se(o){if(!ke(x)||xe(x).size/(1024*1024)<=o)return;let r=De(x,"utf8").trim().split(`
`).filter(E=>E.length>0),i=[];for(let E of r)try{i.push(JSON.parse(E))}catch{continue}i.sort((E,m)=>E.timestamp-m.timestamp);let n=o*1024*1024,a=0,d=0;for(let E=i.length-1;E>=0;E--){let m=i[E].size_bytes+100;if(a+m>n){d=E+1;break}a+=m}let S=i.slice(d).map(E=>JSON.stringify(E)).join(`
`)+`
`;Ue(x,S,"utf8")}var Ke=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function F(o,e){if(!o)return[];if(Array.isArray(o))return o;try{let s=JSON.parse(o);return Array.isArray(s)?s:[]}catch(s){return l.debug("HOOK",`Failed to parse ${e}`,{field:o,error:s}),[]}}function te(o){let e=[];e.push(o.title),o.subtitle&&e.push(o.subtitle),o.narrative&&e.push(o.narrative);let s=F(o.facts,"facts");s.length>0&&e.push(`Facts: ${s.join("; ")}`);let t=F(o.concepts,"concepts");t.length>0&&e.push(`Concepts: ${t.join(", ")}`);let r=F(o.files_read,"files_read");r.length>0&&e.push(`Files read: ${r.join(", ")}`);let i=F(o.files_modified,"files_modified");return i.length>0&&e.push(`Files modified: ${i.join(", ")}`),e.join(". ")}async function Ye(o){let e=new Set;try{let s=Xe(o),t=Ge({input:s,crlfDelay:1/0});for await(let n of t)if(n.includes("agentId"))try{let a=JSON.parse(n);a.toolUseResult?.agentId&&e.add(a.toolUseResult.agentId)}catch{}let r=je(o),i=Array.from(e).map(n=>$e(r,`agent-${n}.jsonl`)).filter(n=>Pe(n));return l.debug("HOOK","Discovered agent transcripts",{agentCount:e.size,filesFound:i.length,agentFiles:i.map(n=>We(n))}),i}catch(s){return l.warn("HOOK","Failed to discover agent files",{mainTranscriptPath:o},s),[]}}async function ne(o,e){let s=await Ye(o),t=await re(o,e),r=0,i=0;for(let n of s)try{let a=await re(n,e);r+=a.originalTokens,i+=a.compressedTokens}catch(a){l.warn("HOOK","Failed to transform agent transcript",{agentFile:n},a)}return{originalTokens:t.originalTokens+r,compressedTokens:t.compressedTokens+i}}async function re(o,e){try{U(D);let p=V(o);He(o,p),l.info("HOOK","Created transcript backup",{original:o,backup:p})}catch(p){throw l.error("HOOK","Failed to create transcript backup",{transcriptPath:o},p),new Error("Backup creation failed - aborting transformation for safety")}let t=G(o,"utf-8").trim().split(`
`),r={totalOriginalSize:0,totalCompressedSize:0,transformCount:0},i=new C,n=t.map((p,h)=>{if(!p.trim())return p;try{let _=JSON.parse(p);if(!Array.isArray(_.message?.content))return p;let c=!1;return _.type==="assistant"&&_.message.content.forEach(b=>{if(b.type==="tool_use"){let g=b;if(!g.id)return;let O=i.getAllObservationsForToolUseId(g.id);if(O.length>0){let v=JSON.stringify(g.input).length,A=O.map(y=>te(y)).join(" | "),L=A.length;if(L<v){try{W(g.id,JSON.stringify(g.input),Date.now())}catch(y){l.warn("HOOK","Failed to backup original tool input",{toolUseId:g.id},y)}g.input={_compressed:A},r.totalOriginalSize+=v,r.totalCompressedSize+=L,r.transformCount++,c=!0,l.success("HOOK","Transformed tool_use input",{toolUseId:g.id,originalSize:v,compressedSize:L,savings:`${Math.round((1-L/v)*100)}%`})}else l.debug("HOOK","Skipped input transformation (observation not shorter)",{toolUseId:g.id,originalSize:v,compressedSize:L})}}}),_.type==="user"&&_.message.content.forEach(b=>{if(b.type==="tool_result"){let g=b,O=g.tool_use_id;if(!O)return;let v=i.getAllObservationsForToolUseId(O);if(v.length>0){let A=JSON.stringify(g.content).length,L=v.map(B=>te(B)).join(" | "),y=L.length;if(y<A){try{W(O,JSON.stringify(g.content),Date.now())}catch(B){l.warn("HOOK","Failed to backup original tool output",{toolUseId:O},B)}g.content=L,r.totalOriginalSize+=A,r.totalCompressedSize+=y,r.transformCount++,c=!0,l.success("HOOK","Transformed tool_result output",{toolUseId:O,originalSize:A,compressedSize:y,savings:`${Math.round((1-y/A)*100)}%`})}else l.debug("HOOK","Skipped output transformation (observation not shorter)",{toolUseId:O,originalSize:A,compressedSize:y})}}}),c?JSON.stringify(_):p}catch(_){throw l.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:h,error:_}),new Error(`Malformed JSONL line at index ${h}: ${_.message}`)}});i.close();let a=`${o}.tmp`;Fe(a,n.join(`
`)+`
`,"utf-8");let u=G(a,"utf-8").trim().split(`
`);for(let p of u)p.trim()&&JSON.parse(p);Be(a,o);let S=4,E=Math.ceil(r.totalOriginalSize/S),m=Math.ceil(r.totalCompressedSize/S);l.success("HOOK","Transcript transformation complete",{toolUseId:e,transformCount:r.transformCount,totalOriginalSize:r.totalOriginalSize,totalCompressedSize:r.totalCompressedSize,savings:r.totalOriginalSize>0?`${Math.round((1-r.totalCompressedSize/r.totalOriginalSize)*100)}%`:"0%"});try{let p=k.getConfig();p.maxToolHistoryMB>0&&(se(p.maxToolHistoryMB),l.debug("HOOK","Trimmed tool output backup",{maxSizeMB:p.maxToolHistoryMB}))}catch(p){l.warn("HOOK","Failed to trim tool output backup",{},p)}return{originalTokens:E,compressedTokens:m}}async function Je(o){if(!o){l.warn("HOOK","PostToolUse called with no input"),console.log(R("PostToolUse",!0));return}let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:i,transcript_path:n,tool_use_id:a}=o;if(Ke.has(t)){console.log(R("PostToolUse",!0));return}await w();let d=new C,u=d.createSDKSession(e,"",""),S=d.getPromptCounter(u);d.close();let E=l.formatTool(t,r),m=M(),p=a;if(!p&&n)try{let N=G(n,"utf-8").trim().split(`
`);for(let b=N.length-1;b>=0;b--){let g=JSON.parse(N[b]);if(g.type==="user"&&Array.isArray(g.message.content)){for(let O of g.message.content)if(O.type==="tool_result"&&O.tool_use_id){p=O.tool_use_id;break}if(p)break}}}catch(c){T("Failed to extract tool_use_id from transcript",{error:c})}l.dataIn("HOOK",`PostToolUse: ${E}`,{sessionDbId:u,claudeSessionId:e,workerPort:m,toolUseId:p||T("tool_use_id not found in transcript",{toolName:t},"(none)")});let h=k.getConfig(),_=!!(h.enabled&&p&&n);T("Endless Mode Check",{configEnabled:h.enabled,hasToolUseId:!!p,hasTranscriptPath:!!n,isEndlessModeEnabled:_,toolName:t,toolUseId:p,allInputKeys:Object.keys(o).join(", ")});try{let c=_?3e4:2e3,N=await fetch(`http://127.0.0.1:${m}/sessions/${u}/observations?wait_until_obs_is_saved=${_}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_response:i!==void 0?JSON.stringify(i):"{}",prompt_number:S,cwd:s||T("save-hook: cwd missing",{sessionDbId:u,tool_name:t}),tool_use_id:p,transcript_path:n||T("save-hook: transcript_path missing",{sessionDbId:u,tool_name:t})}),signal:AbortSignal.timeout(c)});if(!N.ok){let b=await N.text();l.failure("HOOK","Failed to send observation",{sessionDbId:u,status:N.status},b),console.log(R("PostToolUse",!0));return}l.debug("HOOK","Observation sent successfully",{sessionDbId:u,toolName:t,mode:_?"synchronous (Endless Mode)":"async"})}catch(c){if(c.cause?.code==="ECONNREFUSED"){l.failure("HOOK","Worker connection refused",{sessionDbId:u},c),console.log(R("PostToolUse",!0,"Worker connection failed. Try: pm2 restart claude-mem-worker"));return}if(c.name==="TimeoutError"||c.message?.includes("timed out")){l.warn("HOOK","Observation request timed out - continuing",{sessionDbId:u,toolName:t}),console.log(R("PostToolUse",!0));return}l.warn("HOOK","Observation request failed - continuing anyway",{sessionDbId:u,toolName:t,error:c.message}),console.log(R("PostToolUse",!0));return}console.log(R("PostToolUse",!0))}var K="";oe.on("data",o=>K+=o);oe.on("end",async()=>{let o=K?JSON.parse(K):void 0;await Je(o)});async function qe(o){if(!o)throw new Error("newHook requires input");let{session_id:e,cwd:s,prompt:t,transcript_path:r}=o,i=ze.basename(s);await w();let n=new C,a=n.createSDKSession(e,i,t),d=n.incrementPromptCounter(a);if(n.saveUserPrompt(e,d,t),console.error(`[new-hook] Session ${a}, prompt #${d}`),n.close(),k.getConfig().enabled&&r)try{l.info("HOOK","\u{1F504} Batch transforming transcript at UserPromptSubmit",{transcriptPath:r});let m=await ne(r,`user-prompt-${d}`);l.success("HOOK","\u2705 Batch transformation complete",{originalTokens:m.originalTokens,compressedTokens:m.compressedTokens,savings:`${Math.round((1-m.compressedTokens/m.originalTokens)*100)}%`})}catch(m){l.warn("HOOK","Batch transformation failed - continuing anyway",{transcriptPath:r},m)}let S=M(),E=t.startsWith("/")?t.substring(1):t;try{let m=await fetch(`http://127.0.0.1:${S}/sessions/${a}/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:i,userPrompt:E,promptNumber:d}),signal:AbortSignal.timeout(5e3)});if(!m.ok){let p=await m.text();throw new Error(`Failed to initialize session: ${m.status} ${p}`)}}catch(m){throw m.cause?.code==="ECONNREFUSED"||m.name==="TimeoutError"||m.message.includes("fetch failed")?new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"):m}console.log(R("UserPromptSubmit",!0))}var Y="";ie.on("data",o=>Y+=o);ie.on("end",async()=>{let o=Y?JSON.parse(Y):void 0;await qe(o)});
