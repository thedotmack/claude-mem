#!/usr/bin/env node
import H from"path";import F from"better-sqlite3";import{join as u,dirname as x,basename as V}from"path";import{homedir as O}from"os";import{existsSync as Z,mkdirSync as U}from"fs";import{fileURLToPath as w}from"url";function X(){return typeof __dirname<"u"?__dirname:x(w(import.meta.url))}var M=X(),l=process.env.CLAUDE_MEM_DATA_DIR||u(O(),".claude-mem"),T=process.env.CLAUDE_CONFIG_DIR||u(O(),".claude"),se=u(l,"archives"),te=u(l,"logs"),re=u(l,"trash"),ne=u(l,"backups"),ie=u(l,"settings.json"),L=u(l,"claude-mem.db"),oe=u(T,"settings.json"),ae=u(T,"commands"),de=u(T,"CLAUDE.md");function v(p){U(p,{recursive:!0})}function A(){return u(M,"..","..")}var h=(a=>(a[a.DEBUG=0]="DEBUG",a[a.INFO=1]="INFO",a[a.WARN=2]="WARN",a[a.ERROR=3]="ERROR",a[a.SILENT=4]="SILENT",a))(h||{}),g=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=h[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,r){return`obs-${e}-${r}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let r=Object.keys(e);return r.length===0?"{}":r.length<=3?JSON.stringify(e):`{${r.length} keys: ${r.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,r){if(!r)return e;try{let t=typeof r=="string"?JSON.parse(r):r;if(e==="Bash"&&t.command){let n=t.command.length>50?t.command.substring(0,50)+"...":t.command;return`${e}(${n})`}if(e==="Read"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Edit"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}if(e==="Write"&&t.file_path){let n=t.file_path.split("/").pop()||t.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,r,t,n,a){if(e<this.level)return;let s=new Date().toISOString().replace("T"," ").substring(0,23),d=h[e].padEnd(5),o=r.padEnd(6),m="";n?.correlationId?m=`[${n.correlationId}] `:n?.sessionId&&(m=`[session-${n.sessionId}] `);let c="";a!=null&&(this.level===0&&typeof a=="object"?c=`
`+JSON.stringify(a,null,2):c=" "+this.formatData(a));let E="";if(n){let{sessionId:B,sdkSessionId:G,correlationId:Y,...I}=n;Object.keys(I).length>0&&(E=` {${Object.entries(I).map(([$,C])=>`${$}=${C}`).join(", ")}}`)}let R=`[${s}] [${d}] [${o}] ${m}${t}${E}${c}`;e===3?console.error(R):console.log(R)}debug(e,r,t,n){this.log(0,e,r,t,n)}info(e,r,t,n){this.log(1,e,r,t,n)}warn(e,r,t,n){this.log(2,e,r,t,n)}error(e,r,t,n){this.log(3,e,r,t,n)}dataIn(e,r,t,n){this.info(e,`\u2192 ${r}`,t,n)}dataOut(e,r,t,n){this.info(e,`\u2190 ${r}`,t,n)}success(e,r,t,n){this.info(e,`\u2713 ${r}`,t,n)}failure(e,r,t,n){this.error(e,`\u2717 ${r}`,t,n)}timing(e,r,t,n){this.info(e,`\u23F1 ${r}`,n,{duration:`${t}ms`})}},y=new g;var _=class{db;constructor(){v(l),this.db=new F(L),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable()}initializeSchema(){try{this.db.exec(`
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
        `),this.db.prepare("INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString()),console.error("[SessionStore] Migration004 applied successfully"))}catch(e){throw console.error("[SessionStore] Schema initialization error:",e.message),e}}ensureWorkerPortColumn(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(5))return;this.db.pragma("table_info(sdk_sessions)").some(n=>n.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(6))return;this.db.pragma("table_info(sdk_sessions)").some(o=>o.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(o=>o.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(o=>o.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(7))return;if(!this.db.pragma("index_list(session_summaries)").some(n=>n.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(n){throw this.db.exec("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.pragma("table_info(observations)").some(n=>n.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.pragma("table_info(observations)").find(n=>n.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),console.error("[SessionStore] Successfully made observations.text nullable")}catch(n){throw this.db.exec("ROLLBACK"),n}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}getRecentSummaries(e,r=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
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
    `).all(e)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE sdk_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE sdk_session_id = ?
    `).all(e),n=new Set,a=new Set;for(let s of t){if(s.files_read)try{let d=JSON.parse(s.files_read);Array.isArray(d)&&d.forEach(o=>n.add(o))}catch{}if(s.files_modified)try{let d=JSON.parse(s.files_modified);Array.isArray(d)&&d.forEach(o=>a.add(o))}catch{}}return{filesRead:Array.from(n),filesModified:Array.from(a)}}getSessionById(e){return this.db.prepare(`
      SELECT id, sdk_session_id, project, user_prompt
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,r,t){let n=new Date,a=n.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,r,t,n.toISOString(),a).lastInsertRowid}updateSDKSessionId(e,r){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(r,e).changes===0?(y.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:r}),!1):!0}setWorkerPort(e,r){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(r,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,r,t,n){let a=new Date,s=a.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,r,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),n||null,a.toISOString(),s)}storeSummary(e,r,t,n){let a=new Date,s=a.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,r,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,n||null,a.toISOString(),s)}markSessionCompleted(e){let r=new Date,t=r.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(r.toISOString(),t,e)}markSessionFailed(e){let r=new Date,t=r.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(r.toISOString(),t,e)}cleanupOrphanedSessions(){let e=new Date,r=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),r).changes}close(){this.db.close()}};import f from"path";import{existsSync as b}from"fs";import{spawn as P}from"child_process";var j=parseInt(process.env.CLAUDE_MEM_WORKER_PORT||"37777",10),W=`http://127.0.0.1:${j}/health`;async function D(){try{return(await fetch(W,{signal:AbortSignal.timeout(500)})).ok}catch{return!1}}async function k(){try{if(await D())return!0;console.error("[claude-mem] Worker not responding, starting...");let p=A(),e=f.join(p,"plugin","scripts","worker-service.cjs");if(!b(e))return console.error(`[claude-mem] Worker service not found at ${e}`),!1;let r=f.join(p,"ecosystem.config.cjs"),t=f.join(p,"node_modules",".bin","pm2");if(!b(t))throw new Error(`PM2 binary not found at ${t}. This is a bundled dependency - try running: npm install`);if(!b(r))throw new Error(`PM2 ecosystem config not found at ${r}. Plugin installation may be corrupted.`);let n=P(t,["start",r],{detached:!0,stdio:"ignore",cwd:p});n.on("error",a=>{throw new Error(`Failed to spawn PM2: ${a.message}`)}),n.unref(),console.error("[claude-mem] Worker started with PM2");for(let a=0;a<3;a++)if(await new Promise(s=>setTimeout(s,500)),await D())return console.error("[claude-mem] Worker is healthy"),!0;return console.error("[claude-mem] Worker failed to become healthy after startup"),!1}catch(p){return console.error(`[claude-mem] Failed to start worker: ${p.message}`),!1}}var i={reset:"\x1B[0m",bright:"\x1B[1m",dim:"\x1B[2m",cyan:"\x1B[36m",green:"\x1B[32m",yellow:"\x1B[33m",blue:"\x1B[34m",magenta:"\x1B[35m",gray:"\x1B[90m"};function S(p,e=!1){k();let r=p?.cwd??process.cwd(),t=r?H.basename(r):"unknown-project",n=new _;try{let a=n.getRecentSessionsWithStatus(t,3);if(a.length===0)return e?`
${i.bright}${i.cyan}\u{1F4DD} Recent Session Context${i.reset}

${i.dim}No previous sessions found for this project yet.${i.reset}
`:`# Recent Session Context

No previous sessions found for this project yet.`;let s=[];e?(s.push(""),s.push(`${i.bright}${i.cyan}\u{1F4DD} Recent Session Context${i.reset}`),s.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),s.push(`${i.dim}Showing last ${a.length} session(s) for ${i.reset}${i.bright}${t}${i.reset}`),s.push("")):(s.push("# Recent Session Context"),s.push(""),s.push(`Showing last ${a.length} session(s) for **${t}**:`),s.push(""));for(let d of a)if(d.sdk_session_id){if(e?(s.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),s.push("")):(s.push("---"),s.push("")),d.has_summary){let o=n.getSummaryForSession(d.sdk_session_id);if(o){let m=o.prompt_number?` (Prompt #${o.prompt_number})`:"";e?(s.push(`${i.bright}${i.green}\u2713 Summary${m}${i.reset}`),s.push("")):(s.push(`**Summary${m}**`),s.push("")),o.request&&(e?(s.push(`${i.bright}${i.yellow}Request:${i.reset} ${o.request}`),s.push("")):s.push(`**Request:** ${o.request}`)),o.completed&&(e?(s.push(`${i.bright}${i.green}Completed:${i.reset} ${o.completed}`),s.push("")):s.push(`**Completed:** ${o.completed}`)),o.learned&&(e?(s.push(`${i.bright}${i.blue}Learned:${i.reset} ${o.learned}`),s.push("")):s.push(`**Learned:** ${o.learned}`)),o.next_steps&&(e?(s.push(`${i.bright}${i.magenta}Next Steps:${i.reset} ${o.next_steps}`),s.push("")):s.push(`**Next Steps:** ${o.next_steps}`));let c=n.getFilesForSession(d.sdk_session_id);c.filesRead.length>0&&(e?(s.push(`${i.dim}Files Read: ${c.filesRead.join(", ")}${i.reset}`),s.push("")):s.push(`**Files Read:** ${c.filesRead.join(", ")}`)),c.filesModified.length>0&&(e?(s.push(`${i.dim}Files Modified: ${c.filesModified.join(", ")}${i.reset}`),s.push("")):s.push(`**Files Modified:** ${c.filesModified.join(", ")}`));let E=new Date(o.created_at).toLocaleString();e?s.push(`${i.dim}Date: ${E}${i.reset}`):s.push(`**Date:** ${E}`)}}else if(d.status==="active"){e?(s.push(`${i.bright}${i.yellow}\u23F3 In Progress${i.reset}`),s.push("")):(s.push("**In Progress**"),s.push("")),d.user_prompt&&(e?(s.push(`${i.bright}${i.yellow}Request:${i.reset} ${d.user_prompt}`),s.push("")):s.push(`**Request:** ${d.user_prompt}`));let o=n.getObservationsForSession(d.sdk_session_id);if(o.length>0)if(s.push(""),e){s.push(`${i.bright}Observations (${o.length}):${i.reset}`);for(let c of o)s.push(`  ${i.dim}\u2022${i.reset} ${c.title}`);s.push("")}else{s.push(`**Observations (${o.length}):**`);for(let c of o)s.push(`- ${c.title}`)}else s.push(""),e?(s.push(`${i.dim}No observations yet${i.reset}`),s.push("")):s.push("*No observations yet*");s.push("");let m=new Date(d.started_at).toLocaleString();e?(s.push(`${i.dim}Status: Active - summary pending${i.reset}`),s.push(`${i.dim}Date: ${m}${i.reset}`)):(s.push("**Status:** Active - summary pending"),s.push(`**Date:** ${m}`))}else{let o=d.status==="failed"?"stopped":d.status,m=d.status==="failed"?"\u26A0\uFE0F":"\u25CB";if(e){let E=d.status==="failed"?i.yellow:i.gray;s.push(`${i.bright}${E}${m} ${o.charAt(0).toUpperCase()+o.slice(1)}${i.reset}`),s.push("")}else s.push(`**${o.charAt(0).toUpperCase()+o.slice(1)}**`),s.push("");d.user_prompt&&(e?(s.push(`${i.bright}${i.yellow}Request:${i.reset} ${d.user_prompt}`),s.push("")):s.push(`**Request:** ${d.user_prompt}`)),s.push("");let c=new Date(d.started_at).toLocaleString();e?(s.push(`${i.dim}Status: ${o} - no summary available${i.reset}`),s.push(`${i.dim}Date: ${c}${i.reset}`)):(s.push(`**Status:** ${o} - no summary available`),s.push(`**Date:** ${c}`))}s.push("")}return e&&(s.push(`${i.gray}${"\u2500".repeat(60)}${i.reset}`),s.push("")),s.join(`
`)}finally{n.close()}}import{stdin as N}from"process";try{if(N.isTTY){let p=S(void 0,!0);console.log(p),process.exit(0)}else{let p="";N.on("data",e=>p+=e),N.on("end",()=>{let e=p.trim()?JSON.parse(p):void 0,t={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:S(e,!1)}};console.log(JSON.stringify(t)),process.exit(0)})}}catch(p){console.error(`[claude-mem context-hook error: ${p.message}]`),process.exit(0)}
