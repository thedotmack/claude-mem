#!/usr/bin/env node
import b from"better-sqlite3";import{join as n,dirname as w,basename as O}from"path";import{homedir as g}from"os";import{existsSync as P,mkdirSync as f}from"fs";var c=process.env.CLAUDE_MEM_DATA_DIR||n(g(),".claude-mem"),l=process.env.CLAUDE_CONFIG_DIR||n(g(),".claude"),y=n(c,"archives"),H=n(c,"logs"),C=n(c,"trash"),L=n(c,"backups"),U=n(c,"settings.json"),_=n(c,"claude-mem.db"),N=n(l,"settings.json"),W=n(l,"commands"),M=n(l,"CLAUDE.md");function S(o){f(o,{recursive:!0})}var d=class{db;constructor(){S(c),this.db=new b(_),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).run(t,e)}createSDKSession(e,t,s){let r=new Date,i=r.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,r.toISOString(),i).lastInsertRowid}updateSDKSessionId(e,t){this.db.prepare(`
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
    `).get(e)?.worker_port||null}storeObservation(e,t,s,r){let i=new Date,a=i.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e,t,r,s,i.toISOString(),a)}storeSummary(e,t,s){let r=new Date,i=r.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request||null,s.investigated||null,s.learned||null,s.completed||null,s.next_steps||null,s.files_read||null,s.files_edited||null,s.notes||null,r.toISOString(),i)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function h(o,e,t){return o==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:t.reason||"Pre-compact operation failed",suppressOutput:!0}:o==="SessionStart"?e&&t.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:t.context}}:{continue:!0,suppressOutput:!0}:o==="UserPromptSubmit"||o==="PostToolUse"?{continue:!0,suppressOutput:!0}:o==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...t.reason&&!e?{stopReason:t.reason}:{}}}function u(o,e,t={}){let s=h(o,e,t);return JSON.stringify(s)}var T=new Set(["TodoWrite","ListMcpResourcesTool"]);async function E(o){if(!o)throw new Error("saveHook requires input");let{session_id:e,tool_name:t,tool_input:s,tool_output:r}=o;if(T.has(t)){console.log(u("PostToolUse",!0));return}let i=new d,a=i.findActiveSDKSession(e);if(i.close(),!a){console.log(u("PostToolUse",!0));return}if(!a.worker_port){console.error("[save-hook] No worker port for session",a.id),console.log(u("PostToolUse",!0));return}try{let p=await fetch(`http://127.0.0.1:${a.worker_port}/sessions/${a.id}/observations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_name:t,tool_input:JSON.stringify(s),tool_output:JSON.stringify(r)}),signal:AbortSignal.timeout(2e3)});p.ok||console.error("[save-hook] Failed to send observation:",await p.text())}catch(p){console.error("[save-hook] Error:",p.message)}finally{console.log(u("PostToolUse",!0))}}import{stdin as k}from"process";var m="";k.on("data",o=>m+=o);k.on("end",async()=>{try{let o=m.trim()?JSON.parse(m):void 0;await E(o)}catch(o){console.error(`[claude-mem save-hook error: ${o.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
