#!/usr/bin/env node
import Ts from"path";import{stdin as he}from"process";import Ue from"better-sqlite3";import{join as R,dirname as Ne,basename as Ie}from"path";import{homedir as ce}from"os";import{existsSync as ys,mkdirSync as ve}from"fs";import{fileURLToPath as Ae}from"url";function Ce(){return typeof __dirname<"u"?__dirname:Ne(Ae(import.meta.url))}var ke=Ce(),M=process.env.CLAUDE_MEM_DATA_DIR||R(ce(),".claude-mem"),K=process.env.CLAUDE_CONFIG_DIR||R(ce(),".claude"),Ns=R(M,"archives"),Is=R(M,"logs"),vs=R(M,"trash"),x=R(M,"backups"),As=R(M,"settings.json"),pe=R(M,"claude-mem.db"),Cs=R(M,"vector-db"),ks=R(K,"settings.json"),Ls=R(K,"commands"),Ds=R(K,"CLAUDE.md");function U(r){ve(r,{recursive:!0})}function G(){return R(ke,"..","..")}function j(r){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=Ie(r);return R(x,`${s}.backup.${e}`)}var J=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(J||{}),Y=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=J[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let o=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${o})`}if(e==="Read"&&t.file_path){let o=t.file_path.split("/").pop()||t.file_path;return`${e}(${o})`}if(e==="Edit"&&t.file_path){let o=t.file_path.split("/").pop()||t.file_path;return`${e}(${o})`}if(e==="Write"&&t.file_path){let o=t.file_path.split("/").pop()||t.file_path;return`${e}(${o})`}return e}catch{return e}}log(e,s,t,o,n){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),a=J[e].padEnd(5),c=s.padEnd(6),p="";o?.correlationId?p=`[${o.correlationId}] `:o?.sessionId&&(p=`[session-${o.sessionId}] `);let T="";n!=null&&(this.level===0&&typeof n=="object"?T=`
`+JSON.stringify(n,null,2):T=" "+this.formatData(n));let _="";if(o){let{sessionId:u,sdkSessionId:E,correlationId:S,...l}=o;Object.keys(l).length>0&&(_=` {${Object.entries(l).map(([b,y])=>`${b}=${y}`).join(", ")}}`)}let f=`[${i}] [${a}] [${c}] ${p}${t}${_}${T}`;e===3?console.error(f):console.log(f)}debug(e,s,t,o){this.log(0,e,s,t,o)}info(e,s,t,o){this.log(1,e,s,t,o)}warn(e,s,t,o){this.log(2,e,s,t,o)}error(e,s,t,o){this.log(3,e,s,t,o)}dataIn(e,s,t,o){this.info(e,`\u2192 ${s}`,t,o)}dataOut(e,s,t,o){this.info(e,`\u2190 ${s}`,t,o)}success(e,s,t,o){this.info(e,`\u2713 ${s}`,t,o)}failure(e,s,t,o){this.error(e,`\u2717 ${s}`,t,o)}timing(e,s,t,o){this.info(e,`\u23F1 ${s}`,o,{duration:`${t}ms`})}},d=new Y;import{appendFileSync as Le}from"fs";import{homedir as De}from"os";import{join as Me}from"path";var xe=Me(De(),".pm2","logs","claude-mem-worker-error.log");function g(r,e,s=""){let t=new Date().toISOString(),a=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),c=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",p=`[${t}] [HAPPY-PATH-ERROR] [${c}] ${r}`;if(e!==void 0)try{p+=` ${JSON.stringify(e)}`}catch(T){p+=` [stringify error: ${T}]`}p+=`
`;try{Le(xe,p)}catch{}return s}var D=g;var w=class{db;constructor(){U(M),this.db=new Ue(pe),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(o=>o.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(c=>c.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(o=>o.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(o){throw this.db.exec("ROLLBACK"),o}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.pragma("table_info(observations)").some(o=>o.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.pragma("table_info(observations)").find(o=>o.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.error("[SessionStore] Successfully made observations.text nullable")}catch(o){throw this.db.exec("ROLLBACK"),o}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.pragma("table_info(user_prompts)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.error("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(o=>o.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(i=>i.name==="endless_original_tokens"),o=s.some(i=>i.name==="endless_compressed_tokens"),n=s.some(i=>i.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),o||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),n||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||g("SessionStore.getObservationById: No observation found",{id:e},null)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:o}=s,n=t==="date_asc"?"ASC":"DESC",i=o?`LIMIT ${o}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).get(e)||g("SessionStore.getSummaryForSession: No summary found",{sdkSessionId:e},null)}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),o=new Set,n=new Set;for(let i of t){if(i.files_read)try{let a=JSON.parse(i.files_read);Array.isArray(a)&&a.forEach(c=>o.add(c))}catch{}if(i.files_modified)try{let a=JSON.parse(i.files_modified);Array.isArray(a)&&a.forEach(c=>n.add(c))}catch{}}return{filesRead:Array.from(o),filesModified:Array.from(n)}}getSessionById(e){return this.db.prepare(`
      SELECT id, claude_session_id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||g("SessionStore.getSessionById: No session found",{id:e},null)}findActiveSDKSession(e){return this.db.prepare(`
      SELECT id, sdk_session_id, project, worker_port
      FROM sdk_sessions
      WHERE claude_session_id = ? AND status = 'active'
      LIMIT 1
    `).get(e)||g("SessionStore.findActiveSDKSession: No active session found",{claudeSessionId:e},null)}findAnySDKSession(e){return this.db.prepare(`
      SELECT id
      FROM sdk_sessions
      WHERE claude_session_id = ?
      LIMIT 1
    `).get(e)||g("SessionStore.findAnySDKSession: No session found",{claudeSessionId:e},null)}reactivateSession(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(s,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||g("SessionStore.incrementPromptCounter: result or prompt_counter is null",{id:e},1)}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||g("SessionStore.getPromptCounter: prompt_counter is null",{id:e},0)}createSDKSession(e,s,t){let o=new Date,n=o.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,o.toISOString(),n);return a.lastInsertRowid===0||a.changes===0?(s&&s.trim()!==""&&this.db.prepare(`
          UPDATE sdk_sessions
          SET project = ?, user_prompt = ?
          WHERE claude_session_id = ?
        `).run(s,t,e),this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id):a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(d.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||g("SessionStore.getWorkerPort: worker_port is null",{id:e},null)}saveUserPrompt(e,s,t){let o=new Date,n=o.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,o.toISOString(),n).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE claude_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}storeObservation(e,s,t,o,n=0){let i=new Date,a=i.getTime();this.db.prepare(`
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
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),o||g("SessionStore.storeObservation: promptNumber is null",{sdkSessionId:e},null),n,t.tool_use_id||g("SessionStore.storeObservation: tool_use_id is null",{sdkSessionId:e},null),i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      LIMIT 1
    `).get(e)||g("SessionStore.getObservationByToolUseId: No observation found",{toolUseId:e},null)}getAllObservationsForToolUseId(e){return this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationsByToolUseIds(e){if(e.length===0)return new Map;let s=e.map(()=>"?").join(","),o=this.db.prepare(`
      SELECT * FROM observations
      WHERE tool_use_id IN (${s})
    `).all(...e),n=new Map;for(let i of o)i.tool_use_id&&n.set(i.tool_use_id,i);return n}storeSummary(e,s,t,o,n=0){let i=new Date,a=i.getTime();this.db.prepare(`
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
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,o||g("SessionStore.storeSummary: promptNumber is null",{sdkSessionId:e},null),n,i.toISOString(),a);return{id:Number(_.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:o}=s,n=t==="date_asc"?"ASC":"DESC",i=o?`LIMIT ${o}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${n}
      ${i}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:o}=s,n=t==="date_asc"?"ASC":"DESC",i=o?`LIMIT ${o}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${n}
      ${i}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,o){return this.getTimelineAroundObservation(null,e,s,t,o)}getTimelineAroundObservation(e,s,t=10,o=10,n){let i=n?"AND project = ?":"",a=n?[n]:[],c,p;if(e!==null){let u=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${i}
        ORDER BY id DESC
        LIMIT ?
      `,E=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${i}
        ORDER BY id ASC
        LIMIT ?
      `;try{let S=this.db.prepare(u).all(e,...a,t+1),l=this.db.prepare(E).all(e,...a,o+1);if(S.length===0&&l.length===0)return{observations:[],sessions:[],prompts:[]};c=S.length>0?S[S.length-1].created_at_epoch:s,p=l.length>0?l[l.length-1].created_at_epoch:s}catch(S){return console.error("[SessionStore] Error getting boundary observations:",S.message),{observations:[],sessions:[],prompts:[]}}}else{let u=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${i}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,E=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${i}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let S=this.db.prepare(u).all(s,...a,t),l=this.db.prepare(E).all(s,...a,o+1);if(S.length===0&&l.length===0)return{observations:[],sessions:[],prompts:[]};c=S.length>0?S[S.length-1].created_at_epoch:s,p=l.length>0?l[l.length-1].created_at_epoch:s}catch(S){return console.error("[SessionStore] Error getting boundary timestamps:",S.message),{observations:[],sessions:[],prompts:[]}}}let T=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,_=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${i}
      ORDER BY created_at_epoch ASC
    `,f=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${i.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let u=this.db.prepare(T).all(c,p,...a),E=this.db.prepare(_).all(c,p,...a),S=this.db.prepare(f).all(c,p,...a);return{observations:u,sessions:E.map(l=>({id:l.id,sdk_session_id:l.sdk_session_id,project:l.project,request:l.request,completed:l.completed,next_steps:l.next_steps,created_at:l.created_at,created_at_epoch:l.created_at_epoch})),prompts:S.map(l=>({id:l.id,claude_session_id:l.claude_session_id,project:l.project,prompt:l.prompt_text,created_at:l.created_at,created_at_epoch:l.created_at_epoch}))}}catch(u){return console.error("[SessionStore] Error querying timeline records:",u.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let o=s-t;this.db.prepare(`
      UPDATE sdk_sessions
      SET
        endless_original_tokens = COALESCE(endless_original_tokens, 0) + ?,
        endless_compressed_tokens = COALESCE(endless_compressed_tokens, 0) + ?,
        endless_tokens_saved = COALESCE(endless_tokens_saved, 0) + ?
      WHERE claude_session_id = ?
    `).run(s,t,o,e)}getEndlessModeStats(e){let t=this.db.prepare(`
      SELECT
        endless_original_tokens,
        endless_compressed_tokens,
        endless_tokens_saved
      FROM sdk_sessions
      WHERE claude_session_id = ?
    `).get(e);return t?{originalTokens:t.endless_original_tokens||g("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||g("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||g("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};function we(r,e,s){return r==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||g("hook-response: options.reason is null",{},"Pre-compact operation failed"),suppressOutput:!0}:r==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:r==="UserPromptSubmit"||r==="PostToolUse"?{continue:!0,suppressOutput:!0}:r==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function C(r,e,s={}){let t=we(r,e,s);return JSON.stringify(t)}import z from"path";import{homedir as Fe}from"os";import{existsSync as q,readFileSync as He}from"fs";import{spawnSync as Be}from"child_process";var Pe=100,je=500,$e=10;function H(){try{let r=z.join(Fe(),".claude-mem","settings.json");if(q(r)){let e=JSON.parse(He(r,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function de(){try{let r=H();return(await fetch(`http://127.0.0.1:${r}/health`,{signal:AbortSignal.timeout(Pe)})).ok}catch{return!1}}async function Xe(){try{let r=G(),e=z.join(r,"ecosystem.config.cjs");if(!q(e))throw new Error(`Ecosystem config not found at ${e}`);let s=z.join(r,"node_modules",".bin","pm2"),t=process.platform==="win32"?s+".cmd":s,o=q(t)?t:"pm2",n=Be(o,["start",e],{cwd:r,stdio:"pipe",encoding:"utf-8"});if(n.status!==0)throw new Error(n.stderr||"PM2 start failed");for(let i=0;i<$e;i++)if(await new Promise(a=>setTimeout(a,je)),await de())return!0;return!1}catch{return!1}}async function $(){if(await de())return;if(!await Xe()){let e=H(),s=G();throw new Error(`Worker service failed to start on port ${e}.

To start manually, run:
  cd ${s}
  npx pm2 start ecosystem.config.cjs

If already running, try: npx pm2 restart claude-mem-worker`)}}import{stdin as Se}from"process";import{readFileSync as re,writeFileSync as os,renameSync as ns,copyFileSync as is,existsSync as as,createReadStream as cs}from"fs";import{dirname as ps,join as ds,basename as ls}from"path";import{createInterface as us}from"readline";import{existsSync as We,readFileSync as Ke}from"fs";import{homedir as Ge}from"os";import Je from"path";function V(r,e,s){if(r!==void 0){if(typeof r=="boolean")return r;if(typeof r=="string")return r.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function Q(r,e,s){if(r!==void 0){if(typeof r=="number")return r;if(typeof r=="string"){let t=parseInt(r,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function Ye(){let r=Je.join(Ge(),".claude-mem","settings.json"),e={};if(We(r))try{e=JSON.parse(Ke(r,"utf-8"))}catch(p){d.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},p)}let s=V(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=V(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),o=Q(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),n=Q(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),i=Q(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),a=V(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),c={enabled:s,fallbackToOriginal:t,maxLookupTime:o,keepRecentToolUses:n,maxToolHistoryMB:i,enableSynchronousMode:a};return s?d.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${o}ms`,keepRecent:n,maxToolHistoryMB:`${i}MB`,syncMode:a}):d.debug("CONFIG","Endless Mode disabled"),c}var F=class{static getConfig=Ye;static clearCache(){}};import{existsSync as ze,readFileSync as qe,writeFileSync as Ve,appendFileSync as Qe,statSync as Ze}from"fs";import{join as es}from"path";var P=es(x,"tool-outputs.jsonl");function Z(r,e,s=Date.now()){U(x);let t=typeof e=="string"?e:JSON.stringify(e),o=Buffer.byteLength(t,"utf8"),i=JSON.stringify({tool_use_id:r,content:e,timestamp:s,size_bytes:o})+`
`;Qe(P,i,"utf8")}function le(r){if(!ze(P)||Ze(P).size/(1024*1024)<=r)return;let o=qe(P,"utf8").trim().split(`
`).filter(_=>_.length>0),n=[];for(let _ of o)try{n.push(JSON.parse(_))}catch{continue}n.sort((_,f)=>_.timestamp-f.timestamp);let i=r*1024*1024,a=0,c=0;for(let _=n.length-1;_>=0;_--){let f=n[_].size_bytes+100;if(a+f>i){c=_+1;break}a+=f}let T=n.slice(c).map(_=>JSON.stringify(_)).join(`
`)+`
`;Ve(P,T,"utf8")}var X=100;function ue(r){let e=(r.match(/<private>/g)||[]).length,s=(r.match(/<claude-mem-context>/g)||[]).length;return e+s}function ee(r){if(typeof r!="string")return D("[tag-stripping] received non-string for JSON context:",{type:typeof r}),"{}";let e=ue(r);return e>X&&D("[tag-stripping] tag count exceeds limit, truncating:",{tagCount:e,maxAllowed:X,contentLength:r.length}),r.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim()}function me(r){if(typeof r!="string")return D("[tag-stripping] received non-string for prompt context:",{type:typeof r}),"";let e=ue(r);return e>X&&D("[tag-stripping] tag count exceeds limit, truncating:",{tagCount:e,maxAllowed:X,contentLength:r.length}),r.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g,"").replace(/<private>[\s\S]*?<\/private>/g,"").trim()}import{readFileSync as te,writeFileSync as Ee,renameSync as ss,copyFileSync as ts}from"fs";import{randomUUID as se}from"crypto";async function ge(r,e){try{U(x);let p=j(r);ts(r,p),d.debug("HOOK","Created transcript backup before clearing input",{original:r,backup:p})}catch(p){throw d.error("HOOK","Failed to create transcript backup",{transcriptPath:r},p),new Error("Backup creation failed - aborting transformation for safety")}let t=te(r,"utf-8").trim().split(`
`),o=0,n=[];for(let p of t){if(!p.trim()){n.push(p);continue}try{let T=JSON.parse(p);if(T.type==="assistant"&&Array.isArray(T.message?.content)){let _=T,f=!1;for(let u of _.message.content)if(u.type==="tool_use"){let E=u;if(E.id===e){let S=JSON.stringify(E.input).length;o=Math.ceil(S/4),E.input={_cleared:!0,message:`[Input removed to save ~${o} tokens - observation will be injected]`},f=!0,d.info("HOOK","Cleared tool input",{toolUseId:e,tokensSaved:o,originalSize:S});break}}f?n.push(JSON.stringify(T)):n.push(p)}else n.push(p)}catch{d.warn("HOOK","Malformed JSONL line in transcript",{line:p}),n.push(p)}}let i=`${r}.tmp`;Ee(i,n.join(`
`)+`
`,"utf-8");let c=te(i,"utf-8").trim().split(`
`);for(let p of c)p.trim()&&JSON.parse(p);return ss(i,r),o}async function Te(r,e,s,t){if(t.length===0){d.debug("HOOK","No observations to inject");return}let o=te(r,"utf-8"),n=o.trim().split(`
`),i=JSON.parse(n[n.length-1]),a={isSidechain:!1,userType:i.userType||"user",cwd:s,sessionId:e,version:i.version||"1.0",timestamp:new Date().toISOString()},c=`toolu_mem_${se().replace(/-/g,"").substring(0,20)}`,p={...a,type:"assistant",uuid:se(),message:{id:`msg_${Date.now()}`,type:"message",role:"assistant",model:"claude-3-5-sonnet-20241022",content:[{type:"tool_use",id:c,name:"claude-mem-fetch-observations",input:{observation_ids:t.map(u=>u.id),note:"Fetching compressed observations for context"}}],stop_reason:"tool_use"}},T=t.map(u=>rs(u)).join(`

---

`),_={...a,type:"user",uuid:se(),message:{role:"user",content:[{type:"tool_result",tool_use_id:c,content:T}]}},f=[JSON.stringify(p),JSON.stringify(_)];Ee(r,o+`
`+f.join(`
`)+`
`,"utf-8"),d.success("HOOK","Injected observation fetch in transcript",{toolUseId:c,observationCount:t.length,transcriptPath:r})}function rs(r){let e=[];e.push(`## ${r.title}`),r.subtitle&&e.push(r.subtitle),r.narrative&&e.push(r.narrative);let s=_e(r.facts);s.length>0&&e.push(`Facts: ${s.join("; ")}`);let t=_e(r.concepts);return t.length>0&&e.push(`Concepts: ${t.join(", ")}`),e.join(`

`)}function _e(r){if(!r)return[];if(Array.isArray(r))return r;try{let e=JSON.parse(r);return Array.isArray(e)?e:[]}catch{return[]}}var ms=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function W(r,e){if(!r)return[];if(Array.isArray(r))return r;try{let s=JSON.parse(r);return Array.isArray(s)?s:[]}catch(s){return d.debug("HOOK",`Failed to parse ${e}`,{field:r,error:s}),[]}}function _s(r){let e=[];e.push(`## ${r.title}`),r.subtitle&&e.push(r.subtitle),r.narrative&&e.push(r.narrative);let s=W(r.facts,"facts");s.length>0&&e.push(`Facts: ${s.join("; ")}`);let t=W(r.concepts,"concepts");t.length>0&&e.push(`Concepts: ${t.join(", ")}`);let o=W(r.files_read,"files_read");o.length>0&&e.push(`Files read: ${o.join(", ")}`);let n=W(r.files_modified,"files_modified");return n.length>0&&e.push(`Files modified: ${n.join(", ")}`),e.join(`

`)}async function Es(r){let e=new Set;try{let s=cs(r),t=us({input:s,crlfDelay:1/0});for await(let i of t)if(i.includes("agentId"))try{let a=JSON.parse(i);a.toolUseResult?.agentId&&e.add(a.toolUseResult.agentId)}catch{}let o=ps(r),n=Array.from(e).map(i=>ds(o,`agent-${i}.jsonl`)).filter(i=>as(i));return d.debug("HOOK","Discovered agent transcripts",{agentCount:e.size,filesFound:n.length,agentFiles:n.map(i=>ls(i))}),n}catch(s){return d.warn("HOOK","Failed to discover agent files",{mainTranscriptPath:r},s),[]}}async function be(r,e,s=[]){let t=await Es(r),o=await fe(r,e,s),n=0,i=0;for(let a of t)try{let c=await fe(a,e,[]);n+=c.originalTokens,i+=c.compressedTokens}catch(c){d.warn("HOOK","Failed to transform agent transcript",{agentFile:a},c)}return{originalTokens:o.originalTokens+n,compressedTokens:o.compressedTokens+i}}async function fe(r,e,s=[]){try{U(x);let m=j(r);is(r,m),d.info("HOOK","Created transcript backup",{original:r,backup:m})}catch(m){throw d.error("HOOK","Failed to create transcript backup",{transcriptPath:r},m),new Error("Backup creation failed - aborting transformation for safety")}let o=re(r,"utf-8").trim().split(`
`),n={totalOriginalSize:0,totalCompressedSize:0,transformCount:0},i=new w,a=i.getAllObservationsForToolUseId(e);if(a.length===0)return i.close(),d.debug("HOOK","No observations found for rolling replacement",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let c=new Set(s);c.add(e),d.info("HOOK","Rolling replacement scope",{toolUseId:e,cycleSize:c.size,observationCount:a.length});let p=a.map(m=>_s(m)).join(`

`),T={type:"assistant",message:{role:"assistant",content:[{type:"text",text:p}]}},_=p.length,f=new Set,u=new Set,E=new Set;for(let m of o)if(m.trim())try{let N=JSON.parse(m);if(N.type==="assistant"&&Array.isArray(N.message?.content)){for(let O of N.message.content)if(O.type==="tool_use"){let L=O;L.id&&c.has(L.id)&&u.add(L.id)}}if(N.type==="user"&&Array.isArray(N.message?.content)){for(let O of N.message.content)if(O.type==="tool_result"){let L=O;L.tool_use_id&&c.has(L.tool_use_id)&&E.add(L.tool_use_id)}}}catch{continue}for(let m of c)u.has(m)&&E.has(m)&&f.add(m);if(d.info("HOOK","Validated tool pairs for replacement",{requestedIds:c.size,validatedIds:f.size,toolUseOnly:Array.from(u).filter(m=>!E.has(m)),toolResultOnly:Array.from(E).filter(m=>!u.has(m))}),f.size===0)return i.close(),d.debug("HOOK","No complete tool_use/tool_result pairs found for replacement",{toolUseId:e}),{originalTokens:0,compressedTokens:0};let S=[],l=!1,h=-1,b=0,y=!1;for(let m=0;m<o.length;m++){let N=o[m];if(!N.trim()){S.push(N);continue}try{let O=JSON.parse(N);if(O.type==="assistant"&&Array.isArray(O.message?.content)){let L=O;for(let B of L.message.content)if(B.type==="tool_use"){let I=B;if(I.id&&f.has(I.id)){l||(l=!0,h=m,d.debug("HOOK","Replacement zone start",{toolUseId:I.id,lineIndex:m}));try{Z(I.id,JSON.stringify(I.input),Date.now())}catch(ae){d.warn("HOOK","Failed to backup original tool input",{toolUseId:I.id},ae)}b+=N.length,y=!0;break}}if(l&&y)continue}if(O.type==="user"&&Array.isArray(O.message?.content)&&y){let L=O;for(let B of L.message.content)if(B.type==="tool_result"){let I=B;if(I.tool_use_id&&f.has(I.tool_use_id)){try{Z(I.tool_use_id,JSON.stringify(I.content),Date.now())}catch(Re){d.warn("HOOK","Failed to backup original tool output",{toolUseId:I.tool_use_id},Re)}b+=N.length,I.tool_use_id===e&&(S.push(JSON.stringify(T)),l=!1,y=!1,n.totalOriginalSize+=b,n.totalCompressedSize+=_,n.transformCount++,d.success("HOOK","Rolling replacement complete",{zoneStart:h,zoneEnd:m,toolsReplaced:f.size,originalSize:b,compressedSize:_,savings:`${Math.round((1-_/b)*100)}%`}));continue}}}(!l||!y)&&S.push(N)}catch(O){throw d.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:m,error:O}),new Error(`Malformed JSONL line at index ${m}: ${O.message}`)}}i.close();let v=`${r}.tmp`;os(v,S.join(`
`)+`
`,"utf-8");let k=re(v,"utf-8").trim().split(`
`);for(let m of k)m.trim()&&JSON.parse(m);ns(v,r);let ie=4,Oe=Math.ceil(n.totalOriginalSize/ie),ye=Math.ceil(n.totalCompressedSize/ie);d.success("HOOK","Transcript transformation complete",{toolUseId:e,transformCount:n.transformCount,totalOriginalSize:n.totalOriginalSize,totalCompressedSize:n.totalCompressedSize,savings:n.totalOriginalSize>0?`${Math.round((1-n.totalCompressedSize/n.totalOriginalSize)*100)}%`:"0%"});try{let m=F.getConfig();m.maxToolHistoryMB>0&&(le(m.maxToolHistoryMB),d.debug("HOOK","Trimmed tool output backup",{maxSizeMB:m.maxToolHistoryMB}))}catch(m){d.warn("HOOK","Failed to trim tool output backup",{},m)}return{originalTokens:Oe,compressedTokens:ye}}async function gs(r){r||(d.warn("HOOK","PostToolUse called with no input"),console.log(C("PostToolUse",!0)),process.exit(0));let{session_id:e,cwd:s,tool_name:t,tool_input:o,tool_response:n,transcript_path:i,tool_use_id:a}=r;ms.has(t)&&(console.log(C("PostToolUse",!0)),process.exit(0)),await $();let c=new w,p=c.createSDKSession(e,"",""),T=c.getPromptCounter(p),_=c.getUserPrompt(e,T);if(!_||_.trim()===""){D("[save-hook] Skipping observation - user prompt was entirely private",{session_id:e,promptNumber:T,tool_name:t}),c.close(),console.log(C("PostToolUse",!0));return}c.close();let f=d.formatTool(t,o),u=H(),E=a;if(!E&&i)try{let b=re(i,"utf-8").trim().split(`
`);for(let y=b.length-1;y>=0;y--){let v=JSON.parse(b[y]);if(v.type==="user"&&Array.isArray(v.message.content)){for(let A of v.message.content)if(A.type==="tool_result"&&A.tool_use_id){E=A.tool_use_id;break}if(E)break}}}catch(h){g("Failed to extract tool_use_id from transcript",{error:h})}d.dataIn("HOOK",`PostToolUse: ${f}`,{sessionDbId:p,claudeSessionId:e,workerPort:u,toolUseId:E||g("tool_use_id not found in transcript",{toolName:t},"(none)")});let S=F.getConfig(),l=!!(S.enabled&&E&&i);g("Endless Mode Check",{configEnabled:S.enabled,hasToolUseId:!!E,hasTranscriptPath:!!i,isEndlessModeEnabled:l,toolName:t,toolUseId:E,allInputKeys:Object.keys(r).join(", ")});try{let h="{}",b="{}";try{h=o!==void 0?ee(JSON.stringify(o)):"{}"}catch(k){D("[save-hook] Failed to stringify tool_input:",{error:k,tool_name:t}),h='{"error": "Failed to serialize tool_input"}'}try{b=n!==void 0?ee(JSON.stringify(n)):"{}"}catch(k){D("[save-hook] Failed to stringify tool_response:",{error:k,tool_name:t}),b='{"error": "Failed to serialize tool_response"}'}let y=l?parseInt(process.env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS||(g("CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS not set, using default 90000ms"),"90000"),10):2e3,v=await fetch(`http://127.0.0.1:${u}/sessions/${p}/observations?wait_until_obs_is_saved=${l}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:h,tool_response:b,prompt_number:T,cwd:s||g("save-hook: cwd missing",{sessionDbId:p,tool_name:t}),tool_use_id:E,transcript_path:i||g("save-hook: transcript_path missing",{sessionDbId:p,tool_name:t})}),signal:AbortSignal.timeout(y)});if(!v.ok){let k=await v.text();d.failure("HOOK","Failed to send observation",{sessionDbId:p,status:v.status},k),console.log(C("PostToolUse",!0)),process.exit(0)}let A=await v.json();if(A.status==="completed"&&l)try{if(E&&i){let k=await ge(i,E);d.info("HOOK","Cleared tool input from transcript",{toolUseId:E,tokensSaved:k})}A.observation&&i&&(await Te(i,e,s,[A.observation]),d.success("HOOK","Injected observation fetch in transcript",{observationId:A.observation.id})),console.log("[save-hook] \u2705 Observation created, context injected naturally")}catch(k){d.error("HOOK","Failed to inject context",{},k)}else A.status==="completed"?console.log("[save-hook] \u2705 Observation created"):A.status==="skipped"?console.log("[save-hook] \u23ED\uFE0F  No observation needed, continuing"):A.status==="timeout"&&console.warn(`[save-hook] \u23F1\uFE0F  Timeout after ${y}ms - processing async`);d.debug("HOOK","Observation sent successfully",{sessionDbId:p,toolName:t,mode:l?"synchronous (Endless Mode)":"async"})}catch(h){if(h.cause?.code==="ECONNREFUSED"){let b="Worker connection failed. Try: pm2 restart claude-mem-worker";d.failure("HOOK","Worker connection refused",{sessionDbId:p},h),console.error(`[save-hook] ${b}`),console.log(C("PostToolUse",!1,{reason:b})),process.exit(2)}console.warn("[save-hook] \u274C Failed to send observation:",h.message),d.warn("HOOK","Observation request failed - continuing anyway",{sessionDbId:p,toolName:t,error:h.message}),console.log(C("PostToolUse",!0)),process.exit(0)}console.log(C("PostToolUse",!0)),process.exit(0)}var oe="";Se.on("data",r=>oe+=r);Se.on("end",async()=>{try{let r=oe?JSON.parse(oe):void 0;await gs(r)}catch(r){console.error(`[save-hook] Unhandled error: ${r.message}`),console.log(C("PostToolUse",!1,{reason:r.message})),process.exit(1)}});async function fs(r){if(!r)throw new Error("newHook requires input");let{session_id:e,cwd:s,prompt:t,transcript_path:o}=r;g("[new-hook] Input received",{session_id:e,cwd:s,cwd_type:typeof s,cwd_length:s?.length,has_cwd:!!s,prompt_length:t?.length});let n=Ts.basename(s);g("[new-hook] Project extracted",{project:n,project_type:typeof n,project_length:n?.length,is_empty:n==="",cwd_was:s}),await $();let i=new w,a=i.createSDKSession(e,n,t),c=i.incrementPromptCounter(a),p=me(t);if(!p||p.trim()===""){D("[new-hook] Prompt entirely private, skipping memory operations",{session_id:e,promptNumber:c,originalLength:t.length}),i.close(),console.error(`[new-hook] Session ${a}, prompt #${c} (fully private - skipped)`),console.log(C("UserPromptSubmit",!0));return}if(i.saveUserPrompt(e,c,p),console.error(`[new-hook] Session ${a}, prompt #${c}`),i.close(),F.getConfig().enabled&&o)try{d.info("HOOK","\u{1F504} Batch transforming transcript at UserPromptSubmit",{transcriptPath:o});let u=await be(o,`user-prompt-${c}`);d.success("HOOK","\u2705 Batch transformation complete",{originalTokens:u.originalTokens,compressedTokens:u.compressedTokens,savings:`${Math.round((1-u.compressedTokens/u.originalTokens)*100)}%`})}catch(u){d.warn("HOOK","Batch transformation failed - continuing anyway",{transcriptPath:o},u)}let _=H(),f=t.startsWith("/")?t.substring(1):t;try{let u=await fetch(`http://127.0.0.1:${_}/sessions/${a}/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:n,userPrompt:f,promptNumber:c}),signal:AbortSignal.timeout(5e3)});if(!u.ok){let E=await u.text();throw new Error(`Failed to initialize session: ${u.status} ${E}`)}}catch(u){throw u.cause?.code==="ECONNREFUSED"||u.name==="TimeoutError"||u.message.includes("fetch failed")?new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"):u}console.log(C("UserPromptSubmit",!0))}var ne="";he.on("data",r=>ne+=r);he.on("end",async()=>{let r=ne?JSON.parse(ne):void 0;await fs(r)});
