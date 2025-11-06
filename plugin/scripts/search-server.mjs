#!/usr/bin/env node
import{Server as he}from"@modelcontextprotocol/sdk/server/index.js";import{StdioServerTransport as _e}from"@modelcontextprotocol/sdk/server/stdio.js";import{Client as fe}from"@modelcontextprotocol/sdk/client/index.js";import{StdioClientTransport as Ee}from"@modelcontextprotocol/sdk/client/stdio.js";import{CallToolRequestSchema as be,ListToolsRequestSchema as ge}from"@modelcontextprotocol/sdk/types.js";import{z as i}from"zod";import{zodToJsonSchema as Te}from"zod-to-json-schema";import{basename as Se}from"path";import pe from"better-sqlite3";import{join as L,dirname as ce,basename as xe}from"path";import{homedir as ee}from"os";import{existsSync as De,mkdirSync as de}from"fs";import{fileURLToPath as le}from"url";function ue(){return typeof __dirname<"u"?__dirname:ce(le(import.meta.url))}var $e=ue(),w=process.env.CLAUDE_MEM_DATA_DIR||L(ee(),".claude-mem"),V=process.env.CLAUDE_CONFIG_DIR||L(ee(),".claude"),ke=L(w,"archives"),Fe=L(w,"logs"),Ue=L(w,"trash"),Me=L(w,"backups"),je=L(w,"settings.json"),X=L(w,"claude-mem.db"),te=L(w,"vector-db"),Be=L(V,"settings.json"),Xe=L(V,"commands"),Pe=L(V,"CLAUDE.md");function P(c){de(c,{recursive:!0})}var G=class{db;constructor(e){e||(P(w),e=X),this.db=new pe(e),this.db.pragma("journal_mode = WAL"),this.ensureFTSTables()}ensureFTSTables(){try{let e=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all(),r=new Set(e.map(o=>o.name));if(["observations_fts","session_summaries_fts"].every(o=>r.has(o)))return;console.error("[SessionSearch] Creating FTS5 tables..."),this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
          title,
          subtitle,
          narrative,
          text,
          facts,
          concepts,
          content='observations',
          content_rowid='id'
        );
      `),this.db.exec(`
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        SELECT id, title, subtitle, narrative, text, facts, concepts
        FROM observations;
      `),this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
        END;

        CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        END;

        CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
          INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
          VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
        END;
      `),this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
          request,
          investigated,
          learned,
          completed,
          next_steps,
          notes,
          content='session_summaries',
          content_rowid='id'
        );
      `),this.db.exec(`
        INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
        SELECT id, request, investigated, learned, completed, next_steps, notes
        FROM session_summaries;
      `),this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
        END;

        CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
          INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
          VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
        END;
      `),console.error("[SessionSearch] FTS5 tables created successfully")}catch(e){console.error("[SessionSearch] FTS migration error:",e.message)}}escapeFTS5(e){return`"${e.replace(/"/g,'""')}"`}buildFilterClause(e,r,s="o"){let t=[];if(e.project&&(t.push(`${s}.project = ?`),r.push(e.project)),e.type)if(Array.isArray(e.type)){let o=e.type.map(()=>"?").join(",");t.push(`${s}.type IN (${o})`),r.push(...e.type)}else t.push(`${s}.type = ?`),r.push(e.type);if(e.dateRange){let{start:o,end:n}=e.dateRange;if(o){let a=typeof o=="number"?o:new Date(o).getTime();t.push(`${s}.created_at_epoch >= ?`),r.push(a)}if(n){let a=typeof n=="number"?n:new Date(n).getTime();t.push(`${s}.created_at_epoch <= ?`),r.push(a)}}if(e.concepts){let o=Array.isArray(e.concepts)?e.concepts:[e.concepts],n=o.map(()=>`EXISTS (SELECT 1 FROM json_each(${s}.concepts) WHERE value = ?)`);n.length>0&&(t.push(`(${n.join(" OR ")})`),r.push(...o))}if(e.files){let o=Array.isArray(e.files)?e.files:[e.files],n=o.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${s}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${s}.files_modified) WHERE value LIKE ?)
        )`);n.length>0&&(t.push(`(${n.join(" OR ")})`),o.forEach(a=>{r.push(`%${a}%`,`%${a}%`)}))}return t.length>0?t.join(" AND "):""}buildOrderClause(e="relevance",r=!0,s="observations_fts"){switch(e){case"relevance":return r?`ORDER BY ${s}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservations(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="relevance",...a}=r,d=this.escapeFTS5(e);s.push(d);let l=this.buildFilterClause(a,s,"o"),u=l?`AND ${l}`:"",p=this.buildOrderClause(n,!0),m=`
      SELECT
        o.*,
        observations_fts.rank as rank
      FROM observations o
      JOIN observations_fts ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${u}
      ${p}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let f=this.db.prepare(m).all(...s);if(f.length>0){let h=Math.min(...f.map(E=>E.rank||0)),_=Math.max(...f.map(E=>E.rank||0))-h||1;f.forEach(E=>{E.rank!==void 0&&(E.score=1-(E.rank-h)/_)})}return f}searchSessions(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="relevance",...a}=r,d=this.escapeFTS5(e);s.push(d);let l={...a};delete l.type;let u=this.buildFilterClause(l,s,"s"),h=`
      SELECT
        s.*,
        session_summaries_fts.rank as rank
      FROM session_summaries s
      JOIN session_summaries_fts ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${(u?`AND ${u}`:"").replace(/files_read/g,"files_read").replace(/files_modified/g,"files_edited")}
      ${n==="relevance"?"ORDER BY session_summaries_fts.rank ASC":n==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let b=this.db.prepare(h).all(...s);if(b.length>0){let _=Math.min(...b.map(T=>T.rank||0)),x=Math.max(...b.map(T=>T.rank||0))-_||1;b.forEach(T=>{T.rank!==void 0&&(T.score=1-(T.rank-_)/x)})}return b}findByConcept(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="date_desc",...a}=r,d={...a,concepts:e},l=this.buildFilterClause(d,s,"o"),u=this.buildOrderClause(n,!1),p=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${u}
      LIMIT ? OFFSET ?
    `;return s.push(t,o),this.db.prepare(p).all(...s)}findByFile(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="date_desc",...a}=r,d={...a,files:e},l=this.buildFilterClause(d,s,"o"),u=this.buildOrderClause(n,!1),p=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${u}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let m=this.db.prepare(p).all(...s),f=[],h={...a};delete h.type;let b=[];if(h.project&&(b.push("s.project = ?"),f.push(h.project)),h.dateRange){let{start:x,end:T}=h.dateRange;if(x){let g=typeof x=="number"?x:new Date(x).getTime();b.push("s.created_at_epoch >= ?"),f.push(g)}if(T){let g=typeof T=="number"?T:new Date(T).getTime();b.push("s.created_at_epoch <= ?"),f.push(g)}}b.push(`(
      EXISTS (SELECT 1 FROM json_each(s.files_read) WHERE value LIKE ?)
      OR EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)
    )`),f.push(`%${e}%`,`%${e}%`);let _=`
      SELECT s.*
      FROM session_summaries s
      WHERE ${b.join(" AND ")}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;f.push(t,o);let E=this.db.prepare(_).all(...f);return{observations:m,sessions:E}}findByType(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="date_desc",...a}=r,d={...a,type:e},l=this.buildFilterClause(d,s,"o"),u=this.buildOrderClause(n,!1),p=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${u}
      LIMIT ? OFFSET ?
    `;return s.push(t,o),this.db.prepare(p).all(...s)}searchUserPrompts(e,r={}){let s=[],{limit:t=20,offset:o=0,orderBy:n="relevance",...a}=r,d=this.escapeFTS5(e);s.push(d);let l=[];if(a.project&&(l.push("s.project = ?"),s.push(a.project)),a.dateRange){let{start:h,end:b}=a.dateRange;if(h){let _=typeof h=="number"?h:new Date(h).getTime();l.push("up.created_at_epoch >= ?"),s.push(_)}if(b){let _=typeof b=="number"?b:new Date(b).getTime();l.push("up.created_at_epoch <= ?"),s.push(_)}}let m=`
      SELECT
        up.*,
        user_prompts_fts.rank as rank
      FROM user_prompts up
      JOIN user_prompts_fts ON up.id = user_prompts_fts.rowid
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE user_prompts_fts MATCH ?
      ${l.length>0?`AND ${l.join(" AND ")}`:""}
      ${n==="relevance"?"ORDER BY user_prompts_fts.rank ASC":n==="date_asc"?"ORDER BY up.created_at_epoch ASC":"ORDER BY up.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let f=this.db.prepare(m).all(...s);if(f.length>0){let h=Math.min(...f.map(E=>E.rank||0)),_=Math.max(...f.map(E=>E.rank||0))-h||1;f.forEach(E=>{E.rank!==void 0&&(E.score=1-(E.rank-h)/_)})}return f}getUserPromptsBySession(e){return this.db.prepare(`
      SELECT
        id,
        claude_session_id,
        prompt_number,
        prompt_text,
        created_at,
        created_at_epoch
      FROM user_prompts
      WHERE claude_session_id = ?
      ORDER BY prompt_number ASC
    `).all(e)}close(){this.db.close()}};import me from"better-sqlite3";var K=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(K||{}),J=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=K[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,r){return`obs-${e}-${r}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let r=Object.keys(e);return r.length===0?"{}":r.length<=3?JSON.stringify(e):`{${r.length} keys: ${r.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,r){if(!r)return e;try{let s=typeof r=="string"?JSON.parse(r):r;if(e==="Bash"&&s.command){let t=s.command.length>50?s.command.substring(0,50)+"...":s.command;return`${e}(${t})`}if(e==="Read"&&s.file_path){let t=s.file_path.split("/").pop()||s.file_path;return`${e}(${t})`}if(e==="Edit"&&s.file_path){let t=s.file_path.split("/").pop()||s.file_path;return`${e}(${t})`}if(e==="Write"&&s.file_path){let t=s.file_path.split("/").pop()||s.file_path;return`${e}(${t})`}return e}catch{return e}}log(e,r,s,t,o){if(e<this.level)return;let n=new Date().toISOString().replace("T"," ").substring(0,23),a=K[e].padEnd(5),d=r.padEnd(6),l="";t?.correlationId?l=`[${t.correlationId}] `:t?.sessionId&&(l=`[session-${t.sessionId}] `);let u="";o!=null&&(this.level===0&&typeof o=="object"?u=`
`+JSON.stringify(o,null,2):u=" "+this.formatData(o));let p="";if(t){let{sessionId:f,sdkSessionId:h,correlationId:b,..._}=t;Object.keys(_).length>0&&(p=` {${Object.entries(_).map(([x,T])=>`${x}=${T}`).join(", ")}}`)}let m=`[${n}] [${a}] [${d}] ${l}${s}${p}${u}`;e===3?console.error(m):console.log(m)}debug(e,r,s,t){this.log(0,e,r,s,t)}info(e,r,s,t){this.log(1,e,r,s,t)}warn(e,r,s,t){this.log(2,e,r,s,t)}error(e,r,s,t){this.log(3,e,r,s,t)}dataIn(e,r,s,t){this.info(e,`\u2192 ${r}`,s,t)}dataOut(e,r,s,t){this.info(e,`\u2190 ${r}`,s,t)}success(e,r,s,t){this.info(e,`\u2713 ${r}`,s,t)}failure(e,r,s,t){this.error(e,`\u2717 ${r}`,s,t)}timing(e,r,s,t){this.info(e,`\u23F1 ${r}`,t,{duration:`${s}ms`})}},se=new J;var H=class{db;constructor(){P(w),this.db=new me(X),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);let e=this.db.prepare("SELECT version FROM schema_versions ORDER BY version").all();(e.length>0?Math.max(...e.map(s=>s.version)):0)===0&&(console.error("[SessionStore] Initializing fresh database with migration004..."),this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(t=>t.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(d=>d.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(d=>d.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(d=>d.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(t=>t.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.pragma("table_info(observations)").some(t=>t.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let s=this.db.pragma("table_info(observations)").find(t=>t.name==="text");if(!s||s.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.error("[SessionStore] Successfully made observations.text nullable")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}createUserPromptsTable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.pragma("table_info(user_prompts)").length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}console.error("[SessionStore] Creating user_prompts table with FTS5 support..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(s){throw this.db.exec("ROLLBACK"),s}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}getRecentSummaries(e,r=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,r)}getRecentSummariesWithSessionInfo(e,r=3){return this.db.prepare(`
      SELECT
        sdk_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,r)}getRecentObservations(e,r=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,r)}getAllRecentObservations(e=100){return this.db.prepare(`
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
      ORDER BY project ASC
    `).all().map(s=>s.project)}getRecentSessionsWithStatus(e,r=3){return this.db.prepare(`
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
    `).all(e,r)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationsByIds(e,r={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:t}=r,o=s==="date_asc"?"ASC":"DESC",n=t?`LIMIT ${t}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
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
    `).get(e)||null}getFilesForSession(e){let s=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),t=new Set,o=new Set;for(let n of s){if(n.files_read)try{let a=JSON.parse(n.files_read);Array.isArray(a)&&a.forEach(d=>t.add(d))}catch{}if(n.files_modified)try{let a=JSON.parse(n.files_modified);Array.isArray(a)&&a.forEach(d=>o.add(d))}catch{}}return{filesRead:Array.from(t),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)||null}reactivateSession(e,r){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(r,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||1}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||0}createSDKSession(e,r,s){let t=new Date,o=t.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,r,s,t.toISOString(),o);return a.lastInsertRowid===0||a.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:a.lastInsertRowid}updateSDKSessionId(e,r){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(r,e).changes===0?(se.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:r}),!1):!0}setWorkerPort(e,r){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(r,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,r,s){let t=new Date,o=t.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,r,s,t.toISOString(),o).lastInsertRowid}storeObservation(e,r,s,t){let o=new Date,n=o.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,r,o.toISOString(),n),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let u=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,r,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),t||null,o.toISOString(),n);return{id:Number(u.lastInsertRowid),createdAtEpoch:n}}storeSummary(e,r,s,t){let o=new Date,n=o.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,r,o.toISOString(),n),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let u=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,r,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,t||null,o.toISOString(),n);return{id:Number(u.lastInsertRowid),createdAtEpoch:n}}markSessionCompleted(e){let r=new Date,s=r.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(r.toISOString(),s,e)}markSessionFailed(e){let r=new Date,s=r.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(r.toISOString(),s,e)}cleanupOrphanedSessions(){let e=new Date,r=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),r).changes}getSessionSummariesByIds(e,r={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:t}=r,o=s==="date_asc"?"ASC":"DESC",n=t?`LIMIT ${t}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${o}
      ${n}
    `).all(...e)}getUserPromptsByIds(e,r={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:t}=r,o=s==="date_asc"?"ASC":"DESC",n=t?`LIMIT ${t}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${o}
      ${n}
    `).all(...e)}getTimelineAroundTimestamp(e,r=10,s=10,t){return this.getTimelineAroundObservation(null,e,r,s,t)}getTimelineAroundObservation(e,r,s=10,t=10,o){let n=o?"AND project = ?":"",a=o?[o]:[],d,l;if(e!==null){let f=`
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
      `;try{let b=this.db.prepare(f).all(e,...a,s+1),_=this.db.prepare(h).all(e,...a,t+1);if(b.length===0&&_.length===0)return{observations:[],sessions:[],prompts:[]};d=b.length>0?b[b.length-1].created_at_epoch:r,l=_.length>0?_[_.length-1].created_at_epoch:r}catch(b){return console.error("[SessionStore] Error getting boundary observations:",b.message),{observations:[],sessions:[],prompts:[]}}}else{let f=`
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
      `;try{let b=this.db.prepare(f).all(r,...a,s),_=this.db.prepare(h).all(r,...a,t+1);if(b.length===0&&_.length===0)return{observations:[],sessions:[],prompts:[]};d=b.length>0?b[b.length-1].created_at_epoch:r,l=_.length>0?_[_.length-1].created_at_epoch:r}catch(b){return console.error("[SessionStore] Error getting boundary timestamps:",b.message),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,p=`
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
    `;try{let f=this.db.prepare(u).all(d,l,...a),h=this.db.prepare(p).all(d,l,...a),b=this.db.prepare(m).all(d,l,...a);return{observations:f,sessions:h.map(_=>({id:_.id,sdk_session_id:_.sdk_session_id,project:_.project,request:_.request,completed:_.completed,next_steps:_.next_steps,created_at:_.created_at,created_at_epoch:_.created_at_epoch})),prompts:b.map(_=>({id:_.id,claude_session_id:_.claude_session_id,project:_.project,prompt:_.prompt_text,created_at:_.created_at,created_at_epoch:_.created_at_epoch}))}}catch(f){return console.error("[SessionStore] Error querying timeline records:",f.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var $,N,k=null,ye="cm__claude-mem";try{$=new G,N=new H}catch(c){console.error("[search-server] Failed to initialize search:",c.message),process.exit(1)}async function M(c,e,r){if(!k)throw new Error("Chroma client not initialized");let t=(await k.callTool({name:"chroma_query_documents",arguments:{collection_name:ye,query_texts:[c],n_results:e,include:["documents","metadatas","distances"],where:r}})).content[0]?.text||"",o;try{o=JSON.parse(t)}catch(u){return console.error("[search-server] Failed to parse Chroma response as JSON:",u),{ids:[],distances:[],metadatas:[]}}let n=[],a=o.ids?.[0]||[];for(let u of a){let p=u.match(/obs_(\d+)_/),m=u.match(/summary_(\d+)_/),f=u.match(/prompt_(\d+)/),h=null;p?h=parseInt(p[1],10):m?h=parseInt(m[1],10):f&&(h=parseInt(f[1],10)),h!==null&&!n.includes(h)&&n.push(h)}let d=o.distances?.[0]||[],l=o.metadatas?.[0]||[];return{ids:n,distances:d,metadatas:l}}function j(){return`
---
\u{1F4A1} Search Strategy:
ALWAYS search with index format FIRST to get an overview and identify relevant results.
This is critical for token efficiency - index format uses ~10x fewer tokens than full format.

Search workflow:
1. Initial search: Use default (index) format to see titles, dates, and sources
2. Review results: Identify which items are most relevant to your needs
3. Deep dive: Only then use format: "full" on specific items of interest
4. Narrow down: Use filters (type, dateRange, concepts, files) to refine results

Other tips:
\u2022 To search by concept: Use find_by_concept tool
\u2022 To browse by type: Use find_by_type with ["decision", "feature", etc.]
\u2022 To sort by date: Use orderBy: "date_desc" or "date_asc"`}function q(c,e){let r=c.title||`Observation #${c.id}`,s=new Date(c.created_at_epoch).toLocaleString(),t=c.type?`[${c.type}]`:"";return`${e+1}. ${t} ${r}
   Date: ${s}
   Source: claude-mem://observation/${c.id}`}function re(c,e){let r=c.request||`Session ${c.sdk_session_id.substring(0,8)}`,s=new Date(c.created_at_epoch).toLocaleString();return`${e+1}. ${r}
   Date: ${s}
   Source: claude-mem://session/${c.sdk_session_id}`}function W(c,e){let r=c.title||`Observation #${c.id}`,s=[];s.push(`## ${r}`),s.push(`*Source: claude-mem://observation/${c.id}*`),s.push(""),c.subtitle&&(s.push(`**${c.subtitle}**`),s.push("")),c.narrative&&(s.push(c.narrative),s.push("")),c.text&&(s.push(c.text),s.push(""));let t=[];if(t.push(`Type: ${c.type}`),c.facts)try{let n=JSON.parse(c.facts);n.length>0&&t.push(`Facts: ${n.join("; ")}`)}catch{}if(c.concepts)try{let n=JSON.parse(c.concepts);n.length>0&&t.push(`Concepts: ${n.join(", ")}`)}catch{}if(c.files_read||c.files_modified){let n=[];if(c.files_read)try{n.push(...JSON.parse(c.files_read))}catch{}if(c.files_modified)try{n.push(...JSON.parse(c.files_modified))}catch{}n.length>0&&t.push(`Files: ${[...new Set(n)].join(", ")}`)}t.length>0&&(s.push("---"),s.push(t.join(" | ")));let o=new Date(c.created_at_epoch).toLocaleString();return s.push(""),s.push("---"),s.push(`Date: ${o}`),s.join(`
`)}function ne(c,e){let r=c.request||`Session ${c.sdk_session_id.substring(0,8)}`,s=[];s.push(`## ${r}`),s.push(`*Source: claude-mem://session/${c.sdk_session_id}*`),s.push(""),c.completed&&(s.push(`**Completed:** ${c.completed}`),s.push("")),c.learned&&(s.push(`**Learned:** ${c.learned}`),s.push("")),c.investigated&&(s.push(`**Investigated:** ${c.investigated}`),s.push("")),c.next_steps&&(s.push(`**Next Steps:** ${c.next_steps}`),s.push("")),c.notes&&(s.push(`**Notes:** ${c.notes}`),s.push(""));let t=[];if(c.files_read||c.files_edited){let n=[];if(c.files_read)try{n.push(...JSON.parse(c.files_read))}catch{}if(c.files_edited)try{n.push(...JSON.parse(c.files_edited))}catch{}n.length>0&&t.push(`Files: ${[...new Set(n)].join(", ")}`)}let o=new Date(c.created_at_epoch).toLocaleDateString();return t.push(`Date: ${o}`),t.length>0&&(s.push("---"),s.push(t.join(" | "))),s.join(`
`)}function Re(c,e){let r=new Date(c.created_at_epoch).toLocaleString();return`${e+1}. "${c.prompt_text}"
   Date: ${r} | Prompt #${c.prompt_number}
   Source: claude-mem://user-prompt/${c.id}`}function ve(c,e){let r=[];r.push(`## User Prompt #${c.prompt_number}`),r.push(`*Source: claude-mem://user-prompt/${c.id}*`),r.push(""),r.push(c.prompt_text),r.push(""),r.push("---");let s=new Date(c.created_at_epoch).toLocaleString();return r.push(`Date: ${s}`),r.join(`
`)}var Oe=i.object({project:i.string().optional().describe("Filter by project name"),type:i.union([i.enum(["decision","bugfix","feature","refactor","discovery","change"]),i.array(i.enum(["decision","bugfix","feature","refactor","discovery","change"]))]).optional().describe("Filter by observation type"),concepts:i.union([i.string(),i.array(i.string())]).optional().describe("Filter by concept tags"),files:i.union([i.string(),i.array(i.string())]).optional().describe("Filter by file paths (partial match)"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional().describe("Start date (ISO string or epoch)"),end:i.union([i.string(),i.number()]).optional().describe("End date (ISO string or epoch)")}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),oe=[{name:"search_observations",description:'Search observations using full-text search across titles, narratives, facts, and concepts. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),...Oe.shape}),handler:async c=>{try{let{query:e,format:r="index",...s}=c,t=[];if(k)try{console.error("[search-server] Using hybrid semantic search (Chroma + SQLite)");let n=await M(e,100);if(console.error(`[search-server] Chroma returned ${n.ids.length} semantic matches`),n.ids.length>0){let a=Date.now()-7776e6,d=n.ids.filter((l,u)=>{let p=n.metadatas[u];return p&&p.created_at_epoch>a});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=s.limit||20;t=N.getObservationsByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} observations from SQLite`)}}}catch(n){console.error("[search-server] Chroma query failed, falling back to FTS5:",n.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=$.searchObservations(e,s)),t.length===0)return{content:[{type:"text",text:`No observations found matching "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} observation(s) matching "${e}":

`,a=t.map((d,l)=>q(d,l));o=n+a.join(`

`)+j()}else o=t.map((a,d)=>W(a,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"search_sessions",description:'Search session summaries using full-text search across requests, completions, learnings, and notes. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{query:e,format:r="index",...s}=c,t=[];if(k)try{console.error("[search-server] Using hybrid semantic search for sessions");let n=await M(e,100,{doc_type:"session_summary"});if(console.error(`[search-server] Chroma returned ${n.ids.length} semantic matches`),n.ids.length>0){let a=Date.now()-7776e6,d=n.ids.filter((l,u)=>{let p=n.metadatas[u];return p&&p.created_at_epoch>a});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=s.limit||20;t=N.getSessionSummariesByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} sessions from SQLite`)}}}catch(n){console.error("[search-server] Chroma query failed, falling back to FTS5:",n.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=$.searchSessions(e,s)),t.length===0)return{content:[{type:"text",text:`No sessions found matching "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} session(s) matching "${e}":

`,a=t.map((d,l)=>re(d,l));o=n+a.join(`

`)+j()}else o=t.map((a,d)=>ne(a,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_concept",description:'Find observations tagged with a specific concept. Available concepts: "discovery", "problem-solution", "what-changed", "how-it-works", "pattern", "gotcha", "change". IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({concept:i.string().describe("Concept tag to search for. Available: discovery, problem-solution, what-changed, how-it-works, pattern, gotcha, change"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{concept:e,format:r="index",...s}=c,t=[];if(k)try{console.error("[search-server] Using metadata-first + semantic ranking for concept search");let n=$.findByConcept(e,s);if(console.error(`[search-server] Found ${n.length} observations with concept "${e}"`),n.length>0){let a=n.map(u=>u.id),d=await M(e,Math.min(a.length,100)),l=[];for(let u of d.ids)a.includes(u)&&!l.includes(u)&&l.push(u);console.error(`[search-server] Chroma ranked ${l.length} results by semantic relevance`),l.length>0&&(t=N.getObservationsByIds(l,{limit:s.limit||20}),t.sort((u,p)=>l.indexOf(u.id)-l.indexOf(p.id)))}}catch(n){console.error("[search-server] Chroma ranking failed, using SQLite order:",n.message)}if(t.length===0&&(console.error("[search-server] Using SQLite-only concept search"),t=$.findByConcept(e,s)),t.length===0)return{content:[{type:"text",text:`No observations found with concept "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} observation(s) with concept "${e}":

`,a=t.map((d,l)=>q(d,l));o=n+a.join(`

`)+j()}else o=t.map((a,d)=>W(a,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_file",description:'Find observations and sessions that reference a specific file path. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({filePath:i.string().describe("File path to search for (supports partial matching)"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{filePath:e,format:r="index",...s}=c,t=[],o=[];if(k)try{console.error("[search-server] Using metadata-first + semantic ranking for file search");let d=$.findByFile(e,s);if(console.error(`[search-server] Found ${d.observations.length} observations, ${d.sessions.length} sessions for file "${e}"`),o=d.sessions,d.observations.length>0){let l=d.observations.map(m=>m.id),u=await M(e,Math.min(l.length,100)),p=[];for(let m of u.ids)l.includes(m)&&!p.includes(m)&&p.push(m);console.error(`[search-server] Chroma ranked ${p.length} observations by semantic relevance`),p.length>0&&(t=N.getObservationsByIds(p,{limit:s.limit||20}),t.sort((m,f)=>p.indexOf(m.id)-p.indexOf(f.id)))}}catch(d){console.error("[search-server] Chroma ranking failed, using SQLite order:",d.message)}if(t.length===0&&o.length===0){console.error("[search-server] Using SQLite-only file search");let d=$.findByFile(e,s);t=d.observations,o=d.sessions}let n=t.length+o.length;if(n===0)return{content:[{type:"text",text:`No results found for file "${e}"`}]};let a;if(r==="index"){let d=`Found ${n} result(s) for file "${e}":

`,l=[];t.forEach((u,p)=>{l.push(q(u,p))}),o.forEach((u,p)=>{l.push(re(u,p+t.length))}),a=d+l.join(`

`)+j()}else{let d=[];t.forEach((l,u)=>{d.push(W(l,u))}),o.forEach((l,u)=>{d.push(ne(l,u+t.length))}),a=d.join(`

---

`)}return{content:[{type:"text",text:a}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_type",description:'Find observations of a specific type (decision, bugfix, feature, refactor, discovery, change). IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({type:i.union([i.enum(["decision","bugfix","feature","refactor","discovery","change"]),i.array(i.enum(["decision","bugfix","feature","refactor","discovery","change"]))]).describe("Observation type(s) to filter by"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{type:e,format:r="index",...s}=c,t=Array.isArray(e)?e.join(", "):e,o=[];if(k)try{console.error("[search-server] Using metadata-first + semantic ranking for type search");let a=$.findByType(e,s);if(console.error(`[search-server] Found ${a.length} observations with type "${t}"`),a.length>0){let d=a.map(p=>p.id),l=await M(t,Math.min(d.length,100)),u=[];for(let p of l.ids)d.includes(p)&&!u.includes(p)&&u.push(p);console.error(`[search-server] Chroma ranked ${u.length} results by semantic relevance`),u.length>0&&(o=N.getObservationsByIds(u,{limit:s.limit||20}),o.sort((p,m)=>u.indexOf(p.id)-u.indexOf(m.id)))}}catch(a){console.error("[search-server] Chroma ranking failed, using SQLite order:",a.message)}if(o.length===0&&(console.error("[search-server] Using SQLite-only type search"),o=$.findByType(e,s)),o.length===0)return{content:[{type:"text",text:`No observations found with type "${t}"`}]};let n;if(r==="index"){let a=`Found ${o.length} observation(s) with type "${t}":

`,d=o.map((l,u)=>q(l,u));n=a+d.join(`

`)+j()}else n=o.map((d,l)=>W(d,l)).join(`

---

`);return{content:[{type:"text",text:n}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"get_recent_context",description:"Get recent session context including summaries and observations for a project",inputSchema:i.object({project:i.string().optional().describe("Project name (defaults to current working directory basename)"),limit:i.number().min(1).max(10).default(3).describe("Number of recent sessions to retrieve")}),handler:async c=>{try{let e=c.project||Se(process.cwd()),r=c.limit||3,s=N.getRecentSessionsWithStatus(e,r);if(s.length===0)return{content:[{type:"text",text:`# Recent Session Context

No previous sessions found for project "${e}".`}]};let t=[];t.push("# Recent Session Context"),t.push(""),t.push(`Showing last ${s.length} session(s) for **${e}**:`),t.push("");for(let o of s)if(o.sdk_session_id){if(t.push("---"),t.push(""),o.has_summary){let n=N.getSummaryForSession(o.sdk_session_id);if(n){let a=n.prompt_number?` (Prompt #${n.prompt_number})`:"";if(t.push(`**Summary${a}**`),t.push(""),n.request&&t.push(`**Request:** ${n.request}`),n.completed&&t.push(`**Completed:** ${n.completed}`),n.learned&&t.push(`**Learned:** ${n.learned}`),n.next_steps&&t.push(`**Next Steps:** ${n.next_steps}`),n.files_read)try{let l=JSON.parse(n.files_read);Array.isArray(l)&&l.length>0&&t.push(`**Files Read:** ${l.join(", ")}`)}catch{n.files_read.trim()&&t.push(`**Files Read:** ${n.files_read}`)}if(n.files_edited)try{let l=JSON.parse(n.files_edited);Array.isArray(l)&&l.length>0&&t.push(`**Files Edited:** ${l.join(", ")}`)}catch{n.files_edited.trim()&&t.push(`**Files Edited:** ${n.files_edited}`)}let d=new Date(n.created_at).toLocaleString();t.push(`**Date:** ${d}`)}}else if(o.status==="active"){t.push("**In Progress**"),t.push(""),o.user_prompt&&t.push(`**Request:** ${o.user_prompt}`);let n=N.getObservationsForSession(o.sdk_session_id);if(n.length>0){t.push(""),t.push(`**Observations (${n.length}):**`);for(let d of n)t.push(`- ${d.title}`)}else t.push(""),t.push("*No observations yet*");t.push(""),t.push("**Status:** Active - summary pending");let a=new Date(o.started_at).toLocaleString();t.push(`**Date:** ${a}`)}else{t.push(`**${o.status.charAt(0).toUpperCase()+o.status.slice(1)}**`),t.push(""),o.user_prompt&&t.push(`**Request:** ${o.user_prompt}`),t.push(""),t.push(`**Status:** ${o.status} - no summary available`);let n=new Date(o.started_at).toLocaleString();t.push(`**Date:** ${n}`)}t.push("")}return{content:[{type:"text",text:t.join(`
`)}]}}catch(e){return{content:[{type:"text",text:`Failed to get recent context: ${e.message}`}],isError:!0}}}},{name:"search_user_prompts",description:'Search raw user prompts with full-text search. Use this to find what the user actually said/requested across all sessions. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for truncated prompts/dates (default, RECOMMENDED for initial search), "full" for complete prompt text (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{query:e,format:r="index",...s}=c,t=[];if(k)try{console.error("[search-server] Using hybrid semantic search for user prompts");let n=await M(e,100,{doc_type:"user_prompt"});if(console.error(`[search-server] Chroma returned ${n.ids.length} semantic matches`),n.ids.length>0){let a=Date.now()-7776e6,d=n.ids.filter((l,u)=>{let p=n.metadatas[u];return p&&p.created_at_epoch>a});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=s.limit||20;t=N.getUserPromptsByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} user prompts from SQLite`)}}}catch(n){console.error("[search-server] Chroma query failed, falling back to FTS5:",n.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=$.searchUserPrompts(e,s)),t.length===0)return{content:[{type:"text",text:`No user prompts found matching "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} user prompt(s) matching "${e}":

`,a=t.map((d,l)=>Re(d,l));o=n+a.join(`

`)+j()}else o=t.map((a,d)=>ve(a,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"get_context_timeline",description:'Get a unified timeline of context (observations, sessions, and prompts) around a specific point in time. All record types are interleaved chronologically. Useful for understanding "what was happening when X occurred". Returns depth_before records before anchor + anchor + depth_after records after (total: depth_before + 1 + depth_after mixed records).',inputSchema:i.object({anchor:i.union([i.number().describe("Observation ID to center timeline around"),i.string().describe("Session ID (format: S123) or ISO timestamp to center timeline around")]).describe('Anchor point: observation ID, session ID (e.g., "S123"), or ISO timestamp'),depth_before:i.number().min(0).max(50).default(10).describe("Number of records to retrieve before anchor, not including anchor (default: 10)"),depth_after:i.number().min(0).max(50).default(10).describe("Number of records to retrieve after anchor, not including anchor (default: 10)"),project:i.string().optional().describe("Filter by project name")}),handler:async c=>{try{let f=function(g){return new Date(g).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})},h=function(g){return new Date(g).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})},b=function(g){return new Date(g).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})},_=function(g){return g?Math.ceil(g.length/4):0};var e=f,r=h,s=b,t=_;let{anchor:o,depth_before:n=10,depth_after:a=10,project:d}=c,l,u=o,p;if(typeof o=="number"){let g=N.getObservationById(o);if(!g)return{content:[{type:"text",text:`Observation #${o} not found`}],isError:!0};l=g.created_at_epoch,p=N.getTimelineAroundObservation(o,l,n,a,d)}else if(typeof o=="string")if(o.startsWith("S")||o.startsWith("#S")){let g=o.replace(/^#?S/,""),I=parseInt(g,10),S=N.getSessionSummariesByIds([I]);if(S.length===0)return{content:[{type:"text",text:`Session #${I} not found`}],isError:!0};l=S[0].created_at_epoch,u=`S${I}`,p=N.getTimelineAroundTimestamp(l,n,a,d)}else{let g=new Date(o);if(isNaN(g.getTime()))return{content:[{type:"text",text:`Invalid timestamp: ${o}`}],isError:!0};l=g.getTime(),p=N.getTimelineAroundTimestamp(l,n,a,d)}else return{content:[{type:"text",text:'Invalid anchor: must be observation ID (number), session ID (e.g., "S123"), or ISO timestamp'}],isError:!0};let m=[...p.observations.map(g=>({type:"observation",data:g,epoch:g.created_at_epoch})),...p.sessions.map(g=>({type:"session",data:g,epoch:g.created_at_epoch})),...p.prompts.map(g=>({type:"prompt",data:g,epoch:g.created_at_epoch}))];if(m.sort((g,I)=>g.epoch-I.epoch),m.length===0)return{content:[{type:"text",text:`No context found around ${new Date(l).toLocaleString()} (${n} records before, ${a} records after)`}]};let E=[];E.push(`# Timeline around anchor: ${u}`),E.push(`**Window:** ${n} records before \u2192 ${a} records after | **Items:** ${m.length} (${p.observations.length} obs, ${p.sessions.length} sessions, ${p.prompts.length} prompts)`),E.push(""),E.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u{1F9E0} decision"),E.push("");let x=new Map;for(let g of m){let I=f(g.epoch);x.has(I)||x.set(I,[]),x.get(I).push(g)}let T=Array.from(x.entries()).sort((g,I)=>{let S=new Date(g[0]).getTime(),O=new Date(I[0]).getTime();return S-O});for(let[g,I]of T){E.push(`### ${g}`),E.push("");let S=null,O="",C=!1;for(let v of I){let F=typeof u=="number"&&v.type==="observation"&&v.data.id===u||typeof u=="string"&&u.startsWith("S")&&v.type==="session"&&`S${v.data.id}`===u;if(v.type==="session"){C&&(E.push(""),C=!1,S=null,O="");let y=v.data,U=y.request||"Session summary",R=`claude-mem://session-summary/${y.id}`,A=F?" \u2190 **ANCHOR**":"";E.push(`**\u{1F3AF} #S${y.id}** ${U} (${b(v.epoch)}) [\u2192](${R})${A}`),E.push("")}else if(v.type==="prompt"){C&&(E.push(""),C=!1,S=null,O="");let y=v.data,U=y.prompt.length>100?y.prompt.substring(0,100)+"...":y.prompt;E.push(`**\u{1F4AC} User Prompt #${y.prompt_number}** (${b(v.epoch)})`),E.push(`> ${U}`),E.push("")}else if(v.type==="observation"){let y=v.data,U="General";U!==S&&(C&&E.push(""),E.push(`**${U}**`),E.push("| ID | Time | T | Title | Tokens |"),E.push("|----|------|---|-------|--------|"),S=U,C=!0,O="");let R="\u2022";switch(y.type){case"bugfix":R="\u{1F534}";break;case"feature":R="\u{1F7E3}";break;case"refactor":R="\u{1F504}";break;case"change":R="\u2705";break;case"discovery":R="\u{1F535}";break;case"decision":R="\u{1F9E0}";break}let A=h(v.epoch),D=y.title||"Untitled",B=_(y.narrative),Y=A!==O?A:"\u2033";O=A;let Z=F?" \u2190 **ANCHOR**":"";E.push(`| #${y.id} | ${Y} | ${R} | ${D}${Z} | ~${B} |`)}}C&&E.push("")}return{content:[{type:"text",text:E.join(`
`)}]}}catch(o){return{content:[{type:"text",text:`Timeline query failed: ${o.message}`}],isError:!0}}}},{name:"get_timeline_by_query",description:'Search for observations using natural language and get timeline context around the best match. Two modes: "auto" (default) automatically uses top result as timeline anchor; "interactive" returns top matches for you to choose from. This combines search + timeline into a single operation for faster context discovery.',inputSchema:i.object({query:i.string().describe("Natural language search query to find relevant observations"),mode:i.enum(["auto","interactive"]).default("auto").describe("auto: Automatically use top search result as timeline anchor. interactive: Show top N search results for manual anchor selection."),depth_before:i.number().min(0).max(50).default(10).describe("Number of timeline records before anchor (default: 10)"),depth_after:i.number().min(0).max(50).default(10).describe("Number of timeline records after anchor (default: 10)"),limit:i.number().min(1).max(20).default(5).describe("For interactive mode: number of top search results to display (default: 5)"),project:i.string().optional().describe("Filter by project name")}),handler:async c=>{try{let{query:o,mode:n="auto",depth_before:a=10,depth_after:d=10,limit:l=5,project:u}=c,p=[];if(k)try{console.error("[search-server] Using hybrid semantic search for timeline query");let m=await M(o,100);if(console.error(`[search-server] Chroma returned ${m.ids.length} semantic matches`),m.ids.length>0){let f=Date.now()-7776e6,h=m.ids.filter((b,_)=>{let E=m.metadatas[_];return E&&E.created_at_epoch>f});console.error(`[search-server] ${h.length} results within 90-day window`),h.length>0&&(p=N.getObservationsByIds(h,{orderBy:"date_desc",limit:n==="auto"?1:l}),console.error(`[search-server] Hydrated ${p.length} observations from SQLite`))}}catch(m){console.error("[search-server] Chroma query failed, falling back to FTS5:",m.message)}if(p.length===0&&(console.error("[search-server] Using FTS5 keyword search"),p=$.searchObservations(o,{orderBy:"relevance",limit:n==="auto"?1:l,project:u})),p.length===0)return{content:[{type:"text",text:`No observations found matching "${o}". Try a different search query.`}]};if(n==="interactive"){let m=[];m.push("# Timeline Anchor Search Results"),m.push(""),m.push(`Found ${p.length} observation(s) matching "${o}"`),m.push(""),m.push("To get timeline context around any of these observations, use the `get_context_timeline` tool with the observation ID as the anchor."),m.push(""),m.push(`**Top ${p.length} matches:**`),m.push("");for(let f=0;f<p.length;f++){let h=p[f],b=h.title||`Observation #${h.id}`,_=new Date(h.created_at_epoch).toLocaleString(),E=h.type?`[${h.type}]`:"";m.push(`${f+1}. **${E} ${b}**`),m.push(`   - ID: ${h.id}`),m.push(`   - Date: ${_}`),h.subtitle&&m.push(`   - ${h.subtitle}`),m.push(`   - Source: claude-mem://observation/${h.id}`),m.push("")}return{content:[{type:"text",text:m.join(`
`)}]}}else{let b=function(S){return new Date(S).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})},_=function(S){return new Date(S).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})},E=function(S){return new Date(S).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})},x=function(S){return S?Math.ceil(S.length/4):0};var e=b,r=_,s=E,t=x;let m=p[0];console.error(`[search-server] Auto mode: Using observation #${m.id} as timeline anchor`);let f=N.getTimelineAroundObservation(m.id,m.created_at_epoch,a,d,u),h=[...f.observations.map(S=>({type:"observation",data:S,epoch:S.created_at_epoch})),...f.sessions.map(S=>({type:"session",data:S,epoch:S.created_at_epoch})),...f.prompts.map(S=>({type:"prompt",data:S,epoch:S.created_at_epoch}))];if(h.sort((S,O)=>S.epoch-O.epoch),h.length===0)return{content:[{type:"text",text:`Found observation #${m.id} matching "${o}", but no timeline context available (${a} records before, ${d} records after).`}]};let T=[];T.push(`# Timeline for query: "${o}"`),T.push(`**Anchor:** Observation #${m.id} - ${m.title||"Untitled"}`),T.push(`**Window:** ${a} records before \u2192 ${d} records after | **Items:** ${h.length} (${f.observations.length} obs, ${f.sessions.length} sessions, ${f.prompts.length} prompts)`),T.push(""),T.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u{1F9E0} decision"),T.push("");let g=new Map;for(let S of h){let O=b(S.epoch);g.has(O)||g.set(O,[]),g.get(O).push(S)}let I=Array.from(g.entries()).sort((S,O)=>{let C=new Date(S[0]).getTime(),v=new Date(O[0]).getTime();return C-v});for(let[S,O]of I){T.push(`### ${S}`),T.push("");let C=null,v="",F=!1;for(let y of O){let U=y.type==="observation"&&y.data.id===m.id;if(y.type==="session"){F&&(T.push(""),F=!1,C=null,v="");let R=y.data,A=R.request||"Session summary",D=`claude-mem://session-summary/${R.id}`;T.push(`**\u{1F3AF} #S${R.id}** ${A} (${E(y.epoch)}) [\u2192](${D})`),T.push("")}else if(y.type==="prompt"){F&&(T.push(""),F=!1,C=null,v="");let R=y.data,A=R.prompt.length>100?R.prompt.substring(0,100)+"...":R.prompt;T.push(`**\u{1F4AC} User Prompt #${R.prompt_number}** (${E(y.epoch)})`),T.push(`> ${A}`),T.push("")}else if(y.type==="observation"){let R=y.data,A="General";A!==C&&(F&&T.push(""),T.push(`**${A}**`),T.push("| ID | Time | T | Title | Tokens |"),T.push("|----|------|---|-------|--------|"),C=A,F=!0,v="");let D="\u2022";switch(R.type){case"bugfix":D="\u{1F534}";break;case"feature":D="\u{1F7E3}";break;case"refactor":D="\u{1F504}";break;case"change":D="\u2705";break;case"discovery":D="\u{1F535}";break;case"decision":D="\u{1F9E0}";break}let B=_(y.epoch),z=R.title||"Untitled",Y=x(R.narrative),ie=B!==v?B:"\u2033";v=B;let ae=U?" \u2190 **ANCHOR**":"";T.push(`| #${R.id} | ${ie} | ${D} | ${z}${ae} | ~${Y} |`)}}F&&T.push("")}return{content:[{type:"text",text:T.join(`
`)}]}}}catch(o){return{content:[{type:"text",text:`Timeline query failed: ${o.message}`}],isError:!0}}}}],Q=new he({name:"claude-mem-search",version:"1.0.0"},{capabilities:{tools:{}}});Q.setRequestHandler(ge,async()=>({tools:oe.map(c=>({name:c.name,description:c.description,inputSchema:Te(c.inputSchema)}))}));Q.setRequestHandler(be,async c=>{let e=oe.find(r=>r.name===c.params.name);if(!e)throw new Error(`Unknown tool: ${c.params.name}`);try{return await e.handler(c.params.arguments||{})}catch(r){return{content:[{type:"text",text:`Tool execution failed: ${r.message}`}],isError:!0}}});async function Ie(){let c=new _e;await Q.connect(c),console.error("[search-server] Claude-mem search server started"),setTimeout(async()=>{try{console.error("[search-server] Initializing Chroma client...");let e=new Ee({command:"uvx",args:["chroma-mcp","--client-type","persistent","--data-dir",te],stderr:"ignore"}),r=new fe({name:"claude-mem-search-chroma-client",version:"1.0.0"},{capabilities:{}});await r.connect(e),k=r,console.error("[search-server] Chroma client connected successfully")}catch(e){console.error("[search-server] Failed to initialize Chroma client:",e.message),console.error("[search-server] Falling back to FTS5-only search"),k=null}},0)}Ie().catch(c=>{console.error("[search-server] Fatal error:",c),process.exit(1)});
