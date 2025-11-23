#!/usr/bin/env node
import{stdin as ne}from"process";import{readFileSync as G,writeFileSync as Pe,renameSync as Xe,copyFileSync as je,existsSync as $e,createReadStream as We}from"fs";import{dirname as Ge,join as Ke,basename as Ye}from"path";import{createInterface as ze}from"readline";import be from"better-sqlite3";import{join as h,dirname as pe,basename as le}from"path";import{homedir as J}from"os";import{existsSync as os,mkdirSync as ue}from"fs";import{fileURLToPath as _e}from"url";function me(){return typeof __dirname<"u"?__dirname:pe(_e(import.meta.url))}var Ee=me(),A=process.env.CLAUDE_MEM_DATA_DIR||h(J(),".claude-mem"),B=process.env.CLAUDE_CONFIG_DIR||h(J(),".claude"),is=h(A,"archives"),as=h(A,"logs"),cs=h(A,"trash"),k=h(A,"backups"),ds=h(A,"settings.json"),q=h(A,"claude-mem.db"),ps=h(A,"vector-db"),ls=h(B,"settings.json"),us=h(B,"commands"),_s=h(B,"CLAUDE.md");function D(o){ue(o,{recursive:!0})}function V(){return h(Ee,"..","..")}function Q(o){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=le(o);return h(k,`${s}.backup.${e}`)}var P=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(P||{}),X=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=P[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,n){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),a=P[e].padEnd(5),c=s.padEnd(6),l="";r?.correlationId?l=`[${r.correlationId}] `:r?.sessionId&&(l=`[session-${r.sessionId}] `);let f="";n!=null&&(this.level===0&&typeof n=="object"?f=`
`+JSON.stringify(n,null,2):f=" "+this.formatData(n));let _="";if(r){let{sessionId:T,sdkSessionId:O,correlationId:m,...d}=r;Object.keys(d).length>0&&(_=` {${Object.entries(d).map(([S,N])=>`${S}=${N}`).join(", ")}}`)}let g=`[${i}] [${a}] [${c}] ${l}${t}${_}${f}`;e===3?console.error(g):console.log(g)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},u=new X;import{appendFileSync as Te}from"fs";import{homedir as ge}from"os";import{join as fe}from"path";var Se=fe(ge(),".pm2","logs","claude-mem-worker-error.log");function E(o,e,s=""){let t=new Date().toISOString(),a=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),c=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",l=`[${t}] [HAPPY-PATH-ERROR] [${c}] ${o}`;if(e!==void 0)try{l+=` ${JSON.stringify(e)}`}catch(f){l+=` [stringify error: ${f}]`}l+=`
`;try{Te(Se,l)}catch{}return s}var U=class{db;constructor(){D(A),this.db=new be(q),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
    `).run(s,e).changes===0?(u.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
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
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}storeObservation(e,s,t,r,n=0){let i=new Date,a=i.getTime();this.db.prepare(`
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
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,n){let i=n?"AND project = ?":"",a=n?[n]:[],c,l;if(e!==null){let T=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,O=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let m=this.db.prepare(T).all(e,...a,t+1),d=this.db.prepare(O).all(e,...a,r+1);if(m.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};c=m.length>0?m[m.length-1].created_at_epoch:s,l=d.length>0?d[d.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary observations:",m.message),{observations:[],sessions:[],prompts:[]}}}else{let T=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,O=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let m=this.db.prepare(T).all(s,...a,t),d=this.db.prepare(O).all(s,...a,r+1);if(m.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};c=m.length>0?m[m.length-1].created_at_epoch:s,l=d.length>0?d[d.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary timestamps:",m.message),{observations:[],sessions:[],prompts:[]}}}let f=`
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
    `;try{let T=this.db.prepare(f).all(c,l,...a),O=this.db.prepare(_).all(c,l,...a),m=this.db.prepare(g).all(c,l,...a);return{observations:T,sessions:O.map(d=>({id:d.id,sdk_session_id:d.sdk_session_id,project:d.project,request:d.request,completed:d.completed,next_steps:d.next_steps,created_at:d.created_at,created_at_epoch:d.created_at_epoch})),prompts:m.map(d=>({id:d.id,claude_session_id:d.claude_session_id,project:d.project,prompt:d.prompt_text,created_at:d.created_at,created_at_epoch:d.created_at_epoch}))}}catch(T){return console.error("[SessionStore] Error querying timeline records:",T.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||E("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||E("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||E("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};function Oe(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||E("hook-response: options.reason is null",{},"Pre-compact operation failed"),suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function L(o,e,s={}){let t=Oe(o,e,s);return JSON.stringify(t)}import Z from"path";import{homedir as Re}from"os";import{existsSync as ee,readFileSync as he}from"fs";import{execSync as Ne}from"child_process";var ye=100,Ie=500,ve=10;function F(){try{let o=Z.join(Re(),".claude-mem","settings.json");if(ee(o)){let e=JSON.parse(he(o,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function se(){try{let o=F();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(ye)})).ok}catch{return!1}}async function Ae(){try{let o=V(),e=Z.join(o,"ecosystem.config.cjs");if(!ee(e))throw new Error(`Ecosystem config not found at ${e}`);Ne(`pm2 start "${e}"`,{cwd:o,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<ve;s++)if(await new Promise(t=>setTimeout(t,Ie)),await se())return!0;return!1}catch{return!1}}async function te(){if(await se())return;if(!await Ae()){let e=F();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{existsSync as Le,readFileSync as Ce}from"fs";import{homedir as ke}from"os";import De from"path";function j(o,e,s){if(o!==void 0){if(typeof o=="boolean")return o;if(typeof o=="string")return o.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function $(o,e,s){if(o!==void 0){if(typeof o=="number")return o;if(typeof o=="string"){let t=parseInt(o,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function Me(){let o=De.join(ke(),".claude-mem","settings.json"),e={};if(Le(o))try{e=JSON.parse(Ce(o,"utf-8"))}catch(l){u.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},l)}let s=j(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=j(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=$(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),n=$(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),i=$(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),a=j(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),c={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:n,maxToolHistoryMB:i,enableSynchronousMode:a};return s?u.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:n,maxToolHistoryMB:`${i}MB`,syncMode:a}):u.debug("CONFIG","Endless Mode disabled"),c}var x=class{static getConfig=Me;static clearCache(){}};import{existsSync as Ue,readFileSync as xe,writeFileSync as we,appendFileSync as Fe,statSync as He}from"fs";import{join as Be}from"path";var w=Be(k,"tool-outputs.jsonl");function W(o,e,s=Date.now()){D(k);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),i=JSON.stringify({tool_use_id:o,content:e,timestamp:s,size_bytes:r})+`
`;Fe(w,i,"utf8")}function re(o){if(!Ue(w)||He(w).size/(1024*1024)<=o)return;let r=xe(w,"utf8").trim().split(`
`).filter(_=>_.length>0),n=[];for(let _ of r)try{n.push(JSON.parse(_))}catch{continue}n.sort((_,g)=>_.timestamp-g.timestamp);let i=o*1024*1024,a=0,c=0;for(let _=n.length-1;_>=0;_--){let g=n[_].size_bytes+100;if(a+g>i){c=_+1;break}a+=g}let f=n.slice(c).map(_=>JSON.stringify(_)).join(`
`)+`
`;we(w,f,"utf8")}var Je=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function H(o,e){if(!o)return[];if(Array.isArray(o))return o;try{let s=JSON.parse(o);return Array.isArray(s)?s:[]}catch(s){return u.debug("HOOK",`Failed to parse ${e}`,{field:o,error:s}),[]}}function qe(o){let e=[];e.push(`## ${o.title}`),o.subtitle&&e.push(o.subtitle),o.narrative&&e.push(o.narrative);let s=H(o.facts,"facts");s.length>0&&e.push(`Facts: ${s.join("; ")}`);let t=H(o.concepts,"concepts");t.length>0&&e.push(`Concepts: ${t.join(", ")}`);let r=H(o.files_read,"files_read");r.length>0&&e.push(`Files read: ${r.join(", ")}`);let n=H(o.files_modified,"files_modified");return n.length>0&&e.push(`Files modified: ${n.join(", ")}`),e.join(`

`)}async function Ve(o){let e=new Set;try{let s=We(o),t=ze({input:s,crlfDelay:1/0});for await(let i of t)if(i.includes("agentId"))try{let a=JSON.parse(i);a.toolUseResult?.agentId&&e.add(a.toolUseResult.agentId)}catch{}let r=Ge(o),n=Array.from(e).map(i=>Ke(r,`agent-${i}.jsonl`)).filter(i=>$e(i));return u.debug("HOOK","Discovered agent transcripts",{agentCount:e.size,filesFound:n.length,agentFiles:n.map(i=>Ye(i))}),n}catch(s){return u.warn("HOOK","Failed to discover agent files",{mainTranscriptPath:o},s),[]}}async function et(o,e,s=[]){let t=await Ve(o),r=await oe(o,e,s),n=0,i=0;for(let a of t)try{let c=await oe(a,e,[]);n+=c.originalTokens,i+=c.compressedTokens}catch(c){u.warn("HOOK","Failed to transform agent transcript",{agentFile:a},c)}return{originalTokens:r.originalTokens+n,compressedTokens:r.compressedTokens+i}}async function oe(o,e,s=[]){try{D(k);let p=Q(o);je(o,p),u.info("HOOK","Created transcript backup",{original:o,backup:p})}catch(p){throw u.error("HOOK","Failed to create transcript backup",{transcriptPath:o},p),new Error("Backup creation failed - aborting transformation for safety")}let r=G(o,"utf-8").trim().split(`
`),n={totalOriginalSize:0,totalCompressedSize:0,transformCount:0},i=new U,a=i.getAllObservationsForToolUseId(e);if(a.length===0)return i.close(),u.debug("HOOK","No observations found for rolling replacement",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let c=new Set(s);c.add(e),u.info("HOOK","Rolling replacement scope",{toolUseId:e,cycleSize:c.size,observationCount:a.length});let l=a.map(p=>qe(p)).join(`

`),f={type:"assistant",message:{role:"assistant",content:[{type:"text",text:l}]}},_=l.length,g=new Set,T=new Set,O=new Set;for(let p of r)if(p.trim())try{let y=JSON.parse(p);if(y.type==="assistant"&&Array.isArray(y.message?.content)){for(let b of y.message.content)if(b.type==="tool_use"){let v=b;v.id&&c.has(v.id)&&T.add(v.id)}}if(y.type==="user"&&Array.isArray(y.message?.content)){for(let b of y.message.content)if(b.type==="tool_result"){let v=b;v.tool_use_id&&c.has(v.tool_use_id)&&O.add(v.tool_use_id)}}}catch{continue}for(let p of c)T.has(p)&&O.has(p)&&g.add(p);if(u.info("HOOK","Validated tool pairs for replacement",{requestedIds:c.size,validatedIds:g.size,toolUseOnly:Array.from(T).filter(p=>!O.has(p)),toolResultOnly:Array.from(O).filter(p=>!T.has(p))}),g.size===0)return i.close(),u.debug("HOOK","No complete tool_use/tool_result pairs found for replacement",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let m=[],d=!1,R=-1,S=0,N=!1;for(let p=0;p<r.length;p++){let y=r[p];if(!y.trim()){m.push(y);continue}try{let b=JSON.parse(y);if(b.type==="assistant"&&Array.isArray(b.message?.content)){let v=b;for(let M of v.message.content)if(M.type==="tool_use"){let I=M;if(I.id&&g.has(I.id)){d||(d=!0,R=p,u.debug("HOOK","Replacement zone start",{toolUseId:I.id,lineIndex:p}));try{W(I.id,JSON.stringify(I.input),Date.now())}catch(z){u.warn("HOOK","Failed to backup original tool input",{toolUseId:I.id},z)}S+=y.length,N=!0;break}}if(d&&N)continue}if(b.type==="user"&&Array.isArray(b.message?.content)&&N){let v=b;for(let M of v.message.content)if(M.type==="tool_result"){let I=M;if(I.tool_use_id&&g.has(I.tool_use_id)){try{W(I.tool_use_id,JSON.stringify(I.content),Date.now())}catch(de){u.warn("HOOK","Failed to backup original tool output",{toolUseId:I.tool_use_id},de)}S+=y.length,I.tool_use_id===e&&(m.push(JSON.stringify(f)),d=!1,N=!1,n.totalOriginalSize+=S,n.totalCompressedSize+=_,n.transformCount++,u.success("HOOK","Rolling replacement complete",{zoneStart:R,zoneEnd:p,toolsReplaced:g.size,originalSize:S,compressedSize:_,savings:`${Math.round((1-_/S)*100)}%`}));continue}}}(!d||!N)&&m.push(y)}catch(b){throw u.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:p,error:b}),new Error(`Malformed JSONL line at index ${p}: ${b.message}`)}}i.close();let C=`${o}.tmp`;Pe(C,m.join(`
`)+`
`,"utf-8");let ie=G(C,"utf-8").trim().split(`
`);for(let p of ie)p.trim()&&JSON.parse(p);Xe(C,o);let Y=4,ae=Math.ceil(n.totalOriginalSize/Y),ce=Math.ceil(n.totalCompressedSize/Y);u.success("HOOK","Transcript transformation complete",{toolUseId:e,transformCount:n.transformCount,totalOriginalSize:n.totalOriginalSize,totalCompressedSize:n.totalCompressedSize,savings:n.totalOriginalSize>0?`${Math.round((1-n.totalCompressedSize/n.totalOriginalSize)*100)}%`:"0%"});try{let p=x.getConfig();p.maxToolHistoryMB>0&&(re(p.maxToolHistoryMB),u.debug("HOOK","Trimmed tool output backup",{maxSizeMB:p.maxToolHistoryMB}))}catch(p){u.warn("HOOK","Failed to trim tool output backup",{},p)}return{originalTokens:ae,compressedTokens:ce}}async function Qe(o){o||(u.warn("HOOK","PostToolUse called with no input"),console.log(L("PostToolUse",!0)),process.exit(0));let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:n,transcript_path:i,tool_use_id:a}=o;Je.has(t)&&(console.log(L("PostToolUse",!0)),process.exit(0)),await te();let c=new U,l=c.createSDKSession(e,"",""),f=c.getPromptCounter(l);c.close();let _=u.formatTool(t,r),g=F(),T=a;if(!T&&i)try{let R=G(i,"utf-8").trim().split(`
`);for(let S=R.length-1;S>=0;S--){let N=JSON.parse(R[S]);if(N.type==="user"&&Array.isArray(N.message.content)){for(let C of N.message.content)if(C.type==="tool_result"&&C.tool_use_id){T=C.tool_use_id;break}if(T)break}}}catch(d){E("Failed to extract tool_use_id from transcript",{error:d})}u.dataIn("HOOK",`PostToolUse: ${_}`,{sessionDbId:l,claudeSessionId:e,workerPort:g,toolUseId:T||E("tool_use_id not found in transcript",{toolName:t},"(none)")});let O=x.getConfig(),m=!!(O.enabled&&T&&i);E("Endless Mode Check",{configEnabled:O.enabled,hasToolUseId:!!T,hasTranscriptPath:!!i,isEndlessModeEnabled:m,toolName:t,toolUseId:T,allInputKeys:Object.keys(o).join(", ")});try{let d=m?parseInt(process.env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS||(E("CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS not set, using default 90000ms"),"90000"),10):2e3,R=await fetch(`http://127.0.0.1:${g}/sessions/${l}/observations?wait_until_obs_is_saved=${m}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_response:n!==void 0?JSON.stringify(n):"{}",prompt_number:f,cwd:s||E("save-hook: cwd missing",{sessionDbId:l,tool_name:t}),tool_use_id:T,transcript_path:i||E("save-hook: transcript_path missing",{sessionDbId:l,tool_name:t})}),signal:AbortSignal.timeout(d)});if(!R.ok){let N=await R.text();u.failure("HOOK","Failed to send observation",{sessionDbId:l,status:R.status},N),console.log(L("PostToolUse",!0)),process.exit(0)}let S=await R.json();S.status==="completed"?console.log("[save-hook] \u2705 Observation created, transcript transformed"):S.status==="skipped"?console.log("[save-hook] \u23ED\uFE0F  No observation needed, continuing"):S.status==="timeout"&&console.warn(`[save-hook] \u23F1\uFE0F  Timeout after ${d}ms - processing async`),u.debug("HOOK","Observation sent successfully",{sessionDbId:l,toolName:t,mode:m?"synchronous (Endless Mode)":"async"})}catch(d){if(d.cause?.code==="ECONNREFUSED"){let R="Worker connection failed. Try: pm2 restart claude-mem-worker";u.failure("HOOK","Worker connection refused",{sessionDbId:l},d),console.error(`[save-hook] ${R}`),console.log(L("PostToolUse",!1,{reason:R})),process.exit(2)}console.warn("[save-hook] \u274C Failed to send observation:",d.message),u.warn("HOOK","Observation request failed - continuing anyway",{sessionDbId:l,toolName:t,error:d.message}),console.log(L("PostToolUse",!0)),process.exit(0)}console.log(L("PostToolUse",!0)),process.exit(0)}var K="";ne.on("data",o=>K+=o);ne.on("end",async()=>{try{let o=K?JSON.parse(K):void 0;await Qe(o)}catch(o){console.error(`[save-hook] Unhandled error: ${o.message}`),console.log(L("PostToolUse",!1,{reason:o.message})),process.exit(1)}});export{qe as formatObservationAsMarkdown,oe as transformTranscript,et as transformTranscriptWithAgents};
