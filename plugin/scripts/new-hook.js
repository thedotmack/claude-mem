#!/usr/bin/env node
import I from"path";import D from"better-sqlite3";import{join as u,dirname as C,basename as v}from"path";import{homedir as k}from"os";import{existsSync as U,mkdirSync as R}from"fs";var m=process.env.CLAUDE_MEM_DATA_DIR||u(k(),".claude-mem"),g=process.env.CLAUDE_CONFIG_DIR||u(k(),".claude"),H=u(m,"archives"),M=u(m,"logs"),j=u(m,"trash"),W=u(m,"backups"),F=u(m,"settings.json"),T=u(m,"claude-mem.db"),q=u(g,"settings.json"),B=u(g,"commands"),G=u(g,"CLAUDE.md");function S(r){R(r,{recursive:!0})}var l=class{db;constructor(){S(m),this.db=new D(T),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(t=>t.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(p=>p.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(p=>p.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table"));let d=this.db.pragma("index_list(session_summaries)").some(p=>p.unique===1)}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}removeSessionSummariesUniqueConstraint(){try{if(!this.db.pragma("index_list(session_summaries)").some(t=>t.unique===1))return;console.error("[HooksDatabase] Removing UNIQUE constraint from session_summaries.sdk_session_id..."),this.db.exec("BEGIN TRANSACTION");try{this.db.exec(`
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
        `),this.db.exec("COMMIT"),console.error("[HooksDatabase] Successfully removed UNIQUE constraint from session_summaries.sdk_session_id")}catch(t){throw this.db.exec("ROLLBACK"),t}}catch(e){console.error("[HooksDatabase] Migration error (remove UNIQUE constraint):",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
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
    `).all(e,s)}getSessionById(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,s,t,n.toISOString(),o).lastInsertRowid}updateSDKSessionId(e,s){return this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0?(console.error(`[HooksDatabase] Skipped updating sdk_session_id for session ${e} - already set (prevents FOREIGN KEY constraint violation)`),!1):!0}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,s,t,n,o){let a=new Date,i=a.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,n,t,o||null,a.toISOString(),i)}storeSummary(e,s,t,n){let o=new Date,a=o.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request||null,t.investigated||null,t.learned||null,t.completed||null,t.next_steps||null,t.files_read||null,t.files_edited||null,t.notes||null,n||null,o.toISOString(),a)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'completed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}markSessionFailed(e){let s=new Date,t=s.getTime();this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE id = ?
    `).run(s.toISOString(),t,e)}cleanupOrphanedSessions(){let e=new Date,s=e.getTime();return this.db.prepare(`
      UPDATE sdk_sessions
      SET status = 'failed', completed_at = ?, completed_at_epoch = ?
      WHERE status = 'active'
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};function A(r,e,s){return r==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:s.reason||"Pre-compact operation failed",suppressOutput:!0}:r==="SessionStart"?e&&s.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s.context}}:{continue:!0,suppressOutput:!0}:r==="UserPromptSubmit"||r==="PostToolUse"?{continue:!0,suppressOutput:!0}:r==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...s.reason&&!e?{stopReason:s.reason}:{}}}function _(r,e,s={}){let t=A(r,e,s);return JSON.stringify(t)}async function w(){let{readFileSync:r,existsSync:e}=await import("fs"),{join:s}=await import("path"),{homedir:t}=await import("os"),n=s(t(),".claude-mem","worker.port");if(!e(n))return null;try{let o=r(n,"utf8").trim();return parseInt(o,10)}catch{return null}}async function h(r){if(!r)throw new Error("newHook requires input");let{session_id:e,cwd:s,prompt:t}=r,n=I.basename(s),o=new l;try{let a=o.findActiveSDKSession(e),i,d=!1;if(a){i=a.id;let c=o.incrementPromptCounter(i);console.error(`[new-hook] Continuing session ${i}, prompt #${c}`)}else{let c=o.findAnySDKSession(e);if(c){i=c.id,o.reactivateSession(i,t);let E=o.incrementPromptCounter(i);d=!0,console.error(`[new-hook] Reactivated session ${i}, prompt #${E}`)}else{i=o.createSDKSession(e,n,t);let E=o.incrementPromptCounter(i);d=!0,console.error(`[new-hook] Created new session ${i}, prompt #${E}`)}}let p=await w();if(!p){console.error("[new-hook] Worker service not running. Start with: npm run worker:start"),console.log(_("UserPromptSubmit",!0));return}if(d){let c=await fetch(`http://127.0.0.1:${p}/sessions/${i}/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:n,userPrompt:t}),signal:AbortSignal.timeout(5e3)});c.ok||console.error("[new-hook] Failed to init session:",await c.text())}console.log(_("UserPromptSubmit",!0))}catch(a){console.error("[new-hook] FATAL ERROR:",a.message),console.error("[new-hook] Stack:",a.stack),console.error("[new-hook] Full error:",JSON.stringify(a,Object.getOwnPropertyNames(a))),console.log(_("UserPromptSubmit",!0))}finally{o.close()}}import{stdin as f}from"process";var b="";f.on("data",r=>b+=r);f.on("end",async()=>{try{let r=b.trim()?JSON.parse(b):void 0;await h(r)}catch(r){console.error(`[claude-mem new-hook error: ${r.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
