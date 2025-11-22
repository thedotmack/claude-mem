#!/usr/bin/env node
import X from"path";import{homedir as Le}from"os";import{existsSync as ye,readFileSync as Ae}from"fs";import{stdin as V}from"process";import fe from"better-sqlite3";import{join as R,dirname as ue,basename as He}from"path";import{homedir as ee}from"os";import{existsSync as Pe,mkdirSync as me}from"fs";import{fileURLToPath as Ee}from"url";function Te(){return typeof __dirname<"u"?__dirname:ue(Ee(import.meta.url))}var Ke=Te(),y=process.env.CLAUDE_MEM_DATA_DIR||R(ee(),".claude-mem"),G=process.env.CLAUDE_CONFIG_DIR||R(ee(),".claude"),qe=R(y,"archives"),Ve=R(y,"logs"),Je=R(y,"trash"),Qe=R(y,"backups"),ze=R(y,"settings.json"),se=R(y,"claude-mem.db"),Ze=R(y,"vector-db"),es=R(G,"settings.json"),ss=R(G,"commands"),ts=R(G,"CLAUDE.md");function te(d){me(d,{recursive:!0})}var P=(a=>(a[a.DEBUG=0]="DEBUG",a[a.INFO=1]="INFO",a[a.WARN=2]="WARN",a[a.ERROR=3]="ERROR",a[a.SILENT=4]="SILENT",a))(P||{}),Y=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=P[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,a){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),c=P[e].padEnd(5),_=s.padEnd(6),T="";r?.correlationId?T=`[${r.correlationId}] `:r?.sessionId&&(T=`[session-${r.sessionId}] `);let n="";a!=null&&(this.level===0&&typeof a=="object"?n=`
`+JSON.stringify(a,null,2):n=" "+this.formatData(a));let N="";if(r){let{sessionId:b,sdkSessionId:f,correlationId:h,...l}=r;Object.keys(l).length>0&&(N=` {${Object.entries(l).map(([H,M])=>`${H}=${M}`).join(", ")}}`)}let g=`[${i}] [${c}] [${_}] ${T}${t}${N}${n}`;e===3?console.error(g):console.log(g)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},k=new Y;import{appendFileSync as ge}from"fs";import{homedir as he}from"os";import{join as be}from"path";var Se=be(he(),".pm2","logs","claude-mem-worker-error.log");function p(d,e,s=""){let t=new Date().toISOString(),c=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),_=c?`${c[1].split("/").pop()}:${c[2]}`:"unknown",T=`[${t}] [SILENT-DEBUG] [${_}] ${d}`;if(e!==void 0)try{T+=` ${JSON.stringify(e)}`}catch(n){T+=` [stringify error: ${n}]`}T+=`
`;try{ge(Se,T)}catch{}return s}var w=class{db;constructor(){te(y),this.db=new fe(se),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(_=>_.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(_=>_.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(_=>_.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(i=>i.name==="endless_original_tokens"),r=s.some(i=>i.name==="endless_compressed_tokens"),a=s.some(i=>i.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),a||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||p("SessionStore.getObservationById: No observation found",{id:e},null)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,a=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${a}
      ${i}
    `).all(...e)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||p("SessionStore.getSummaryForSession: No summary found",{sdkSessionId:e},null)}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),r=new Set,a=new Set;for(let i of t){if(i.files_read)try{let c=JSON.parse(i.files_read);Array.isArray(c)&&c.forEach(_=>r.add(_))}catch{}if(i.files_modified)try{let c=JSON.parse(i.files_modified);Array.isArray(c)&&c.forEach(_=>a.add(_))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(a)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||p("SessionStore.getSessionById: No session found",{id:e},null)}findActiveSDKSession(e){return this.db.prepare(`
      SELECT id, sdk_session_id, project, worker_port
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(e)||p("SessionStore.findActiveSDKSession: No active session found",{claudeSessionId:e},null)}findAnySDKSession(e){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE claude_session_id = ?
      LIMIT 1
    `).get(e)||p("SessionStore.findAnySDKSession: No session found",{claudeSessionId:e},null)}reactivateSession(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(s,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||p("SessionStore.incrementPromptCounter: result or prompt_counter is null",{id:e},1)}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||p("SessionStore.getPromptCounter: prompt_counter is null",{id:e},0)}createSDKSession(e,s,t){let r=new Date,a=r.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),a);return c.lastInsertRowid===0||c.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:c.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(k.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||p("SessionStore.getWorkerPort: worker_port is null",{id:e},null)}saveUserPrompt(e,s,t){let r=new Date,a=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),a).lastInsertRowid}storeObservation(e,s,t,r,a=0){let i=new Date,c=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let N=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||p("SessionStore.storeObservation: promptNumber is null",{sdkSessionId:e},null),a,t.tool_use_id||p("SessionStore.storeObservation: tool_use_id is null",{sdkSessionId:e},null),i.toISOString(),c);return{id:Number(N.lastInsertRowid),createdAtEpoch:c}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||p("SessionStore.getObservationByToolUseId: No observation found",{toolUseId:e},null)}getAllObservationsForToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),r=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),a=new Map;for(let i of r)i.tool_use_id&&a.set(i.tool_use_id,i);return a}storeSummary(e,s,t,r,a=0){let i=new Date,c=i.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,i.toISOString(),c),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let N=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||p("SessionStore.storeSummary: promptNumber is null",{sdkSessionId:e},null),a,i.toISOString(),c);return{id:Number(N.lastInsertRowid),createdAtEpoch:c}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,a=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${a}
      ${i}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,a=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${c})
      ORDER BY up.created_at_epoch ${a}
      ${i}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,a){let i=a?"AND project = ?":"",c=a?[a]:[],_,T;if(e!==null){let b=`
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
      `;try{let h=this.db.prepare(b).all(e,...c,t+1),l=this.db.prepare(f).all(e,...c,r+1);if(h.length===0&&l.length===0)return{observations:[],sessions:[],prompts:[]};_=h.length>0?h[h.length-1].created_at_epoch:s,T=l.length>0?l[l.length-1].created_at_epoch:s}catch(h){return console.error("[SessionStore] Error getting boundary observations:",h.message),{observations:[],sessions:[],prompts:[]}}}else{let b=`
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
      `;try{let h=this.db.prepare(b).all(s,...c,t),l=this.db.prepare(f).all(s,...c,r+1);if(h.length===0&&l.length===0)return{observations:[],sessions:[],prompts:[]};_=h.length>0?h[h.length-1].created_at_epoch:s,T=l.length>0?l[l.length-1].created_at_epoch:s}catch(h){return console.error("[SessionStore] Error getting boundary timestamps:",h.message),{observations:[],sessions:[],prompts:[]}}}let n=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,N=`
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
    `;try{let b=this.db.prepare(n).all(_,T,...c),f=this.db.prepare(N).all(_,T,...c),h=this.db.prepare(g).all(_,T,...c);return{observations:b,sessions:f.map(l=>({id:l.id,sdk_session_id:l.sdk_session_id,project:l.project,request:l.request,completed:l.completed,next_steps:l.next_steps,created_at:l.created_at,created_at_epoch:l.created_at_epoch})),prompts:h.map(l=>({id:l.id,claude_session_id:l.claude_session_id,project:l.project,prompt:l.prompt_text,created_at:l.created_at,created_at_epoch:l.created_at_epoch}))}}catch(b){return console.error("[SessionStore] Error querying timeline records:",b.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||p("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||p("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||p("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};import{existsSync as Re,readFileSync as Oe}from"fs";import{homedir as Ne}from"os";import Ie from"path";function K(d,e,s){if(d!==void 0){if(typeof d=="boolean")return d;if(typeof d=="string")return d.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function q(d,e,s){if(d!==void 0){if(typeof d=="number")return d;if(typeof d=="string"){let t=parseInt(d,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function ve(){let d=Ie.join(Ne(),".claude-mem","settings.json"),e={};if(Re(d))try{e=JSON.parse(Oe(d,"utf-8"))}catch(T){k.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},T)}let s=K(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=K(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=q(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),a=q(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),i=q(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),c=K(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),_={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:a,maxToolHistoryMB:i,enableSynchronousMode:c};return s?k.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:a,maxToolHistoryMB:`${i}MB`,syncMode:c}):k.debug("CONFIG","Endless Mode disabled"),_}var F=class{static getConfig=ve;static clearCache(){}};function ke(){try{let d=X.join(Le(),".claude","settings.json");if(ye(d)){let e=JSON.parse(Ae(d,"utf-8"));if(e.env?.CLAUDE_MEM_CONTEXT_OBSERVATIONS){let s=parseInt(e.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS,10);if(!isNaN(s)&&s>0)return s}}}catch{}return parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS||p("context-hook: CLAUDE_MEM_CONTEXT_OBSERVATIONS not set",{},"50"),10)}var Ce=ke(),re=10,ne=4,De=1,o={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m",red:"\x1B[31m"};function xe(d){if(!d)return[];try{let e=JSON.parse(d);return Array.isArray(e)?e:[]}catch{return[]}}function Me(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})}function $e(d){return new Date(d).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})}function Ue(d){return new Date(d).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})}function we(d,e){return X.isAbsolute(d)?X.relative(e,d):d}function B(d,e,s,t){return e?t?[`${s}${d}:${o.reset} ${e}`,""]:[`**${d}**: ${e}`,""]:[]}async function oe(d,e=!1){let s=d?.cwd??process.cwd(),t=s?X.basename(s):"unknown-project",r=new w,a=r.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(t,Ce),i=r.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(t,re+De);if(a.length===0&&i.length===0)return r.close(),e?`
${o.bright}${o.cyan}\u{1F4DD} [${t}] recent context${o.reset}
${o.gray}${"\u2500".repeat(60)}${o.reset}

${o.dim}No previous sessions found for this project yet.${o.reset}
`:`# [${t}] recent context

No previous sessions found for this project yet.`;let c=a,_=i.slice(0,re),T=c,n=[];if(e?(n.push(""),n.push(`${o.bright}${o.cyan}\u{1F4DD} [${t}] recent context${o.reset}`),n.push(`${o.gray}${"\u2500".repeat(60)}${o.reset}`),n.push("")):(n.push(`# [${t}] recent context`),n.push("")),T.length>0){e?n.push(`${o.dim}Legend: \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision${o.reset}`):n.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u2696\uFE0F  decision"),n.push(""),e?(n.push(`${o.bright}\u{1F4A1} Column Key${o.reset}`),n.push(`${o.dim}  Read: Tokens to read this observation (cost to learn it now)${o.reset}`),n.push(`${o.dim}  Work: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)${o.reset}`)):(n.push("\u{1F4A1} **Column Key**:"),n.push("- **Read**: Tokens to read this observation (cost to learn it now)"),n.push("- **Work**: Tokens spent on work that produced this record (\u{1F50D} research, \u{1F6E0}\uFE0F building, \u2696\uFE0F  deciding)")),n.push(""),e?(n.push(`${o.dim}\u{1F4A1} Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${o.reset}`),n.push(""),n.push(`${o.dim}When you need implementation details, rationale, or debugging context:${o.reset}`),n.push(`${o.dim}  - Use the mem-search skill to fetch full observations on-demand${o.reset}`),n.push(`${o.dim}  - Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching${o.reset}`),n.push(`${o.dim}  - Trust this index over re-reading code for past decisions and learnings${o.reset}`)):(n.push("\u{1F4A1} **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work."),n.push(""),n.push("When you need implementation details, rationale, or debugging context:"),n.push("- Use the mem-search skill to fetch full observations on-demand"),n.push("- Critical types (\u{1F534} bugfix, \u2696\uFE0F decision) often need detailed fetching"),n.push("- Trust this index over re-reading code for past decisions and learnings")),n.push("");let g=c.length,b=c.reduce((u,E)=>{let S=(E.title?.length||p("context-hook: obs.title.length is null",{obsId:E.id},0))+(E.subtitle?.length||p("context-hook: obs.subtitle.length is null",{obsId:E.id},0))+(E.narrative?.length||p("context-hook: obs.narrative.length is null",{obsId:E.id},0))+JSON.stringify(E.facts||p("context-hook: obs.facts is null",{obsId:E.id},[])).length;return u+Math.ceil(S/ne)},0),f=c.reduce((u,E)=>u+(E.discovery_tokens||p("context-hook: obs.discovery_tokens is null",{obsId:E.id},0)),0),h=f-b,l=f>0?Math.round(h/f*100):0;e?(n.push(`${o.bright}${o.cyan}\u{1F4CA} Context Economics${o.reset}`),n.push(`${o.dim}  Loading: ${g} observations (${b.toLocaleString()} tokens to read)${o.reset}`),n.push(`${o.dim}  Work investment: ${f.toLocaleString()} tokens spent on research, building, and decisions${o.reset}`),f>0&&n.push(`${o.green}  Your savings: ${h.toLocaleString()} tokens (${l}% reduction from reuse)${o.reset}`),n.push("")):(n.push("\u{1F4CA} **Context Economics**:"),n.push(`- Loading: ${g} observations (${b.toLocaleString()} tokens to read)`),n.push(`- Work investment: ${f.toLocaleString()} tokens spent on research, building, and decisions`),f>0&&n.push(`- Your savings: ${h.toLocaleString()} tokens (${l}% reduction from reuse)`),n.push(""));let J=i[0]?.id,H=_.map((u,E)=>{let S=E===0?null:i[E+1];return{...u,displayEpoch:S?S.created_at_epoch:u.created_at_epoch,displayTime:S?S.created_at:u.created_at,shouldShowLink:u.id!==J}}),M=[...T.map(u=>({type:"observation",data:u})),...H.map(u=>({type:"summary",data:u}))];M.sort((u,E)=>{let S=u.type==="observation"?u.data.created_at_epoch:u.data.displayEpoch,A=E.type==="observation"?E.data.created_at_epoch:E.data.displayEpoch;return S-A});let $=new Map;for(let u of M){let E=u.type==="observation"?u.data.created_at:u.data.displayTime,S=Ue(E);$.has(S)||$.set(S,[]),$.get(S).push(u)}let ie=Array.from($.entries()).sort((u,E)=>{let S=new Date(u[0]).getTime(),A=new Date(E[0]).getTime();return S-A});for(let[u,E]of ie){e?(n.push(`${o.bright}${o.cyan}${u}${o.reset}`),n.push("")):(n.push(`### ${u}`),n.push(""));let S=null,A="",C=!1;for(let j of E)if(j.type==="summary"){C&&(n.push(""),C=!1,S=null,A="");let m=j.data,D=`${m.request||p("context-hook: summary.request is null",{summaryId:m.id},"Session started")} (${Me(m.displayTime)})`,I=m.shouldShowLink?`claude-mem://session-summary/${m.id}`:"";if(e){let v=I?`${o.dim}[${I}]${o.reset}`:"";n.push(`\u{1F3AF} ${o.yellow}#S${m.id}${o.reset} ${D} ${v}`)}else{let v=I?` [\u2192](${I})`:"";n.push(`**\u{1F3AF} #S${m.id}** ${D}${v}`)}n.push("")}else{let m=j.data,D=xe(m.files_modified),I=D.length>0?we(D[0],s):"General";I!==S&&(C&&n.push(""),e?n.push(`${o.dim}${I}${o.reset}`):n.push(`**${I}**`),e||(n.push("| ID | Time | T | Title | Read | Work |"),n.push("|----|------|---|-------|------|------|")),S=I,C=!0,A="");let v=$e(m.created_at),z=m.title||p("context-hook: obs.title is null",{obsId:m.id},"Untitled"),L="\u2022";switch(m.type){case"bugfix":L="\u{1F534}";break;case"feature":L="\u{1F7E3}";break;case"refactor":L="\u{1F504}";break;case"change":L="\u2705";break;case"discovery":L="\u{1F535}";break;case"decision":L="\u2696\uFE0F";break;default:L="\u2022"}let ae=(m.title?.length||p("context-hook: obs.title.length is null (timeline)",{obsId:m.id},0))+(m.subtitle?.length||p("context-hook: obs.subtitle.length is null (timeline)",{obsId:m.id},0))+(m.narrative?.length||p("context-hook: obs.narrative.length is null (timeline)",{obsId:m.id},0))+JSON.stringify(m.facts||p("context-hook: obs.facts is null (timeline)",{obsId:m.id},[])).length,W=Math.ceil(ae/ne),U=m.discovery_tokens||p("context-hook: obs.discovery_tokens is null (timeline)",{obsId:m.id},0),x="\u{1F50D}";switch(m.type){case"discovery":x="\u{1F50D}";break;case"change":case"feature":case"bugfix":case"refactor":x="\u{1F6E0}\uFE0F";break;case"decision":x="\u2696\uFE0F";break}let de=U>0?`${x} ${U.toLocaleString()}`:"-",Z=v!==A,ce=Z?v:"";if(A=v,e){let le=Z?`${o.dim}${v}${o.reset}`:" ".repeat(v.length),pe=W>0?`${o.dim}(~${W}t)${o.reset}`:"",_e=U>0?`${o.dim}(${x} ${U.toLocaleString()}t)${o.reset}`:"";n.push(`  ${o.dim}#${m.id}${o.reset}  ${le}  ${L}  ${z} ${pe} ${_e}`)}else n.push(`| #${m.id} | ${ce||p("context-hook: timeDisplay is null",{obsId:m.id},"\u2033")} | ${L} | ${z} | ~${W} | ${de} |`)}C&&n.push("")}let O=i[0],Q=c[0];if(O&&(O.investigated||O.learned||O.completed||O.next_steps)&&(!Q||O.created_at_epoch>Q.created_at_epoch)&&(n.push(...B("Investigated",O.investigated,o.blue,e)),n.push(...B("Learned",O.learned,o.yellow,e)),n.push(...B("Completed",O.completed,o.green,e)),n.push(...B("Next Steps",O.next_steps,o.magenta,e))),f>0&&h>0){let u=Math.round(f/1e3);n.push(""),e?n.push(`${o.dim}\u{1F4B0} Access ${u}k tokens of past research & decisions for just ${b.toLocaleString()}t. Use claude-mem search to access memories by ID instead of re-reading files.${o.reset}`):n.push(`\u{1F4B0} Access ${u}k tokens of past research & decisions for just ${b.toLocaleString()}t. Use claude-mem search to access memories by ID instead of re-reading files.`)}}if(F.getConfig().enabled){let g=r.db.prepare(`
      SELECT claude_session_id, endless_original_tokens, endless_compressed_tokens, endless_tokens_saved
      FROM sdk_sessions
      WHERE project = ? AND status = 'completed'
        AND endless_tokens_saved > 0
      ORDER BY completed_at_epoch DESC
      LIMIT 1
    `).get(t);if(g&&g.endless_tokens_saved>0)if(n.push(""),n.push(""),e){n.push(`${o.bright}${o.magenta}\u{1F504} Endless Mode Stats${o.reset}`),n.push(`${o.dim}  Tokens saved last session: ${g.endless_tokens_saved.toLocaleString()}${o.reset}`),n.push(`${o.dim}  Without compression: ${g.endless_original_tokens.toLocaleString()}t would pile up exponentially${o.reset}`),n.push(`${o.dim}  With compression: ${g.endless_compressed_tokens.toLocaleString()}t keeps context manageable${o.reset}`);let b=Math.round(g.endless_tokens_saved/g.endless_original_tokens*100);n.push(`${o.green}  Compression ratio: ${b}% reduction${o.reset}`)}else{n.push("\u{1F504} **Endless Mode Stats**"),n.push(`- Tokens saved last session: ${g.endless_tokens_saved.toLocaleString()}`),n.push(`- Without compression: ${g.endless_original_tokens.toLocaleString()}t would pile up exponentially`),n.push(`- With compression: ${g.endless_compressed_tokens.toLocaleString()}t keeps context manageable`);let b=Math.round(g.endless_tokens_saved/g.endless_original_tokens*100);n.push(`- Compression ratio: ${b}% reduction`)}}return r.close(),n.join(`
`).trimEnd()}var Fe=process.argv.includes("--colors");if(V.isTTY||Fe)oe(void 0,!0).then(d=>{console.log(d),process.exit(0)});else{let d="";V.on("data",e=>d+=e),V.on("end",async()=>{let e=d.trim()?JSON.parse(d):void 0,t={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:await oe(e,!1)}};console.log(JSON.stringify(t)),process.exit(0)})}
