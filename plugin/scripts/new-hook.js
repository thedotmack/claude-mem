#!/usr/bin/env node
import A from"path";import w from"better-sqlite3";import{join as p,dirname as x,basename as C}from"path";import{homedir as k}from"os";import{existsSync as N,mkdirSync as R}from"fs";var c=process.env.CLAUDE_MEM_DATA_DIR||p(k(),".claude-mem"),b=process.env.CLAUDE_CONFIG_DIR||p(k(),".claude"),U=p(c,"archives"),W=p(c,"logs"),M=p(c,"trash"),j=p(c,"backups"),F=p(c,"settings.json"),S=p(c,"claude-mem.db"),$=p(b,"settings.json"),q=p(b,"commands"),G=p(b,"CLAUDE.md");function f(r){R(r,{recursive:!0})}var l=class{db;constructor(){f(c),this.db=new w(S),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(u=>u.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(u=>u.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(u=>u.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table")),this.db.pragma("index_list(session_summaries)").some(u=>u.unique===1)&&(console.error("[HooksDatabase] WARNING: session_summaries.sdk_session_id has UNIQUE constraint. Cannot be removed in SQLite without recreating table."),console.error("[HooksDatabase] Multiple summaries per session will fail until table is recreated."))}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).all(e,t)}findActiveSDKSession(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,t,s){let n=new Date,o=n.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,n.toISOString(),o).lastInsertRowid}updateSDKSessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(t,e).changes===0&&console.error(`[HooksDatabase] Skipped updating sdk_session_id for session ${e} - already set (prevents FOREIGN KEY constraint violation)`)}setWorkerPort(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(t,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,t,s,n,o){let a=new Date,i=a.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,n,s,o||null,a.toISOString(),i)}storeSummary(e,t,s,n){let o=new Date,a=o.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request||null,s.investigated||null,s.learned||null,s.completed||null,s.next_steps||null,s.files_read||null,s.files_edited||null,s.notes||null,n||null,o.toISOString(),a)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function T(r,e,t){return r==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:t.reason||"Pre-compact operation failed",suppressOutput:!0}:r==="SessionStart"?e&&t.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:t.context}}:{continue:!0,suppressOutput:!0}:r==="UserPromptSubmit"||r==="PostToolUse"?{continue:!0,suppressOutput:!0}:r==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...t.reason&&!e?{stopReason:t.reason}:{}}}function _(r,e,t={}){let s=T(r,e,t);return JSON.stringify(s)}async function I(){let{readFileSync:r,existsSync:e}=await import("fs"),{join:t}=await import("path"),{homedir:s}=await import("os"),n=t(s(),".claude-mem","worker.port");if(!e(n))return null;try{let o=r(n,"utf8").trim();return parseInt(o,10)}catch{return null}}async function h(r){if(!r)throw new Error("newHook requires input");let{session_id:e,cwd:t,prompt:s}=r,n=A.basename(t),o=new l;try{let a=o.findActiveSDKSession(e),i,d=!1;if(a){i=a.id;let m=o.incrementPromptCounter(i);console.error(`[new-hook] Continuing session ${i}, prompt #${m}`)}else{let m=o.findAnySDKSession(e);if(m){i=m.id,o.reactivateSession(i,s);let g=o.incrementPromptCounter(i);d=!0,console.error(`[new-hook] Reactivated session ${i}, prompt #${g}`)}else{i=o.createSDKSession(e,n,s);let g=o.incrementPromptCounter(i);d=!0,console.error(`[new-hook] Created new session ${i}, prompt #${g}`)}}let u=await I();if(!u){console.error("[new-hook] Worker service not running. Start with: npm run worker:start"),console.log(_("UserPromptSubmit",!0));return}if(d){let m=await fetch(`http://127.0.0.1:${u}/sessions/${i}/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:n,userPrompt:s}),signal:AbortSignal.timeout(5e3)});m.ok||console.error("[new-hook] Failed to init session:",await m.text())}console.log(_("UserPromptSubmit",!0))}catch(a){console.error("[new-hook] FATAL ERROR:",a.message),console.error("[new-hook] Stack:",a.stack),console.error("[new-hook] Full error:",JSON.stringify(a,Object.getOwnPropertyNames(a))),console.log(_("UserPromptSubmit",!0))}finally{o.close()}}import{stdin as D}from"process";var E="";D.on("data",r=>E+=r);D.on("end",async()=>{try{let r=E.trim()?JSON.parse(E):void 0;await h(r)}catch(r){console.error(`[claude-mem new-hook error: ${r.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
