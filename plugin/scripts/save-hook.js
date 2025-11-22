#!/usr/bin/env node
import{stdin as re}from"process";import{readFileSync as W,writeFileSync as Ue,renameSync as xe,copyFileSync as we,existsSync as Fe,createReadStream as Be}from"fs";import{dirname as He,join as Xe,basename as Pe}from"path";import{createInterface as je}from"readline";import me from"better-sqlite3";import{join as f,dirname as oe,basename as ne}from"path";import{homedir as K}from"os";import{existsSync as qe,mkdirSync as ie}from"fs";import{fileURLToPath as ae}from"url";function de(){return typeof __dirname<"u"?__dirname:oe(ae(import.meta.url))}var ce=de(),I=process.env.CLAUDE_MEM_DATA_DIR||f(K(),".claude-mem"),B=process.env.CLAUDE_CONFIG_DIR||f(K(),".claude"),Qe=f(I,"archives"),Ze=f(I,"logs"),es=f(I,"trash"),C=f(I,"backups"),ss=f(I,"settings.json"),Y=f(I,"claude-mem.db"),ts=f(I,"vector-db"),rs=f(B,"settings.json"),os=f(B,"commands"),ns=f(B,"CLAUDE.md");function k(o){ie(o,{recursive:!0})}function J(){return f(ce,"..","..")}function z(o){let e=new Date().toISOString().replace(/[:.]/g,"-").replace("T","_").slice(0,19),s=ne(o);return f(C,`${s}.backup.${e}`)}var H=(i=>(i[i.DEBUG=0]="DEBUG",i[i.INFO=1]="INFO",i[i.WARN=2]="WARN",i[i.ERROR=3]="ERROR",i[i.SILENT=4]="SILENT",i))(H||{}),X=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=H[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let t=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&t.command){let r=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${r})`}if(e==="Read"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Edit"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}if(e==="Write"&&t.file_path){let r=t.file_path.split("/").pop()||t.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,s,t,r,i){if(e<this.level)return;let n=new Date().toISOString().replace("T"," ").substring(0,23),a=H[e].padEnd(5),p=s.padEnd(6),l="";r?.correlationId?l=`[${r.correlationId}] `:r?.sessionId&&(l=`[session-${r.sessionId}] `);let g="";i!=null&&(this.level===0&&typeof i=="object"?g=`
`+JSON.stringify(i,null,2):g=" "+this.formatData(i));let m="";if(r){let{sessionId:c,sdkSessionId:R,correlationId:u,...d}=r;Object.keys(d).length>0&&(m=` {${Object.entries(d).map(([b,T])=>`${b}=${T}`).join(", ")}}`)}let S=`[${n}] [${a}] [${p}] ${l}${t}${m}${g}`;e===3?console.error(S):console.log(S)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}},_=new X;import{appendFileSync as pe}from"fs";import{homedir as le}from"os";import{join as ue}from"path";var _e=ue(le(),".pm2","logs","claude-mem-worker-error.log");function E(o,e,s=""){let t=new Date().toISOString(),a=((new Error().stack?.split(`
`)??[])[2]??"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),p=a?`${a[1].split("/").pop()}:${a[2]}`:"unknown",l=`[${t}] [SILENT-DEBUG] [${p}] ${o}`;if(e!==void 0)try{l+=` ${JSON.stringify(e)}`}catch(g){l+=` [stringify error: ${g}]`}l+=`
`;try{pe(_e,l)}catch{}return s}var D=class{db;constructor(){k(I),this.db=new me(Y),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.addEndlessModeStatsColumns(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.addToolUseIdColumn(),this.removeToolUseIdUniqueConstraint()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(r=>r.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(p=>p.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(r=>r.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).get(e)||E("SessionStore.getObservationById: No observation found",{id:e},null)}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r}=s,i=t==="date_asc"?"ASC":"DESC",n=r?`LIMIT ${r}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
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
    `).get(e)||E("SessionStore.getSummaryForSession: No summary found",{sdkSessionId:e},null)}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),r=new Set,i=new Set;for(let n of t){if(n.files_read)try{let a=JSON.parse(n.files_read);Array.isArray(a)&&a.forEach(p=>r.add(p))}catch{}if(n.files_modified)try{let a=JSON.parse(n.files_modified);Array.isArray(a)&&a.forEach(p=>i.add(p))}catch{}}return{filesRead:Array.from(r),filesModified:Array.from(i)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||E("SessionStore.getPromptCounter: prompt_counter is null",{id:e},0)}createSDKSession(e,s,t){let r=new Date,i=r.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,t,r.toISOString(),i);return a.lastInsertRowid===0||a.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(_.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||E("SessionStore.getWorkerPort: worker_port is null",{id:e},null)}saveUserPrompt(e,s,t){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),i).lastInsertRowid}storeObservation(e,s,t,r,i=0){let n=new Date,a=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let m=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, tool_use_id, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||E("SessionStore.storeObservation: promptNumber is null",{sdkSessionId:e},null),i,t.tool_use_id||E("SessionStore.storeObservation: tool_use_id is null",{sdkSessionId:e},null),n.toISOString(),a);return{id:Number(m.lastInsertRowid),createdAtEpoch:a}}getObservationByToolUseId(e){return this.db.prepare(`
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
    `).all(...e),i=new Map;for(let n of r)n.tool_use_id&&i.set(n.tool_use_id,n);return i}storeSummary(e,s,t,r,i=0){let n=new Date,a=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),a),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let m=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||E("SessionStore.storeSummary: promptNumber is null",{sdkSessionId:e},null),i,n.toISOString(),a);return{id:Number(m.lastInsertRowid),createdAtEpoch:a}}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,i){let n=i?"AND project = ?":"",a=i?[i]:[],p,l;if(e!==null){let c=`
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
      `;try{let u=this.db.prepare(c).all(e,...a,t+1),d=this.db.prepare(R).all(e,...a,r+1);if(u.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};p=u.length>0?u[u.length-1].created_at_epoch:s,l=d.length>0?d[d.length-1].created_at_epoch:s}catch(u){return console.error("[SessionStore] Error getting boundary observations:",u.message),{observations:[],sessions:[],prompts:[]}}}else{let c=`
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
      `;try{let u=this.db.prepare(c).all(s,...a,t),d=this.db.prepare(R).all(s,...a,r+1);if(u.length===0&&d.length===0)return{observations:[],sessions:[],prompts:[]};p=u.length>0?u[u.length-1].created_at_epoch:s,l=d.length>0?d[d.length-1].created_at_epoch:s}catch(u){return console.error("[SessionStore] Error getting boundary timestamps:",u.message),{observations:[],sessions:[],prompts:[]}}}let g=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,m=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,S=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${n.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let c=this.db.prepare(g).all(p,l,...a),R=this.db.prepare(m).all(p,l,...a),u=this.db.prepare(S).all(p,l,...a);return{observations:c,sessions:R.map(d=>({id:d.id,sdk_session_id:d.sdk_session_id,project:d.project,request:d.request,completed:d.completed,next_steps:d.next_steps,created_at:d.created_at,created_at_epoch:d.created_at_epoch})),prompts:u.map(d=>({id:d.id,claude_session_id:d.claude_session_id,project:d.project,prompt:d.prompt_text,created_at:d.created_at,created_at_epoch:d.created_at_epoch}))}}catch(c){return console.error("[SessionStore] Error querying timeline records:",c.message),{observations:[],sessions:[],prompts:[]}}}incrementEndlessModeStats(e,s,t){let r=s-t;this.db.prepare(`
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
    `).get(e);return t?{originalTokens:t.endless_original_tokens||E("SessionStore.getEndlessModeStats: endless_original_tokens is null",{claudeSessionId:e},0),compressedTokens:t.endless_compressed_tokens||E("SessionStore.getEndlessModeStats: endless_compressed_tokens is null",{claudeSessionId:e},0),tokensSaved:t.endless_tokens_saved||E("SessionStore.getEndlessModeStats: endless_tokens_saved is null",{claudeSessionId:e},0)}:null}close(){this.db.close()}};function Ee(o,e,s){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||E("hook-response: options.reason is null",{},"Pre-compact operation failed"),suppressOutput:!0}:o==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function L(o,e,s={}){let t=Ee(o,e,s);return JSON.stringify(t)}import q from"path";import{homedir as Te}from"os";import{existsSync as V,readFileSync as ge}from"fs";import{execSync as Se}from"child_process";var fe=100,be=500,Oe=10;function x(){try{let o=q.join(Te(),".claude-mem","settings.json");if(V(o)){let e=JSON.parse(ge(o,"utf-8")),s=parseInt(e.env?.CLAUDE_MEM_WORKER_PORT,10);if(!isNaN(s))return s}}catch{}return parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10)}async function Q(){try{let o=x();return(await fetch(`http://127.0.0.1:${o}/health`,{signal:AbortSignal.timeout(fe)})).ok}catch{return!1}}async function Re(){try{let o=J(),e=q.join(o,"ecosystem.config.cjs");if(!V(e))throw new Error(`Ecosystem config not found at ${e}`);Se(`pm2 start "${e}"`,{cwd:o,stdio:"pipe",encoding:"utf-8"});for(let s=0;s<Oe;s++)if(await new Promise(t=>setTimeout(t,be)),await Q())return!0;return!1}catch{return!1}}async function Z(){if(await Q())return;if(!await Re()){let e=x();throw new Error(`Worker service failed to start on port ${e}.

Try manually running: pm2 start ecosystem.config.cjs
Or restart: pm2 restart claude-mem-worker`)}}import{existsSync as he,readFileSync as Ne}from"fs";import{homedir as Ie}from"os";import ye from"path";function P(o,e,s){if(o!==void 0){if(typeof o=="boolean")return o;if(typeof o=="string")return o.toLowerCase()==="true"}return e!==void 0?e.toLowerCase()==="true":s}function j(o,e,s){if(o!==void 0){if(typeof o=="number")return o;if(typeof o=="string"){let t=parseInt(o,10);if(!isNaN(t))return t}}if(e!==void 0){let t=parseInt(e,10);if(!isNaN(t))return t}return s}function ve(){let o=ye.join(Ie(),".claude-mem","settings.json"),e={};if(he(o))try{e=JSON.parse(Ne(o,"utf-8"))}catch(l){_.warn("CONFIG","Failed to parse settings.json, using environment/defaults",{},l)}let s=P(e.env?.CLAUDE_MEM_ENDLESS_MODE,process.env.CLAUDE_MEM_ENDLESS_MODE,!1),t=P(e.env?.CLAUDE_MEM_TRANSFORM_FALLBACK,process.env.CLAUDE_MEM_TRANSFORM_FALLBACK,!0),r=j(e.env?.CLAUDE_MEM_TRANSFORM_TIMEOUT,process.env.CLAUDE_MEM_TRANSFORM_TIMEOUT,500),i=j(e.env?.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,process.env.CLAUDE_MEM_TRANSFORM_KEEP_RECENT,0),n=j(e.env?.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,process.env.CLAUDE_MEM_ENDLESS_MODE__MAX_TOOL_HISTORY__MB,50),a=P(e.env?.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,process.env.CLAUDE_MEM_ENABLE_SYNCHRONOUS_MODE,s),p={enabled:s,fallbackToOriginal:t,maxLookupTime:r,keepRecentToolUses:i,maxToolHistoryMB:n,enableSynchronousMode:a};return s?_.info("CONFIG","Endless Mode enabled",{fallback:t,maxLookupTime:`${r}ms`,keepRecent:i,maxToolHistoryMB:`${n}MB`,syncMode:a}):_.debug("CONFIG","Endless Mode disabled"),p}var M=class{static getConfig=ve;static clearCache(){}};import{existsSync as Ae,readFileSync as Le,writeFileSync as Ce,appendFileSync as ke,statSync as De}from"fs";import{join as Me}from"path";var U=Me(C,"tool-outputs.jsonl");function $(o,e,s=Date.now()){k(C);let t=typeof e=="string"?e:JSON.stringify(e),r=Buffer.byteLength(t,"utf8"),n=JSON.stringify({tool_use_id:o,content:e,timestamp:s,size_bytes:r})+`
`;ke(U,n,"utf8")}function ee(o){if(!Ae(U)||De(U).size/(1024*1024)<=o)return;let r=Le(U,"utf8").trim().split(`
`).filter(m=>m.length>0),i=[];for(let m of r)try{i.push(JSON.parse(m))}catch{continue}i.sort((m,S)=>m.timestamp-S.timestamp);let n=o*1024*1024,a=0,p=0;for(let m=i.length-1;m>=0;m--){let S=i[m].size_bytes+100;if(a+S>n){p=m+1;break}a+=S}let g=i.slice(p).map(m=>JSON.stringify(m)).join(`
`)+`
`;Ce(U,g,"utf8")}var $e=new Set(["ListMcpResourcesTool","SlashCommand","Skill","TodoWrite","AskUserQuestion"]);function w(o,e){if(!o)return[];if(Array.isArray(o))return o;try{let s=JSON.parse(o);return Array.isArray(s)?s:[]}catch(s){return _.debug("HOOK",`Failed to parse ${e}`,{field:o,error:s}),[]}}function se(o){let e=[];e.push(`# ${o.title}`),o.subtitle&&e.push(`**${o.subtitle}**`),e.push(""),o.narrative&&(e.push(o.narrative),e.push(""));let s=w(o.facts,"facts");s.length>0&&(e.push("**Key Facts:**"),s.forEach(n=>e.push(`- ${n}`)),e.push(""));let t=w(o.concepts,"concepts");t.length>0&&(e.push(`**Concepts**: ${t.join(", ")}`),e.push(""));let r=w(o.files_read,"files_read");r.length>0&&(e.push(`**Files Read**: ${r.join(", ")}`),e.push(""));let i=w(o.files_modified,"files_modified");return i.length>0&&(e.push(`**Files Modified**: ${i.join(", ")}`),e.push("")),e.push("---"),e.push("*[Compressed by Endless Mode]*"),e.join(`
`)}async function We(o){let e=new Set;try{let s=Be(o),t=je({input:s,crlfDelay:1/0});for await(let n of t)if(n.includes("agentId"))try{let a=JSON.parse(n);a.toolUseResult?.agentId&&e.add(a.toolUseResult.agentId)}catch{}let r=He(o),i=Array.from(e).map(n=>Xe(r,`agent-${n}.jsonl`)).filter(n=>Fe(n));return _.debug("HOOK","Discovered agent transcripts",{agentCount:e.size,filesFound:i.length,agentFiles:i.map(n=>Pe(n))}),i}catch(s){return _.warn("HOOK","Failed to discover agent files",{mainTranscriptPath:o},s),[]}}async function Ks(o,e){let s=await We(o),t=await te(o,e),r=0,i=0;for(let n of s)try{let a=await te(n,e);r+=a.originalTokens,i+=a.compressedTokens}catch(a){_.warn("HOOK","Failed to transform agent transcript",{agentFile:n},a)}return{originalTokens:t.originalTokens+r,compressedTokens:t.compressedTokens+i}}async function te(o,e){try{k(C);let c=z(o);we(o,c),_.info("HOOK","Created transcript backup",{original:o,backup:c})}catch(c){throw _.error("HOOK","Failed to create transcript backup",{transcriptPath:o},c),new Error("Backup creation failed - aborting transformation for safety")}let t=W(o,"utf-8").trim().split(`
`),r={totalOriginalSize:0,totalCompressedSize:0,transformCount:0},i=new D,n=t.map((c,R)=>{if(!c.trim())return c;try{let u=JSON.parse(c);if(!Array.isArray(u.message?.content))return c;let d=!1;return u.type==="assistant"&&u.message.content.forEach(b=>{if(b.type==="tool_use"){let T=b;if(!T.id)return;let O=i.getAllObservationsForToolUseId(T.id);if(O.length>0){let y=JSON.stringify(T.input).length,v=O.map(N=>se(N)).join(`

---

`),A=v.length;if(A<y){try{$(T.id,JSON.stringify(T.input),Date.now())}catch(N){_.warn("HOOK","Failed to backup original tool input",{toolUseId:T.id},N)}T.input={_compressed:v},r.totalOriginalSize+=y,r.totalCompressedSize+=A,r.transformCount++,d=!0,_.success("HOOK","Transformed tool_use input",{toolUseId:T.id,originalSize:y,compressedSize:A,savings:`${Math.round((1-A/y)*100)}%`})}else _.debug("HOOK","Skipped input transformation (observation not shorter)",{toolUseId:T.id,originalSize:y,compressedSize:A})}}}),u.type==="user"&&u.message.content.forEach(b=>{if(b.type==="tool_result"){let T=b,O=T.tool_use_id;if(!O)return;let y=i.getAllObservationsForToolUseId(O);if(y.length>0){let v=JSON.stringify(T.content).length,A=y.map(F=>se(F)).join(`

---

`),N=A.length;if(N<v){try{$(O,JSON.stringify(T.content),Date.now())}catch(F){_.warn("HOOK","Failed to backup original tool output",{toolUseId:O},F)}T.content=A,r.totalOriginalSize+=v,r.totalCompressedSize+=N,r.transformCount++,d=!0,_.success("HOOK","Transformed tool_result output",{toolUseId:O,originalSize:v,compressedSize:N,savings:`${Math.round((1-N/v)*100)}%`})}else _.debug("HOOK","Skipped output transformation (observation not shorter)",{toolUseId:O,originalSize:v,compressedSize:N})}}}),d?JSON.stringify(u):c}catch(u){throw _.warn("HOOK","Malformed JSONL line in transcript",{lineIndex:R,error:u}),new Error(`Malformed JSONL line at index ${R}: ${u.message}`)}});i.close();let a=`${o}.tmp`;Ue(a,n.join(`
`)+`
`,"utf-8");let l=W(a,"utf-8").trim().split(`
`);for(let c of l)c.trim()&&JSON.parse(c);xe(a,o);let g=4,m=Math.ceil(r.totalOriginalSize/g),S=Math.ceil(r.totalCompressedSize/g);_.success("HOOK","Transcript transformation complete",{toolUseId:e,transformCount:r.transformCount,totalOriginalSize:r.totalOriginalSize,totalCompressedSize:r.totalCompressedSize,savings:r.totalOriginalSize>0?`${Math.round((1-r.totalCompressedSize/r.totalOriginalSize)*100)}%`:"0%"});try{let c=M.getConfig();c.maxToolHistoryMB>0&&(ee(c.maxToolHistoryMB),_.debug("HOOK","Trimmed tool output backup",{maxSizeMB:c.maxToolHistoryMB}))}catch(c){_.warn("HOOK","Failed to trim tool output backup",{},c)}return{originalTokens:m,compressedTokens:S}}async function Ge(o){if(!o){_.warn("HOOK","PostToolUse called with no input"),console.log(L("PostToolUse",!0));return}let{session_id:e,cwd:s,tool_name:t,tool_input:r,tool_response:i,transcript_path:n,tool_use_id:a}=o;if($e.has(t)){console.log(L("PostToolUse",!0));return}await Z();let p=new D,l=p.createSDKSession(e,"",""),g=p.getPromptCounter(l);p.close();let m=_.formatTool(t,r),S=x(),c=a;if(!c&&n)try{let h=W(n,"utf-8").trim().split(`
`);for(let b=h.length-1;b>=0;b--){let T=JSON.parse(h[b]);if(T.type==="user"&&Array.isArray(T.message.content)){for(let O of T.message.content)if(O.type==="tool_result"&&O.tool_use_id){c=O.tool_use_id;break}if(c)break}}}catch(d){E("Failed to extract tool_use_id from transcript",{error:d})}_.dataIn("HOOK",`PostToolUse: ${m}`,{sessionDbId:l,claudeSessionId:e,workerPort:S,toolUseId:c||E("tool_use_id not found in transcript",{toolName:t},"(none)")});let R=M.getConfig(),u=!!(R.enabled&&c&&n);E("Endless Mode Check",{configEnabled:R.enabled,hasToolUseId:!!c,hasTranscriptPath:!!n,isEndlessModeEnabled:u,toolName:t,toolUseId:c,allInputKeys:Object.keys(o).join(", ")});try{let d=u?3e4:2e3,h=await fetch(`http://127.0.0.1:${S}/sessions/${l}/observations?wait_until_obs_is_saved=${u}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:r!==void 0?JSON.stringify(r):"{}",tool_response:i!==void 0?JSON.stringify(i):"{}",prompt_number:g,cwd:s||E("save-hook: cwd missing",{sessionDbId:l,tool_name:t}),tool_use_id:c,transcript_path:n||E("save-hook: transcript_path missing",{sessionDbId:l,tool_name:t})}),signal:AbortSignal.timeout(d)});if(!h.ok){let b=await h.text();_.failure("HOOK","Failed to send observation",{sessionDbId:l,status:h.status},b),console.log(L("PostToolUse",!0));return}_.debug("HOOK","Observation sent successfully",{sessionDbId:l,toolName:t,mode:u?"synchronous (Endless Mode)":"async"})}catch(d){if(d.cause?.code==="ECONNREFUSED"){_.failure("HOOK","Worker connection refused",{sessionDbId:l},d),console.log(L("PostToolUse",!0,"Worker connection failed. Try: pm2 restart claude-mem-worker"));return}if(d.name==="TimeoutError"||d.message?.includes("timed out")){_.warn("HOOK","Observation request timed out - continuing",{sessionDbId:l,toolName:t}),console.log(L("PostToolUse",!0));return}_.warn("HOOK","Observation request failed - continuing anyway",{sessionDbId:l,toolName:t,error:d.message}),console.log(L("PostToolUse",!0));return}console.log(L("PostToolUse",!0))}var G="";re.on("data",o=>G+=o);re.on("end",async()=>{let o=G?JSON.parse(G):void 0;await Ge(o)});export{se as formatObservationAsMarkdown,te as transformTranscript,Ks as transformTranscriptWithAgents};
