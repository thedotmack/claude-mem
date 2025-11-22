#!/usr/bin/env node
import{stdin as w}from"process";import{readFileSync as F,existsSync as X}from"fs";import J from"better-sqlite3";import{join as E,dirname as P,basename as pe}from"path";import{homedir as v}from"os";import{existsSync as me,mkdirSync as j}from"fs";import{fileURLToPath as W}from"url";function $(){return typeof __dirname<"u"?__dirname:P(W(import.meta.url))}var G=$(),S=process.env.CLAUDE_MEM_DATA_DIR||E(v(),".claude-mem"),O=process.env.CLAUDE_CONFIG_DIR||E(v(),".claude"),Te=E(S,"archives"),Se=E(S,"logs"),ge=E(S,"trash"),be=E(S,"backups"),Re=E(S,"settings.json"),y=E(S,"claude-mem.db"),he=E(S,"vector-db"),fe=E(O,"settings.json"),Oe=E(O,"commands"),Ne=E(O,"CLAUDE.md");function A(a){j(a,{recursive:!0})}function C(){return E(G,"..","..")}var N=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(N||{}),I=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=N[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,o){if(e<this.level)return;let n=new Date().toISOString().replace("T"," ").substring(0,23),i=N[e].padEnd(5),d=s.padEnd(6),_="";r?.correlationId?_=`[${r.correlationId}] `:r?.sessionId&&(_=`[session-${r.sessionId}] `);let l="";o!=null&&(this.level===0&&typeof o=="object"?l=`
`+JSON.stringify(o,null,2):l=" "+this.formatData(o));let u="";if(r){let{sessionId:g,sdkSessionId:R,correlationId:m,...c}=r;Object.keys(c).length>0&&(u=` {${Object.entries(c).map(([H,B])=>`${H}=${B}`).join(", ")}}`)}let T=`[${n}] [${i}] [${d}] ${_}${t}${u}${l}`;e===3?console.error(T):console.log(T)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},b=new I;import{appendFileSync as Y}from"fs";import{homedir as K}from"os";import{join as V}from"path";var q=V(K(),".pm2","logs","claude-mem-worker-error.log");function p(a,e,s=""){let t=new Date().toISOString(),i=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),d=i?`${i[1].split("/").pop()}:${i[2]}`:"unknown",_=`[${t}] [SILENT-DEBUG] [${d}] ${a}`;if(e!==void 0)try{_+=` ${JSON.stringify(e)}`}catch(l){_+=` [stringify error: ${l}]`}_+=`
`;try{Y(q,_)}catch{}return s}var h=class{db;constructor(){A(S),this.db=new J(y),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}ensureDiscoveryTokensColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.pragma("table_info(observations)").some(n=>n.name==="discovery_tokens")||(this.db.exec("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to observations table")),this.db.pragma("table_info(session_summaries)").some(n=>n.name==="discovery_tokens")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}catch(e){throw console.error("[SessionStore] Discovery tokens migration error:",e.message),e}}addToolUseIdColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(12))return;this.db.pragma("table_info(observations)").some(r=>r.name==="tool_use_id")||(this.db.exec("ALTER TABLE observations ADD COLUMN tool_use_id TEXT"),console.error("[SessionStore] Added tool_use_id column to observations table"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Created index on tool_use_id column")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(12,new Date().toISOString())}catch(e){console.error("[SessionStore] Tool use ID migration error:",e.message)}}addEndlessModeStatsColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(13))return;let s=this.db.pragma("table_info(sdk_sessions)"),t=s.some(n=>n.name==="endless_original_tokens"),r=s.some(n=>n.name==="endless_compressed_tokens"),o=s.some(n=>n.name==="endless_tokens_saved");t||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_original_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_original_tokens column to sdk_sessions table")),r||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_compressed_tokens INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_compressed_tokens column to sdk_sessions table")),o||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN endless_tokens_saved INTEGER DEFAULT 0"),console.error("[SessionStore] Added endless_tokens_saved column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(13,new Date().toISOString())}catch(e){console.error("[SessionStore] Endless Mode stats migration error:",e.message)}}removeToolUseIdUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(14))return;this.db.exec("DROP INDEX IF EXISTS idx_observations_tool_use_id"),console.error("[SessionStore] Dropped UNIQUE index on tool_use_id"),this.db.exec("CREATE INDEX IF NOT EXISTS idx_observations_tool_use_id ON observations(tool_use_id) WHERE tool_use_id IS NOT NULL"),console.error("[SessionStore] Recreated tool_use_id index without UNIQUE constraint"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(14,new Date().toISOString())}catch(e){console.error("[SessionStore] Remove UNIQUE constraint migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).get(e)||p("SessionStore.getObservationById: No observation found",{id:e},null)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",i=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${i})
      ORDER BY created_at_epoch ${o}
      ${n}
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
    `).all(e),r=new Set,o=new Set;for(let n of t){if(n.files_read)try{let i=JSON.parse(n.files_read);Array.isArray(i)&&i.forEach(d=>r.add(d))}catch{}if(n.files_modified)try{let i=JSON.parse(n.files_modified);Array.isArray(i)&&i.forEach(d=>o.add(d))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||p("SessionStore.getPromptCounter: prompt_counter is null",{id:e},0)}createSDKSession(e,s,t){let r=new Date,o=r.getTime(),i=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),o);return i.lastInsertRowid===0||i.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:i.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(b.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||p("SessionStore.getWorkerPort: worker_port is null",{id:e},null)}saveUserPrompt(e,s,t){let r=new Date,o=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),o).lastInsertRowid}storeObservation(e,s,t,r,o=0){let n=new Date,i=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),i),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let u=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||p("SessionStore.storeObservation: promptNumber is null",{sdkSessionId:e},null),o,t.tool_use_id||p("SessionStore.storeObservation: tool_use_id is null",{sdkSessionId:e},null),n.toISOString(),i);return{id:Number(u.lastInsertRowid),createdAtEpoch:i}}getObservationByToolUseId(e){return this.db.prepare(`
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
    `).all(...e),o=new Map;for(let n of r)n.tool_use_id&&o.set(n.tool_use_id,n);return o}storeSummary(e,s,t,r,o=0){let n=new Date,i=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),i),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let u=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||p("SessionStore.storeSummary: promptNumber is null",{sdkSessionId:e},null),o,n.toISOString(),i);return{id:Number(u.lastInsertRowid),createdAtEpoch:i}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",i=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${i})
      ORDER BY created_at_epoch ${o}
      ${n}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,o=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",i=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${i})
      ORDER BY up.created_at_epoch ${o}
      ${n}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,o){let n=o?"AND project = ?":"",i=o?[o]:[],d,_;if(e!==null){let g=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${n}
        ORDER BY id DESC
        LIMIT ?
      `,R=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${n}
        ORDER BY id ASC
        LIMIT ?
      `;try{let m=this.db.prepare(g).all(e,...i,t+1),c=this.db.prepare(R).all(e,...i,r+1);if(m.length===0&&c.length===0)return{observations:[],sessions:[],prompts:[]};d=m.length>0?m[m.length-1].created_at_epoch:s,_=c.length>0?c[c.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary observations:",m.message),{observations:[],sessions:[],prompts:[]}}}else{let g=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${n}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,R=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${n}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let m=this.db.prepare(g).all(s,...i,t),c=this.db.prepare(R).all(s,...i,r+1);if(m.length===0&&c.length===0)return{observations:[],sessions:[],prompts:[]};d=m.length>0?m[m.length-1].created_at_epoch:s,_=c.length>0?c[c.length-1].created_at_epoch:s}catch(m){return console.error("[SessionStore] Error getting boundary timestamps:",m.message),{observations:[],sessions:[],prompts:[]}}}let l=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,u=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,T=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${n.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let g=this.db.prepare(l).all(d,_,...i),R=this.db.prepare(u).all(d,_,...i),m=this.db.prepare(T).all(d,_,...i);return{observations:g,sessions:R.map(c=>({id:c.id,sdk_session_id:c.sdk_session_id,project:c.project,request:c.request,completed:c.completed,next_steps:c.next_steps,created_at:c.created_at,created_at_epoch:c.created_at_epoch})),prompts:m.map(c=>({id:c.id,claude_session_id:c.claude_session_id,project:c.project,prompt:c.prompt_text,created_at:c.created_at,created_at_epoch:c.created_at_epoch}))}}catch(g){return console.error("[SessionStore] Error querying timeline records:",g.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||p("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||p("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||p("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};function Q(a,e,s){return a==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||p("hook-response: options.reason is null",{},"Pre-compact operation failed"),suppressOutput:!0}:a==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:a==="UserPromptSubmit"||a==="PostToolUse"?{continue:!0,suppressOutput:!0}:a==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function k(a,e,s={}){let t=Q(a,e,s);return JSON.stringify(t)}import D from"path";import{homedir as z}from"os";import{existsSync as x,readFileSync as Z}from"fs";import{execSync as ee}from"child_process";var se=100,te=500,re=10;function f(){try{let a=D.join(z(),".claude-mem","settings.json");if(x(a)){let e=JSON.parse(Z(a,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function U(){try{let a=f();return(await fetch(`http://127.0.0.1:${a}/health`,{signal:AbortSignal.timeout(se)})).ok}catch{return!1}}async function oe(){try{let a=C(),e=D.join(a,"ecosystem.config.cjs");if(!x(e))throw new Error(`Ecosystem config not found at ${e}`);ee(`pm2 start "${e}"`,{cwd:a,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<re;s++)if(await new Promise(t=>setTimeout(t,te)),await U())return!0;return!1}catch{return!1}}async function M(){if(await U())return;if(!await oe()){let e=f();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}function ne(a){if(!a||!X(a))return"";try{let e=F(a,"utf-8").trim();if(!e)return"";let s=e.split(`
`);for(let t=s.length-1;t>=0;t--)try{let r=JSON.parse(s[t]);if(r.type==="user"&&r.message?.content){let o=r.message.content;if(typeof o=="string")return o;if(Array.isArray(o))return o.filter(i=>i.type==="text").map(i=>i.text).join(`
`)}}catch{continue}}catch(e){b.error("HOOK","Failed to read transcript",{transcriptPath:a},e)}return""}function ie(a){if(!a||!X(a))return"";try{let e=F(a,"utf-8").trim();if(!e)return"";let s=e.split(`
`);for(let t=s.length-1;t>=0;t--)try{let r=JSON.parse(s[t]);if(r.type==="assistant"&&r.message?.content){let o="",n=r.message.content;return typeof n=="string"?o=n:Array.isArray(n)&&(o=n.filter(d=>d.type==="text").map(d=>d.text).join(`
`)),o=o.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,""),o=o.replace(/\n{3,}/g,`

`).trim(),o}}catch{continue}}catch(e){b.error("HOOK","Failed to read transcript",{transcriptPath:a},e)}return""}async function ae(a){if(!a)throw new Error("summaryHook requires input");let{session_id:e,transcript_path:s}=a;await M();let t=new h,r=t.createSDKSession(e,"",""),o=t.getPromptCounter(r),n=t.db.prepare(`
    SELECT id, claude_session_id, sdk_session_id, project
    FROM sdk_sessions WHERE id = ?
  `).get(r),i=t.db.prepare(`
    SELECT COUNT(*) as count
    FROM observations
    WHERE sdk_session_id = ?
  `).get(n?.sdk_session_id);p("[summary-hook] Session diagnostics",{claudeSessionId:e,sessionDbId:r,sdkSessionId:n?.sdk_session_id,project:n?.project,promptNumber:o,observationCount:i?.count||p("summary-hook: obsCount.count is null",{sessionDbId:r},0),transcriptPath:a.transcript_path}),t.close();let d=f(),_=ne(a.transcript_path||p("summary-hook: transcript_path missing for extractLastUserMessage",{session_id__from_hook})),l=ie(a.transcript_path||p("summary-hook: transcript_path missing for extractLastAssistantMessage",{session_id__from_hook}));p("[summary-hook] Extracted messages",{hasLastUserMessage:!!_,hasLastAssistantMessage:!!l,lastAssistantPreview:l.substring(0,200),lastAssistantLength:l.length}),b.dataIn("HOOK","Stop: Requesting summary",{sessionId:r,workerPort:d,promptNumber:o,hasLastUserMessage:!!_,hasLastAssistantMessage:!!l});try{let u=await fetch(`http://127.0.0.1:${d}/sessions/${r}/summarize`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt_number:o,last_user_message:_,last_assistant_message:l}),signal:AbortSignal.timeout(2e3)});if(!u.ok){let T=await u.text();throw b.failure("HOOK","Failed to generate summary",{sessionId:r,status:u.status},T),new Error(`Failed to request summary from worker: ${u.status} ${T}`)}b.debug("HOOK","Summary request sent successfully",{sessionId:r})}catch(u){throw u.cause?.code==="ECONNREFUSED"||u.name==="TimeoutError"||u.message.includes("fetch failed")?new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"):u}finally{await fetch(`http://127.0.0.1:${d}/api/processing`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({isProcessing:!1})})}console.log(k("Stop",!0))}var L="";w.on("data",a=>L+=a);w.on("end",async()=>{let a=L?JSON.parse(L):void 0;await ae(a)});
