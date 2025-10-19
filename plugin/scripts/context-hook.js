#!/usr/bin/env node
import C from"path";import D from"better-sqlite3";import{join as d,dirname as P,basename as B}from"path";import{homedir as R}from"os";import{existsSync as X,mkdirSync as v}from"fs";var m=process.env.CLAUDE_MEM_DATA_DIR||d(R(),".claude-mem"),_=process.env.CLAUDE_CONFIG_DIR||d(R(),".claude"),W=d(m,"archives"),G=d(m,"logs"),q=d(m,"trash"),J=d(m,"backups"),Y=d(m,"settings.json"),L=d(m,"claude-mem.db"),K=d(_,"settings.json"),V=d(_,"commands"),Q=d(_,"CLAUDE.md");function A(c){v(c,{recursive:!0})}var E=(r=>(r[r.DEBUG=0]="DEBUG",r[r.INFO=1]="INFO",r[r.WARN=2]="WARN",r[r.ERROR=3]="ERROR",r[r.SILENT=4]="SILENT",r))(E||{}),g=class{level;useColor;constructor(){let e=process.env.CLAUDE_MEM_LOG_LEVEL?.toUpperCase()||"INFO";this.level=E[e]??1,this.useColor=process.stdout.isTTY??!1}correlationId(e,t){return`obs-${e}-${t}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.level===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let t=Object.keys(e);return t.length===0?"{}":t.length<=3?JSON.stringify(e):`{${t.length} keys: ${t.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,t){if(!t)return e;try{let s=typeof t=="string"?JSON.parse(t):t;if(e==="Bash"&&s.command){let n=s.command.length>50?s.command.substring(0,50)+"...":s.command;return`${e}(${n})`}if(e==="Read"&&s.file_path){let n=s.file_path.split("/").pop()||s.file_path;return`${e}(${n})`}if(e==="Edit"&&s.file_path){let n=s.file_path.split("/").pop()||s.file_path;return`${e}(${n})`}if(e==="Write"&&s.file_path){let n=s.file_path.split("/").pop()||s.file_path;return`${e}(${n})`}return e}catch{return e}}log(e,t,s,n,r){if(e<this.level)return;let i=new Date().toISOString().replace("T"," ").substring(0,23),o=E[e].padEnd(5),u=t.padEnd(6),a="";n?.correlationId?a=`[${n.correlationId}] `:n?.sessionId&&(a=`[session-${n.sessionId}] `);let p="";r!=null&&(this.level===0&&typeof r=="object"?p=`
`+JSON.stringify(r,null,2):p=" "+this.formatData(r));let b="";if(n){let{sessionId:k,sdkSessionId:I,correlationId:x,...S}=n;Object.keys(S).length>0&&(b=` {${Object.entries(S).map(([y,N])=>`${y}=${N}`).join(", ")}}`)}let f=`[${i}] [${o}] [${u}] ${a}${s}${b}${p}`;e===3?console.error(f):console.log(f)}debug(e,t,s,n){this.log(0,e,t,s,n)}info(e,t,s,n){this.log(1,e,t,s,n)}warn(e,t,s,n){this.log(2,e,t,s,n)}error(e,t,s,n){this.log(3,e,t,s,n)}dataIn(e,t,s,n){this.info(e,`\u2192 ${t}`,s,n)}dataOut(e,t,s,n){this.info(e,`\u2190 ${t}`,s,n)}success(e,t,s,n){this.info(e,`\u2713 ${t}`,s,n)}failure(e,t,s,n){this.error(e,`\u2717 ${t}`,s,n)}timing(e,t,s,n){this.info(e,`\u23F1 ${t}`,n,{duration:`${s}ms`})}},O=new g;var l=class{db;constructor(){A(m),this.db=new D(L),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[SessionStore] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[SessionStore] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(a=>a.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[SessionStore] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(a=>a.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(a=>a.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[SessionStore] Added prompt_number column to session_summaries table"));let u=this.db.pragma("index_list(session_summaries)").some(a=>a.unique===1)}catch(e){console.error("[SessionStore] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(!this.db.pragma("index_list(session_summaries)").some(s=>s.unique===1))return;console.error("[SessionStore] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,t,s){let n=new Date,r=n.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,n.toISOString(),r).lastInsertRowid}updateSDKSessionId(e,t){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(t,e).changes===0?(O.debug("DB","sdk_session_id already set, skipping update",{sessionId:e,sdkSessionId:t}),!1):!0}setWorkerPort(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(t,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,t,s,n){let r=new Date,i=r.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.type,s.title,s.subtitle,JSON.stringify(s.facts),s.narrative,JSON.stringify(s.concepts),JSON.stringify(s.files_read),JSON.stringify(s.files_modified),n||null,r.toISOString(),i)}storeSummary(e,t,s,n){let r=new Date,i=r.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request,s.investigated,s.learned,s.completed,s.next_steps,s.notes,n||null,r.toISOString(),i)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function h(c){let e=c?.cwd??process.cwd(),t=e?C.basename(e):"unknown-project",s=new l;try{let n=s.getRecentSessionsWithStatus(t,3);if(n.length===0)return`# Recent Session Context

No previous sessions found for this project yet.`;let r=[];r.push("# Recent Session Context"),r.push(""),r.push(`Showing last ${n.length} session(s) for **${t}**:`),r.push("");for(let i of n)if(i.sdk_session_id){if(r.push("---"),r.push(""),i.has_summary){let o=s.getSummaryForSession(i.sdk_session_id);if(o){let u=o.prompt_number?` (Prompt #${o.prompt_number})`:"";if(r.push(`**Summary${u}**`),r.push(""),o.request&&r.push(`**Request:** ${o.request}`),o.completed&&r.push(`**Completed:** ${o.completed}`),o.learned&&r.push(`**Learned:** ${o.learned}`),o.next_steps&&r.push(`**Next Steps:** ${o.next_steps}`),o.files_read)try{let p=JSON.parse(o.files_read);Array.isArray(p)&&p.length>0&&r.push(`**Files Read:** ${p.join(", ")}`)}catch{o.files_read.trim()&&r.push(`**Files Read:** ${o.files_read}`)}if(o.files_edited)try{let p=JSON.parse(o.files_edited);Array.isArray(p)&&p.length>0&&r.push(`**Files Edited:** ${p.join(", ")}`)}catch{o.files_edited.trim()&&r.push(`**Files Edited:** ${o.files_edited}`)}let a=new Date(o.created_at).toLocaleString();r.push(`**Date:** ${a}`)}}else if(i.status==="active"){r.push("**In Progress**"),r.push(""),i.user_prompt&&r.push(`**Request:** ${i.user_prompt}`);let o=s.getObservationsForSession(i.sdk_session_id);if(o.length>0){r.push(""),r.push(`**Observations (${o.length}):**`);for(let a of o)r.push(`- ${a.title}`)}else r.push(""),r.push("*No observations yet*");r.push(""),r.push("**Status:** Active - summary pending");let u=new Date(i.started_at).toLocaleString();r.push(`**Date:** ${u}`)}else{let o=i.status==="failed"?"stopped":i.status;r.push(`**${o.charAt(0).toUpperCase()+o.slice(1)}**`),r.push(""),i.user_prompt&&r.push(`**Request:** ${i.user_prompt}`),r.push(""),r.push(`**Status:** ${o} - no summary available`);let u=new Date(i.started_at).toLocaleString();r.push(`**Date:** ${u}`)}r.push("")}return r.join(`
`)}finally{s.close()}}import{stdin as T}from"process";try{if(T.isTTY){let e={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:h()}};console.log(JSON.stringify(e)),process.exit(0)}else{let c="";T.on("data",e=>c+=e),T.on("end",()=>{let e=c.trim()?JSON.parse(c):void 0,s={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:h(e)}};console.log(JSON.stringify(s)),process.exit(0)})}}catch(c){console.error(`[claude-mem context-hook error: ${c.message}]`),process.exit(0)}
