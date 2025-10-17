#!/usr/bin/env node
import b from"better-sqlite3";import{join as n,dirname as w,basename as A}from"path";import{homedir as m}from"os";import{existsSync as v,mkdirSync as f}from"fs";var i=process.env.CLAUDE_MEM_DATA_DIR||n(m(),".claude-mem"),d=process.env.CLAUDE_CONFIG_DIR||n(m(),".claude"),P=n(i,"archives"),y=n(i,"logs"),H=n(i,"trash"),C=n(i,"backups"),L=n(i,"settings.json"),g=n(i,"claude-mem.db"),U=n(d,"settings.json"),N=n(d,"commands"),W=n(d,"CLAUDE.md");function _(r){f(r,{recursive:!0})}var c=class{db;constructor(){_(i),this.db=new b(g),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,t)}getRecentObservations(e,t=20){return this.db.prepare(`
      SELECT type, text, created_at
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
    `).run(t,e)}createSDKSession(e,t,s){let o=new Date,a=o.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,o.toISOString(),a).lastInsertRowid}updateSDKSessionId(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ?
    `).run(t,e)}setWorkerPort(e,t){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(t,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,t,s,o){let a=new Date,u=a.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e,t,o,s,a.toISOString(),u)}storeSummary(e,t,s){let o=new Date,a=o.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request||null,s.investigated||null,s.learned||null,s.completed||null,s.next_steps||null,s.files_read||null,s.files_edited||null,s.notes||null,o.toISOString(),a)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function h(r,e,t){return r==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:t.reason||"Pre-compact operation failed",suppressOutput:!0}:r==="SessionStart"?e&&t.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:t.context}}:{continue:!0,suppressOutput:!0}:r==="UserPromptSubmit"||r==="PostToolUse"?{continue:!0,suppressOutput:!0}:r==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...t.reason&&!e?{stopReason:t.reason}:{}}}function p(r,e,t={}){let s=h(r,e,t);return JSON.stringify(s)}async function S(r){if(!r)throw new Error("summaryHook requires input");let{session_id:e}=r,t=new c,s=t.findActiveSDKSession(e);if(t.close(),!s){console.log(p("Stop",!0));return}if(!s.worker_port){console.error("[summary-hook] No worker port for session",s.id),console.log(p("Stop",!0));return}try{let o=await fetch(`http://127.0.0.1:${s.worker_port}/sessions/${s.id}/finalize`,{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(2e3)});o.ok||console.error("[summary-hook] Failed to finalize:",await o.text())}catch(o){console.error("[summary-hook] Error:",o.message)}finally{console.log(p("Stop",!0))}}import{stdin as E}from"process";var l="";E.on("data",r=>l+=r);E.on("end",async()=>{try{let r=l.trim()?JSON.parse(l):void 0;await S(r)}catch(r){console.error(`[claude-mem summary-hook error: ${r.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
