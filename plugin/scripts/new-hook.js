#!/usr/bin/env node
import T from"path";import D from"better-sqlite3";import{join as a,dirname as v,basename as P}from"path";import{homedir as k}from"os";import{existsSync as U,mkdirSync as w}from"fs";var p=process.env.CLAUDE_MEM_DATA_DIR||a(k(),".claude-mem"),l=process.env.CLAUDE_CONFIG_DIR||a(k(),".claude"),L=a(p,"archives"),N=a(p,"logs"),W=a(p,"trash"),j=a(p,"backups"),M=a(p,"settings.json"),f=a(p,"claude-mem.db"),F=a(l,"settings.json"),$=a(l,"commands"),q=a(l,"CLAUDE.md");function E(r){w(r,{recursive:!0})}var d=class{db;constructor(){E(p),this.db=new D(f),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(s=>s.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}getRecentSummaries(e,t=10){return this.db.prepare(`
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
    `).run(t,e)}createSDKSession(e,t,s){let o=new Date,n=o.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,t,s,o.toISOString(),n).lastInsertRowid}updateSDKSessionId(e,t){this.db.prepare(`
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
    `).get(e)?.worker_port||null}storeObservation(e,t,s,o){let n=new Date,i=n.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e,t,o,s,n.toISOString(),i)}storeSummary(e,t,s){let o=new Date,n=o.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,t,s.request||null,s.investigated||null,s.learned||null,s.completed||null,s.next_steps||null,s.files_read||null,s.files_edited||null,s.notes||null,o.toISOString(),n)}markSessionCompleted(e){let t=new Date,s=t.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),t).changes}close(){this.db.close()}};function R(r,e,t){return r==="PreCompact"?e?{continue:!0,suppressOutput:!0}:{continue:!1,stopReason:t.reason||"Pre-compact operation failed",suppressOutput:!0}:r==="SessionStart"?e&&t.context?{continue:!0,suppressOutput:!0,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:t.context}}:{continue:!0,suppressOutput:!0}:r==="UserPromptSubmit"||r==="PostToolUse"?{continue:!0,suppressOutput:!0}:r==="Stop"?{continue:!0,suppressOutput:!0}:{continue:e,suppressOutput:!0,...t.reason&&!e?{stopReason:t.reason}:{}}}function u(r,e,t={}){let s=R(r,e,t);return JSON.stringify(s)}async function A(){let{readFileSync:r,existsSync:e}=await import("fs"),{join:t}=await import("path"),{homedir:s}=await import("os"),o=t(s(),".claude-mem","worker.port");if(!e(o))return null;try{let n=r(o,"utf8").trim();return parseInt(n,10)}catch{return null}}async function b(r){if(!r)throw new Error("newHook requires input");let{session_id:e,cwd:t,prompt:s}=r,o=T.basename(t),n=new d;try{let i=n.findActiveSDKSession(e),c;if(i){c=i.id,console.log(u("UserPromptSubmit",!0));return}let g=n.findAnySDKSession(e);g?(c=g.id,n.reactivateSession(c,s),console.error(`[new-hook] Reactivated session ${c} for Claude session ${e}`)):(c=n.createSDKSession(e,o,s),console.error(`[new-hook] Created new session ${c} for Claude session ${e}`));let _=await A();if(!_){console.error("[new-hook] Worker service not running. Start with: npm run worker:start"),console.log(u("UserPromptSubmit",!0));return}let S=await fetch(`http://127.0.0.1:${_}/sessions/${c}/init`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:o,userPrompt:s}),signal:AbortSignal.timeout(5e3)});S.ok||console.error("[new-hook] Failed to init session:",await S.text()),console.log(u("UserPromptSubmit",!0))}catch(i){console.error("[new-hook] FATAL ERROR:",i.message),console.error("[new-hook] Stack:",i.stack),console.error("[new-hook] Full error:",JSON.stringify(i,Object.getOwnPropertyNames(i))),console.log(u("UserPromptSubmit",!0))}finally{n.close()}}import{stdin as h}from"process";var m="";h.on("data",r=>m+=r);h.on("end",async()=>{try{let r=m.trim()?JSON.parse(m):void 0;await b(r)}catch(r){console.error(`[claude-mem new-hook error: ${r.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
