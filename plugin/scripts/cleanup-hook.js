#!/usr/bin/env node
import f from"better-sqlite3";import{join as i,dirname as I,basename as R}from"path";import{homedir as _}from"os";import{existsSync as L,mkdirSync as D}from"fs";var a=process.env.CLAUDE_MEM_DATA_DIR||i(_(),".claude-mem"),d=process.env.CLAUDE_CONFIG_DIR||i(_(),".claude"),C=i(a,"archives"),P=i(a,"logs"),y=i(a,"trash"),O=i(a,"backups"),H=i(a,"settings.json"),g=i(a,"claude-mem.db"),N=i(d,"settings.json"),U=i(d,"commands"),M=i(d,"CLAUDE.md");function E(o){D(o,{recursive:!0})}var m=class{db;constructor(){E(a),this.db=new f(g),this.db.pragma("journal_mode = WAL"),this.db.pragma("synchronous = NORMAL"),this.db.pragma("foreign_keys = ON"),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns()}ensureWorkerPortColumn(){try{this.db.pragma("table_info(sdk_sessions)").some(t=>t.name==="worker_port")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),console.error("[HooksDatabase] Added worker_port column to sdk_sessions table"))}catch(e){console.error("[HooksDatabase] Migration error:",e.message)}}ensurePromptTrackingColumns(){try{this.db.pragma("table_info(sdk_sessions)").some(c=>c.name==="prompt_counter")||(this.db.exec("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),console.error("[HooksDatabase] Added prompt_counter column to sdk_sessions table")),this.db.pragma("table_info(observations)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to observations table")),this.db.pragma("table_info(session_summaries)").some(c=>c.name==="prompt_number")||(this.db.exec("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),console.error("[HooksDatabase] Added prompt_number column to session_summaries table")),this.db.pragma("index_list(session_summaries)").some(c=>c.unique===1)&&(console.error("[HooksDatabase] WARNING: session_summaries.sdk_session_id has UNIQUE constraint. Cannot be removed in SQLite without recreating table."),console.error("[HooksDatabase] Multiple summaries per session will fail until table is recreated."))}catch(e){console.error("[HooksDatabase] Prompt tracking migration error:",e.message)}}getRecentSummaries(e,s=10){return this.db.prepare(`
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
    `).all(e,s)}findActiveSDKSession(e){return this.db.prepare(`
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
    `).get(e)?.prompt_counter||0}createSDKSession(e,s,t){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO sdk_sessions
      (claude_session_id, project, user_prompt, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}updateSDKSessionId(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET sdk_session_id = ?
      WHERE id = ? AND sdk_session_id IS NULL
    `).run(s,e).changes===0&&console.error(`[HooksDatabase] Skipped updating sdk_session_id for session ${e} - already set (prevents FOREIGN KEY constraint violation)`)}setWorkerPort(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET worker_port = ?
      WHERE id = ?
    `).run(s,e)}getWorkerPort(e){return this.db.prepare(`
      SELECT worker_port
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)?.worker_port||null}storeObservation(e,s,t,r,n){let u=new Date,p=u.getTime();this.db.prepare(`
      INSERT INTO observations
      (sdk_session_id, project, text, type, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,r,t,n||null,u.toISOString(),p)}storeSummary(e,s,t,r){let n=new Date,u=n.getTime();this.db.prepare(`
      INSERT INTO session_summaries
      (sdk_session_id, project, request, investigated, learned, completed,
       next_steps, files_read, files_edited, notes, prompt_number, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request||null,t.investigated||null,t.learned||null,t.completed||null,t.next_steps||null,t.files_read||null,t.files_edited||null,t.notes||null,r||null,n.toISOString(),u)}markSessionCompleted(e){let s=new Date,t=s.getTime();this.db.prepare(`
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
    `).run(e.toISOString(),s).changes}close(){this.db.close()}};async function b(o){try{console.error("[claude-mem cleanup] Hook fired",{input:o?{session_id:o.session_id,cwd:o.cwd,reason:o.reason}:null}),o||(console.log("No input provided - this script is designed to run as a Claude Code SessionEnd hook"),console.log(`
Expected input format:`),console.log(JSON.stringify({session_id:"string",cwd:"string",transcript_path:"string",hook_event_name:"SessionEnd",reason:"exit"},null,2)),process.exit(0));let{session_id:e,reason:s}=o;console.error("[claude-mem cleanup] Searching for active SDK session",{session_id:e,reason:s});let t=new m,r=t.findActiveSDKSession(e);if(r||(console.error("[claude-mem cleanup] No active SDK session found",{session_id:e}),t.close(),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)),console.error("[claude-mem cleanup] Active SDK session found",{session_id:r.id,sdk_session_id:r.sdk_session_id,project:r.project,worker_port:r.worker_port}),r.worker_port)try{let n=await fetch(`http://127.0.0.1:${r.worker_port}/sessions/${r.id}`,{method:"DELETE",signal:AbortSignal.timeout(5e3)});n.ok?console.error("[claude-mem cleanup] Session deleted successfully via HTTP"):console.error("[claude-mem cleanup] Failed to delete session:",await n.text())}catch(n){console.error("[claude-mem cleanup] HTTP DELETE error:",n.message)}else console.error("[claude-mem cleanup] No worker port, cannot send DELETE request");try{t.markSessionFailed(r.id),console.error("[claude-mem cleanup] Session marked as failed in database")}catch(n){console.error("[claude-mem cleanup] Failed to mark session as failed:",n)}t.close(),console.error("[claude-mem cleanup] Cleanup completed successfully"),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}catch(e){console.error("[claude-mem cleanup] Unexpected error in hook",{error:e.message,stack:e.stack,name:e.name}),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}}import{stdin as k}from"process";var l="";k.on("data",o=>l+=o);k.on("end",async()=>{try{let o=l.trim()?JSON.parse(l):void 0;await b(o)}catch(o){console.error(`[claude-mem cleanup-hook error: ${o.message}]`),console.log('{"continue": true, "suppressOutput": true}'),process.exit(0)}});
