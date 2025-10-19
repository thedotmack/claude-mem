#!/usr/bin/env node
import v from"better-sqlite3";import{join as a,dirname as $,basename as X}from"path";import{homedir as O}from"os";import{existsSync as G,mkdirSync as N}from"fs";var c=process.env.CLAUDE_MEM_DATA_DIR||a(O(),".claude-mem"),E=process.env.CLAUDE_CONFIG_DIR||a(O(),".claude"),q=a(c,"archives"),K=a(c,"logs"),J=a(c,"trash"),Y=a(c,"backups"),V=a(c,"settings.json"),k=a(c,"claude-mem.db"),Q=a(E,"settings.json"),z=a(E,"commands"),Z=a(E,"CLAUDE.md");function L(o){N(o,{recursive:!0})}var g=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(g||{}),b=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=g[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;try{let s=typeof t=="string"?JSON.parse(t):t;if(e==="Bash"&&s.command){let r=s.command.length>50?s.command.substring(0,50)+"...":s.command;return`${e}(${r})`}if(e==="Read"&&s.file_path){let r=s.file_path.split("/").pop()||s.file_path;return`${e}(${r})`}if(e==="Edit"&&s.file_path){let r=s.file_path.split("/").pop()||s.file_path;return`${e}(${r})`}if(e==="Write"&&s.file_path){let r=s.file_path.split("/").pop()||s.file_path;return`${e}(${r})`}return e}catch{return e}}log(e,t,s,r,n){if(e<this.level)return;let u=new Date().toISOString().replace("T"," ").substring(0,23),d=g[e].padEnd(5),f=t.padEnd(6),i="";r?.correlationId?i=`[${r.correlationId}] `:r?.sessionId&&(i=`[session-${r.sessionId}] `);let _="";n!=null&&(this.level===0&&typeof n=="object"?_=`
`+JSON.stringify(n,null,2):_=" "+this.formatData(n));let S="";if(r){let{sessionId:x,sdkSessionId:U,correlationId:w,...R}=r;Object.keys(R).length>0&&(S=` {${Object.entries(R).map(([y,C])=>`${y}=${C}`).join(", ")}}`)}let h=`[${u}] [${d}] [${f}] ${i}${s}${S}${_}`;e===3?console.error(h):console.log(h)}debug(e,t,s,r){this.log(0,e,t,s,r)}info(e,t,s,r){this.log(1,e,t,s,r)}warn(e,t,s,r){this.log(2,e,t,s,r)}error(e,t,s,r){this.log(3,e,t,s,r)}dataIn(e,t,s,r){this.info(e,`\u2192 ${t}`,s,r)}dataOut(e,t,s,r){this.info(e,`\u2190 ${t}`,s,r)}success(e,t,s,r){this.info(e,`\u2713 ${t}`,s,r)}failure(e,t,s,r){this.error(e,`\u2717 ${t}`,s,r)}timing(e,t,s,r){this.info(e,`\u23F1 ${t}`,r,{duration:`${s}ms`})}},p=new b;var m=class{db;constructor(){L(c),this.db=new v(k),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(i=>i.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(i=>i.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(i=>i.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table"));let f=this.db.pragma("index_list(session_summaries)").some(i=>i.unique===1)}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(!this.db.pragma("index_list(session_summaries)").some(s=>s.unique===1))return;console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),console.error("[SessionStore] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(s){throw this.db.exec("ROLLBACK"),s}}catch(e){console.error("[SessionStore] Migration error (remove UNIQUE constraint):",e.message)}}addObservationHierarchicalFields(){try{if(this.db.pragma("table_info(observations)").some(s=>s.name==="title"))return;console.error("[SessionStore] Adding hierarchical fields to observations table..."),this.db.exec(`
        ALTER TABLE observations ADD COLUMN title TEXT;
        ALTER TABLE observations ADD COLUMN subtitle TEXT;
        ALTER TABLE observations ADD COLUMN facts TEXT;
        ALTER TABLE observations ADD COLUMN narrative TEXT;
        ALTER TABLE observations ADD COLUMN concepts TEXT;
        ALTER TABLE observations ADD COLUMN files_read TEXT;
        ALTER TABLE observations ADD COLUMN files_modified TEXT;
      `),console.error("[SessionStore] Successfully added hierarchical fields to observations table")}catch(e){console.error("[SessionStore] Migration error (add hierarchical fields):",e.message)}}makeObservationsTextNullable(){try{let t=this.db.pragma("table_info(observations)").find(s=>s.name==="text");if(!t||t.notnull===0)return;console.error("[SessionStore] Making observations.text nullable..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),console.error("[SessionStore] Successfully made observations.text nullable")}catch(s){throw this.db.exec("ROLLBACK"),s}}catch(e){console.error("[SessionStore] Migration error (make text nullable):",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentObservations(e,t=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentSessionsWithStatus(e,t=3){return this.db.prepare(`
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
    `).all(e,t)}getObservationsForSession(e){return this.db.prepare(`
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
    `).get(e)||null}getSessionById(e){return this.db.prepare(`
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
    `).get(e)||null}reactivateSession(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'active', user_prompt = ?, worker_port = NULL
      WHERE id = ?
    `).run(t,e)}incrementPromptCounter(e){return this.db.prepare(`
      UPDATE sdk_sessions
      SET prompt_counter = COALESCE(prompt_counter, 0) + 1
      WHERE id = ?
    `).run(e),this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||1}getPromptCounter(e){return this.db.prepare(`
      SELECT prompt_counter FROM sdk_sessions WHERE id = ?
    `).get(e)?.prompt_counter||0}createSDKSession(e,t,s){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,r.toISOString(),n).lastInsertRowid}updateSDKSessionId(e,t){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(t,e).changes===0?(p.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:t}),!1):!0}setWorkerPort(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(t,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,t,s,r){let n=new Date,u=n.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),r||null,n.toISOString(),u)}storeSummary(e,t,s,r){let n=new Date,u=n.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,r||null,n.toISOString(),u)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t.toISOString(),s,e)}markSessionFailed(e){let t=new Date,s=t.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(t.toISOString(),s,e)}cleanupOrphanedSessions(){let e=new Date,t=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function D(o,e,t){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:t.reason||"Pre-compact operation failed",suppressOutput:!0}:o==="SessionStart"?e&&t.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:t.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...t.reason&&!e?{stopReason:t.reason}:{}}}function l(o,e,t={}){let s=D(o,e,t);return JSON.stringify(s)}async function A(o){if(!o)throw new Error("summaryHook requires input");let{session_id:e}=o,t=new m,s=t.findActiveSDKSession(e);if(!s){t.close(),console.log(l("Stop",!0));return}if(!s.worker_port){t.close(),p.error("HOOK","No worker port for session",{sessionId:s.id}),console.log(l("Stop",!0));return}let r=t.getPromptCounter(s.id);t.close();try{p.dataIn("HOOK","Stop: Requesting summary",{sessionId:s.id,workerPort:s.worker_port,promptNumber:r});let n=await fetch(`http://127.0.0.1:${s.worker_port}/sessions/${s.id}/summarize`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt_number:r}),signal:AbortSignal.timeout(2e3)});if(n.ok)p.debug("HOOK","Summary request sent successfully",{sessionId:s.id});else{let u=await n.text();p.failure("HOOK","Failed to generate summary",{sessionId:s.id,status:n.status},u)}}catch(n){p.failure("HOOK","Error requesting summary",{sessionId:s.id},n)}finally{console.log(l("Stop",!0))}}import{stdin as I}from"process";var T="";I.on("data",o=>T+=o);I.on("end",async()=>{try{let o=T.trim()?JSON.parse(T):void 0;await A(o),process.exit(0)}catch(o){console.error(`[claude-mem summary-hook error: ${o.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
