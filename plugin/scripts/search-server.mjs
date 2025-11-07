#!/usr/bin/env node
import{Server as he}from"@modelcontextprotocol/sdk/server/index.js";import{StdioServerTransport as _e}from"@modelcontextprotocol/sdk/server/stdio.js";import{Client as fe}from"@modelcontextprotocol/sdk/client/index.js";import{StdioClientTransport as Ee}from"@modelcontextprotocol/sdk/client/stdio.js";import{CallToolRequestSchema as be,ListToolsRequestSchema as ge}from"@modelcontextprotocol/sdk/types.js";import{z as i}from"zod";import{zodToJsonSchema as Te}from"zod-to-json-schema";import{basename as Se}from"path";import pe from"better-sqlite3";import{join as L,dirname as ce,basename as xe}from"path";import{homedir as ee}from"os";import{existsSync as De,mkdirSync as de}from"fs";import{fileURLToPath as le}from"url";function ue(){return typeof __dirname<"u"?__dirname:ce(le(import.meta.url))}var $e=ue(),w=process.env.CLAUDE_MEM_DATA_DIR||L(ee(),".claude-mem"),V=process.env.CLAUDE_CONFIG_DIR||L(ee(),".claude"),ke=L(w,"archives"),Fe=L(w,"logs"),Me=L(w,"trash"),Ue=L(w,"backups"),je=L(w,"settings.json"),X=L(w,"claude-mem.db"),te=L(w,"vector-db"),Be=L(V,"settings.json"),Xe=L(V,"commands"),Pe=L(V,"CLAUDE.md");function P(c){de(c,{recursive:!0})}var G=class{db;constructor(e){e||(P(w),e=X),this.db=new pe(e),this.db.pragma("journal_mode = WAL"),this.ensureFTSTables()}ensureFTSTables(){try{if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all().some(r=>r.name==="observations_fts"||r.name==="session_summaries_fts"))return;console.error("[SessionSearch] Creating FTS5 tables..."),this.db.exec(`
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
      `),console.error("[SessionSearch] FTS5 tables created successfully")}catch(e){console.error("[SessionSearch] FTS migration error:",e.message)}}escapeFTS5(e){return`"${e.replace(/"/g,'""')}"`}buildFilterClause(e,s,r="o"){let t=[];if(e.project&&(t.push(`${r}.project = ?`),s.push(e.project)),e.type)if(Array.isArray(e.type)){let n=e.type.map(()=>"?").join(",");t.push(`${r}.type IN (${n})`),s.push(...e.type)}else t.push(`${r}.type = ?`),s.push(e.type);if(e.dateRange){let{start:n,end:o}=e.dateRange;if(n){let a=typeof n=="number"?n:new Date(n).getTime();t.push(`${r}.created_at_epoch >= ?`),s.push(a)}if(o){let a=typeof o=="number"?o:new Date(o).getTime();t.push(`${r}.created_at_epoch <= ?`),s.push(a)}}if(e.concepts){let n=Array.isArray(e.concepts)?e.concepts:[e.concepts],o=n.map(()=>`EXISTS (SELECT 1 FROM json_each(${r}.concepts) WHERE value = ?)`);o.length>0&&(t.push(`(${o.join(" OR ")})`),s.push(...n))}if(e.files){let n=Array.isArray(e.files)?e.files:[e.files],o=n.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${r}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${r}.files_modified) WHERE value LIKE ?)
        )`);o.length>0&&(t.push(`(${o.join(" OR ")})`),n.forEach(a=>{s.push(`%${a}%`,`%${a}%`)}))}return t.length>0?t.join(" AND "):""}buildOrderClause(e="relevance",s=!0,r="observations_fts"){switch(e){case"relevance":return s?`ORDER BY ${r}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservations(e,s={}){let r=[],{limit:t=50,offset:n=0,orderBy:o="relevance",...a}=s,d=this.escapeFTS5(e);r.push(d);let l=this.buildFilterClause(a,r,"o"),p=l?`AND ${l}`:"",u=this.buildOrderClause(o,!0),m=`
      SELECT
        o.*,
        observations_fts.rank as rank
      FROM observations o
      JOIN observations_fts ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${p}
      ${u}
      LIMIT ? OFFSET ?
    `;r.push(t,n);let f=this.db.prepare(m).all(...r);if(f.length>0){let h=Math.min(...f.map(E=>E.rank||0)),_=Math.max(...f.map(E=>E.rank||0))-h||1;f.forEach(E=>{E.rank!==void 0&&(E.score=1-(E.rank-h)/_)})}return f}searchSessions(e,s={}){let r=[],{limit:t=50,offset:n=0,orderBy:o="relevance",...a}=s,d=this.escapeFTS5(e);r.push(d);let l={...a};delete l.type;let p=this.buildFilterClause(l,r,"s"),h=`
      SELECT
        s.*,
        session_summaries_fts.rank as rank
      FROM session_summaries s
      JOIN session_summaries_fts ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${(p?`AND ${p}`:"").replace(/files_read/g,"files_read").replace(/files_modified/g,"files_edited")}
      ${o==="relevance"?"ORDER BY session_summaries_fts.rank ASC":o==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;r.push(t,n);let b=this.db.prepare(h).all(...r);if(b.length>0){let _=Math.min(...b.map(T=>T.rank||0)),x=Math.max(...b.map(T=>T.rank||0))-_||1;b.forEach(T=>{T.rank!==void 0&&(T.score=1-(T.rank-_)/x)})}return b}findByConcept(e,s={}){let r=[],{limit:t=50,offset:n=0,orderBy:o="date_desc",...a}=s,d={...a,concepts:e},l=this.buildFilterClause(d,r,"o"),p=this.buildOrderClause(o,!1),u=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${p}
      LIMIT ? OFFSET ?
    `;return r.push(t,n),this.db.prepare(u).all(...r)}findByFile(e,s={}){let r=[],{limit:t=50,offset:n=0,orderBy:o="date_desc",...a}=s,d={...a,files:e},l=this.buildFilterClause(d,r,"o"),p=this.buildOrderClause(o,!1),u=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${p}
      LIMIT ? OFFSET ?
    `;r.push(t,n);let m=this.db.prepare(u).all(...r),f=[],h={...a};delete h.type;let b=[];if(h.project&&(b.push("s.project = ?"),f.push(h.project)),h.dateRange){let{start:x,end:T}=h.dateRange;if(x){let g=typeof x=="number"?x:new Date(x).getTime();b.push("s.created_at_epoch >= ?"),f.push(g)}if(T){let g=typeof T=="number"?T:new Date(T).getTime();b.push("s.created_at_epoch <= ?"),f.push(g)}}b.push(`(
      EXISTS (SELECT 1 FROM json_each(s.files_read) WHERE value LIKE ?)
      OR EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)
    )`),f.push(`%${e}%`,`%${e}%`);let _=`
      SELECT s.*
      FROM session_summaries s
      WHERE ${b.join(" AND ")}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;f.push(t,n);let E=this.db.prepare(_).all(...f);return{observations:m,sessions:E}}findByType(e,s={}){let r=[],{limit:t=50,offset:n=0,orderBy:o="date_desc",...a}=s,d={...a,type:e},l=this.buildFilterClause(d,r,"o"),p=this.buildOrderClause(o,!1),u=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${p}
      LIMIT ? OFFSET ?
    `;return r.push(t,n),this.db.prepare(u).all(...r)}searchUserPrompts(e,s={}){let r=[],{limit:t=20,offset:n=0,orderBy:o="relevance",...a}=s,d=this.escapeFTS5(e);r.push(d);let l=[];if(a.project&&(l.push("s.project = ?"),r.push(a.project)),a.dateRange){let{start:h,end:b}=a.dateRange;if(h){let _=typeof h=="number"?h:new Date(h).getTime();l.push("up.created_at_epoch >= ?"),r.push(_)}if(b){let _=typeof b=="number"?b:new Date(b).getTime();l.push("up.created_at_epoch <= ?"),r.push(_)}}let m=`
      SELECT
        up.*,
        user_prompts_fts.rank as rank
      FROM user_prompts up
      JOIN user_prompts_fts ON up.id = user_prompts_fts.rowid
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE user_prompts_fts MATCH ?
      ${l.length>0?`AND ${l.join(" AND ")}`:""}
      ${o==="relevance"?"ORDER BY user_prompts_fts.rank ASC":o==="date_asc"?"ORDER BY up.created_at_epoch ASC":"ORDER BY up.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;r.push(t,n);let f=this.db.prepare(m).all(...r);if(f.length>0){let h=Math.min(...f.map(E=>E.rank||0)),_=Math.max(...f.map(E=>E.rank||0))-h||1;f.forEach(E=>{E.rank!==void 0&&(E.score=1-(E.rank-h)/_)})}return f}getUserPromptsBySession(e){return this.db.prepare(`
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
    `).all(e)}close(){this.db.close()}};import me from"better-sqlite3";var K=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(K||{}),J=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=K[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;try{let r=typeof s=="string"?JSON.parse(s):s;if(e==="Bash"&&r.command){let t=r.command.length>50?r.command.substring(0,50)+"...":r.command;return`${e}(${t})`}if(e==="Read"&&r.file_path){let t=r.file_path.split("/").pop()||r.file_path;return`${e}(${t})`}if(e==="Edit"&&r.file_path){let t=r.file_path.split("/").pop()||r.file_path;return`${e}(${t})`}if(e==="Write"&&r.file_path){let t=r.file_path.split("/").pop()||r.file_path;return`${e}(${t})`}return e}catch{return e}}log(e,s,r,t,n){if(e<this.level)return;let o=new Date().toISOString().replace("T"," ").substring(0,23),a=K[e].padEnd(5),d=s.padEnd(6),l="";t?.correlationId?l=`[${t.correlationId}] `:t?.sessionId&&(l=`[session-${t.sessionId}] `);let p="";n!=null&&(this.level===0&&typeof n=="object"?p=`
`+JSON.stringify(n,null,2):p=" "+this.formatData(n));let u="";if(t){let{sessionId:f,sdkSessionId:h,correlationId:b,..._}=t;Object.keys(_).length>0&&(u=` {${Object.entries(_).map(([x,T])=>`${x}=${T}`).join(", ")}}`)}let m=`[${o}] [${a}] [${d}] ${l}${r}${u}${p}`;e===3?console.error(m):console.log(m)}debug(e,s,r,t){this.log(0,e,s,r,t)}info(e,s,r,t){this.log(1,e,s,r,t)}warn(e,s,r,t){this.log(2,e,s,r,t)}error(e,s,r,t){this.log(3,e,s,r,t)}dataIn(e,s,r,t){this.info(e,`\u2192 ${s}`,r,t)}dataOut(e,s,r,t){this.info(e,`\u2190 ${s}`,r,t)}success(e,s,r,t){this.info(e,`\u2713 ${s}`,r,t)}failure(e,s,r,t){this.error(e,`\u2717 ${s}`,r,t)}timing(e,s,r,t){this.info(e,`\u23F1 ${s}`,t,{duration:`${r}ms`})}},se=new J;var H=class{db;constructor(){P(w),this.db=new me(X),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
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
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let r=this.db.pragma("table_info(observations)").find(t=>t.name==="text");if(!r||r.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),console.error("[SessionStore] Successfully created user_prompts table with FTS5 support")}catch(r){throw this.db.exec("ROLLBACK"),r}}catch(e){console.error("[SessionStore] Migration error (create user_prompts table):",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
      ORDER BY project ASC
    `).all().map(r=>r.project)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:t}=s,n=r==="date_asc"?"ASC":"DESC",o=t?`LIMIT ${t}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${n}
      ${o}
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
    `).all(e),t=new Set,n=new Set;for(let o of r){if(o.files_read)try{let a=JSON.parse(o.files_read);Array.isArray(a)&&a.forEach(d=>t.add(d))}catch{}if(o.files_modified)try{let a=JSON.parse(o.files_modified);Array.isArray(a)&&a.forEach(d=>n.add(d))}catch{}}return{filesRead:Array.from(t),filesModified:Array.from(n)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,r){let t=new Date,n=t.getTime(),a=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,s,r,t.toISOString(),n);return a.lastInsertRowid===0||a.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:a.lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(se.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:s}),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}saveUserPrompt(e,s,r){let t=new Date,n=t.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (claude_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,r,t.toISOString(),n).lastInsertRowid}storeObservation(e,s,r,t){let n=new Date,o=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),o),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let p=this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.type,r.title,r.subtitle,JSON.stringify(r.facts),r.narrative,JSON.stringify(r.concepts),JSON.stringify(r.files_read),JSON.stringify(r.files_modified),t||null,n.toISOString(),o);return{id:Number(p.lastInsertRowid),createdAtEpoch:o}}storeSummary(e,s,r,t){let n=new Date,o=n.getTime();this.db.prepare(`
      SELECT id FROM sdk_sessions WHERE sdk_session_id = ?
    `).get(e)||(this.db.prepare(`
        INSERT INTO sdk_sessions
        (claude_session_id, sdk_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run(e,e,s,n.toISOString(),o),console.error(`[SessionStore] Auto-created session record for session_id: ${e}`));let p=this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,t||null,n.toISOString(),o);return{id:Number(p.lastInsertRowid),createdAtEpoch:o}}markSessionCompleted(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}markSessionFailed(e){let s=new Date,r=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),r,e)}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:t}=s,n=r==="date_asc"?"ASC":"DESC",o=t?`LIMIT ${t}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${a})
      ORDER BY created_at_epoch ${n}
      ${o}
    `).all(...e)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:r="date_desc",limit:t}=s,n=r==="date_asc"?"ASC":"DESC",o=t?`LIMIT ${t}`:"",a=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${a})
      ORDER BY up.created_at_epoch ${n}
      ${o}
    `).all(...e)}getTimelineAroundTimestamp(e,s=10,r=10,t){return this.getTimelineAroundObservation(null,e,s,r,t)}getTimelineAroundObservation(e,s,r=10,t=10,n){let o=n?"AND project = ?":"",a=n?[n]:[],d,l;if(e!==null){let f=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${o}
        ORDER BY id DESC
        LIMIT ?
      `,h=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${o}
        ORDER BY id ASC
        LIMIT ?
      `;try{let b=this.db.prepare(f).all(e,...a,r+1),_=this.db.prepare(h).all(e,...a,t+1);if(b.length===0&&_.length===0)return{observations:[],sessions:[],prompts:[]};d=b.length>0?b[b.length-1].created_at_epoch:s,l=_.length>0?_[_.length-1].created_at_epoch:s}catch(b){return console.error("[SessionStore] Error getting boundary observations:",b.message),{observations:[],sessions:[],prompts:[]}}}else{let f=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${o}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${o}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let b=this.db.prepare(f).all(s,...a,r),_=this.db.prepare(h).all(s,...a,t+1);if(b.length===0&&_.length===0)return{observations:[],sessions:[],prompts:[]};d=b.length>0?b[b.length-1].created_at_epoch:s,l=_.length>0?_[_.length-1].created_at_epoch:s}catch(b){return console.error("[SessionStore] Error getting boundary timestamps:",b.message),{observations:[],sessions:[],prompts:[]}}}let p=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${o}
      ORDER BY created_at_epoch ASC
    `,u=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${o}
      ORDER BY created_at_epoch ASC
    `,m=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${o.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let f=this.db.prepare(p).all(d,l,...a),h=this.db.prepare(u).all(d,l,...a),b=this.db.prepare(m).all(d,l,...a);return{observations:f,sessions:h.map(_=>({id:_.id,sdk_session_id:_.sdk_session_id,project:_.project,request:_.request,completed:_.completed,next_steps:_.next_steps,created_at:_.created_at,created_at_epoch:_.created_at_epoch})),prompts:b.map(_=>({id:_.id,claude_session_id:_.claude_session_id,project:_.project,prompt:_.prompt_text,created_at:_.created_at,created_at_epoch:_.created_at_epoch}))}}catch(f){return console.error("[SessionStore] Error querying timeline records:",f.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var $,N,k=null,ye="cm__claude-mem";try{$=new G,N=new H}catch(c){console.error("[search-server] Failed to initialize search:",c.message),process.exit(1)}async function U(c,e,s){if(!k)throw new Error("Chroma client not initialized");let t=(await k.callTool({name:"chroma_query_documents",arguments:{collection_name:ye,query_texts:[c],n_results:e,include:["documents","metadatas","distances"],where:s}})).content[0]?.text||"",n;try{n=JSON.parse(t)}catch(p){return console.error("[search-server] Failed to parse Chroma response as JSON:",p),{ids:[],distances:[],metadatas:[]}}let o=[],a=n.ids?.[0]||[];for(let p of a){let u=p.match(/obs_(\d+)_/),m=p.match(/summary_(\d+)_/),f=p.match(/prompt_(\d+)/),h=null;u?h=parseInt(u[1],10):m?h=parseInt(m[1],10):f&&(h=parseInt(f[1],10)),h!==null&&!o.includes(h)&&o.push(h)}let d=n.distances?.[0]||[],l=n.metadatas?.[0]||[];return{ids:o,distances:d,metadatas:l}}function j(){return`
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
\u2022 To sort by date: Use orderBy: "date_desc" or "date_asc"`}function q(c,e){let s=c.title||`Observation #${c.id}`,r=new Date(c.created_at_epoch).toLocaleString(),t=c.type?`[${c.type}]`:"";return`${e+1}. ${t} ${s}
   Date: ${r}
   Source: claude-mem://observation/${c.id}`}function re(c,e){let s=c.request||`Session ${c.sdk_session_id.substring(0,8)}`,r=new Date(c.created_at_epoch).toLocaleString();return`${e+1}. ${s}
   Date: ${r}
   Source: claude-mem://session/${c.sdk_session_id}`}function W(c){let e=c.title||`Observation #${c.id}`,s=[];s.push(`## ${e}`),s.push(`*Source: claude-mem://observation/${c.id}*`),s.push(""),c.subtitle&&(s.push(`**${c.subtitle}**`),s.push("")),c.narrative&&(s.push(c.narrative),s.push("")),c.text&&(s.push(c.text),s.push(""));let r=[];if(r.push(`Type: ${c.type}`),c.facts)try{let n=JSON.parse(c.facts);n.length>0&&r.push(`Facts: ${n.join("; ")}`)}catch{}if(c.concepts)try{let n=JSON.parse(c.concepts);n.length>0&&r.push(`Concepts: ${n.join(", ")}`)}catch{}if(c.files_read||c.files_modified){let n=[];if(c.files_read)try{n.push(...JSON.parse(c.files_read))}catch{}if(c.files_modified)try{n.push(...JSON.parse(c.files_modified))}catch{}n.length>0&&r.push(`Files: ${[...new Set(n)].join(", ")}`)}r.length>0&&(s.push("---"),s.push(r.join(" | ")));let t=new Date(c.created_at_epoch).toLocaleString();return s.push(""),s.push("---"),s.push(`Date: ${t}`),s.join(`
`)}function ne(c){let e=c.request||`Session ${c.sdk_session_id.substring(0,8)}`,s=[];s.push(`## ${e}`),s.push(`*Source: claude-mem://session/${c.sdk_session_id}*`),s.push(""),c.completed&&(s.push(`**Completed:** ${c.completed}`),s.push("")),c.learned&&(s.push(`**Learned:** ${c.learned}`),s.push("")),c.investigated&&(s.push(`**Investigated:** ${c.investigated}`),s.push("")),c.next_steps&&(s.push(`**Next Steps:** ${c.next_steps}`),s.push("")),c.notes&&(s.push(`**Notes:** ${c.notes}`),s.push(""));let r=[];if(c.files_read||c.files_edited){let n=[];if(c.files_read)try{n.push(...JSON.parse(c.files_read))}catch{}if(c.files_edited)try{n.push(...JSON.parse(c.files_edited))}catch{}n.length>0&&r.push(`Files: ${[...new Set(n)].join(", ")}`)}let t=new Date(c.created_at_epoch).toLocaleDateString();return r.push(`Date: ${t}`),r.length>0&&(s.push("---"),s.push(r.join(" | "))),s.join(`
`)}function Re(c,e){let s=new Date(c.created_at_epoch).toLocaleString();return`${e+1}. "${c.prompt_text}"
   Date: ${s} | Prompt #${c.prompt_number}
   Source: claude-mem://user-prompt/${c.id}`}function ve(c){let e=[];e.push(`## User Prompt #${c.prompt_number}`),e.push(`*Source: claude-mem://user-prompt/${c.id}*`),e.push(""),e.push(c.prompt_text),e.push(""),e.push("---");let s=new Date(c.created_at_epoch).toLocaleString();return e.push(`Date: ${s}`),e.join(`
`)}var Oe=i.object({project:i.string().optional().describe("Filter by project name"),type:i.union([i.enum(["decision","bugfix","feature","refactor","discovery","change"]),i.array(i.enum(["decision","bugfix","feature","refactor","discovery","change"]))]).optional().describe("Filter by observation type"),concepts:i.union([i.string(),i.array(i.string())]).optional().describe("Filter by concept tags"),files:i.union([i.string(),i.array(i.string())]).optional().describe("Filter by file paths (partial match)"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional().describe("Start date (ISO string or epoch)"),end:i.union([i.string(),i.number()]).optional().describe("End date (ISO string or epoch)")}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),oe=[{name:"search_observations",description:'Search observations using full-text search across titles, narratives, facts, and concepts. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),...Oe.shape}),handler:async c=>{try{let{query:e,format:s="index",...r}=c,t=[];if(k)try{console.error("[search-server] Using hybrid semantic search (Chroma + SQLite)");let o=await U(e,100);if(console.error(`[search-server] Chroma returned ${o.ids.length} semantic matches`),o.ids.length>0){let a=Date.now()-7776e6,d=o.ids.filter((l,p)=>{let u=o.metadatas[p];return u&&u.created_at_epoch>a});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=r.limit||20;t=N.getObservationsByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} observations from SQLite`)}}}catch(o){console.error("[search-server] Chroma query failed, falling back to FTS5:",o.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=$.searchObservations(e,r)),t.length===0)return{content:[{type:"text",text:`No observations found matching "${e}"`}]};let n;if(s==="index"){let o=`Found ${t.length} observation(s) matching "${e}":

`,a=t.map((d,l)=>q(d,l));n=o+a.join(`

`)+j()}else n=t.map(a=>W(a)).join(`

---

`);return{content:[{type:"text",text:n}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"search_sessions",description:'Search session summaries using full-text search across requests, completions, learnings, and notes. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{query:e,format:s="index",...r}=c,t=[];if(k)try{console.error("[search-server] Using hybrid semantic search for sessions");let o=await U(e,100,{doc_type:"session_summary"});if(console.error(`[search-server] Chroma returned ${o.ids.length} semantic matches`),o.ids.length>0){let a=Date.now()-7776e6,d=o.ids.filter((l,p)=>{let u=o.metadatas[p];return u&&u.created_at_epoch>a});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=r.limit||20;t=N.getSessionSummariesByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} sessions from SQLite`)}}}catch(o){console.error("[search-server] Chroma query failed, falling back to FTS5:",o.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=$.searchSessions(e,r)),t.length===0)return{content:[{type:"text",text:`No sessions found matching "${e}"`}]};let n;if(s==="index"){let o=`Found ${t.length} session(s) matching "${e}":

`,a=t.map((d,l)=>re(d,l));n=o+a.join(`

`)+j()}else n=t.map(a=>ne(a)).join(`

---

`);return{content:[{type:"text",text:n}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_concept",description:'Find observations tagged with a specific concept. Available concepts: "discovery", "problem-solution", "what-changed", "how-it-works", "pattern", "gotcha", "change". IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({concept:i.string().describe("Concept tag to search for. Available: discovery, problem-solution, what-changed, how-it-works, pattern, gotcha, change"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{concept:e,format:s="index",...r}=c,t=[];if(k)try{console.error("[search-server] Using metadata-first + semantic ranking for concept search");let o=$.findByConcept(e,r);if(console.error(`[search-server] Found ${o.length} observations with concept "${e}"`),o.length>0){let a=o.map(p=>p.id),d=await U(e,Math.min(a.length,100)),l=[];for(let p of d.ids)a.includes(p)&&!l.includes(p)&&l.push(p);console.error(`[search-server] Chroma ranked ${l.length} results by semantic relevance`),l.length>0&&(t=N.getObservationsByIds(l,{limit:r.limit||20}),t.sort((p,u)=>l.indexOf(p.id)-l.indexOf(u.id)))}}catch(o){console.error("[search-server] Chroma ranking failed, using SQLite order:",o.message)}if(t.length===0&&(console.error("[search-server] Using SQLite-only concept search"),t=$.findByConcept(e,r)),t.length===0)return{content:[{type:"text",text:`No observations found with concept "${e}"`}]};let n;if(s==="index"){let o=`Found ${t.length} observation(s) with concept "${e}":

`,a=t.map((d,l)=>q(d,l));n=o+a.join(`

`)+j()}else n=t.map(a=>W(a)).join(`

---

`);return{content:[{type:"text",text:n}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_file",description:'Find observations and sessions that reference a specific file path. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({filePath:i.string().describe("File path to search for (supports partial matching)"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{filePath:e,format:s="index",...r}=c,t=[],n=[];if(k)try{console.error("[search-server] Using metadata-first + semantic ranking for file search");let d=$.findByFile(e,r);if(console.error(`[search-server] Found ${d.observations.length} observations, ${d.sessions.length} sessions for file "${e}"`),n=d.sessions,d.observations.length>0){let l=d.observations.map(m=>m.id),p=await U(e,Math.min(l.length,100)),u=[];for(let m of p.ids)l.includes(m)&&!u.includes(m)&&u.push(m);console.error(`[search-server] Chroma ranked ${u.length} observations by semantic relevance`),u.length>0&&(t=N.getObservationsByIds(u,{limit:r.limit||20}),t.sort((m,f)=>u.indexOf(m.id)-u.indexOf(f.id)))}}catch(d){console.error("[search-server] Chroma ranking failed, using SQLite order:",d.message)}if(t.length===0&&n.length===0){console.error("[search-server] Using SQLite-only file search");let d=$.findByFile(e,r);t=d.observations,n=d.sessions}let o=t.length+n.length;if(o===0)return{content:[{type:"text",text:`No results found for file "${e}"`}]};let a;if(s==="index"){let d=`Found ${o} result(s) for file "${e}":

`,l=[];t.forEach((p,u)=>{l.push(q(p,u))}),n.forEach((p,u)=>{l.push(re(p,u+t.length))}),a=d+l.join(`

`)+j()}else{let d=[];t.forEach(l=>{d.push(W(l))}),n.forEach(l=>{d.push(ne(l))}),a=d.join(`

---

`)}return{content:[{type:"text",text:a}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_type",description:'Find observations of a specific type (decision, bugfix, feature, refactor, discovery, change). IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({type:i.union([i.enum(["decision","bugfix","feature","refactor","discovery","change"]),i.array(i.enum(["decision","bugfix","feature","refactor","discovery","change"]))]).describe("Observation type(s) to filter by"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{type:e,format:s="index",...r}=c,t=Array.isArray(e)?e.join(", "):e,n=[];if(k)try{console.error("[search-server] Using metadata-first + semantic ranking for type search");let a=$.findByType(e,r);if(console.error(`[search-server] Found ${a.length} observations with type "${t}"`),a.length>0){let d=a.map(u=>u.id),l=await U(t,Math.min(d.length,100)),p=[];for(let u of l.ids)d.includes(u)&&!p.includes(u)&&p.push(u);console.error(`[search-server] Chroma ranked ${p.length} results by semantic relevance`),p.length>0&&(n=N.getObservationsByIds(p,{limit:r.limit||20}),n.sort((u,m)=>p.indexOf(u.id)-p.indexOf(m.id)))}}catch(a){console.error("[search-server] Chroma ranking failed, using SQLite order:",a.message)}if(n.length===0&&(console.error("[search-server] Using SQLite-only type search"),n=$.findByType(e,r)),n.length===0)return{content:[{type:"text",text:`No observations found with type "${t}"`}]};let o;if(s==="index"){let a=`Found ${n.length} observation(s) with type "${t}":

`,d=n.map((l,p)=>q(l,p));o=a+d.join(`

`)+j()}else o=n.map(d=>W(d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"get_recent_context",description:"Get recent session context including summaries and observations for a project",inputSchema:i.object({project:i.string().optional().describe("Project name (defaults to current working directory basename)"),limit:i.number().min(1).max(10).default(3).describe("Number of recent sessions to retrieve")}),handler:async c=>{try{let e=c.project||Se(process.cwd()),s=c.limit||3,r=N.getRecentSessionsWithStatus(e,s);if(r.length===0)return{content:[{type:"text",text:`# Recent Session Context

No previous sessions found for project "${e}".`}]};let t=[];t.push("# Recent Session Context"),t.push(""),t.push(`Showing last ${r.length} session(s) for **${e}**:`),t.push("");for(let n of r)if(n.sdk_session_id){if(t.push("---"),t.push(""),n.has_summary){let o=N.getSummaryForSession(n.sdk_session_id);if(o){let a=o.prompt_number?` (Prompt #${o.prompt_number})`:"";if(t.push(`**Summary${a}**`),t.push(""),o.request&&t.push(`**Request:** ${o.request}`),o.completed&&t.push(`**Completed:** ${o.completed}`),o.learned&&t.push(`**Learned:** ${o.learned}`),o.next_steps&&t.push(`**Next Steps:** ${o.next_steps}`),o.files_read)try{let l=JSON.parse(o.files_read);Array.isArray(l)&&l.length>0&&t.push(`**Files Read:** ${l.join(", ")}`)}catch{o.files_read.trim()&&t.push(`**Files Read:** ${o.files_read}`)}if(o.files_edited)try{let l=JSON.parse(o.files_edited);Array.isArray(l)&&l.length>0&&t.push(`**Files Edited:** ${l.join(", ")}`)}catch{o.files_edited.trim()&&t.push(`**Files Edited:** ${o.files_edited}`)}let d=new Date(o.created_at).toLocaleString();t.push(`**Date:** ${d}`)}}else if(n.status==="active"){t.push("**In Progress**"),t.push(""),n.user_prompt&&t.push(`**Request:** ${n.user_prompt}`);let o=N.getObservationsForSession(n.sdk_session_id);if(o.length>0){t.push(""),t.push(`**Observations (${o.length}):**`);for(let d of o)t.push(`- ${d.title}`)}else t.push(""),t.push("*No observations yet*");t.push(""),t.push("**Status:** Active - summary pending");let a=new Date(n.started_at).toLocaleString();t.push(`**Date:** ${a}`)}else{t.push(`**${n.status.charAt(0).toUpperCase()+n.status.slice(1)}**`),t.push(""),n.user_prompt&&t.push(`**Request:** ${n.user_prompt}`),t.push(""),t.push(`**Status:** ${n.status} - no summary available`);let o=new Date(n.started_at).toLocaleString();t.push(`**Date:** ${o}`)}t.push("")}return{content:[{type:"text",text:t.join(`
`)}]}}catch(e){return{content:[{type:"text",text:`Failed to get recent context: ${e.message}`}],isError:!0}}}},{name:"search_user_prompts",description:'Search raw user prompts with full-text search. Use this to find what the user actually said/requested across all sessions. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for truncated prompts/dates (default, RECOMMENDED for initial search), "full" for complete prompt text (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async c=>{try{let{query:e,format:s="index",...r}=c,t=[];if(k)try{console.error("[search-server] Using hybrid semantic search for user prompts");let o=await U(e,100,{doc_type:"user_prompt"});if(console.error(`[search-server] Chroma returned ${o.ids.length} semantic matches`),o.ids.length>0){let a=Date.now()-7776e6,d=o.ids.filter((l,p)=>{let u=o.metadatas[p];return u&&u.created_at_epoch>a});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=r.limit||20;t=N.getUserPromptsByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} user prompts from SQLite`)}}}catch(o){console.error("[search-server] Chroma query failed, falling back to FTS5:",o.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=$.searchUserPrompts(e,r)),t.length===0)return{content:[{type:"text",text:`No user prompts found matching "${e}"`}]};let n;if(s==="index"){let o=`Found ${t.length} user prompt(s) matching "${e}":

`,a=t.map((d,l)=>Re(d,l));n=o+a.join(`

`)+j()}else n=t.map(a=>ve(a)).join(`

---

`);return{content:[{type:"text",text:n}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"get_context_timeline",description:'Get a unified timeline of context (observations, sessions, and prompts) around a specific point in time. All record types are interleaved chronologically. Useful for understanding "what was happening when X occurred". Returns depth_before records before anchor + anchor + depth_after records after (total: depth_before + 1 + depth_after mixed records).',inputSchema:i.object({anchor:i.union([i.number().describe("Observation ID to center timeline around"),i.string().describe("Session ID (format: S123) or ISO timestamp to center timeline around")]).describe('Anchor point: observation ID, session ID (e.g., "S123"), or ISO timestamp'),depth_before:i.number().min(0).max(50).default(10).describe("Number of records to retrieve before anchor, not including anchor (default: 10)"),depth_after:i.number().min(0).max(50).default(10).describe("Number of records to retrieve after anchor, not including anchor (default: 10)"),project:i.string().optional().describe("Filter by project name")}),handler:async c=>{try{let f=function(g){return new Date(g).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})},h=function(g){return new Date(g).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})},b=function(g){return new Date(g).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})},_=function(g){return g?Math.ceil(g.length/4):0};var e=f,s=h,r=b,t=_;let{anchor:n,depth_before:o=10,depth_after:a=10,project:d}=c,l,p=n,u;if(typeof n=="number"){let g=N.getObservationById(n);if(!g)return{content:[{type:"text",text:`Observation #${n} not found`}],isError:!0};l=g.created_at_epoch,u=N.getTimelineAroundObservation(n,l,o,a,d)}else if(typeof n=="string")if(n.startsWith("S")||n.startsWith("#S")){let g=n.replace(/^#?S/,""),I=parseInt(g,10),S=N.getSessionSummariesByIds([I]);if(S.length===0)return{content:[{type:"text",text:`Session #${I} not found`}],isError:!0};l=S[0].created_at_epoch,p=`S${I}`,u=N.getTimelineAroundTimestamp(l,o,a,d)}else{let g=new Date(n);if(isNaN(g.getTime()))return{content:[{type:"text",text:`Invalid timestamp: ${n}`}],isError:!0};l=g.getTime(),u=N.getTimelineAroundTimestamp(l,o,a,d)}else return{content:[{type:"text",text:'Invalid anchor: must be observation ID (number), session ID (e.g., "S123"), or ISO timestamp'}],isError:!0};let m=[...u.observations.map(g=>({type:"observation",data:g,epoch:g.created_at_epoch})),...u.sessions.map(g=>({type:"session",data:g,epoch:g.created_at_epoch})),...u.prompts.map(g=>({type:"prompt",data:g,epoch:g.created_at_epoch}))];if(m.sort((g,I)=>g.epoch-I.epoch),m.length===0)return{content:[{type:"text",text:`No context found around ${new Date(l).toLocaleString()} (${o} records before, ${a} records after)`}]};let E=[];E.push(`# Timeline around anchor: ${p}`),E.push(`**Window:** ${o} records before \u2192 ${a} records after | **Items:** ${m.length} (${u.observations.length} obs, ${u.sessions.length} sessions, ${u.prompts.length} prompts)`),E.push(""),E.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u{1F9E0} decision"),E.push("");let x=new Map;for(let g of m){let I=f(g.epoch);x.has(I)||x.set(I,[]),x.get(I).push(g)}let T=Array.from(x.entries()).sort((g,I)=>{let S=new Date(g[0]).getTime(),O=new Date(I[0]).getTime();return S-O});for(let[g,I]of T){E.push(`### ${g}`),E.push("");let S=null,O="",C=!1;for(let v of I){let F=typeof p=="number"&&v.type==="observation"&&v.data.id===p||typeof p=="string"&&p.startsWith("S")&&v.type==="session"&&`S${v.data.id}`===p;if(v.type==="session"){C&&(E.push(""),C=!1,S=null,O="");let y=v.data,M=y.request||"Session summary",R=`claude-mem://session-summary/${y.id}`,A=F?" \u2190 **ANCHOR**":"";E.push(`**\u{1F3AF} #S${y.id}** ${M} (${b(v.epoch)}) [\u2192](${R})${A}`),E.push("")}else if(v.type==="prompt"){C&&(E.push(""),C=!1,S=null,O="");let y=v.data,M=y.prompt.length>100?y.prompt.substring(0,100)+"...":y.prompt;E.push(`**\u{1F4AC} User Prompt #${y.prompt_number}** (${b(v.epoch)})`),E.push(`> ${M}`),E.push("")}else if(v.type==="observation"){let y=v.data,M="General";M!==S&&(C&&E.push(""),E.push(`**${M}**`),E.push("| ID | Time | T | Title | Tokens |"),E.push("|----|------|---|-------|--------|"),S=M,C=!0,O="");let R="\u2022";switch(y.type){case"bugfix":R="\u{1F534}";break;case"feature":R="\u{1F7E3}";break;case"refactor":R="\u{1F504}";break;case"change":R="\u2705";break;case"discovery":R="\u{1F535}";break;case"decision":R="\u{1F9E0}";break}let A=h(v.epoch),D=y.title||"Untitled",B=_(y.narrative),Y=A!==O?A:"\u2033";O=A;let Z=F?" \u2190 **ANCHOR**":"";E.push(`| #${y.id} | ${Y} | ${R} | ${D}${Z} | ~${B} |`)}}C&&E.push("")}return{content:[{type:"text",text:E.join(`
`)}]}}catch(n){return{content:[{type:"text",text:`Timeline query failed: ${n.message}`}],isError:!0}}}},{name:"get_timeline_by_query",description:'Search for observations using natural language and get timeline context around the best match. Two modes: "auto" (default) automatically uses top result as timeline anchor; "interactive" returns top matches for you to choose from. This combines search + timeline into a single operation for faster context discovery.',inputSchema:i.object({query:i.string().describe("Natural language search query to find relevant observations"),mode:i.enum(["auto","interactive"]).default("auto").describe("auto: Automatically use top search result as timeline anchor. interactive: Show top N search results for manual anchor selection."),depth_before:i.number().min(0).max(50).default(10).describe("Number of timeline records before anchor (default: 10)"),depth_after:i.number().min(0).max(50).default(10).describe("Number of timeline records after anchor (default: 10)"),limit:i.number().min(1).max(20).default(5).describe("For interactive mode: number of top search results to display (default: 5)"),project:i.string().optional().describe("Filter by project name")}),handler:async c=>{try{let{query:n,mode:o="auto",depth_before:a=10,depth_after:d=10,limit:l=5,project:p}=c,u=[];if(k)try{console.error("[search-server] Using hybrid semantic search for timeline query");let m=await U(n,100);if(console.error(`[search-server] Chroma returned ${m.ids.length} semantic matches`),m.ids.length>0){let f=Date.now()-7776e6,h=m.ids.filter((b,_)=>{let E=m.metadatas[_];return E&&E.created_at_epoch>f});console.error(`[search-server] ${h.length} results within 90-day window`),h.length>0&&(u=N.getObservationsByIds(h,{orderBy:"date_desc",limit:o==="auto"?1:l}),console.error(`[search-server] Hydrated ${u.length} observations from SQLite`))}}catch(m){console.error("[search-server] Chroma query failed, falling back to FTS5:",m.message)}if(u.length===0&&(console.error("[search-server] Using FTS5 keyword search"),u=$.searchObservations(n,{orderBy:"relevance",limit:o==="auto"?1:l,project:p})),u.length===0)return{content:[{type:"text",text:`No observations found matching "${n}". Try a different search query.`}]};if(o==="interactive"){let m=[];m.push("# Timeline Anchor Search Results"),m.push(""),m.push(`Found ${u.length} observation(s) matching "${n}"`),m.push(""),m.push("To get timeline context around any of these observations, use the `get_context_timeline` tool with the observation ID as the anchor."),m.push(""),m.push(`**Top ${u.length} matches:**`),m.push("");for(let f=0;f<u.length;f++){let h=u[f],b=h.title||`Observation #${h.id}`,_=new Date(h.created_at_epoch).toLocaleString(),E=h.type?`[${h.type}]`:"";m.push(`${f+1}. **${E} ${b}**`),m.push(`   - ID: ${h.id}`),m.push(`   - Date: ${_}`),h.subtitle&&m.push(`   - ${h.subtitle}`),m.push(`   - Source: claude-mem://observation/${h.id}`),m.push("")}return{content:[{type:"text",text:m.join(`
`)}]}}else{let b=function(S){return new Date(S).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})},_=function(S){return new Date(S).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})},E=function(S){return new Date(S).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})},x=function(S){return S?Math.ceil(S.length/4):0};var e=b,s=_,r=E,t=x;let m=u[0];console.error(`[search-server] Auto mode: Using observation #${m.id} as timeline anchor`);let f=N.getTimelineAroundObservation(m.id,m.created_at_epoch,a,d,p),h=[...f.observations.map(S=>({type:"observation",data:S,epoch:S.created_at_epoch})),...f.sessions.map(S=>({type:"session",data:S,epoch:S.created_at_epoch})),...f.prompts.map(S=>({type:"prompt",data:S,epoch:S.created_at_epoch}))];if(h.sort((S,O)=>S.epoch-O.epoch),h.length===0)return{content:[{type:"text",text:`Found observation #${m.id} matching "${n}", but no timeline context available (${a} records before, ${d} records after).`}]};let T=[];T.push(`# Timeline for query: "${n}"`),T.push(`**Anchor:** Observation #${m.id} - ${m.title||"Untitled"}`),T.push(`**Window:** ${a} records before \u2192 ${d} records after | **Items:** ${h.length} (${f.observations.length} obs, ${f.sessions.length} sessions, ${f.prompts.length} prompts)`),T.push(""),T.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u{1F9E0} decision"),T.push("");let g=new Map;for(let S of h){let O=b(S.epoch);g.has(O)||g.set(O,[]),g.get(O).push(S)}let I=Array.from(g.entries()).sort((S,O)=>{let C=new Date(S[0]).getTime(),v=new Date(O[0]).getTime();return C-v});for(let[S,O]of I){T.push(`### ${S}`),T.push("");let C=null,v="",F=!1;for(let y of O){let M=y.type==="observation"&&y.data.id===m.id;if(y.type==="session"){F&&(T.push(""),F=!1,C=null,v="");let R=y.data,A=R.request||"Session summary",D=`claude-mem://session-summary/${R.id}`;T.push(`**\u{1F3AF} #S${R.id}** ${A} (${E(y.epoch)}) [\u2192](${D})`),T.push("")}else if(y.type==="prompt"){F&&(T.push(""),F=!1,C=null,v="");let R=y.data,A=R.prompt.length>100?R.prompt.substring(0,100)+"...":R.prompt;T.push(`**\u{1F4AC} User Prompt #${R.prompt_number}** (${E(y.epoch)})`),T.push(`> ${A}`),T.push("")}else if(y.type==="observation"){let R=y.data,A="General";A!==C&&(F&&T.push(""),T.push(`**${A}**`),T.push("| ID | Time | T | Title | Tokens |"),T.push("|----|------|---|-------|--------|"),C=A,F=!0,v="");let D="\u2022";switch(R.type){case"bugfix":D="\u{1F534}";break;case"feature":D="\u{1F7E3}";break;case"refactor":D="\u{1F504}";break;case"change":D="\u2705";break;case"discovery":D="\u{1F535}";break;case"decision":D="\u{1F9E0}";break}let B=_(y.epoch),z=R.title||"Untitled",Y=x(R.narrative),ie=B!==v?B:"\u2033";v=B;let ae=M?" \u2190 **ANCHOR**":"";T.push(`| #${R.id} | ${ie} | ${D} | ${z}${ae} | ~${Y} |`)}}F&&T.push("")}return{content:[{type:"text",text:T.join(`
`)}]}}}catch(n){return{content:[{type:"text",text:`Timeline query failed: ${n.message}`}],isError:!0}}}}],Q=new he({name:"claude-mem-search",version:"1.0.0"},{capabilities:{tools:{}}});Q.setRequestHandler(ge,async()=>({tools:oe.map(c=>({name:c.name,description:c.description,inputSchema:Te(c.inputSchema)}))}));Q.setRequestHandler(be,async c=>{let e=oe.find(s=>s.name===c.params.name);if(!e)throw new Error(`Unknown tool: ${c.params.name}`);try{return await e.handler(c.params.arguments||{})}catch(s){return{content:[{type:"text",text:`Tool execution failed: ${s.message}`}],isError:!0}}});async function Ie(){let c=new _e;await Q.connect(c),console.error("[search-server] Claude-mem search server started"),setTimeout(async()=>{try{console.error("[search-server] Initializing Chroma client...");let e=new Ee({command:"uvx",args:["chroma-mcp","--client-type","persistent","--data-dir",te],stderr:"ignore"}),s=new fe({name:"claude-mem-search-chroma-client",version:"1.0.0"},{capabilities:{}});await s.connect(e),k=s,console.error("[search-server] Chroma client connected successfully")}catch(e){console.error("[search-server] Failed to initialize Chroma client:",e.message),console.error("[search-server] Falling back to FTS5-only search"),k=null}},0)}Ie().catch(c=>{console.error("[search-server] Fatal error:",c),process.exit(1)});
