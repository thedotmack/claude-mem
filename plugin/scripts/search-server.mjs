#!/usr/bin/env node
import{Server as ue}from"@modelcontextprotocol/sdk/server/index.js";import{StdioServerTransport as pe}from"@modelcontextprotocol/sdk/server/stdio.js";import{Client as me}from"@modelcontextprotocol/sdk/client/index.js";import{StdioClientTransport as he}from"@modelcontextprotocol/sdk/client/stdio.js";import{CallToolRequestSchema as _e,ListToolsRequestSchema as fe}from"@modelcontextprotocol/sdk/types.js";import{z as i}from"zod";import{zodToJsonSchema as Ee}from"zod-to-json-schema";import{basename as be}from"path";import de from"better-sqlite3";import{join as I,dirname as oe,basename as Ie}from"path";import{homedir as K}from"os";import{existsSync as Ae,mkdirSync as ie}from"fs";import{fileURLToPath as ae}from"url";function ce(){return typeof __dirname<"u"?__dirname:oe(ae(import.meta.url))}var De=ce(),N=process.env.CLAUDE_MEM_DATA_DIR||I(K(),".claude-mem"),H=process.env.CLAUDE_CONFIG_DIR||I(K(),".claude"),we=I(N,"archives"),ke=I(N,"logs"),$e=I(N,"trash"),Fe=I(N,"backups"),Me=I(N,"settings.json"),U=I(N,"claude-mem.db"),J=I(N,"vector-db"),Ue=I(H,"settings.json"),je=I(H,"commands"),Be=I(H,"CLAUDE.md");function j(a){ie(a,{recursive:!0})}var B=class{db;constructor(e){e||(j(N),e=U),this.db=new de(e),this.db.pragma("journal_mode = WAL"),this.ensureFTSTables()}ensureFTSTables(){try{if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'").all().some(s=>s.name==="observations_fts"||s.name==="session_summaries_fts"))return;console.error("[SessionSearch] Creating FTS5 tables..."),this.db.exec(`
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
      `),console.error("[SessionSearch] FTS5 tables created successfully")}catch(e){console.error("[SessionSearch] FTS migration error:",e.message)}}escapeFTS5(e){return`"${e.replace(/"/g,'""')}"`}buildFilterClause(e,r,s="o"){let t=[];if(e.project&&(t.push(`${s}.project = ?`),r.push(e.project)),e.type)if(Array.isArray(e.type)){let o=e.type.map(()=>"?").join(",");t.push(`${s}.type IN (${o})`),r.push(...e.type)}else t.push(`${s}.type = ?`),r.push(e.type);if(e.dateRange){let{start:o,end:n}=e.dateRange;if(o){let c=typeof o=="number"?o:new Date(o).getTime();t.push(`${s}.created_at_epoch >= ?`),r.push(c)}if(n){let c=typeof n=="number"?n:new Date(n).getTime();t.push(`${s}.created_at_epoch <= ?`),r.push(c)}}if(e.concepts){let o=Array.isArray(e.concepts)?e.concepts:[e.concepts],n=o.map(()=>`EXISTS (SELECT 1 FROM json_each(${s}.concepts) WHERE value = ?)`);n.length>0&&(t.push(`(${n.join(" OR ")})`),r.push(...o))}if(e.files){let o=Array.isArray(e.files)?e.files:[e.files],n=o.map(()=>`(
          EXISTS (SELECT 1 FROM json_each(${s}.files_read) WHERE value LIKE ?)
          OR EXISTS (SELECT 1 FROM json_each(${s}.files_modified) WHERE value LIKE ?)
        )`);n.length>0&&(t.push(`(${n.join(" OR ")})`),o.forEach(c=>{r.push(`%${c}%`,`%${c}%`)}))}return t.length>0?t.join(" AND "):""}buildOrderClause(e="relevance",r=!0,s="observations_fts"){switch(e){case"relevance":return r?`ORDER BY ${s}.rank ASC`:"ORDER BY o.created_at_epoch DESC";case"date_desc":return"ORDER BY o.created_at_epoch DESC";case"date_asc":return"ORDER BY o.created_at_epoch ASC";default:return"ORDER BY o.created_at_epoch DESC"}}searchObservations(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="relevance",...c}=r,d=this.escapeFTS5(e);s.push(d);let l=this.buildFilterClause(c,s,"o"),u=l?`AND ${l}`:"",p=this.buildOrderClause(n,!0),g=`
      SELECT
        o.*,
        observations_fts.rank as rank
      FROM observations o
      JOIN observations_fts ON o.id = observations_fts.rowid
      WHERE observations_fts MATCH ?
      ${u}
      ${p}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let E=this.db.prepare(g).all(...s);if(E.length>0){let b=Math.min(...E.map(h=>h.rank||0)),m=Math.max(...E.map(h=>h.rank||0))-b||1;E.forEach(h=>{h.rank!==void 0&&(h.score=1-(h.rank-b)/m)})}return E}searchSessions(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="relevance",...c}=r,d=this.escapeFTS5(e);s.push(d);let l={...c};delete l.type;let u=this.buildFilterClause(l,s,"s"),b=`
      SELECT
        s.*,
        session_summaries_fts.rank as rank
      FROM session_summaries s
      JOIN session_summaries_fts ON s.id = session_summaries_fts.rowid
      WHERE session_summaries_fts MATCH ?
      ${(u?`AND ${u}`:"").replace(/files_read/g,"files_read").replace(/files_modified/g,"files_edited")}
      ${n==="relevance"?"ORDER BY session_summaries_fts.rank ASC":n==="date_asc"?"ORDER BY s.created_at_epoch ASC":"ORDER BY s.created_at_epoch DESC"}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let _=this.db.prepare(b).all(...s);if(_.length>0){let m=Math.min(..._.map(T=>T.rank||0)),y=Math.max(..._.map(T=>T.rank||0))-m||1;_.forEach(T=>{T.rank!==void 0&&(T.score=1-(T.rank-m)/y)})}return _}findByConcept(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="date_desc",...c}=r,d={...c,concepts:e},l=this.buildFilterClause(d,s,"o"),u=this.buildOrderClause(n,!1),p=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${u}
      LIMIT ? OFFSET ?
    `;return s.push(t,o),this.db.prepare(p).all(...s)}findByFile(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="date_desc",...c}=r,d={...c,files:e},l=this.buildFilterClause(d,s,"o"),u=this.buildOrderClause(n,!1),p=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${u}
      LIMIT ? OFFSET ?
    `;s.push(t,o);let g=this.db.prepare(p).all(...s),E=[],b={...c};delete b.type;let _=[];if(b.project&&(_.push("s.project = ?"),E.push(b.project)),b.dateRange){let{start:y,end:T}=b.dateRange;if(y){let f=typeof y=="number"?y:new Date(y).getTime();_.push("s.created_at_epoch >= ?"),E.push(f)}if(T){let f=typeof T=="number"?T:new Date(T).getTime();_.push("s.created_at_epoch <= ?"),E.push(f)}}_.push(`(
      EXISTS (SELECT 1 FROM json_each(s.files_read) WHERE value LIKE ?)
      OR EXISTS (SELECT 1 FROM json_each(s.files_edited) WHERE value LIKE ?)
    )`),E.push(`%${e}%`,`%${e}%`);let m=`
      SELECT s.*
      FROM session_summaries s
      WHERE ${_.join(" AND ")}
      ORDER BY s.created_at_epoch DESC
      LIMIT ? OFFSET ?
    `;E.push(t,o);let h=this.db.prepare(m).all(...E);return{observations:g,sessions:h}}findByType(e,r={}){let s=[],{limit:t=50,offset:o=0,orderBy:n="date_desc",...c}=r,d={...c,type:e},l=this.buildFilterClause(d,s,"o"),u=this.buildOrderClause(n,!1),p=`
      SELECT o.*
      FROM observations o
      WHERE ${l}
      ${u}
      LIMIT ? OFFSET ?
    `;return s.push(t,o),this.db.prepare(p).all(...s)}searchUserPrompts(e,r={}){let s=[],{limit:t=20,offset:o=0,orderBy:n="relevance",...c}=r,d=this.escapeFTS5(e);s.push(d);let l=[];if(c.project&&(l.push("s.project = ?"),s.push(c.project)),c.dateRange){let{start:b,end:_}=c.dateRange;if(b){let m=typeof b=="number"?b:new Date(b).getTime();l.push("up.created_at_epoch >= ?"),s.push(m)}if(_){let m=typeof _=="number"?_:new Date(_).getTime();l.push("up.created_at_epoch <= ?"),s.push(m)}}let g=`
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
    `;s.push(t,o);let E=this.db.prepare(g).all(...s);if(E.length>0){let b=Math.min(...E.map(h=>h.rank||0)),m=Math.max(...E.map(h=>h.rank||0))-b||1;E.forEach(h=>{h.rank!==void 0&&(h.score=1-(h.rank-b)/m)})}return E}getUserPromptsBySession(e){return this.db.prepare(`
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
    `).all(e)}close(){this.db.close()}};import le from"better-sqlite3";var W=(o=>(o[o.DEBUG=0]="DEBUG",o[o.INFO=1]="INFO",o[o.WARN=2]="WARN",o[o.ERROR=3]="ERROR",o[o.SILENT=4]="SILENT",o))(W||{}),q=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=W[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,r){return`obs-${e}-${r}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let r=Object.keys(e);return r.length===0?"{}":r.length<=3?JSON.stringify(e):`{${r.length} keys: ${r.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,r){if(!r)return e;try{let s=typeof r=="string"?JSON.parse(r):r;if(e==="Bash"&&s.command){let t=s.command.length>50?s.command.substring(0,50)+"...":s.command;return`${e}(${t})`}if(e==="Read"&&s.file_path){let t=s.file_path.split("/").pop()||s.file_path;return`${e}(${t})`}if(e==="Edit"&&s.file_path){let t=s.file_path.split("/").pop()||s.file_path;return`${e}(${t})`}if(e==="Write"&&s.file_path){let t=s.file_path.split("/").pop()||s.file_path;return`${e}(${t})`}return e}catch{return e}}log(e,r,s,t,o){if(e<this.level)return;let n=new Date().toISOString().replace("T"," ").substring(0,23),c=W[e].padEnd(5),d=r.padEnd(6),l="";t?.correlationId?l=`[${t.correlationId}] `:t?.sessionId&&(l=`[session-${t.sessionId}] `);let u="";o!=null&&(this.level===0&&typeof o=="object"?u=`
`+JSON.stringify(o,null,2):u=" "+this.formatData(o));let p="";if(t){let{sessionId:E,sdkSessionId:b,correlationId:_,...m}=t;Object.keys(m).length>0&&(p=` {${Object.entries(m).map(([y,T])=>`${y}=${T}`).join(", ")}}`)}let g=`[${n}] [${c}] [${d}] ${l}${s}${p}${u}`;e===3?console.error(g):console.log(g)}debug(e,r,s,t){this.log(0,e,r,s,t)}info(e,r,s,t){this.log(1,e,r,s,t)}warn(e,r,s,t){this.log(2,e,r,s,t)}error(e,r,s,t){this.log(3,e,r,s,t)}dataIn(e,r,s,t){this.info(e,`\u2192 ${r}`,s,t)}dataOut(e,r,s,t){this.info(e,`\u2190 ${r}`,s,t)}success(e,r,s,t){this.info(e,`\u2713 ${r}`,s,t)}failure(e,r,s,t){this.error(e,`\u2717 ${r}`,s,t)}timing(e,r,s,t){this.info(e,`\u23F1 ${r}`,t,{duration:`${s}ms`})}},Q=new q;var X=class{db;constructor(){j(N),this.db=new le(U),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable()}initializeSchema(){try{this.db.exec(`
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
    `).all(e,r)}getRecentSessionsWithStatus(e,r=3){return this.db.prepare(`
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
    `).get(e)||null}getObservationsByIds(e,r={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:t}=r,o=s==="date_asc"?"ASC":"DESC",n=t?`LIMIT ${t}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id IN (${c})
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
    `).all(e),t=new Set,o=new Set;for(let n of s){if(n.files_read)try{let c=JSON.parse(n.files_read);Array.isArray(c)&&c.forEach(d=>t.add(d))}catch{}if(n.files_modified)try{let c=JSON.parse(n.files_modified);Array.isArray(c)&&c.forEach(d=>o.add(d))}catch{}}return{filesRead:Array.from(t),filesModified:Array.from(o)}}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,r,s){let t=new Date,o=t.getTime(),c=this.db.prepare(`
      INSERT OR IGNORE INTO sdk_sessions
      (claude_session_id, sdk_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(e,e,r,s,t.toISOString(),o);return c.lastInsertRowid===0||c.changes===0?this.db.prepare(`
        SELECT id FROM sdk_sessions WHERE claude_session_id = ? LIMIT 1
      `).get(e).id:c.lastInsertRowid}updateSDKSessionId(e,r){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(r,e).changes===0?(Q.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:r}),!1):!0}setWorkerPort(e,r){this.db.prepare(`
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
    `).run(e.toISOString(),r).changes}getSessionSummariesByIds(e,r={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:t}=r,o=s==="date_asc"?"ASC":"DESC",n=t?`LIMIT ${t}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT * FROM session_summaries
      WHERE id IN (${c})
      ORDER BY created_at_epoch ${o}
      ${n}
    `).all(...e)}getUserPromptsByIds(e,r={}){if(e.length===0)return[];let{orderBy:s="date_desc",limit:t}=r,o=s==="date_asc"?"ASC":"DESC",n=t?`LIMIT ${t}`:"",c=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.id IN (${c})
      ORDER BY up.created_at_epoch ${o}
      ${n}
    `).all(...e)}getTimelineAroundTimestamp(e,r=10,s=10,t){return this.getTimelineAroundObservation(null,e,r,s,t)}getTimelineAroundObservation(e,r,s=10,t=10,o){let n=o?"AND project = ?":"",c=o?[o]:[],d,l;if(e!==null){let E=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${n}
        ORDER BY id DESC
        LIMIT ?
      `,b=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${n}
        ORDER BY id ASC
        LIMIT ?
      `;try{let _=this.db.prepare(E).all(e,...c,s+1),m=this.db.prepare(b).all(e,...c,t+1);if(_.length===0&&m.length===0)return{observations:[],sessions:[],prompts:[]};d=_.length>0?_[_.length-1].created_at_epoch:r,l=m.length>0?m[m.length-1].created_at_epoch:r}catch(_){return console.error("[SessionStore] Error getting boundary observations:",_.message),{observations:[],sessions:[],prompts:[]}}}else{let E=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${n}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,b=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${n}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let _=this.db.prepare(E).all(r,...c,s),m=this.db.prepare(b).all(r,...c,t+1);if(_.length===0&&m.length===0)return{observations:[],sessions:[],prompts:[]};d=_.length>0?_[_.length-1].created_at_epoch:r,l=m.length>0?m[m.length-1].created_at_epoch:r}catch(_){return console.error("[SessionStore] Error getting boundary timestamps:",_.message),{observations:[],sessions:[],prompts:[]}}}let u=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,p=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${n}
      ORDER BY created_at_epoch ASC
    `,g=`
      SELECT up.*, s.project, s.sdk_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${n.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `;try{let E=this.db.prepare(u).all(d,l,...c),b=this.db.prepare(p).all(d,l,...c),_=this.db.prepare(g).all(d,l,...c);return{observations:E,sessions:b.map(m=>({id:m.id,sdk_session_id:m.sdk_session_id,project:m.project,request:m.request,completed:m.completed,next_steps:m.next_steps,created_at:m.created_at,created_at_epoch:m.created_at_epoch})),prompts:_.map(m=>({id:m.id,claude_session_id:m.claude_session_id,project:m.project,prompt:m.prompt_text,created_at:m.created_at,created_at_epoch:m.created_at_epoch}))}}catch(E){return console.error("[SessionStore] Error querying timeline records:",E.message),{observations:[],sessions:[],prompts:[]}}}close(){this.db.close()}};var x,R,C=null,ge="cm__claude-mem";try{x=new B,R=new X}catch(a){console.error("[search-server] Failed to initialize search:",a.message),process.exit(1)}async function $(a,e,r){if(!C)throw new Error("Chroma client not initialized");let t=(await C.callTool({name:"chroma_query_documents",arguments:{collection_name:ge,query_texts:[a],n_results:e,include:["documents","metadatas","distances"],where:r}})).content[0]?.text||"",o;try{o=JSON.parse(t)}catch(u){return console.error("[search-server] Failed to parse Chroma response as JSON:",u),{ids:[],distances:[],metadatas:[]}}let n=[],c=o.ids?.[0]||[];for(let u of c){let p=u.match(/obs_(\d+)_/),g=u.match(/summary_(\d+)_/),E=u.match(/prompt_(\d+)/),b=null;p?b=parseInt(p[1],10):g?b=parseInt(g[1],10):E&&(b=parseInt(E[1],10)),b!==null&&!n.includes(b)&&n.push(b)}let d=o.distances?.[0]||[],l=o.metadatas?.[0]||[];return{ids:n,distances:d,metadatas:l}}function F(){return`
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
\u2022 To sort by date: Use orderBy: "date_desc" or "date_asc"`}function P(a,e){let r=a.title||`Observation #${a.id}`,s=new Date(a.created_at_epoch).toLocaleString(),t=a.type?`[${a.type}]`:"";return`${e+1}. ${t} ${r}
   Date: ${s}
   Source: claude-mem://observation/${a.id}`}function z(a,e){let r=a.request||`Session ${a.sdk_session_id.substring(0,8)}`,s=new Date(a.created_at_epoch).toLocaleString();return`${e+1}. ${r}
   Date: ${s}
   Source: claude-mem://session/${a.sdk_session_id}`}function G(a,e){let r=a.title||`Observation #${a.id}`,s=[];s.push(`## ${r}`),s.push(`*Source: claude-mem://observation/${a.id}*`),s.push(""),a.subtitle&&(s.push(`**${a.subtitle}**`),s.push("")),a.narrative&&(s.push(a.narrative),s.push("")),a.text&&(s.push(a.text),s.push(""));let t=[];if(t.push(`Type: ${a.type}`),a.facts)try{let n=JSON.parse(a.facts);n.length>0&&t.push(`Facts: ${n.join("; ")}`)}catch{}if(a.concepts)try{let n=JSON.parse(a.concepts);n.length>0&&t.push(`Concepts: ${n.join(", ")}`)}catch{}if(a.files_read||a.files_modified){let n=[];if(a.files_read)try{n.push(...JSON.parse(a.files_read))}catch{}if(a.files_modified)try{n.push(...JSON.parse(a.files_modified))}catch{}n.length>0&&t.push(`Files: ${[...new Set(n)].join(", ")}`)}t.length>0&&(s.push("---"),s.push(t.join(" | ")));let o=new Date(a.created_at_epoch).toLocaleString();return s.push(""),s.push("---"),s.push(`Date: ${o}`),s.join(`
`)}function Z(a,e){let r=a.request||`Session ${a.sdk_session_id.substring(0,8)}`,s=[];s.push(`## ${r}`),s.push(`*Source: claude-mem://session/${a.sdk_session_id}*`),s.push(""),a.completed&&(s.push(`**Completed:** ${a.completed}`),s.push("")),a.learned&&(s.push(`**Learned:** ${a.learned}`),s.push("")),a.investigated&&(s.push(`**Investigated:** ${a.investigated}`),s.push("")),a.next_steps&&(s.push(`**Next Steps:** ${a.next_steps}`),s.push("")),a.notes&&(s.push(`**Notes:** ${a.notes}`),s.push(""));let t=[];if(a.files_read||a.files_edited){let n=[];if(a.files_read)try{n.push(...JSON.parse(a.files_read))}catch{}if(a.files_edited)try{n.push(...JSON.parse(a.files_edited))}catch{}n.length>0&&t.push(`Files: ${[...new Set(n)].join(", ")}`)}let o=new Date(a.created_at_epoch).toLocaleDateString();return t.push(`Date: ${o}`),t.length>0&&(s.push("---"),s.push(t.join(" | "))),s.join(`
`)}function Te(a,e){let r=a.prompt.length>100?a.prompt.substring(0,100)+"...":a.prompt,s=new Date(a.created_at_epoch).toLocaleString();return`${e+1}. "${r}"
   Date: ${s} | Prompt #${a.prompt_number}
   Source: claude-mem://user-prompt/${a.id}`}function Se(a,e){let r=[];r.push(`## User Prompt #${a.prompt_number}`),r.push(`*Source: claude-mem://user-prompt/${a.id}*`),r.push(""),r.push(a.prompt),r.push(""),r.push("---");let s=new Date(a.created_at_epoch).toLocaleString();return r.push(`Date: ${s}`),r.join(`
`)}var Re=i.object({project:i.string().optional().describe("Filter by project name"),type:i.union([i.enum(["decision","bugfix","feature","refactor","discovery","change"]),i.array(i.enum(["decision","bugfix","feature","refactor","discovery","change"]))]).optional().describe("Filter by observation type"),concepts:i.union([i.string(),i.array(i.string())]).optional().describe("Filter by concept tags"),files:i.union([i.string(),i.array(i.string())]).optional().describe("Filter by file paths (partial match)"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional().describe("Start date (ISO string or epoch)"),end:i.union([i.string(),i.number()]).optional().describe("End date (ISO string or epoch)")}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),ee=[{name:"search_observations",description:'Search observations using full-text search across titles, narratives, facts, and concepts. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),...Re.shape}),handler:async a=>{try{let{query:e,format:r="index",...s}=a,t=[];if(C)try{console.error("[search-server] Using hybrid semantic search (Chroma + SQLite)");let n=await $(e,100);if(console.error(`[search-server] Chroma returned ${n.ids.length} semantic matches`),n.ids.length>0){let c=Math.floor(Date.now()/1e3)-7776e3,d=n.ids.filter((l,u)=>{let p=n.metadatas[u];return p&&p.created_at_epoch>c});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=s.limit||20;t=R.getObservationsByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} observations from SQLite`)}}}catch(n){console.error("[search-server] Chroma query failed, falling back to FTS5:",n.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=x.searchObservations(e,s)),t.length===0)return{content:[{type:"text",text:`No observations found matching "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} observation(s) matching "${e}":

`,c=t.map((d,l)=>P(d,l));o=n+c.join(`

`)+F()}else o=t.map((c,d)=>G(c,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"search_sessions",description:'Search session summaries using full-text search across requests, completions, learnings, and notes. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async a=>{try{let{query:e,format:r="index",...s}=a,t=[];if(C)try{console.error("[search-server] Using hybrid semantic search for sessions");let n=await $(e,100,{doc_type:"session_summary"});if(console.error(`[search-server] Chroma returned ${n.ids.length} semantic matches`),n.ids.length>0){let c=Math.floor(Date.now()/1e3)-7776e3,d=n.ids.filter((l,u)=>{let p=n.metadatas[u];return p&&p.created_at_epoch>c});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=s.limit||20;t=R.getSessionSummariesByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} sessions from SQLite`)}}}catch(n){console.error("[search-server] Chroma query failed, falling back to FTS5:",n.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=x.searchSessions(e,s)),t.length===0)return{content:[{type:"text",text:`No sessions found matching "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} session(s) matching "${e}":

`,c=t.map((d,l)=>z(d,l));o=n+c.join(`

`)+F()}else o=t.map((c,d)=>Z(c,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_concept",description:'Find observations tagged with a specific concept. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({concept:i.string().describe("Concept tag to search for"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async a=>{try{let{concept:e,format:r="index",...s}=a,t=[];if(C)try{console.error("[search-server] Using metadata-first + semantic ranking for concept search");let n=x.findByConcept(e,s);if(console.error(`[search-server] Found ${n.length} observations with concept "${e}"`),n.length>0){let c=n.map(u=>u.id),d=await $(e,Math.min(c.length,100)),l=[];for(let u of d.ids)c.includes(u)&&!l.includes(u)&&l.push(u);console.error(`[search-server] Chroma ranked ${l.length} results by semantic relevance`),l.length>0&&(t=R.getObservationsByIds(l,{limit:s.limit||20}),t.sort((u,p)=>l.indexOf(u.id)-l.indexOf(p.id)))}}catch(n){console.error("[search-server] Chroma ranking failed, using SQLite order:",n.message)}if(t.length===0&&(console.error("[search-server] Using SQLite-only concept search"),t=x.findByConcept(e,s)),t.length===0)return{content:[{type:"text",text:`No observations found with concept "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} observation(s) with concept "${e}":

`,c=t.map((d,l)=>P(d,l));o=n+c.join(`

`)+F()}else o=t.map((c,d)=>G(c,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_file",description:'Find observations and sessions that reference a specific file path. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({filePath:i.string().describe("File path to search for (supports partial matching)"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async a=>{try{let{filePath:e,format:r="index",...s}=a,t=[],o=[];if(C)try{console.error("[search-server] Using metadata-first + semantic ranking for file search");let d=x.findByFile(e,s);if(console.error(`[search-server] Found ${d.observations.length} observations, ${d.sessions.length} sessions for file "${e}"`),o=d.sessions,d.observations.length>0){let l=d.observations.map(g=>g.id),u=await $(e,Math.min(l.length,100)),p=[];for(let g of u.ids)l.includes(g)&&!p.includes(g)&&p.push(g);console.error(`[search-server] Chroma ranked ${p.length} observations by semantic relevance`),p.length>0&&(t=R.getObservationsByIds(p,{limit:s.limit||20}),t.sort((g,E)=>p.indexOf(g.id)-p.indexOf(E.id)))}}catch(d){console.error("[search-server] Chroma ranking failed, using SQLite order:",d.message)}if(t.length===0&&o.length===0){console.error("[search-server] Using SQLite-only file search");let d=x.findByFile(e,s);t=d.observations,o=d.sessions}let n=t.length+o.length;if(n===0)return{content:[{type:"text",text:`No results found for file "${e}"`}]};let c;if(r==="index"){let d=`Found ${n} result(s) for file "${e}":

`,l=[];t.forEach((u,p)=>{l.push(P(u,p))}),o.forEach((u,p)=>{l.push(z(u,p+t.length))}),c=d+l.join(`

`)+F()}else{let d=[];t.forEach((l,u)=>{d.push(G(l,u))}),o.forEach((l,u)=>{d.push(Z(l,u+t.length))}),c=d.join(`

---

`)}return{content:[{type:"text",text:c}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"find_by_type",description:'Find observations of a specific type (decision, bugfix, feature, refactor, discovery, change). IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({type:i.union([i.enum(["decision","bugfix","feature","refactor","discovery","change"]),i.array(i.enum(["decision","bugfix","feature","refactor","discovery","change"]))]).describe("Observation type(s) to filter by"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for titles/dates only (default, RECOMMENDED for initial search), "full" for complete details (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum results. IMPORTANT: Start with 3-5 to avoid exceeding MCP token limits, even in index mode."),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async a=>{try{let{type:e,format:r="index",...s}=a,t=Array.isArray(e)?e.join(", "):e,o=[];if(C)try{console.error("[search-server] Using metadata-first + semantic ranking for type search");let c=x.findByType(e,s);if(console.error(`[search-server] Found ${c.length} observations with type "${t}"`),c.length>0){let d=c.map(p=>p.id),l=await $(t,Math.min(d.length,100)),u=[];for(let p of l.ids)d.includes(p)&&!u.includes(p)&&u.push(p);console.error(`[search-server] Chroma ranked ${u.length} results by semantic relevance`),u.length>0&&(o=R.getObservationsByIds(u,{limit:s.limit||20}),o.sort((p,g)=>u.indexOf(p.id)-u.indexOf(g.id)))}}catch(c){console.error("[search-server] Chroma ranking failed, using SQLite order:",c.message)}if(o.length===0&&(console.error("[search-server] Using SQLite-only type search"),o=x.findByType(e,s)),o.length===0)return{content:[{type:"text",text:`No observations found with type "${t}"`}]};let n;if(r==="index"){let c=`Found ${o.length} observation(s) with type "${t}":

`,d=o.map((l,u)=>P(l,u));n=c+d.join(`

`)+F()}else n=o.map((d,l)=>G(d,l)).join(`

---

`);return{content:[{type:"text",text:n}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"get_recent_context",description:"Get recent session context including summaries and observations for a project",inputSchema:i.object({project:i.string().optional().describe("Project name (defaults to current working directory basename)"),limit:i.number().min(1).max(10).default(3).describe("Number of recent sessions to retrieve")}),handler:async a=>{try{let e=a.project||be(process.cwd()),r=a.limit||3,s=R.getRecentSessionsWithStatus(e,r);if(s.length===0)return{content:[{type:"text",text:`# Recent Session Context

No previous sessions found for project "${e}".`}]};let t=[];t.push("# Recent Session Context"),t.push(""),t.push(`Showing last ${s.length} session(s) for **${e}**:`),t.push("");for(let o of s)if(o.sdk_session_id){if(t.push("---"),t.push(""),o.has_summary){let n=R.getSummaryForSession(o.sdk_session_id);if(n){let c=n.prompt_number?` (Prompt #${n.prompt_number})`:"";if(t.push(`**Summary${c}**`),t.push(""),n.request&&t.push(`**Request:** ${n.request}`),n.completed&&t.push(`**Completed:** ${n.completed}`),n.learned&&t.push(`**Learned:** ${n.learned}`),n.next_steps&&t.push(`**Next Steps:** ${n.next_steps}`),n.files_read)try{let l=JSON.parse(n.files_read);Array.isArray(l)&&l.length>0&&t.push(`**Files Read:** ${l.join(", ")}`)}catch{n.files_read.trim()&&t.push(`**Files Read:** ${n.files_read}`)}if(n.files_edited)try{let l=JSON.parse(n.files_edited);Array.isArray(l)&&l.length>0&&t.push(`**Files Edited:** ${l.join(", ")}`)}catch{n.files_edited.trim()&&t.push(`**Files Edited:** ${n.files_edited}`)}let d=new Date(n.created_at).toLocaleString();t.push(`**Date:** ${d}`)}}else if(o.status==="active"){t.push("**In Progress**"),t.push(""),o.user_prompt&&t.push(`**Request:** ${o.user_prompt}`);let n=R.getObservationsForSession(o.sdk_session_id);if(n.length>0){t.push(""),t.push(`**Observations (${n.length}):**`);for(let d of n)t.push(`- ${d.title}`)}else t.push(""),t.push("*No observations yet*");t.push(""),t.push("**Status:** Active - summary pending");let c=new Date(o.started_at).toLocaleString();t.push(`**Date:** ${c}`)}else{t.push(`**${o.status.charAt(0).toUpperCase()+o.status.slice(1)}**`),t.push(""),o.user_prompt&&t.push(`**Request:** ${o.user_prompt}`),t.push(""),t.push(`**Status:** ${o.status} - no summary available`);let n=new Date(o.started_at).toLocaleString();t.push(`**Date:** ${n}`)}t.push("")}return{content:[{type:"text",text:t.join(`
`)}]}}catch(e){return{content:[{type:"text",text:`Failed to get recent context: ${e.message}`}],isError:!0}}}},{name:"search_user_prompts",description:'Search raw user prompts with full-text search. Use this to find what the user actually said/requested across all sessions. IMPORTANT: Always use index format first (default) to get an overview with minimal token usage, then use format: "full" only for specific items of interest.',inputSchema:i.object({query:i.string().describe("Search query for FTS5 full-text search"),format:i.enum(["index","full"]).default("index").describe('Output format: "index" for truncated prompts/dates (default, RECOMMENDED for initial search), "full" for complete prompt text (use only after reviewing index results)'),project:i.string().optional().describe("Filter by project name"),dateRange:i.object({start:i.union([i.string(),i.number()]).optional(),end:i.union([i.string(),i.number()]).optional()}).optional().describe("Filter by date range"),limit:i.number().min(1).max(100).default(20).describe("Maximum number of results"),offset:i.number().min(0).default(0).describe("Number of results to skip"),orderBy:i.enum(["relevance","date_desc","date_asc"]).default("date_desc").describe("Sort order")}),handler:async a=>{try{let{query:e,format:r="index",...s}=a,t=[];if(C)try{console.error("[search-server] Using hybrid semantic search for user prompts");let n=await $(e,100,{doc_type:"user_prompt"});if(console.error(`[search-server] Chroma returned ${n.ids.length} semantic matches`),n.ids.length>0){let c=Math.floor(Date.now()/1e3)-7776e3,d=n.ids.filter((l,u)=>{let p=n.metadatas[u];return p&&p.created_at_epoch>c});if(console.error(`[search-server] ${d.length} results within 90-day window`),d.length>0){let l=s.limit||20;t=R.getUserPromptsByIds(d,{orderBy:"date_desc",limit:l}),console.error(`[search-server] Hydrated ${t.length} user prompts from SQLite`)}}}catch(n){console.error("[search-server] Chroma query failed, falling back to FTS5:",n.message)}if(t.length===0&&(console.error("[search-server] Using FTS5 keyword search"),t=x.searchUserPrompts(e,s)),t.length===0)return{content:[{type:"text",text:`No user prompts found matching "${e}"`}]};let o;if(r==="index"){let n=`Found ${t.length} user prompt(s) matching "${e}":

`,c=t.map((d,l)=>Te(d,l));o=n+c.join(`

`)+F()}else o=t.map((c,d)=>Se(c,d)).join(`

---

`);return{content:[{type:"text",text:o}]}}catch(e){return{content:[{type:"text",text:`Search failed: ${e.message}`}],isError:!0}}}},{name:"get_context_timeline",description:'Get a unified timeline of context (observations, sessions, and prompts) around a specific point in time. All record types are interleaved chronologically. Useful for understanding "what was happening when X occurred". Returns depth_before records before anchor + anchor + depth_after records after (total: depth_before + 1 + depth_after mixed records).',inputSchema:i.object({anchor:i.union([i.number().describe("Observation ID to center timeline around"),i.string().describe("Session ID (format: S123) or ISO timestamp to center timeline around")]).describe('Anchor point: observation ID, session ID (e.g., "S123"), or ISO timestamp'),depth_before:i.number().min(0).max(50).default(10).describe("Number of records to retrieve before anchor, not including anchor (default: 10)"),depth_after:i.number().min(0).max(50).default(10).describe("Number of records to retrieve after anchor, not including anchor (default: 10)"),project:i.string().optional().describe("Filter by project name")}),handler:async a=>{try{let E=function(f){return new Date(f).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric"})},b=function(f){return new Date(f).toLocaleString("en-US",{hour:"numeric",minute:"2-digit",hour12:!0})},_=function(f){return new Date(f).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",hour12:!0})},m=function(f){return f?Math.ceil(f.length/4):0};var e=E,r=b,s=_,t=m;let{anchor:o,depth_before:n=10,depth_after:c=10,project:d}=a,l,u=o,p;if(typeof o=="number"){let f=R.getObservationById(o);if(!f)return{content:[{type:"text",text:`Observation #${o} not found`}],isError:!0};l=f.created_at_epoch,p=R.getTimelineAroundObservation(o,l,n,c,d)}else if(typeof o=="string")if(o.startsWith("S")||o.startsWith("#S")){let f=o.replace(/^#?S/,""),S=parseInt(f,10),A=R.getSessionSummariesByIds([S]);if(A.length===0)return{content:[{type:"text",text:`Session #${S} not found`}],isError:!0};l=A[0].created_at_epoch,u=`S${S}`,p=R.getTimelineAroundTimestamp(l,n,c,d)}else{let f=new Date(o);if(isNaN(f.getTime()))return{content:[{type:"text",text:`Invalid timestamp: ${o}`}],isError:!0};l=f.getTime(),p=R.getTimelineAroundTimestamp(l,n,c,d)}else return{content:[{type:"text",text:'Invalid anchor: must be observation ID (number), session ID (e.g., "S123"), or ISO timestamp'}],isError:!0};let g=[...p.observations.map(f=>({type:"observation",data:f,epoch:f.created_at_epoch})),...p.sessions.map(f=>({type:"session",data:f,epoch:f.created_at_epoch})),...p.prompts.map(f=>({type:"prompt",data:f,epoch:f.created_at_epoch}))];if(g.sort((f,S)=>f.epoch-S.epoch),g.length===0)return{content:[{type:"text",text:`No context found around ${new Date(l).toLocaleString()} (${n} records before, ${c} records after)`}]};let h=[];h.push(`# Timeline around anchor: ${u}`),h.push(`**Window:** ${n} records before \u2192 ${c} records after | **Items:** ${g.length} (${p.observations.length} obs, ${p.sessions.length} sessions, ${p.prompts.length} prompts)`),h.push(""),h.push("**Legend:** \u{1F3AF} session-request | \u{1F534} bugfix | \u{1F7E3} feature | \u{1F504} refactor | \u2705 change | \u{1F535} discovery | \u{1F9E0} decision"),h.push("");let y=new Map;for(let f of g){let S=E(f.epoch);y.has(S)||y.set(S,[]),y.get(S).push(f)}let T=Array.from(y.entries()).sort((f,S)=>{let A=new Date(f[0]).getTime(),D=new Date(S[0]).getTime();return A-D});for(let[f,S]of T){h.push(`### ${f}`),h.push("");let A=null,D="",w=!1;for(let O of S){let V=typeof u=="number"&&O.type==="observation"&&O.data.id===u||typeof u=="string"&&u.startsWith("S")&&O.type==="session"&&`S${O.data.id}`===u;if(O.type==="session"){w&&(h.push(""),w=!1,A=null,D="");let v=O.data,k=v.request||"Session summary",L=`claude-mem://session-summary/${v.id}`,M=V?" \u2190 **ANCHOR**":"";h.push(`**\u{1F3AF} #S${v.id}** ${k} (${_(O.epoch)}) [\u2192](${L})${M}`),h.push("")}else if(O.type==="prompt"){w&&(h.push(""),w=!1,A=null,D="");let v=O.data,k=v.prompt.length>100?v.prompt.substring(0,100)+"...":v.prompt;h.push(`**\u{1F4AC} User Prompt #${v.prompt_number}** (${_(O.epoch)})`),h.push(`> ${k}`),h.push("")}else if(O.type==="observation"){let v=O.data,k="General";k!==A&&(w&&h.push(""),h.push(`**${k}**`),h.push("| ID | Time | T | Title | Tokens |"),h.push("|----|------|---|-------|--------|"),A=k,w=!0,D="");let L="\u2022";switch(v.type){case"bugfix":L="\u{1F534}";break;case"feature":L="\u{1F7E3}";break;case"refactor":L="\u{1F504}";break;case"change":L="\u2705";break;case"discovery":L="\u{1F535}";break;case"decision":L="\u{1F9E0}";break}let M=b(O.epoch),te=v.title||"Untitled",se=m(v.narrative),re=M!==D?M:"\u2033";D=M;let ne=V?" \u2190 **ANCHOR**":"";h.push(`| #${v.id} | ${re} | ${L} | ${te}${ne} | ~${se} |`)}}w&&h.push("")}return{content:[{type:"text",text:h.join(`
`)}]}}catch(o){return{content:[{type:"text",text:`Timeline query failed: ${o.message}`}],isError:!0}}}}],Y=new ue({name:"claude-mem-search",version:"1.0.0"},{capabilities:{tools:{}}});Y.setRequestHandler(fe,async()=>({tools:ee.map(a=>({name:a.name,description:a.description,inputSchema:Ee(a.inputSchema)}))}));Y.setRequestHandler(_e,async a=>{let e=ee.find(r=>r.name===a.params.name);if(!e)throw new Error(`Unknown tool: ${a.params.name}`);try{return await e.handler(a.params.arguments||{})}catch(r){return{content:[{type:"text",text:`Tool execution failed: ${r.message}`}],isError:!0}}});async function ye(){let a=new pe;await Y.connect(a),console.error("[search-server] Claude-mem search server started"),setTimeout(async()=>{try{console.error("[search-server] Initializing Chroma client...");let e=new he({command:"uvx",args:["chroma-mcp","--client-type","persistent","--data-dir",J]}),r=new me({name:"claude-mem-search-chroma-client",version:"1.0.0"},{capabilities:{}});await r.connect(e),C=r,console.error("[search-server] Chroma client connected successfully")}catch(e){console.error("[search-server] Failed to initialize Chroma client:",e.message),console.error("[search-server] Falling back to FTS5-only search"),C=null}},0)}ye().catch(a=>{console.error("[search-server] Fatal error:",a),process.exit(1)});
